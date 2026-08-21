import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const agentPath = path.join(repoRoot, 'extension', 'content-agent.js');
const agentSource = fs.readFileSync(agentPath, 'utf8');

const AGENT_KEY = '__umbraContentAgent';
const CONSOLE_STORE_KEY = '__umbraConsole';

function makeRect(width, height) {
  return { x: 0, y: 0, width, height, right: width, bottom: height };
}

function makeElement(overrides = {}) {
  const element = {
    tagName: 'BUTTON',
    id: '',
    innerText: 'Submit',
    textContent: 'Submit',
    outerHTML: '<button>Submit</button>',
    isContentEditable: false,
    parentElement: null,
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [makeRect(120, 40)],
    getBoundingClientRect: () => makeRect(120, 40),
    closest: () => null,
    scrollIntoView: () => {},
    dispatchEvent: () => true,
    ...overrides,
  };
  element.click = () => {
    element.clicks += 1;
  };
  return element;
}

function makeImage() {
  return {
    currentSrc: 'https://example.test/photo.png',
    naturalWidth: 200,
    naturalHeight: 100,
    parentElement: null,
    getAttribute: (name) => (name === 'alt' ? 'A photo' : ''),
    getClientRects: () => [makeRect(200, 100)],
    getBoundingClientRect: () => makeRect(200, 100),
    closest: () => null,
  };
}

/**
 * Loads extension/content-agent.js into a fresh vm context with a DOM stub
 * small enough to read, and returns a dispatcher that drives the same
 * chrome.runtime port the background worker uses. Every caller must invoke
 * dispose(), because the agent arms a 45 second idle-disconnect timer on load
 * and again after each command.
 */
