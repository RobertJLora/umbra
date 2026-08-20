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
