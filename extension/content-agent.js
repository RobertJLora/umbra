(() => {
  const AGENT_KEY = '__umbraContentAgent';
  const CONSOLE_STORE_KEY = '__umbraConsole';
  const VERSION = '0.1.0';
  const DOM_VERSION_THROTTLE_MS = 250;
  const IDLE_DISCONNECT_MS = 45_000;
  const CONSOLE_CAP = 200;
  // Ceiling for a caller-supplied maxChars, and the value used when a caller
  // supplies none. Zero used to mean unbounded, which let one runaway page
  // buffer a single unbounded line in the broker. Keep this number in step
  // with readPageContent in extension/background.js and with the maxChars
  // description in mcp-server/tools.js.
  const MAX_CHARS_LIMIT = 500_000;
  const DEFAULT_MAX_CHARS = 500_000;

  const existing = globalThis[AGENT_KEY];
  if (existing?.connected && existing?.announce) {
    existing.announce();
    return;
  }

  const getAxTreeApi = () => globalThis.UmbraAxTree || null;

  // domVersion is the only staleness signal a ref carries, and it used to be a
  // per-agent counter that restarted at zero. After the 45-second idle
  // disconnect the agent re-injects onto a page whose UmbraAxTree ref store
  // survived, so a ref an earlier agent issued at version 0 resolved against a
  // brand-new version 0 and pointed at a different element. Seeding past the
  // surviving store's version makes every re-injection a new namespace, so an
  // old ref fails as stale instead of silently resolving.
  function seedDomVersion() {
    const store = getAxTreeApi()?.getSharedRefStore?.();
    const previous = Number(store?.domVersion);
    return Number.isInteger(previous) && previous >= 0 ? previous + 1 : 0;
  }

  const state = {
    connected: true,
    activeRequests: 0,
    domVersion: seedDomVersion(),
    domVersionTimer: null,
    idleTimer: null,
    lastDomVersionAt: 0,
    lastHref: typeof location === 'object' ? location.href : '',
    observer: null,
    port: null,
    announce: null,
  };

  function expireSharedRefs(nextDomVersion = state.domVersion) {
    const ax = getAxTreeApi();
    if (ax?.expireRefStore && ax.getSharedRefStore) {
      ax.expireRefStore(ax.getSharedRefStore(), nextDomVersion);
    }
  }

  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const cssEscape = (value) => {
    if (globalThis.CSS?.escape) {
      return globalThis.CSS.escape(value);
    }
    return String(value || '').replace(/["\\]/g, '\\$&');
  };
  const absoluteUrl = (value) => {
    try {
      return value ? new URL(value, location.href).href : '';
    } catch {
      return value || '';
    }
  };
  const truncate = (value, maxChars) => {
    const text = String(value || '');
    if (!maxChars || text.length <= maxChars) {
      return {
        value: text,
        truncated: false,
        originalLength: text.length,
      };
    }
    return {
      value: text.slice(0, maxChars),
      truncated: true,
      originalLength: text.length,
    };
  };
  const isVisible = (element, minimum = 1) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    return [...element.getClientRects()].some((rect) => rect.width >= minimum && rect.height >= minimum);
  };

  const CURSOR_HOST_TAG = 'UMBRA-CURSOR-LAYER';

  function isCursorHostNode(node) {
    return node?.nodeType === 1 && node.tagName === CURSOR_HOST_TAG;
  }

  function isCursorHostOnly(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return false;
    }
    for (const record of records) {
      if (record.type !== 'childList') {
        return false;
      }
      const touched = [...(record.addedNodes || []), ...(record.removedNodes || [])];
      if (touched.length === 0 || !touched.every(isCursorHostNode)) {
        return false;
      }
    }
    return true;
  }

  function markDomChanged() {
    const href = typeof location === 'object' ? location.href : state.lastHref;
    if (href !== state.lastHref) {
      state.lastHref = href;
      state.domVersion += 1;
      state.lastDomVersionAt = Date.now();
      expireSharedRefs(state.domVersion);
      return;
    }
    const now = Date.now();
    if (now - state.lastDomVersionAt >= DOM_VERSION_THROTTLE_MS) {
      state.domVersion += 1;
      state.lastDomVersionAt = now;
      return;
    }
    if (!state.domVersionTimer) {
      state.domVersionTimer = setTimeout(() => {
        state.domVersion += 1;
        state.lastDomVersionAt = Date.now();
        state.domVersionTimer = null;
      }, DOM_VERSION_THROTTLE_MS);
    }
  }

  function startDomObserver() {
    if (state.observer || !(document.documentElement || document)) {
      return;
    }
    state.observer = new MutationObserver((records) => {
      // The agent's own furniture is not a page change. On the normal path the
      // cursor host goes in before this observer starts, but a page driven only
      // by coordinate calls or page recipes brings the agent up first and the
      // overlay later, and that one appendChild used to bump domVersion and
      // expire every outstanding element ref. A record that only added or
      // removed the cursor host is ignored; anything else in the same batch
      // still counts.
      if (isCursorHostOnly(records)) {
        return;
      }
      markDomChanged();
    });
    state.observer.observe(document.documentElement || document, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    if (!state.navListenersBound && typeof window !== 'undefined') {
      const expireOnNavigation = () => {
        state.lastHref = location.href;
        state.domVersion += 1;
        state.lastDomVersionAt = Date.now();
        expireSharedRefs(state.domVersion);
      };
      window.addEventListener('pagehide', expireOnNavigation);
      window.addEventListener('pageshow', expireOnNavigation);
      window.addEventListener('popstate', expireOnNavigation);
      window.addEventListener('hashchange', expireOnNavigation);
      state.navListenersBound = true;
    }
  }

  function stopDomObserver() {
    state.observer?.disconnect();
    state.observer = null;
    clearTimeout(state.domVersionTimer);
    state.domVersionTimer = null;
  }

  function scheduleIdleDisconnect() {
    clearTimeout(state.idleTimer);
    if (state.activeRequests > 0) {
      return;
    }
    state.idleTimer = setTimeout(() => {
      if (state.activeRequests > 0) {
        return;
      }
      stopDomObserver();
      state.connected = false;
      try {
        state.port?.disconnect();
      } catch {
        // Already disconnected.
      }
    }, IDLE_DISCONNECT_MS);
  }

  async function withActiveRequest(callback) {
    clearTimeout(state.idleTimer);
    state.activeRequests += 1;
    startDomObserver();
    try {
      return await callback();
    } finally {
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      scheduleIdleDisconnect();
    }
  }

  function collectRenderedImages(root, includeImages) {
    if (!includeImages) {
      return [];
    }
    const queryRoot = root === document.documentElement ? document : root;
    return [...queryRoot.querySelectorAll('img')]
      .filter((image) => isVisible(image, 8))
      .map((image, index) => {
        const rect = image.getBoundingClientRect();
        const src = image.currentSrc || image.getAttribute('src') || '';
        const srcset = image.getAttribute('srcset') || '';
        const label =
          image.getAttribute('alt') ||
          image.getAttribute('aria-label') ||
          image.closest('[aria-label]')?.getAttribute('aria-label') ||
          '';
        const container = image.closest('article,[data-message-author-role],main,section,figure,div') || image.parentElement;
        return {
          index,
          src: absoluteUrl(src),
          srcset: srcset.slice(0, 500),
          alt: label,
          title: image.getAttribute('title') || '',
          naturalWidth: image.naturalWidth || null,
          naturalHeight: image.naturalHeight || null,
          renderedWidth: Math.round(rect.width),
          renderedHeight: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          loading: image.getAttribute('loading') || '',
          nearestText: normalize(container?.innerText || '').slice(0, 240),
        };
      });
  }

  function formatRenderedImageSummary(images) {
    if (!images.length) {
      return '';
    }
    const rows = images.slice(0, 20).map((image, index) => {
      const dimensions = `${image.naturalWidth || '?'}x${image.naturalHeight || '?'} natural, ${image.renderedWidth || '?'}x${image.renderedHeight || '?'} rendered`;
      const alt = image.alt ? ` alt="${image.alt.slice(0, 120)}"` : '';
      const src = image.src ? ` src="${image.src.slice(0, 220)}"` : image.srcset ? ` srcset="${image.srcset.slice(0, 220)}"` : '';
      const nearby = image.nearestText ? ` nearby="${image.nearestText.slice(0, 160)}"` : '';
      return `${index + 1}. ${dimensions}${alt}${src}${nearby}`;
    });
    return `Rendered images (${images.length} visible):\n${rows.join('\n')}`;
  }

  // Subtrees that are furniture on every article page. They are excluded from
  // the returned text, not removed from the page: nothing here mutates the DOM.
  const ARTICLE_STRIP_SELECTOR = 'script, style, nav, aside, footer, header, form, noscript, [aria-hidden="true"]';
  const ARTICLE_NOISE_RE = /nav|menu|sidebar|footer|header|comment|share|promo|related|breadcrumb/i;
  // Markup that names a body outright. Density alone let Wikipedia's whole Vector
  // shell win over the body it wraps, and these are the hooks that separate them.
  const ARTICLE_BODY_SELECTOR = '[itemprop="articleBody"], .mw-parser-output, #mw-content-text, #bodyContent, article, main article';

  function describeArticleRoot(element) {
    if (!element || !element.tagName) {
      return '';
    }
    const tag = element.tagName.toLowerCase();
    if (element.id) {
      return `${tag}#${element.id}`;
    }
    const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
    return className ? `${tag}.${className}` : tag;
  }

  // Density scoring in the shape Readability uses: the best candidate is the one
  // with the most text that is not link text, nudged for the markup that names an
  // article body and away from the class and id names boilerplate wears.
  function extractArticleText(root) {
    const scope = root || document.body || document.documentElement;
    const candidates = [...scope.querySelectorAll('p, div, section, article, td')];
    if (typeof scope.matches === 'function' && scope.matches('p, div, section, article, td')) {
      candidates.push(scope);
    }

    // Memoized, because the ancestor walk below re-scores up to six parents and
    // each of those re-reads its whole subtree. Without it a long article paid
    // for the same text several times over on the page's own main thread.
    const scoreCache = new WeakMap();
    const scoreOf = (node) => {
      const cached = scoreCache.get(node);
      if (cached !== undefined) {
        return cached;
      }
      const score = computeScore(node);
      scoreCache.set(node, score);
      return score;
    };

    const computeScore = (node) => {
      // textContent, not innerText. innerText forces a layout flush on every
      // candidate, and there is one candidate per p, div, section, article and
      // td in the document. The cheap read decides whether this node is even
      // worth measuring; only the ones that clear the floor cost anything more.
      const textLength = (node.textContent || '').trim().length;
      if (textLength < 100) {
        return 0;
      }
      let linkTextLength = 0;
      for (const link of node.querySelectorAll('a')) {
        linkTextLength += (link.textContent || '').trim().length;
      }
      const linkDensity = Math.min(1, linkTextLength / Math.max(1, textLength));
      // The spec's flat penalty is the second term. On its own it moves a score
      // by at most 40 points, which never separates a link list from prose once
      // a candidate runs past a few hundred characters, so the proportional term
      // carries the decision and the flat one breaks ties.
      let score = (textLength * (1 - linkDensity)) - ((40 * linkTextLength) / Math.max(1, textLength));
      const tag = node.tagName.toLowerCase();
      const namedBody = tag === 'article'
        || node.getAttribute('itemprop') === 'articleBody'
        || (typeof node.matches === 'function' && node.matches(ARTICLE_BODY_SELECTOR));
      if (namedBody) {
        score *= 1.35;
      }
      const label = `${node.className && typeof node.className === 'string' ? node.className : ''} ${node.id || ''}`;
      if (ARTICLE_NOISE_RE.test(label)) {
        score *= 0.4;
      }
      return score;
    };

    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = scoreOf(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) {
      best = scope;
      bestScore = scoreOf(scope);
    }

    // A byline, a lede image and the body are often siblings under a wrapper the
    // per-node pass scores just below the body itself. Walking up while the
    // parent still scores at least 90 percent of the child recovers them without
    // swallowing the page chrome, which scores far lower.
    let node = best;
    for (let depth = 0; depth < 6; depth += 1) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) {
        break;
      }
      if (scoreOf(parent) < bestScore * 0.9) {
        break;
      }
      // A parent carrying far more text than the child is a page shell, not the
      // wrapper around a byline and a lede image. Wikipedia's div.mw-page-container
      // cleared the 90 percent score rule on link density alone and still brought
      // the whole navigation, header and footer with it.
      const parentLength = (parent.textContent || '').trim().length;
      const nodeLength = (node.textContent || '').trim().length;
      if (nodeLength > 0 && parentLength > nodeLength * 1.6) {
        break;
      }
      node = parent;
    }

    // The same guard ax-tree.js added after a deeply nested page threw RangeError
    // out of every read tool. An uncapped recursion here is the identical hazard.
    const MAX_READ_DEPTH = 1_000;
    const readBlock = (element, depth = 0) => {
      if (depth > MAX_READ_DEPTH) {
        return element.textContent || '';
      }
      if (element.matches(ARTICLE_STRIP_SELECTOR)) {
        return '';
      }
      if (!element.querySelector(ARTICLE_STRIP_SELECTOR)) {
        return element.innerText || element.textContent || '';
      }
      let out = '';
      for (const child of element.childNodes) {
        if (child.nodeType === 3) {
          out += child.textContent;
          continue;
        }
        if (child.nodeType !== 1) {
          continue;
        }
        const part = readBlock(child, depth + 1);
        if (!part) {
          continue;
        }
        out += out && !out.endsWith('\n') ? `\n${part}` : part;
      }
      return out;
    };

    const heading = document.querySelector('h1');
    return {
      root: node,
      selector: describeArticleRoot(node),
      title: normalize(heading?.innerText || heading?.textContent || document.title || ''),
      text: readBlock(node).replace(/\n{3,}/g, '\n\n').trim(),
    };
  }

  function readPageContent(options = {}) {
    const config = typeof options === 'string' ? { format: options } : options || {};
    const format = config.format === 'html' ? 'html' : 'text';
    const selector = typeof config.selector === 'string' ? config.selector.trim() : '';
    const requestedMode = String(config.mode || '').trim();
    const mode = selector
      ? 'selector'
      : ['page', 'body', 'main', 'selector', 'article'].includes(requestedMode)
        ? requestedMode
        : 'page';
    const includeImages = config.includeImages === true;
    const rawMaxChars = Number(config.maxChars);
    // Floored at one character. A fractional value used to survive the `> 0`
    // test and then floor to zero, and truncate() reads zero as unbounded, which
    // is exactly the unbounded line this limit exists to prevent.
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1
      ? Math.min(Math.floor(rawMaxChars), MAX_CHARS_LIMIT)
      : DEFAULT_MAX_CHARS;

    let article = null;
    const resolveRoot = () => {
      if (selector) {
        return document.querySelector(selector);
      }
      if (mode === 'body') {
        return document.body || document.documentElement;
      }
      if (mode === 'main') {
        return document.querySelector('main, article, [role="main"]') || document.body || document.documentElement;
      }
      if (mode === 'article') {
        article = extractArticleText(document.body || document.documentElement);
        return article.root || document.body || document.documentElement;
      }
      return document.documentElement;
    };

    const root = resolveRoot();
    if (!root) {
      throw new Error(`Selector not found: ${selector}`);
    }

    const renderedImages = collectRenderedImages(root, includeImages);
    const renderedImageSummary = formatRenderedImageSummary(renderedImages);
    const base = {
      title: document.title,
      url: location.href,
      format,
      mode,
      selector,
      maxChars,
      includeImages,
      renderedImages,
      // Article mode names the node it picked, so a caller that disagrees can
      // rerun with that selector instead of guessing why the text is short.
      ...(article ? { articleTitle: article.title, articleRootSelector: article.selector } : {}),
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };

    if (format === 'html') {
      const rawHtml = root === document.documentElement ? document.documentElement.outerHTML : root.outerHTML || '';
      // The cursor overlay leaves one empty custom element on the page. Its
      // shadow content is not serialized, so the whole of it in raw HTML is this
      // one deterministic tag pair, and a caller reading markup should not have
      // to know the agent's own furniture is in it.
      const stripped = globalThis.UmbraCursor && rawHtml.includes('<umbra-cursor-layer')
        ? rawHtml.replace(/<umbra-cursor-layer\b[^>]*><\/umbra-cursor-layer>/g, '')
        : rawHtml;
      const html = truncate(stripped, maxChars);
      return {
        ...base,
        // The html branch never folds the image summary into content, so this
        // is the only copy of it and it is emitted only when there is one.
        ...(renderedImageSummary ? { renderedImageSummary } : {}),
        truncated: html.truncated,
        originalContentLength: html.originalLength,
        contentLength: html.value.length,
        content: html.value,
      };
    }

    const rawBodyText = article ? article.text : (root.innerText || root.textContent || '');
    // content is body text plus the rendered-image summary when one exists.
    // With no summary the two strings are identical, which is every read at
    // the default includeImages: false, so bodyText is emitted only when it
    // genuinely differs from content instead of doubling the payload.
    const rawContent = renderedImageSummary ? `${rawBodyText}\n\n${renderedImageSummary}` : rawBodyText;
    const content = truncate(rawContent, maxChars);
    const bodyText = rawContent === rawBodyText ? null : truncate(rawBodyText, maxChars);
    return {
      ...base,
      truncated: content.truncated,
      originalContentLength: content.originalLength,
      contentLength: content.value.length,
      ...(bodyText ? { bodyText: bodyText.value, bodyTextTruncated: bodyText.truncated } : {}),
      content: content.value,
    };
  }

  function interactiveSelector(options = {}) {
    const selector = String(options.selector || '').trim();
    if (selector) {
      return selector;
    }
    return [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="switch"]',
      '[aria-haspopup]',
      '[onclick]',
      'summary',
    ].join(',');
  }

  function selectorHint(element) {
    const tagName = element.tagName.toLowerCase();
    if (element.id) {
      return `${tagName}#${cssEscape(element.id)}`;
    }
    const aria = element.getAttribute('aria-label');
    if (aria) {
      return `${tagName}[aria-label="${String(aria).slice(0, 80).replace(/"/g, '\\"')}"]`;
    }
    const name = element.getAttribute('name');
    if (name) {
      return `${tagName}[name="${String(name).slice(0, 80).replace(/"/g, '\\"')}"]`;
    }
    const type = element.getAttribute('type');
    return type ? `${tagName}[type="${cssEscape(type)}"]` : tagName;
  }

  function elementRole(element) {
    return element.getAttribute('role') || element.tagName.toLowerCase();
  }

  function elementName(element) {
    const aria = normalize(element.getAttribute('aria-label') || '');
    if (aria) {
      return aria;
    }
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelText = labelledBy
        .split(/\s+/)
        .map((id) => normalize(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''))
        .filter(Boolean)
        .join(' ');
      if (labelText) {
        return labelText;
      }
    }
    if (element.id) {
      const label = document.querySelector(`label[for="${cssEscape(element.id)}"]`);
      const labelText = normalize(label?.innerText || label?.textContent || '');
      if (labelText) {
        return labelText;
      }
    }
    return normalize(element.innerText || element.textContent || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('value') || '');
  }

  function nearbyLabel(element) {
    const explicit = element.id
      ? normalize(document.querySelector(`label[for="${cssEscape(element.id)}"]`)?.innerText || '')
      : '';
    if (explicit) {
      return explicit.slice(0, 240);
    }
    const label = element.closest('label');
    if (label) {
      return normalize(label.innerText || label.textContent || '').slice(0, 240);
    }
    const container = element.closest('td,th,li,form,section,article,div') || element.parentElement;
    return normalize(container?.innerText || container?.textContent || '').slice(0, 240);
  }

  function readInteractive(options = {}) {
    const selector = interactiveSelector(options);
    const limit = Math.min(Math.max(Number(options.maxItems) || 80, 1), 300);
    const elements = [...document.querySelectorAll(selector)]
      .filter((element) => isVisible(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, limit);
    const ax = getAxTreeApi();
    const controls = elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const ref = ax?.assignElementRef
        ? ax.assignElementRef(ax.getSharedRefStore(), element, state.domVersion)
        : `cic:${state.domVersion}:${index}`;
      return {
        ref,
        index,
        tagName: element.tagName.toLowerCase(),
        role: elementRole(element),
        type: element.getAttribute('type') || '',
        name: elementName(element).slice(0, 500),
        text: normalize(element.innerText || element.textContent || '').slice(0, 500),
        value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? String(element.value || '').slice(0, 500)
          : '',
        selectorHint: selectorHint(element),
        disabled: Boolean(element.closest('[disabled], [aria-disabled="true"]')),
        hidden: false,
        contentEditable: element.isContentEditable === true,
        nearbyLabel: nearbyLabel(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
        },
      };
    });
    return {
      title: document.title,
      url: location.href,
      selector,
      count: controls.length,
      maxItems: limit,
      domVersion: state.domVersion,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      controls,
      _compactSummary: `Interactive controls: ${controls.length} on ${document.title || location.href}`,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function resolveInteractiveRef(ref, options = {}) {
    const ax = getAxTreeApi();
    if (ax?.resolveElementRef && ax.getSharedRefStore) {
      const resolved = ax.resolveElementRef(ax.getSharedRefStore(), ref, state.domVersion);
      if (!resolved.__error) {
        return { element: resolved.element, control: null, snapshot: null };
      }
      // The shared store is authoritative once it has issued refs. Falling back
      // to a positional index after it reported the ref's element gone resolved
      // the same index in a re-rendered list, so a click landed on a different
      // control and still reported clicked: true. The fallback exists for refs
      // the store never issued, which is why it stays reachable only when the
      // store has no entry for this ref at all.
      const store = ax.getSharedRefStore();
      const storeIssuedIt = Boolean(store?.byRef?.has?.(String(ref || '').trim()));
      if (storeIssuedIt || !/^cic:\d+:\d+$/.test(String(ref || '').trim())) {
        return resolved;
      }
    }
    const match = /^cic:(\d+):(\d+)$/.exec(String(ref || '').trim());
    if (!match) {
      return { __error: 'Invalid element ref. Run browser_read_page or browser_read_interactive again.' };
    }
    const refDomVersion = Number(match[1]);
    const index = Number(match[2]);
    if (refDomVersion !== state.domVersion) {
      return {
        __error: 'Stale element ref. Run browser_read_page or browser_read_interactive again.',
        code: 'stale_interactive_ref',
      };
    }
    const snapshot = readInteractive({ ...options, maxItems: Math.max(index + 1, Number(options.maxItems) || 0) });
    const control = snapshot.controls[index];
    const selector = snapshot.selector;
    const element = [...document.querySelectorAll(selector)]
      .filter((candidate) => isVisible(candidate))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })[index];
    if (!control || !element) {
      return {
        __error: 'Element ref no longer resolves. Run browser_read_page or browser_read_interactive again.',
        code: 'stale_interactive_ref',
      };
    }
    return { element, control, snapshot };
  }

  // Selecting the block under a triple click is a browser default action, and a
  // dispatched event has none: the click reported clickCount 3 and
  // getSelection() stayed empty. Rebuilt here, and only when the page made no
  // selection of its own.
  const TRIPLE_CLICK_BLOCK_SELECTOR = 'p, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, pre, figcaption';

  function selectTripleClicked(node) {
    const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
    if (!selection || String(selection).length > 0) {
      return 0;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && typeof node.select === 'function') {
      node.select();
      return String(node.value || '').length;
    }
    let block = typeof node.closest === 'function' ? node.closest(TRIPLE_CLICK_BLOCK_SELECTOR) : null;
    for (let walk = node; !block && walk && walk !== document.body; walk = walk.parentElement) {
      const display = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(walk).display : '';
      if ((display === 'block' || display === 'list-item' || display === 'table-cell')
        && (walk.textContent || '').trim().length > 0) {
        block = walk;
      }
    }
    if (!block || (block.textContent || '').trim().length === 0) {
      return 0;
    }
    const range = document.createRange();
    range.selectNodeContents(block);
    selection.removeAllRanges();
    selection.addRange(range);
    return String(selection).length;
  }

  function clickInteractiveRef(ref, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element, control } = resolved;
    if (element.closest('[disabled], [aria-disabled="true"]')) {
      return { __error: 'Interactive ref resolved to a disabled element.' };
    }
    const doubleClick = options.doubleClick === true;
    const buttonName = options.button === 'right' || options.button === 'middle' ? options.button : 'left';
    const button = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0;
    const held = button === 2 ? 2 : button === 1 ? 4 : 1;
    const modifiers = options.modifiers || {};
    const ctrlKey = modifiers.ctrl === true;
    const shiftKey = modifiers.shift === true;
    const altKey = modifiers.alt === true;
    const metaKey = modifiers.meta === true;
    const modified = ctrlKey || shiftKey || altKey || metaKey;
    const rawCount = Number(options.clickCount);
    const clickCount = Number.isFinite(rawCount) && rawCount >= 1
      ? Math.min(3, Math.floor(rawCount))
      : (doubleClick ? 2 : 1);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const init = (detail, buttons) => ({
      bubbles: true,
      cancelable: true,
      view: window,
      button,
      buttons,
      detail,
      ctrlKey,
      shiftKey,
      altKey,
      metaKey,
    });
    const fireClick = (detail) => {
      element.dispatchEvent(new MouseEvent('mouseover', init(0, held)));
      element.dispatchEvent(new MouseEvent('mousedown', init(detail, held)));
      element.dispatchEvent(new MouseEvent('mouseup', init(detail, 0)));
      if (button === 2) {
        // No click on a right press. The page gets contextmenu and renders its
        // own menu if it has one.
        element.dispatchEvent(new MouseEvent('contextmenu', init(detail, 0)));
        return;
      }
      if (button === 0 && !modified) {
        // Dispatch first, then element.click(). The dispatched event is the only
        // one that carries `detail`, and a page implementing select-paragraph
        // reads click.detail === 3; returning on element.click() alone left
        // detail at 0 on every pass, so browser_click { ref, clickCount: 3 }
        // reported clickCount 3 and selected nothing. element.click() still
        // follows, because it is what runs activation behavior.
        element.dispatchEvent(new MouseEvent('click', init(detail, 0)));
        element.click();
        return;
      }
      element.dispatchEvent(new MouseEvent('click', init(detail, 0)));
      if (button === 1) {
        element.dispatchEvent(new MouseEvent('auxclick', init(detail, 0)));
      }
    };
    for (let pass = 1; pass <= clickCount; pass += 1) {
      fireClick(pass);
      if (pass === 2 && button !== 2) {
        element.dispatchEvent(new MouseEvent('dblclick', init(2, 0)));
      }
    }
    const selectedTextLength = clickCount >= 3 && button === 0 ? selectTripleClicked(element) : 0;
    return {
      clicked: true,
      doubleClick: clickCount === 2,
      clickCount,
      ...(selectedTextLength > 0 ? { selectedTextLength } : {}),
      button: buttonName,
      ref,
      tagName: control?.tagName || element.tagName.toLowerCase(),
      role: control?.role || element.getAttribute('role') || '',
      x: rect.x,
      y: rect.y,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function fillInteractiveRef(ref, value, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element } = resolved;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      element.value = value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    } else {
      return { __error: 'Interactive ref did not resolve to an input-like or contenteditable element.' };
    }
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return {
      filled: true,
      ref,
      contentEditable: element.isContentEditable,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function scrollInteractiveRef(ref, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element } = resolved;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    return {
      ref,
      scrolled: true,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function prepareFileInput(ref, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element } = resolved;
    const fileInput = element instanceof HTMLInputElement && element.type === 'file'
      ? element
      : element?.querySelector?.('input[type="file"]') || null;
    if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
      return { __error: 'Interactive ref did not resolve to an input[type=file].' };
    }
    const marker = `cic-file-${Date.now()}`;
    fileInput.setAttribute('data-cic-file-target', marker);
    fileInput.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    fileInput.focus();
    return {
      selector: `input[type="file"][data-cic-file-target="${marker}"]`,
      ref,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function hoverInteractiveRef(ref, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element } = resolved;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    return {
      hovered: true,
      ref,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function selectInteractiveRef(ref, values, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element } = resolved;
    if (!(element instanceof HTMLSelectElement)) {
      return { __error: 'Interactive ref did not resolve to a select element.' };
    }
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.focus();
    const wanted = (Array.isArray(values) ? values : []).map((value) => String(value));
    const selected = [];
    if (element.multiple) {
      for (const option of element.options) {
        const match = wanted.includes(option.value) || wanted.includes(option.text) || wanted.includes(option.label);
        option.selected = match;
        if (match) {
          selected.push(option.value);
        }
      }
    } else {
      let matchIndex = -1;
      for (const value of wanted) {
        const index = [...element.options].findIndex((option) => (
          option.value === value || option.text === value || option.label === value
        ));
        if (index >= 0) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex >= 0) {
        element.selectedIndex = matchIndex;
        selected.push(element.options[matchIndex].value);
      }
    }
    if (selected.length === 0) {
      return { __error: 'No matching select option for the provided values.' };
    }
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return {
      selected,
      ref,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  async function typeInteractiveRef(ref, text, options = {}) {
    const resolved = resolveInteractiveRef(ref, options);
    if (resolved.__error) {
      return resolved;
    }
    const { element } = resolved;
    const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
    if (!isField && !element.isContentEditable) {
      return { __error: 'Interactive ref did not resolve to an input-like or contenteditable element.' };
    }
    const value = String(text ?? '');
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.focus();
    if (isField) {
      element.value = '';
    } else {
      element.textContent = '';
    }
    for (const char of value) {
      // keyCode, which and code were all zero or empty here, so a page handler
      // that branches on event.keyCode ignored every character Umbra typed.
      const legacy = char.toUpperCase().charCodeAt(0) || 0;
      const init = {
        key: char,
        code: /[a-z]/i.test(char) ? `Key${char.toUpperCase()}` : (/[0-9]/.test(char) ? `Digit${char}` : ''),
        keyCode: legacy,
        which: legacy,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      element.dispatchEvent(new KeyboardEvent('keydown', init));
      element.dispatchEvent(new KeyboardEvent('keypress', init));
      if (isField) {
        element.value += char;
      } else {
        element.textContent = `${element.textContent || ''}${char}`;
      }
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', init));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return {
      typed: true,
      length: value.length,
      ref,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function formatConsoleArg(value) {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    const type = typeof value;
    if (type === 'string') {
      return value;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
      return String(value);
    }
    if (type === 'symbol') {
      return value.toString();
    }
    if (type === 'function') {
      return value.name ? `[function ${value.name}]` : '[function]';
    }
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  function postConsoleMessage(entry) {
    try {
      state.port?.postMessage({ type: 'console_message', ...entry });
    } catch {
      // Port may be down while the page still logs.
    }
  }

  function ensureConsoleBuffer() {
    if (globalThis[CONSOLE_STORE_KEY]?.messages) {
      globalThis[CONSOLE_STORE_KEY].post = postConsoleMessage;
      return globalThis[CONSOLE_STORE_KEY];
    }
    const store = {
      installedAt: Date.now(),
      messages: [],
      post: postConsoleMessage,
    };
    const wrap = (level, methodName) => {
      const original = console[methodName].bind(console);
      console[methodName] = (...args) => {
        try {
          const entry = {
            level,
            text: args.map(formatConsoleArg).join(' ').slice(0, 2000),
            ts: Date.now(),
          };
          store.messages.push(entry);
          if (store.messages.length > CONSOLE_CAP) {
            store.messages.splice(0, store.messages.length - CONSOLE_CAP);
          }
          store.post?.(entry);
        } catch {
          // Ignore console mirror failures.
        }
        return original(...args);
      };
    };
    wrap('error', 'error');
    wrap('warning', 'warn');
    wrap('info', 'info');
    wrap('info', 'log');
    wrap('debug', 'debug');
    globalThis[CONSOLE_STORE_KEY] = store;
    return store;
  }

  function readConsoleMessages() {
    const store = ensureConsoleBuffer();
    return {
      messages: store.messages.slice(-CONSOLE_CAP),
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function waitForSelector(selector, options = {}) {
    const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 10_000, 120_000));
    const visible = options.visible === true;
    const startedAt = Date.now();
    const isMatch = () => {
      const element = document.querySelector(selector);
      if (!element) {
        return false;
      }
      return visible ? isVisible(element) : true;
    };

    if (isMatch()) {
      return {
        selector,
        found: true,
        visible,
        strategy: 'content_agent_immediate',
        elapsedMs: Date.now() - startedAt,
        contentAgent: {
          used: true,
          version: VERSION,
          domVersion: state.domVersion,
        },
      };
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(safetyPoll);
        observer.disconnect();
        callback();
      };
      const check = () => {
        if (!isMatch()) {
          return;
        }
        finish(() => resolve({
          selector,
          found: true,
          visible,
          strategy: 'content_agent_mutation_observer',
          elapsedMs: Date.now() - startedAt,
          contentAgent: {
            used: true,
            version: VERSION,
            domVersion: state.domVersion,
          },
        }));
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Timed out waiting for selector: ${selector}`)));
      }, timeoutMs);
      const observer = new MutationObserver(check);
      const safetyPoll = setInterval(check, 1_000);

      observer.observe(document.documentElement || document, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
      });
    });
  }

  // The content agent never compiles caller-supplied code. Every browser_javascript
  // call is routed to the page world by extension/background.js, which runs the code
  // through the Chrome DevTools Protocol Runtime.evaluate. The `code` argument is kept
  // in the signature so the execute_javascript command shape stays stable, and it is
  // deliberately never evaluated here. The dynamic-function constructor this branch
  // used to reach for was unreachable in practice and is a catalogued eval-evasion
  // pattern that Chrome Web Store scanners flag on presence.
  async function executeJavascript(code, options = {}) {
    if (options.pageWorld === true) {
      return {
        pageWorld: true,
        contentAgent: {
          used: true,
          version: VERSION,
          domVersion: state.domVersion,
        },
      };
    }
    return {
      __error: 'The content agent does not run caller-supplied JavaScript. Send pageWorld: true so the page-world debugger path handles it.',
      code: 'page_world_required',
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function resolveAxRoot(selector) {
    const scope = String(selector || '').trim();
    if (scope) {
      return document.querySelector(scope);
    }
    return document.body || document.documentElement;
  }

  // browser_find treats selector as a constraint, not as a single walk root:
  // every element the selector matched is searched, along with everything inside
  // it. Walking only the first match meant `selector: "a"` searched inside the
  // page's first anchor and reported zero matches on a page of links.
  function resolveAxRoots(selector) {
    const scope = String(selector || '').trim();
    if (!scope) {
      const root = document.body || document.documentElement;
      return root ? [root] : [];
    }
    return [...document.querySelectorAll(scope)];
  }

  function readAxTree(options = {}) {
    const ax = getAxTreeApi();
    if (!ax?.walkAxTree) {
      throw new Error('AX tree helpers are not loaded.');
    }
    const selector = String(options.selector || '').trim();
    const root = resolveAxRoot(selector);
    if (!root) {
      throw new Error(selector ? `Selector not found: ${selector}` : 'Page root was not found.');
    }
    const walked = ax.walkAxTree(root, {
      filter: options.filter,
      maxNodes: options.maxNodes,
    }, {
      document,
      refStore: ax.getSharedRefStore(),
      domVersion: state.domVersion,
    });
    return {
      title: document.title,
      url: location.href,
      selector,
      filter: walked.filter,
      maxNodes: walked.maxNodes,
      truncated: walked.truncated,
      count: walked.nodes.length,
      domVersion: state.domVersion,
      nodes: walked.nodes,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function findAxNodes(options = {}) {
    const ax = getAxTreeApi();
    if (!ax?.findAxNodes) {
      throw new Error('AX tree helpers are not loaded.');
    }
    const query = String(options.query || '').trim();
    if (!query) {
      throw new Error('browser_find requires query.');
    }
    const selector = String(options.selector || '').trim();
    const roots = resolveAxRoots(selector);
    if (!roots.length) {
      throw new Error(selector ? `Selector not found: ${selector}` : 'Page root was not found.');
    }
    const found = ax.findAxNodes(roots, {
      query,
      selector,
      limit: options.limit,
    }, {
      document,
      refStore: ax.getSharedRefStore(),
      domVersion: state.domVersion,
    });
    return {
      title: document.title,
      url: location.href,
      query,
      selector,
      count: found.matches.length,
      domVersion: state.domVersion,
      matches: found.matches,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  function formInput(params = {}) {
    const ax = getAxTreeApi();
    if (!ax?.applyFormInput) {
      throw new Error('AX tree helpers are not loaded.');
    }
    const selector = String(params.selector || '').trim();
    const ref = String(params.ref || '').trim();
    let element = null;
    if (ref) {
      const resolved = resolveInteractiveRef(ref, selector ? { selector } : {});
      if (resolved.__error) {
        return resolved;
      }
      element = resolved.element;
    } else if (selector) {
      element = document.querySelector(selector);
      if (!element) {
        return { __error: `Selector not found: ${selector}` };
      }
    } else {
      return { __error: 'browser_form_input requires selector or ref.' };
    }
    const result = ax.applyFormInput(element, {
      value: params.value,
      checked: params.checked,
    });
    if (result.__error) {
      return result;
    }
    return {
      ...result,
      ref: ref || undefined,
      selector: selector || undefined,
      contentAgent: {
        used: true,
        version: VERSION,
        domVersion: state.domVersion,
      },
    };
  }

  async function handleCommand(message) {
    return await withActiveRequest(async () => {
      if (message.action === 'read_page_content') {
        return readPageContent(message.params?.options || {});
      }
      if (message.action === 'read_interactive') {
        return readInteractive(message.params?.options || {});
      }
      if (message.action === 'read_ax_tree') {
        return readAxTree(message.params?.options || {});
      }
      if (message.action === 'find_ax_nodes') {
        return findAxNodes(message.params?.options || {});
      }
      if (message.action === 'form_input') {
        return formInput(message.params || {});
      }
      if (message.action === 'click_interactive_ref') {
        return clickInteractiveRef(message.params?.ref, message.params?.options || {});
      }
      if (message.action === 'fill_interactive_ref') {
        return fillInteractiveRef(message.params?.ref, message.params?.value ?? '', message.params?.options || {});
      }
      if (message.action === 'scroll_interactive_ref') {
        return scrollInteractiveRef(message.params?.ref, message.params?.options || {});
      }
      if (message.action === 'hover_interactive_ref') {
        return hoverInteractiveRef(message.params?.ref, message.params?.options || {});
      }
      if (message.action === 'select_interactive_ref') {
        return selectInteractiveRef(message.params?.ref, message.params?.values || [], message.params?.options || {});
      }
      if (message.action === 'type_interactive_ref') {
        return await typeInteractiveRef(message.params?.ref, message.params?.text ?? '', message.params?.options || {});
      }
      if (message.action === 'prepare_file_input') {
        return prepareFileInput(message.params?.ref, message.params?.options || {});
      }
      if (message.action === 'read_console_messages') {
        return readConsoleMessages();
      }
      if (message.action === 'wait_for_selector') {
        return await waitForSelector(message.params?.selector || '', message.params?.options || {});
      }
      if (message.action === 'execute_javascript') {
        return await executeJavascript(message.params?.code, message.params || {});
      }
      throw new Error(`Unsupported content agent action: ${message.action}`);
    });
  }

  function post(message) {
    try {
      state.port?.postMessage(message);
    } catch {
      state.connected = false;
    }
  }

  state.port = chrome.runtime.connect({ name: 'cic-content-agent' });
  state.announce = () => post({
    type: 'agent_ready',
    version: VERSION,
    url: location.href,
    title: document.title,
    domVersion: state.domVersion,
  });

  state.port.onMessage.addListener((message) => {
    if (message?.type !== 'agent_command' || !message.id) {
      return;
    }
    handleCommand(message)
      .then((result) => post({
        type: 'agent_response',
        id: message.id,
        ok: true,
        result,
      }))
      .catch((error) => post({
        type: 'agent_response',
        id: message.id,
        ok: false,
        error: {
          code: 'content_agent_command_error',
          message: error?.message || 'Content agent command failed.',
        },
      }));
  });

  state.port.onDisconnect.addListener(() => {
    state.connected = false;
    clearTimeout(state.idleTimer);
    stopDomObserver();
  });

  globalThis[AGENT_KEY] = state;
  ensureConsoleBuffer();
  state.announce();
  scheduleIdleDisconnect();
})();
