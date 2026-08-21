(() => {
  // Bump AX_TREE_VERSION whenever anything in this file changes. The helpers are injected
  // into a page's isolated world on demand, so a page that was visited before an extension
  // update still holds the previous copy. Matching on the version replaces stale helpers on
  // the next injection while leaving a same-version copy, and the element ref store it owns,
  // untouched. A bare truthiness guard would pin the old code until the page navigated.
  const AX_TREE_VERSION = '0.3.0';
  if (globalThis.UmbraAxTree?.version === AX_TREE_VERSION) {
    return globalThis.UmbraAxTree;
  }

  const DEFAULT_MAX_NODES = 200;
  const ABSOLUTE_MAX_NODES = 500;
  const DEFAULT_FIND_LIMIT = 10;
  // A candidate's name is its accessible name, and computeAccessibleName falls
  // back to innerText, so a wrapper's name is a dump of everything under it.
  // Ranking and reporting both stop at 120 characters: past that the text
  // belongs to the subtree, not to the element.
  const FIND_NAME_MAX = 120;
  // Past this much subtree text the node contains the query rather than being
  // the thing the caller asked for. The penalty is larger than the 35 points the
  // multi-token tail can award and smaller than the 100 an exact name match
  // earns, so a container still surfaces when nothing better matched.
  const CONTAINER_TEXT_MAX = 400;
  const CONTAINER_PENALTY = 45;
  // Far past any real page. The walk recurses once per DOM level and burns about
  // two stack frames per level, so a hostile page nested a few thousand deep
  // used to throw RangeError out of every read tool.
  const MAX_WALK_DEPTH = 1_000;
  // A ceiling on elements visited, not on nodes kept. Generous enough that a
  // normal page never reaches it and tight enough that a 100,000-node document
  // cannot make one read walk the whole tree.
  const VISIT_BUDGET_FACTOR = 40;
  const MIN_VISIT_BUDGET = 20_000;

  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'slider',
    'spinbutton',
    'option',
    'treeitem',
    'gridcell',
    'scrollbar',
  ]);

  const LANDMARK_ROLES = new Set([
    'banner',
    'navigation',
    'main',
    'contentinfo',
    'complementary',
    'search',
    'form',
    'region',
  ]);

  const STRUCTURAL_ROLES = new Set([
    'heading',
    'list',
    'listitem',
    'table',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'article',
    'image',
    'img',
    'dialog',
    'figure',
    'alert',
    'status',
    'label',
  ]);

  const SKIP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'meta',
    'link',
    'head',
    'br',
    'wbr',
  ]);

  function normalize(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) {
      return globalThis.CSS.escape(value);
    }
    return String(value || '').replace(/["\\]/g, '\\$&');
  }

  // Floored at one node. A value between 0 and 1 passed the `<= 0` guard and
  // then floored to zero, so a page full of controls came back as an empty read
  // with truncated: true, which is both wrong and self-contradictory.
  function clampMaxNodes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_MAX_NODES;
    }
    return Math.min(Math.max(1, Math.floor(parsed)), ABSOLUTE_MAX_NODES);
  }

  function clampFindLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_FIND_LIMIT;
    }
    return Math.min(Math.max(1, Math.floor(parsed)), ABSOLUTE_MAX_NODES);
  }

  function attrMap(element) {
    if (!element) {
      return {};
    }
    if (element.attributes && !element.getAttribute && typeof element.attributes === 'object' && !element.attributes.length) {
      return { ...element.attributes };
    }
    const names = [
      'role',
      'type',
      'href',
      'alt',
      'title',
      'placeholder',
      'name',
      'value',
      'aria-label',
      'aria-labelledby',
      'aria-checked',
      'aria-disabled',
      'aria-hidden',
      'contenteditable',
      'tabindex',
      'disabled',
      'hidden',
    ];
    const attrs = {};
    for (const name of names) {
      const value = element.getAttribute?.(name);
      if (value !== null && value !== undefined) {
        attrs[name] = value;
      }
    }
    if (element.id) {
      attrs.id = element.id;
    }
    if (element.type && attrs.type === undefined) {
      attrs.type = element.type;
    }
    if (element.isContentEditable === true && attrs.contenteditable === undefined) {
      attrs.contenteditable = 'true';
    }
    return attrs;
  }

  function implicitRole(tag, attrs = {}, context = {}) {
    const explicit = normalize(attrs.role);
    if (explicit) {
      return explicit;
    }
    const type = String(attrs.type || '').toLowerCase();
    switch (String(tag || '').toLowerCase()) {
      case 'a':
        return attrs.href !== undefined && attrs.href !== null ? 'link' : 'generic';
      case 'button':
      case 'summary':
        return 'button';
      case 'input':
        if (type === 'hidden') {
          return 'none';
        }
        if (['button', 'submit', 'reset', 'image'].includes(type)) {
          return 'button';
        }
        if (type === 'checkbox') {
          return 'checkbox';
        }
        if (type === 'radio') {
          return 'radio';
        }
        if (type === 'range') {
          return 'slider';
        }
        if (type === 'number') {
          return 'spinbutton';
        }
        if (type === 'search') {
          return 'searchbox';
        }
        return 'textbox';
      case 'select':
        return 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return 'image';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return context.insideSection ? 'generic' : 'banner';
      case 'footer':
        return context.insideSection ? 'generic' : 'contentinfo';
      case 'aside':
        return 'complementary';
      case 'form':
        return 'form';
      case 'section':
        return attrs['aria-label'] || attrs['aria-labelledby'] ? 'region' : 'generic';
      case 'article':
        return 'article';
      case 'ul':
      case 'ol':
        return 'list';
      case 'li':
        return 'listitem';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th':
        return 'columnheader';
      case 'label':
        return 'label';
      case 'dialog':
        return 'dialog';
      case 'option':
        return 'option';
      default:
        if (attrs.contenteditable === 'true' || attrs.contenteditable === '') {
          return 'textbox';
        }
        return 'generic';
    }
  }

  function isInteractiveRole(role, tag, attrs = {}) {
    if (INTERACTIVE_ROLES.has(role)) {
      return true;
    }
    const normalizedTag = String(tag || '').toLowerCase();
    const type = String(attrs.type || '').toLowerCase();
    if (normalizedTag === 'input' && type !== 'hidden') {
      return true;
    }
    if (['button', 'select', 'textarea', 'summary'].includes(normalizedTag)) {
      return true;
    }
    if (normalizedTag === 'a' && attrs.href !== undefined && attrs.href !== null) {
      return true;
    }
    if (attrs.contenteditable === 'true' || attrs.contenteditable === '') {
      return true;
    }
    if (attrs.tabindex !== undefined && attrs.tabindex !== null && Number(attrs.tabindex) >= 0) {
      return true;
    }
    return false;
  }

  function isLandmarkRole(role) {
    return LANDMARK_ROLES.has(role);
  }

  function shouldIncludeAxNode(node, filter) {
    const role = node?.role || 'generic';
    if (role === 'none' || role === 'presentation') {
      return false;
    }
    if (filter === 'interactive') {
      return isInteractiveRole(role, node.tag, node.attrs || {});
    }
    if (filter === 'landmarks') {
      return isLandmarkRole(role);
    }
    if (isInteractiveRole(role, node.tag, node.attrs || {}) || isLandmarkRole(role) || STRUCTURAL_ROLES.has(role)) {
      return true;
    }
    if (filter === 'find') {
      // Roleless wrapper: keep it only when its own text is short enough to be a
      // label. A 500-character name is an article, and admitting it costs the
      // walk one of the node slots the real links are waiting for.
      const named = normalize(node.name);
      return Boolean(named) && (Number(node.nameLength) || named.length) <= FIND_NAME_MAX;
    }
    return Boolean(normalize(node.name));
  }

  function accessibleName(sources = {}) {
    return normalize(
      sources.ariaLabel
      || sources.labelledByText
      || sources.labelText
      || sources.alt
      || sources.text
      || sources.title
      || sources.placeholder
      || sources.value
      || '',
    );
  }

  function labelledByText(element, documentRef) {
    const labelledBy = element.getAttribute?.('aria-labelledby');
    if (!labelledBy || !documentRef?.getElementById) {
      return '';
    }
    return labelledBy
      .split(/\s+/)
      .map((id) => normalize(documentRef.getElementById(id)?.innerText || documentRef.getElementById(id)?.textContent || ''))
      .filter(Boolean)
      .join(' ');
  }

  // One `label[for]` sweep per walk replaces a per-element `document.querySelector`. Document
  // order is preserved by querySelectorAll, so keeping the first label registered for an id
  // returns what querySelector returned. Returns null when the document cannot be swept, which
  // sends labelText back to the per-element query rather than to an empty answer.
  function buildLabelForMap(documentRef) {
    const labels = documentRef?.querySelectorAll?.('label[for]');
    if (!labels) {
      return null;
    }
    const map = new Map();
    for (const label of labels) {
      const forId = label?.getAttribute?.('for');
      if (!forId || map.has(forId)) {
        continue;
      }
      map.set(forId, label);
    }
    return map;
  }

  function labelText(element, documentRef, labelForMap) {
    if (element.id) {
      let explicit = null;
      if (labelForMap) {
        explicit = labelForMap.get(element.id) || null;
      } else if (documentRef?.querySelector) {
        explicit = documentRef.querySelector(`label[for="${cssEscape(element.id)}"]`);
      }
      const text = normalize(explicit?.innerText || explicit?.textContent || '');
      if (text) {
        return text;
      }
    }
    const closest = element.closest?.('label');
    if (closest && closest !== element) {
      return normalize(closest.innerText || closest.textContent || '');
    }
    return '';
  }

  function computeAccessibleNameParts(element, documentRef, labelForMap) {
    const full = accessibleName({
      ariaLabel: element.getAttribute?.('aria-label') || '',
      labelledByText: labelledByText(element, documentRef),
      labelText: labelText(element, documentRef, labelForMap),
      alt: element.getAttribute?.('alt') || '',
      // innerText, not textContent, on purpose. innerText skips display:none subtrees, so
      // hidden menu, tooltip, and screen-reader-only copy stays out of the accessible names
      // that agents match against. Swapping it would change results, not just cost.
      text: element.innerText || element.textContent || '',
      title: element.getAttribute?.('title') || '',
      placeholder: element.getAttribute?.('placeholder') || '',
      value: element.value || '',
    });
    // The pre-slice length is the only cheap measure of how much text hangs
    // under this element, and innerText has already been paid for here.
    return { name: full.slice(0, 500), nameLength: full.length };
  }

  function computeAccessibleName(element, documentRef, labelForMap) {
    return computeAccessibleNameParts(element, documentRef, labelForMap).name;
  }

  function elementValue(element) {
    if (element?.isContentEditable) {
      return String(element.textContent || '').slice(0, 500);
    }
    if (element && (typeof element.value === 'string' || typeof element.value === 'number')) {
      return String(element.value).slice(0, 500);
    }
    return '';
  }

  function elementChecked(element, role) {
    const type = String(element?.type || element?.getAttribute?.('type') || '').toLowerCase();
    const checkable = type === 'checkbox' || type === 'radio' || ['checkbox', 'radio', 'switch'].includes(role);
    if (!checkable) {
      const aria = element?.getAttribute?.('aria-checked');
      if (aria === 'true') {
        return true;
      }
      if (aria === 'false') {
        return false;
      }
      return null;
    }
    if (typeof element.checked === 'boolean') {
      return element.checked;
    }
    return element.getAttribute?.('aria-checked') === 'true';
  }

  function elementDisabled(element) {
    if (element?.disabled === true) {
      return true;
    }
    if (element?.getAttribute?.('aria-disabled') === 'true') {
      return true;
    }
    return Boolean(element?.closest?.('[disabled], [aria-disabled="true"]'));
  }

  // Split measuring from rounding so one getBoundingClientRect call feeds both the box test
  // and the reported rect. hasBox reads the raw values, so a sub-pixel element is judged on
  // what it actually measures rather than on the rounded copy.
  function measureElementRect(element) {
    return element?.getBoundingClientRect?.() || null;
  }

  function roundRect(rect) {
    return {
      x: Math.round(rect?.x || 0),
      y: Math.round(rect?.y || 0),
      width: Math.round(rect?.width || 0),
      height: Math.round(rect?.height || 0),
    };
  }

  function isHidden(element, env = {}) {
    if (!element) {
      return true;
    }
    if (element.getAttribute?.('aria-hidden') === 'true') {
      return true;
    }
    if (element.hasAttribute?.('hidden') || element.hidden === true) {
      return true;
    }
    if (String(element.getAttribute?.('type') || element.type || '').toLowerCase() === 'hidden') {
      return true;
    }
    if (element.inert === true) {
      return true;
    }
    const styleFn = env.getComputedStyle || globalThis.getComputedStyle;
    if (typeof styleFn === 'function') {
      try {
        const style = styleFn(element);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
          return true;
        }
      } catch {
        // Some test doubles do not implement computed style.
      }
    }
    return false;
  }

  // Takes an already measured rect. A null rect means the element could not be measured at
  // all, which keeps the node rather than dropping it.
  function hasBox(rect) {
    if (!rect) {
      return true;
    }
    return (rect.width || 0) > 0 && (rect.height || 0) > 0;
  }

  function childElements(element) {
    if (!element) {
      return [];
    }
    if (element.children && typeof element.children.length === 'number') {
      return [...element.children];
    }
    return [];
  }

  function insideSectionContext(tag, previous = {}) {
    const normalized = String(tag || '').toLowerCase();
    if (['article', 'section', 'aside', 'main', 'nav'].includes(normalized)) {
      return true;
    }
    return Boolean(previous.insideSection);
  }

  function scoreFindMatch(node, query) {
    const q = normalize(query).toLowerCase();
    if (!q) {
      return 0;
    }
    const name = normalize(node?.name).toLowerCase().slice(0, FIND_NAME_MAX);
    const role = normalize(node?.role).toLowerCase();
    // Walked nodes carry neither text nor description, so this term is empty for every node
    // rankFindMatches receives from walkAxTree, and it was empty before the unread `text`
    // field was deleted too. Ranking rides on name, role, and tag by decision, not accident:
    // computeAccessibleName already falls back to inner text, so any element without an
    // aria-label, aria-labelledby, associated label, or alt has its inner text in `name`.
    // The term stays here because callers may hand rankFindMatches nodes from another source.
    const text = normalize(node?.text || node?.description || '').toLowerCase();
    const tag = normalize(node?.tag).toLowerCase();
    let score = 0;
    if (name === q) {
      score += 100;
    } else if (name.startsWith(q)) {
      score += 80;
    } else if (name.includes(q)) {
      score += 60;
    }
    if (role === q) {
      score += 50;
    } else if (role.includes(q)) {
      score += 40;
    }
    if (text === q) {
      score += 35;
    } else if (text.includes(q)) {
      score += 25;
    }
    if (tag === q) {
      score += 15;
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      const hay = `${name} ${role} ${text} ${tag}`;
      const hits = tokens.filter((token) => hay.includes(token)).length;
      score += (hits / tokens.length) * 20;
      if (hits === tokens.length) {
        score += 15;
      }
    }
    // A node whose subtree text runs past CONTAINER_TEXT_MAX contains the query,
    // it is not the thing the caller asked for.
    const subtreeTextLength = Number(node?.nameLength) || name.length;
    if (subtreeTextLength > CONTAINER_TEXT_MAX && !isInteractiveRole(role, tag, {})) {
      score -= CONTAINER_PENALTY;
    }
    return score;
  }

  function rankFindMatches(nodes, query, limit) {
    const capped = clampFindLimit(limit);
    return (Array.isArray(nodes) ? nodes : [])
      .map((node, index) => ({
        ref: node.ref,
        role: node.role || '',
        name: String(node.name || '').slice(0, FIND_NAME_MAX),
        score: scoreFindMatch(node, query),
        rect: node.rect || { x: 0, y: 0, width: 0, height: 0 },
        index,
      }))
      .filter((entry) => entry.score > 0 && entry.ref)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, capped)
      .map(({ index: _index, ...entry }) => entry);
  }

  function createRefStore() {
    return {
      domVersion: 0,
      nextIndex: 0,
      byRef: new Map(),
      byElement: new WeakMap(),
    };
  }

  const sharedRefStore = createRefStore();

  function getSharedRefStore() {
    return sharedRefStore;
  }

  function expireRefStore(store = sharedRefStore, nextDomVersion = 0) {
    store.byRef.clear();
    store.byElement = new WeakMap();
    store.nextIndex = 0;
    store.domVersion = nextDomVersion;
    return store;
  }

  function assignElementRef(store, element, domVersion) {
    if (!element) {
      return '';
    }
    const version = Number.isInteger(domVersion) ? domVersion : 0;
    if (store.domVersion !== version) {
      expireRefStore(store, version);
    }
    const existing = store.byElement.get(element);
    if (existing && store.byRef.get(existing) === element) {
      return existing;
    }
    const ref = `cic:${version}:${store.nextIndex}`;
    store.nextIndex += 1;
    store.byRef.set(ref, element);
    store.byElement.set(element, ref);
    return ref;
  }

  function resolveElementRef(store, ref, currentDomVersion) {
    const raw = String(ref || '').trim();
    const match = /^cic:(\d+):(\d+)$/.exec(raw);
    if (!match) {
      return { __error: 'Invalid element ref. Run browser_read_page or browser_read_interactive again.' };
    }
    const refDomVersion = Number(match[1]);
    if (Number.isInteger(currentDomVersion) && refDomVersion !== currentDomVersion) {
      return {
        __error: 'Stale element ref. Run browser_read_page or browser_read_interactive again.',
        code: 'stale_interactive_ref',
      };
    }
    if (store.domVersion !== refDomVersion) {
      return {
        __error: 'Stale element ref. Run browser_read_page or browser_read_interactive again.',
        code: 'stale_interactive_ref',
      };
    }
    const element = store.byRef.get(raw);
    if (!element || element.isConnected === false) {
      return {
        __error: 'Element ref no longer resolves. Run browser_read_page or browser_read_interactive again.',
        code: 'stale_interactive_ref',
      };
    }
    return { element, ref: raw };
  }

  function walkAxTree(root, options = {}, env = {}) {
    // An array root is how browser_find scopes by selector: every element the
    // selector matched is a root, and their subtrees are searched as one walk
    // under one node budget.
    const roots = (Array.isArray(root) ? root : [root]).filter(Boolean);
    const filter = ['all', 'interactive', 'landmarks', 'find'].includes(options.filter) ? options.filter : 'interactive';
    const withNameLength = options.withNameLength === true;
    const maxNodes = clampMaxNodes(options.maxNodes);
    const documentRef = env.document || roots[0]?.ownerDocument || globalThis.document;
    const store = env.refStore || sharedRefStore;
    const domVersion = Number.isInteger(env.domVersion) ? env.domVersion : store.domVersion || 0;
    const labelForMap = buildLabelForMap(documentRef);
    const nodes = [];
    let truncated = false;
    // maxNodes bounds the output, not the work. A page where nothing matches the
    // filter never reaches that ceiling, so the walk used to cost one
    // getComputedStyle per element in the whole document with no limit at all,
    // on the page's own main thread. The visit budget puts a ceiling on the
    // traversal itself and reports the stop as a truncation.
    const maxVisits = Math.max(MIN_VISIT_BUDGET, maxNodes * VISIT_BUDGET_FACTOR);
    let visits = 0;
    // Selector roots can nest inside each other, so an element reached from two
    // roots must not be walked, counted, or reported twice.
    const seen = new Set();

    const visit = (element, parentAx, context, depth = 0) => {
      if (!element || seen.has(element)) {
        return;
      }
      seen.add(element);
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      // A deeply nested page used to blow the JavaScript stack, and the
      // RangeError took out every read tool for that tab with a message naming
      // neither the page nor the cause. Stopping the descent degrades to a
      // truncated read instead, which is what maxNodes already does for width.
      if (depth > MAX_WALK_DEPTH) {
        truncated = true;
        return;
      }
      visits += 1;
      if (visits > maxVisits) {
        truncated = true;
        return;
      }
      const tag = String(element.tagName || '').toLowerCase();
      if (!tag || SKIP_TAGS.has(tag) || isHidden(element, env)) {
        return;
      }
      const attrs = attrMap(element);
      const role = implicitRole(tag, attrs, context);
      // The `all` filter falls back to the accessible name to decide inclusion, so that name
      // has to exist before shouldIncludeAxNode runs. The interactive and landmark filters
      // decide on role, tag, and attributes alone, so they compute the name only for nodes
      // they keep. Everything else an included node reports, value, checked, disabled, and
      // the rect, is computed inside the include branch for the same reason.
      const nameDecidesInclusion = filter === 'all' || filter === 'find';
      let nameLength = 0;
      let name = '';
      if (nameDecidesInclusion) {
        const parts = computeAccessibleNameParts(element, documentRef, labelForMap);
        name = parts.name;
        nameLength = parts.nameLength;
      }
      let include = shouldIncludeAxNode({ tag, role, name, nameLength, attrs }, filter);
      let measuredRect = null;
      let rectMeasured = false;
      if (include && filter === 'interactive') {
        measuredRect = measureElementRect(element);
        rectMeasured = true;
        if (!hasBox(measuredRect) && !isLandmarkRole(role)) {
          include = false;
        }
      }
      let axNode = null;
      if (include && nodes.length < maxNodes) {
        if (!nameDecidesInclusion) {
          const parts = computeAccessibleNameParts(element, documentRef, labelForMap);
          name = parts.name;
          nameLength = parts.nameLength;
        }
        if (!rectMeasured) {
          measuredRect = measureElementRect(element);
        }
        const ref = assignElementRef(store, element, domVersion);
        axNode = {
          ref,
          role,
          name,
          value: elementValue(element),
          checked: elementChecked(element, role),
          disabled: elementDisabled(element),
          rect: roundRect(measuredRect),
          tag,
          // Find-only. browser_read_page's output must not grow, so the length
          // signal ranking needs rides along only when the caller asked for it.
          ...(withNameLength ? { nameLength } : {}),
          childrenRefs: [],
        };
        nodes.push(axNode);
        if (parentAx) {
          parentAx.childrenRefs.push(ref);
        }
      } else if (include) {
        truncated = true;
      }
      const nextParent = axNode || parentAx;
      const nextContext = {
        insideSection: insideSectionContext(tag, context),
      };
      for (const child of childElements(element)) {
        if (nodes.length >= maxNodes) {
          truncated = true;
          break;
        }
        if (visits > maxVisits) {
          truncated = true;
          break;
        }
        visit(child, nextParent, nextContext, depth + 1);
      }
    };

    for (const entry of roots) {
      visit(entry, null, { insideSection: false }, 0);
    }
    return {
      nodes,
      filter,
      maxNodes,
      truncated,
      domVersion,
    };
  }

  function findAxNodes(root, options = {}, env = {}) {
    const walked = walkAxTree(root, {
      filter: options.filter || 'find',
      maxNodes: options.maxNodes || ABSOLUTE_MAX_NODES,
      withNameLength: true,
    }, env);
    return {
      ...walked,
      query: String(options.query || ''),
      matches: rankFindMatches(walked.nodes, options.query, options.limit),
    };
  }

  function isCheckable(element) {
    const type = String(element?.type || element?.getAttribute?.('type') || '').toLowerCase();
    const role = String(element?.getAttribute?.('role') || '').toLowerCase();
    return type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch';
  }

  function isSelectElement(element) {
    return String(element?.tagName || '').toLowerCase() === 'select'
      || (typeof HTMLSelectElement === 'function' && element instanceof HTMLSelectElement);
  }

  function isTextLike(element) {
    if (element?.isContentEditable) {
      return true;
    }
    const tag = String(element?.tagName || '').toLowerCase();
    if (tag === 'textarea') {
      return true;
    }
    if (tag === 'input' && !isCheckable(element)) {
      return true;
    }
    return typeof HTMLInputElement === 'function' && element instanceof HTMLInputElement && !isCheckable(element);
  }

  function setNativeValue(element, value) {
    const ctors = [];
    if (typeof HTMLInputElement === 'function') {
      ctors.push(HTMLInputElement);
    }
    if (typeof HTMLTextAreaElement === 'function') {
      ctors.push(HTMLTextAreaElement);
    }
    if (typeof HTMLSelectElement === 'function') {
      ctors.push(HTMLSelectElement);
    }
    for (const Ctor of ctors) {
      if (element instanceof Ctor) {
        const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'value');
        if (descriptor?.set) {
          descriptor.set.call(element, value);
          return;
        }
      }
    }
    element.value = value;
  }

  function setNativeChecked(element, checked) {
    if (typeof HTMLInputElement === 'function' && element instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (descriptor?.set) {
        descriptor.set.call(element, Boolean(checked));
        return;
      }
    }
    element.checked = Boolean(checked);
  }

  function dispatchInputChange(element, env = {}) {
    const EventCtor = env.Event || globalThis.Event;
    element.dispatchEvent(new EventCtor('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new EventCtor('change', { bubbles: true, cancelable: true }));
  }

  function selectByValueOrLabel(element, value) {
    const wanted = String(value);
    const options = [...(element.options || [])];
    const match = options.find((option) => (
      option.value === wanted || option.text === wanted || option.label === wanted
    ));
    if (!match) {
      return { __error: 'No matching select option for the provided value.' };
    }
    if (element.multiple) {
      for (const option of options) {
        option.selected = option === match;
      }
    } else if (typeof element.selectedIndex === 'number') {
      element.selectedIndex = options.indexOf(match);
    }
    setNativeValue(element, match.value);
    return { selected: match.value };
  }

  function applyFormInput(element, params = {}, env = {}) {
    if (!element) {
      return { __error: 'Form field was not found.' };
    }
    const hasValue = Object.prototype.hasOwnProperty.call(params, 'value') && params.value !== undefined;
    const hasChecked = Object.prototype.hasOwnProperty.call(params, 'checked') && typeof params.checked === 'boolean';
    if (!hasValue && !hasChecked) {
      return { __error: 'browser_form_input requires value or checked.' };
    }

    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    if (typeof element.focus === 'function') {
      element.focus();
    }

    if (isCheckable(element)) {
      if (!hasChecked) {
        return { __error: 'Checkbox or radio fields require checked.' };
      }
      const desired = params.checked === true;
      if (element.checked !== desired && typeof element.click === 'function') {
        element.click();
      }
      if (element.checked !== desired) {
        setNativeChecked(element, desired);
        if (typeof element.click === 'function' && element.checked !== desired) {
          element.click();
        }
      }
      if (element.checked !== desired) {
        setNativeChecked(element, desired);
      }
      dispatchInputChange(element, env);
      return {
        filled: true,
        kind: String(element.type || element.getAttribute?.('type') || 'checkbox').toLowerCase() === 'radio' ? 'radio' : 'checkbox',
        checked: Boolean(element.checked),
      };
    }

    if (isSelectElement(element)) {
      if (!hasValue) {
        return { __error: 'Select fields require value.' };
      }
      const selected = selectByValueOrLabel(element, params.value);
      if (selected.__error) {
        return selected;
      }
      dispatchInputChange(element, env);
      return {
        filled: true,
        kind: 'select',
        value: selected.selected,
        selected: selected.selected,
      };
    }

    if (element.isContentEditable) {
      if (!hasValue) {
        return { __error: 'Contenteditable fields require value.' };
      }
      element.textContent = String(params.value);
      dispatchInputChange(element, env);
      return {
        filled: true,
        kind: 'contenteditable',
        value: String(element.textContent || ''),
      };
    }

    if (isTextLike(element) || typeof element.value === 'string') {
      if (!hasValue) {
        return { __error: 'Text fields require value.' };
      }
      setNativeValue(element, String(params.value));
      dispatchInputChange(element, env);
      return {
        filled: true,
        kind: 'text',
        value: String(element.value ?? ''),
      };
    }

    return { __error: 'Element is not a form field or contenteditable editor.' };
  }

  const api = {
    version: AX_TREE_VERSION,
    DEFAULT_MAX_NODES,
    ABSOLUTE_MAX_NODES,
    DEFAULT_FIND_LIMIT,
    INTERACTIVE_ROLES,
    LANDMARK_ROLES,
    normalize,
    clampMaxNodes,
    clampFindLimit,
    implicitRole,
    isInteractiveRole,
    isLandmarkRole,
    shouldIncludeAxNode,
    accessibleName,
    computeAccessibleName,
    scoreFindMatch,
    rankFindMatches,
    createRefStore,
    getSharedRefStore,
    expireRefStore,
    assignElementRef,
    resolveElementRef,
    walkAxTree,
    findAxNodes,
    applyFormInput,
    setNativeValue,
    setNativeChecked,
  };

  globalThis.UmbraAxTree = api;
  return api;
})();