function loadAgent({
  bodyText = 'Page body text.',
  html = '<html><body>Page body text.</body></html>',
  title = 'Example page',
  href = 'https://example.test/article',
  images = [],
  interactive = [],
  axTree = null,
  documentOverrides = null,
} = {}) {
  const sent = [];
  let commandListener = null;

  const root = { innerText: bodyText, textContent: bodyText, outerHTML: html };
  const documentStub = {
    title,
    documentElement: root,
    body: root,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'img' ? images : interactive),
  };
  if (documentOverrides) {
    Object.assign(documentStub, documentOverrides);
  }

  const sandbox = {
    chrome: {
      runtime: {
        connect: () => ({
          name: 'cic-content-agent',
          onMessage: {
            addListener: (listener) => {
              commandListener = listener;
            },
          },
          onDisconnect: { addListener: () => {} },
          postMessage: (message) => {
            sent.push(message);
          },
          disconnect: () => {},
        }),
      },
    },
    document: documentStub,
    location: { href },
    window: {
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
      addEventListener: () => {},
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    MouseEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    console: {
      log() {},
      warn() {},
      error() {},
      info() {},
      debug() {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  if (axTree) {
    sandbox.UmbraAxTree = axTree;
  }

  vm.createContext(sandbox);
  vm.runInContext(agentSource, sandbox, { filename: agentPath });

  const state = sandbox[AGENT_KEY];
  assert.ok(state, `the agent should register itself as globalThis.${AGENT_KEY}`);
  assert.ok(commandListener, 'the agent should register a port message listener');

  let nextId = 0;
  const dispatch = async (action, params = {}) => {
    nextId += 1;
    const id = `cmd-${nextId}`;
    commandListener({ type: 'agent_command', id, action, params });
    await new Promise((resolve) => setImmediate(resolve));
    const response = sent.find((message) => message?.type === 'agent_response' && message.id === id);
    assert.ok(response, `command ${action} should produce a response`);
    return response;
  };

  const dispose = () => {
    clearTimeout(state.idleTimer);
    clearTimeout(state.domVersionTimer);
  };

  return { sandbox, state, sent, dispatch, dispose };
}

describe('content agent payload contract', () => {
  it('registers under Umbra global keys with no vendor name left in the source', () => {
    const agent = loadAgent();
    try {
      assert.ok(agent.sandbox[AGENT_KEY], 'the agent record should live on the Umbra global key');
      assert.ok(agent.sandbox[CONSOLE_STORE_KEY], 'the console buffer should live on the Umbra global key');
      assert.doesNotMatch(agentSource, /__codexChromeBridge/);
      assert.doesNotMatch(agentSource, /codex/i);
    } finally {
      agent.dispose();
    }
  });

  it('returns one copy of a default text read, with no bodyText and no html', async () => {
    const agent = loadAgent({ bodyText: 'Only body text here.' });
    try {
      const response = await agent.dispatch('read_page_content', { options: {} });
      assert.equal(response.ok, true);
      const result = response.result;
      assert.equal(result.content, 'Only body text here.');
      assert.equal(Object.hasOwn(result, 'bodyText'), false, 'bodyText duplicates content on a default read');
      assert.equal(Object.hasOwn(result, 'bodyTextTruncated'), false);
      assert.equal(Object.hasOwn(result, 'html'), false);
      assert.equal(Object.hasOwn(result, 'renderedImageSummary'), false, 'an empty image summary should not ship');
    } finally {
      agent.dispose();
    }
  });

  it('returns one copy of an html read under the content key alone', async () => {
    const markup = '<html><body><p>Structured</p></body></html>';
    const agent = loadAgent({ html: markup });
    try {
      const response = await agent.dispatch('read_page_content', { options: { format: 'html' } });
      const result = response.result;
      assert.equal(result.content, markup);
      assert.equal(Object.hasOwn(result, 'html'), false, 'html duplicated content on every html read');
      assert.equal(Object.hasOwn(result, 'bodyText'), false);
    } finally {
      agent.dispose();
    }
  });

  it('emits bodyText only when the image summary makes it differ from content', async () => {
    const agent = loadAgent({ bodyText: 'Body only.', images: [makeImage()] });
    try {
      const response = await agent.dispatch('read_page_content', { options: { includeImages: true } });
      const result = response.result;
      assert.equal(result.bodyText, 'Body only.');
      assert.notEqual(result.content, result.bodyText);
      assert.match(result.content, /Rendered images \(1 visible\)/);
      assert.equal(result.bodyTextTruncated, false);
      assert.equal(result.renderedImages.length, 1);
      assert.equal(Object.hasOwn(result, 'renderedImageSummary'), false, 'the summary already travels inside content');
    } finally {
      agent.dispose();
    }
  });

  it('keeps the image summary on an html read, where content does not carry it', async () => {
    const agent = loadAgent({ images: [makeImage()] });
    try {
      const response = await agent.dispatch('read_page_content', {
        options: { format: 'html', includeImages: true },
      });
      const result = response.result;
      assert.match(result.renderedImageSummary, /Rendered images \(1 visible\)/);
      assert.doesNotMatch(result.content, /Rendered images/);
    } finally {
      agent.dispose();
    }
  });

  it('picks the densest body block in article mode and leaves the furniture out', async () => {
    const CANDIDATES = 'p, div, section, article, td';
    const STRIP = 'script, style, nav, aside, footer, header, form, noscript, [aria-hidden="true"]';
    const body = 'The article body runs for several sentences. '.repeat(12);
    const shareBar = 'Share this article';
    const navText = 'Home About Contact Subscribe';

    const share = {
      tagName: 'FOOTER',
      nodeType: 1,
      id: '',
      className: 'share',
      innerText: shareBar,
      textContent: shareBar,
      matches: (selector) => selector === STRIP,
      querySelector: () => null,
      querySelectorAll: () => [],
      childNodes: [],
    };
    const article = {
      tagName: 'ARTICLE',
      nodeType: 1,
      id: 'story',
      className: 'story-body',
      innerText: `${body}\n${shareBar}`,
      textContent: `${body}\n${shareBar}`,
      getAttribute: () => null,
      matches: () => false,
      // The share bar is a stripped descendant, which is what sends the reader
      // down the child-by-child path instead of taking innerText wholesale.
      querySelector: (selector) => (selector === STRIP ? share : null),
      querySelectorAll: () => [],
      childNodes: [{ nodeType: 3, textContent: body }, share],
    };
    const wrapper = {
      tagName: 'DIV',
      nodeType: 1,
      id: '',
      className: 'page',
      innerText: `${navText}\n${body}\n${shareBar}`,
      textContent: `${navText}\n${body}\n${shareBar}`,
      getAttribute: () => null,
      matches: () => false,
      querySelector: (selector) => (selector === STRIP ? share : null),
      querySelectorAll: (selector) => (selector === 'a'
        ? [{ innerText: navText, textContent: navText }]
        : []),
      childNodes: [],
    };
    article.parentElement = wrapper;
    wrapper.parentElement = null;

    const agent = loadAgent({
      documentOverrides: {
        querySelector: (selector) => (selector === 'h1'
          ? { innerText: 'A headline', textContent: 'A headline' }
          : null),
        body: {
          tagName: 'BODY',
          nodeType: 1,
          id: '',
          className: '',
          innerText: `${navText}\n${body}`,
          textContent: `${navText}\n${body}`,
          getAttribute: () => null,
          matches: () => false,
          querySelector: () => null,
          querySelectorAll: (selector) => (selector === CANDIDATES ? [wrapper, article] : []),
          childNodes: [],
          parentElement: null,
        },
      },
    });
    try {
      const response = await agent.dispatch('read_page_content', { options: { mode: 'article' } });
      assert.equal(response.ok, true);
      const result = response.result;
      assert.equal(result.mode, 'article');
      // The wrapper carries the same body plus the navigation, and scores lower
      // for it, so the article element is the one that comes back.
      assert.equal(result.articleRootSelector, 'article#story');
      assert.equal(result.articleTitle, 'A headline');
      assert.equal(result.content.includes('Home About Contact'), false, 'navigation should not survive an article read');
      assert.equal(result.content.includes(shareBar), false, 'a stripped subtree should not survive an article read');
      assert.ok(result.content.startsWith('The article body runs'));
    } finally {
      agent.dispose();
    }
  });

  it('stops the ancestor walk at a page shell that carries far more text', async () => {
    // Wikipedia's div.mw-page-container wears no boilerplate class name, so the
    // noise penalty misses it and its link density is low enough to clear the
    // 90 percent score rule. Article mode returned the whole Vector shell. The
    // text ratio is what separates a wrapper around a byline from a page shell.
    const CANDIDATES = 'p, div, section, article, td';
    const STRIP = 'script, style, nav, aside, footer, header, form, noscript, [aria-hidden="true"]';
    const body = 'The article body runs on for a while. '.repeat(26);
    const chrome = 'Article Talk Read Edit View history Tools Appearance '.repeat(14);

    const makeNode = (overrides) => ({
      nodeType: 1,
      id: '',
      className: '',
      getAttribute: () => null,
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      childNodes: [],
      parentElement: null,
      ...overrides,
    });

    const article = makeNode({
      tagName: 'DIV',
      className: 'mw-parser-output',
      innerText: body,
      textContent: body,
      childNodes: [{ nodeType: 3, textContent: body }],
    });
    const shell = makeNode({
      tagName: 'DIV',
      className: 'mw-page-container',
      innerText: `${chrome}\n${body}`,
      textContent: `${chrome}\n${body}`,
      // Every character of the shell's own text is link text, which is what
      // keeps its score just under the body's while its length runs past it.
      querySelectorAll: (selector) => (selector === 'a' ? [{ textContent: chrome }] : []),
    });
    article.parentElement = shell;

    const agent = loadAgent({
      documentOverrides: {
        querySelector: () => null,
        body: makeNode({
          tagName: 'BODY',
          innerText: `${chrome}\n${body}`,
          textContent: `${chrome}\n${body}`,
          querySelectorAll: (selector) => (selector === CANDIDATES ? [shell, article] : []),
        }),
      },
    });
    try {
      const response = await agent.dispatch('read_page_content', { options: { mode: 'article' } });
      assert.equal(response.result.articleRootSelector, 'div.mw-parser-output');
      assert.equal(response.result.content.includes('View history'), false, 'the page shell should not survive');
      assert.equal(STRIP.length > 0, true);
    } finally {
      agent.dispose();
    }
  });

  it('prefers markup that names an article body over a denser wrapper', async () => {
    const CANDIDATES = 'p, div, section, article, td';
    const BODY_SELECTOR = '[itemprop="articleBody"], .mw-parser-output, #mw-content-text, #bodyContent, article, main article';
    const body = 'Prose that names nothing in particular. '.repeat(20);
    // Enough extra prose to outscore the body on density alone, and not enough
    // to clear 90 percent of it once the body's own markup is credited.
    const extra = 'Extra prose in the column. '.repeat(3);

    const makeNode = (overrides) => ({
      nodeType: 1,
      id: '',
      className: '',
      getAttribute: () => null,
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      childNodes: [],
      parentElement: null,
      ...overrides,
    });

    const article = makeNode({
      tagName: 'DIV',
      className: 'mw-parser-output',
      innerText: body,
      textContent: body,
      matches: (selector) => selector === BODY_SELECTOR,
      childNodes: [{ nodeType: 3, textContent: body }],
    });
    const wrapper = makeNode({
      tagName: 'DIV',
      className: 'column',
      innerText: `${body}\n${extra}`,
      textContent: `${body}\n${extra}`,
    });
    article.parentElement = wrapper;

    const agent = loadAgent({
      documentOverrides: {
        querySelector: () => null,
        body: makeNode({
          tagName: 'BODY',
          innerText: body,
          textContent: body,
          querySelectorAll: (selector) => (selector === CANDIDATES ? [wrapper, article] : []),
        }),
      },
    });
    try {
      const response = await agent.dispatch('read_page_content', { options: { mode: 'article' } });
      // Without the bonus the wrapper's extra text outscores the body it wraps.
      assert.equal(response.result.articleRootSelector, 'div.mw-parser-output');
    } finally {
      agent.dispose();
    }
  });

  it('selects the block under a triple click, which no synthetic event does', async () => {
    const text = 'Rhythm Watch is a Japanese watchmaker founded in 1950.';
    const selection = {
      ranges: [],
      removeAllRanges() {
        this.ranges = [];
      },
      addRange(range) {
        this.ranges.push(range);
      },
      toString() {
        return this.ranges.length > 0 ? this.ranges[0].contents : '';
      },
    };
    const paragraph = { tagName: 'P', textContent: text };
    const target = makeElement({
      tagName: 'P',
      innerText: text,
      textContent: text,
      // The disabled check asks first and has to come back empty.
      closest: (selector) => (selector.startsWith('p, li') ? paragraph : null),
    });

    const agent = loadAgent({
      interactive: [target],
      documentOverrides: {
        getSelection: () => selection,
        createRange: () => ({
          contents: '',
          selectNodeContents(node) {
            this.contents = node.textContent;
          },
        }),
      },
      axTree: {
        getSharedRefStore: () => ({}),
        expireRefStore: () => {},
        resolveElementRef: () => ({ __error: 'Stale element ref.', code: 'stale_interactive_ref' }),
      },
    });
    try {
      const response = await agent.dispatch('click_interactive_ref', { ref: 'cic:0:0', options: { clickCount: 3 } });
      assert.equal(response.result.clickCount, 3);
      assert.equal(response.result.selectedTextLength, text.length);
      assert.equal(selection.toString(), text);

      const single = await agent.dispatch('click_interactive_ref', { ref: 'cic:0:0', options: {} });
      assert.equal(Object.hasOwn(single.result, 'selectedTextLength'), false);
    } finally {
      agent.dispose();
    }
  });

  it('scores article candidates on link density and names the stripped subtrees', () => {
    const start = agentSource.indexOf('function extractArticleText');
    assert.ok(start >= 0, 'extractArticleText should exist');
    const block = agentSource.slice(start, agentSource.indexOf('\n  function readPageContent', start));
    assert.match(block, /linkTextLength/);
    assert.match(block, /linkDensity/);
    assert.match(block, /ARTICLE_STRIP_SELECTOR/);
    assert.match(agentSource, /aria-hidden="true"\]';/);
    assert.match(agentSource, /ARTICLE_NOISE_RE = \/nav\|menu\|sidebar\|footer\|header\|comment\|share\|promo\|related\|breadcrumb\/i/);
    // Scoring reads the live DOM. Nothing here removes or hides a node, because
    // a read must never change the page it is reading.
    assert.doesNotMatch(block, /\.remove\(\)|removeChild|style\.display/);
  });

  it('resolves maxChars to a finite default and still honours a caller value', async () => {
    const agent = loadAgent({ bodyText: 'abcdefghij' });
    try {
      const defaulted = await agent.dispatch('read_page_content', { options: {} });
      assert.equal(Number.isFinite(defaulted.result.maxChars), true);
      assert.ok(defaulted.result.maxChars > 0, 'zero used to mean unbounded');
      assert.equal(defaulted.result.truncated, false);

      const capped = await agent.dispatch('read_page_content', { options: { maxChars: 4 } });
      assert.equal(capped.result.content, 'abcd');
      assert.equal(capped.result.truncated, true);
      assert.equal(capped.result.originalContentLength, 10);

      const clamped = await agent.dispatch('read_page_content', { options: { maxChars: 5_000_000 } });
      assert.equal(clamped.result.maxChars, defaulted.result.maxChars);
    } finally {
      agent.dispose();
    }
  });

  it('never compiles caller-supplied code and reports the page-world requirement', async () => {
    assert.doesNotMatch(agentSource, /AsyncFunction/);
    assert.doesNotMatch(agentSource, /new Function\s*\(/);
    assert.doesNotMatch(agentSource, /\beval\s*\(/);
    assert.match(agentSource, /async function executeJavascript/);
    assert.match(agentSource, /execute_javascript/);

    const agent = loadAgent();
    try {
      const pageWorld = await agent.dispatch('execute_javascript', {
        code: 'globalThis.__pwned = 1; return 1;',
        pageWorld: true,
      });
      assert.equal(pageWorld.result.pageWorld, true);
      assert.equal(agent.sandbox.__pwned, undefined);

      const refused = await agent.dispatch('execute_javascript', {
        code: 'globalThis.__pwned = 1; return 1;',
      });
      assert.equal(refused.result.code, 'page_world_required');
      assert.match(refused.result.__error, /does not run caller-supplied JavaScript/);
      assert.equal(agent.sandbox.__pwned, undefined);
    } finally {
      agent.dispose();
    }
  });

  it('reaches the index fallback when the shared ref store reports a stale ref', async () => {
    const button = makeElement();
    const agent = loadAgent({
      interactive: [button],
      axTree: {
        getSharedRefStore: () => ({}),
        expireRefStore: () => {},
        resolveElementRef: () => ({
          __error: 'Stale element ref. Run browser_read_page or browser_read_interactive again.',
          code: 'stale_interactive_ref',
        }),
      },
    });
    try {
      const response = await agent.dispatch('click_interactive_ref', { ref: 'cic:0:0', options: {} });
      assert.equal(response.ok, true);
      assert.equal(response.result.clicked, true, 'the shared-store error used to short-circuit the fallback');
      assert.equal(button.clicks, 1);
    } finally {
      agent.dispose();
    }
  });

  it('still refuses a ref shape the index fallback cannot parse', async () => {
    const agent = loadAgent({
      interactive: [makeElement()],
      axTree: {
        getSharedRefStore: () => ({}),
        expireRefStore: () => {},
        resolveElementRef: () => ({
          __error: 'Stale element ref.',
          code: 'stale_interactive_ref',
        }),
      },
    });
    try {
      const response = await agent.dispatch('click_interactive_ref', { ref: 'not-a-ref', options: {} });
      assert.match(response.result.__error, /Stale element ref/);
      assert.equal(response.result.clicked, undefined);
    } finally {
      agent.dispose();
    }
  });
});

describe('content agent ref safety', () => {
  it('honours the shared store when it says a ref no longer resolves', async () => {
    // A ref whose element left the DOM used to fall through to a positional
    // index lookup, which resolved the same index in the re-rendered list. The
    // click landed on a different control and still reported clicked: true.
    const detached = { tagName: 'BUTTON', isConnected: false };
    const store = { byRef: new Map([['cic:0:0', detached]]), domVersion: 0 };
    const axTree = {
      getSharedRefStore: () => store,
      createRefStore: () => store,
      expireRefStore: () => store,
      resolveElementRef: () => ({
        __error: 'Element ref no longer resolves. Run browser_read_page or browser_read_interactive again.',
        code: 'stale_interactive_ref',
      }),
      walkAxTree: () => ({ nodes: [], filter: 'interactive', maxNodes: 1, truncated: false, domVersion: 0 }),
      findAxNodes: () => ({ matches: [] }),
    };

    const clicks = [];
    const survivor = {
      tagName: 'BUTTON',
      isConnected: true,
      textContent: 'Publish to production',
      innerText: 'Publish to production',
      getAttribute: () => null,
      hasAttribute: () => false,
      getBoundingClientRect: () => makeRect(120, 30),
      getClientRects: () => [makeRect(120, 30)],
      closest: () => null,
      scrollIntoView: () => {},
      focus: () => {},
      click: () => clicks.push('publish'),
      dispatchEvent: () => true,
    };

    const agent = loadAgent({ interactive: [survivor], axTree });
    try {
      const response = await agent.dispatch('click_interactive_ref', { ref: 'cic:0:0' });
      const failed = response.ok === false || Boolean(response.result?.__error);
      assert.ok(failed, 'a ref the store rejected still resolved to some element');
      assert.notEqual(response.result?.clicked, true);
      assert.deepEqual(clicks, [], 'a stale ref clicked a different control');
    } finally {
      agent.dispose();
    }
  });

  it('starts past a surviving ref store version so old refs cannot resolve after re-injection', () => {
    const store = { byRef: new Map(), domVersion: 6 };
    const axTree = {
      getSharedRefStore: () => store,
      createRefStore: () => store,
      expireRefStore: () => store,
      resolveElementRef: () => ({ __error: 'x' }),
      walkAxTree: () => ({ nodes: [], filter: 'interactive', maxNodes: 1, truncated: false, domVersion: 7 }),
      findAxNodes: () => ({ matches: [] }),
    };

    const agent = loadAgent({ axTree });
    try {
      // domVersion used to restart at 0 on every injection, so a ref an earlier
      // agent issued at version 0 resolved against a brand-new version 0.
      assert.ok(agent.state.domVersion > 6, `re-injected agent restarted at ${agent.state.domVersion}`);
    } finally {
      agent.dispose();
    }
  });
});
