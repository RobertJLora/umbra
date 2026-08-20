(() => {
  const DEFAULT_MAX_NODES = 200;
  const ABSOLUTE_MAX_NODES = 500;
  const DEFAULT_FIND_LIMIT = 10;

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

  function clampMaxNodes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_MAX_NODES;
    }
    return Math.min(Math.floor(parsed), ABSOLUTE_MAX_NODES);
  }

  function clampFindLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_FIND_LIMIT;
    }
    return Math.min(Math.floor(parsed), ABSOLUTE_MAX_NODES);
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

  function labelText(element, documentRef) {
    if (element.id && documentRef?.querySelector) {
      const explicit = documentRef.querySelector(`label[for="${cssEscape(element.id)}"]`);
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

  function computeAccessibleName(element, documentRef) {
    return accessibleName({
      ariaLabel: element.getAttribute?.('aria-label') || '',
      labelledByText: labelledByText(element, documentRef),
      labelText: labelText(element, documentRef),
      alt: element.getAttribute?.('alt') || '',
      text: element.innerText || element.textContent || '',
      title: element.getAttribute?.('title') || '',
      placeholder: element.getAttribute?.('placeholder') || '',
      value: element.value || '',
    }).slice(0, 500);
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

  function elementRect(element) {
    const rect = element?.getBoundingClientRect?.() || {};
    return {
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0),
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

  function hasBox(element) {
    const rect = element?.getBoundingClientRect?.();
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
    const name = normalize(node?.name).toLowerCase();
    const role = normalize(node?.role).toLowerCase();
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
    return score;
  }

  function rankFindMatches(nodes, query, limit) {
    const capped = clampFindLimit(limit);
    return (Array.isArray(nodes) ? nodes : [])
      .map((node, index) => ({
        ref: node.ref,
        role: node.role || '',
        name: node.name || '',
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
    const filter = ['all', 'interactive', 'landmarks'].includes(options.filter) ? options.filter : 'interactive';
    const maxNodes = clampMaxNodes(options.maxNodes);
    const documentRef = env.document || root?.ownerDocument || globalThis.document;
    const store = env.refStore || sharedRefStore;
    const domVersion = Number.isInteger(env.domVersion) ? env.domVersion : store.domVersion || 0;
    const nodes = [];
    let truncated = false;

    const visit = (element, parentAx, context) => {
      if (!element || nodes.length >= maxNodes) {
        if (element && nodes.length >= maxNodes) {
          truncated = true;
        }
        return;
      }
      const tag = String(element.tagName || '').toLowerCase();
      if (!tag || SKIP_TAGS.has(tag) || isHidden(element, env)) {
        return;
      }
      const attrs = attrMap(element);
      const role = implicitRole(tag, attrs, context);
      const name = computeAccessibleName(element, documentRef);
      const candidate = {
        tag,
        role,
        name,
        attrs,
        value: elementValue(element),
        checked: elementChecked(element, role),
        disabled: elementDisabled(element),
        rect: elementRect(element),
        text: normalize(element.innerText || element.textContent || '').slice(0, 500),
      };
      const include = shouldIncludeAxNode(candidate, filter)
        && (filter !== 'interactive' || hasBox(element) || isLandmarkRole(role));
      let axNode = null;
      if (include && nodes.length < maxNodes) {
        const ref = assignElementRef(store, element, domVersion);
        axNode = {
          ref,
          role,
          name,
          value: candidate.value,
          checked: candidate.checked,
          disabled: candidate.disabled,
          rect: candidate.rect,
          tag,
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
        visit(child, nextParent, nextContext);
      }
    };

    visit(root, null, { insideSection: false });
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
      filter: options.filter || 'all',
      maxNodes: options.maxNodes || ABSOLUTE_MAX_NODES,
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
