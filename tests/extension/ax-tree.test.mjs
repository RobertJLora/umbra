import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach } from 'node:test';
import '../../extension/ax-tree.js';

const Ax = globalThis.UmbraAxTree;
const AX_TREE_SOURCE = readFileSync(new URL('../../extension/ax-tree.js', import.meta.url), 'utf8');

function matchesSimple(node, selector) {
  if (!selector || !node?.tagName) {
    return false;
  }
  const parts = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.some((part) => matchesSimple(node, part));
  }
  let rest = selector.trim();
  const attrRe = /\[([^=\]]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  const attrs = [];
  rest = rest.replace(attrRe, (_all, name, dq, sq, bare) => {
    attrs.push({ name, value: dq ?? sq ?? bare ?? null });
    return '';
  });
  let tag = '';
  let id = '';
  if (rest.includes('#')) {
    const [maybeTag, maybeId] = rest.split('#');
    tag = maybeTag;
    id = maybeId;
  } else {
    tag = rest;
  }
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) {
    return false;
  }
  if (id && node.id !== id) {
    return false;
  }
  for (const attr of attrs) {
    if (!node.hasAttribute(attr.name)) {
      return false;
    }
    if (attr.value !== null && node.getAttribute(attr.name) !== attr.value) {
      return false;
    }
  }
  return true;
}

class FakeNode {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attributes = { ...attrs };
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.id = attrs.id || '';
    this._value = attrs.value ?? '';
    this._checked = attrs.checked === true || attrs.checked === '';
    this.disabled = attrs.disabled === true || attrs.disabled === '';
    this.hidden = attrs.hidden === true || attrs.hidden === '';
    this.isContentEditable = attrs.contenteditable === 'true' || attrs.contenteditable === '';
    this.isConnected = true;
    this.events = [];
    this.selectedIndex = 0;
    this.multiple = attrs.multiple === true;
    this.options = attrs.options || [];
    this._text = '';
    for (const child of children) {
      if (typeof child === 'string') {
        this._text += child;
        this.childNodes.push({ nodeType: 3, textContent: child, parentElement: this });
      } else {
        child.parentElement = this;
        this.children.push(child);
        this.childNodes.push(child);
        this._text += child.textContent;
      }
    }
    if (this.options.length && !this._value) {
      this._value = this.options[0].value || '';
    }
  }

  get type() {
    return this.attributes.type || (this.tagName === 'INPUT' ? 'text' : '');
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
  }

  get innerText() {
    return this._text;
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
  }

  get checked() {
    return this._checked;
  }

  set checked(value) {
    this._checked = Boolean(value);
  }

  getAttribute(name) {
    if (name === 'value') {
      return this._value === '' ? null : String(this._value);
    }
    if (!(name in this.attributes)) {
      return null;
    }
    const value = this.attributes[name];
    return value === true ? '' : String(value);
  }

  hasAttribute(name) {
    return name in this.attributes;
  }

  getBoundingClientRect() {
    return this.attributes.rect || { x: 0, y: 0, width: 80, height: 20, right: 80, bottom: 20 };
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSimple(node, selector)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      if (matchesSimple(node, selector)) {
        out.push(node);
      }
      for (const child of node.children || []) {
        visit(child);
      }
    };
    for (const child of this.children) {
      visit(child);
    }
    return out;
  }

  getElementById(id) {
    if (this.id === id) {
      return this;
    }
    for (const child of this.children) {
      const hit = child.getElementById?.(id);
      if (hit) {
        return hit;
      }
    }
    return null;
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.events.push('click');
    if (this.type === 'checkbox') {
      this._checked = !this._checked;
    } else if (this.type === 'radio') {
      this._checked = true;
    }
  }

  scrollIntoView() {
    this.scrolled = true;
  }

  dispatchEvent(event) {
    this.events.push(event.type);
    return true;
  }
}

class CountingNode extends FakeNode {
  constructor(tag, attrs = {}, children = []) {
    super(tag, attrs, children);
    this.rectReads = 0;
    this.closestCalls = 0;
    this.innerTextReads = 0;
  }

  get innerText() {
    this.innerTextReads += 1;
    return super.innerText;
  }

  getBoundingClientRect() {
    this.rectReads += 1;
    return super.getBoundingClientRect();
  }

  closest(selector) {
    this.closestCalls += 1;
    return super.closest(selector);
  }
}

function createPage(children) {
  const body = new FakeNode('body', {}, children);
  const document = new FakeNode('html', {}, [body]);
  const bind = (node) => {
    node.ownerDocument = document;
    for (const child of node.children) {
      bind(child);
    }
  };
  bind(document);
  document.body = body;
  return { document, body };
}

describe('AX tree helpers', () => {
  beforeEach(() => {
    Ax.expireRefStore(Ax.getSharedRefStore(), 0);
  });

  it('maps implicit roles for common controls and landmarks', () => {
    assert.equal(Ax.implicitRole('a', { href: '/export' }), 'link');
    assert.equal(Ax.implicitRole('button', {}), 'button');
    assert.equal(Ax.implicitRole('input', { type: 'text' }), 'textbox');
    assert.equal(Ax.implicitRole('input', { type: 'checkbox' }), 'checkbox');
    assert.equal(Ax.implicitRole('input', { type: 'radio' }), 'radio');
    assert.equal(Ax.implicitRole('input', { type: 'hidden' }), 'none');
    assert.equal(Ax.implicitRole('select', {}), 'combobox');
    assert.equal(Ax.implicitRole('nav', {}), 'navigation');
    assert.equal(Ax.implicitRole('header', {}), 'banner');
    assert.equal(Ax.implicitRole('header', {}, { insideSection: true }), 'generic');
    assert.equal(Ax.implicitRole('section', { 'aria-label': 'Results' }), 'region');
    assert.equal(Ax.implicitRole('div', { role: 'tab' }), 'tab');
  });

  it('walks a page into a shared ref table with parent childrenRefs', () => {
    const exportButton = new FakeNode('button', { id: 'export' }, ['Export CSV']);
    const email = new FakeNode('input', { id: 'email', type: 'email', 'aria-label': 'Email' });
    const nav = new FakeNode('nav', { 'aria-label': 'Primary' }, [
      new FakeNode('a', { href: '/home' }, ['Home']),
    ]);
    const { document, body } = createPage([
      nav,
      new FakeNode('main', {}, [
        new FakeNode('h1', {}, ['Keyword report']),
        email,
        exportButton,
      ]),
    ]);

    const walked = Ax.walkAxTree(body, { filter: 'all', maxNodes: 50 }, { document, refStore: Ax.getSharedRefStore(), domVersion: 3 });
    const byName = Object.fromEntries(walked.nodes.map((node) => [node.name, node]));

    assert.equal(walked.filter, 'all');
    assert.ok(byName['Export CSV']);
    assert.equal(byName['Export CSV'].role, 'button');
    assert.equal(byName['Export CSV'].tag, 'button');
    assert.equal(byName.Email.role, 'textbox');
    assert.equal(byName.Primary.role, 'navigation');
    assert.ok(byName.Primary.childrenRefs.includes(byName.Home.ref));
    assert.match(byName['Export CSV'].ref, /^cic:3:\d+$/);
    assert.equal(Ax.resolveElementRef(Ax.getSharedRefStore(), byName['Export CSV'].ref, 3).element, exportButton);
  });

  it('filters interactive and landmark nodes and caps maxNodes', () => {
    const { document, body } = createPage([
      new FakeNode('nav', { 'aria-label': 'Site' }, [new FakeNode('a', { href: '/' }, ['Home'])]),
      new FakeNode('main', {}, [
        new FakeNode('h1', {}, ['Title']),
        new FakeNode('button', {}, ['Save']),
        new FakeNode('button', {}, ['Cancel']),
      ]),
    ]);

    const interactive = Ax.walkAxTree(body, { filter: 'interactive' }, { document, refStore: Ax.createRefStore(), domVersion: 1 });
    assert.deepEqual(interactive.nodes.map((node) => node.name), ['Home', 'Save', 'Cancel']);

    const landmarks = Ax.walkAxTree(body, { filter: 'landmarks' }, { document, refStore: Ax.createRefStore(), domVersion: 1 });
    assert.deepEqual(landmarks.nodes.map((node) => node.role).sort(), ['main', 'navigation']);

    const capped = Ax.walkAxTree(body, { filter: 'interactive', maxNodes: 1 }, { document, refStore: Ax.createRefStore(), domVersion: 1 });
    assert.equal(capped.nodes.length, 1);
    assert.equal(capped.truncated, true);
    assert.equal(Ax.clampMaxNodes(900), 500);
    assert.equal(Ax.clampMaxNodes(undefined), 200);
  });

  it('reuses the same ref for one element across AX and interactive assignment', () => {
    const button = new FakeNode('button', {}, ['Export']);
    const store = Ax.getSharedRefStore();
    const first = Ax.assignElementRef(store, button, 4);
    const second = Ax.assignElementRef(store, button, 4);
    assert.equal(first, second);
    assert.equal(Ax.resolveElementRef(store, first, 4).element, button);
  });

  it('expires refs when the DOM version changes or after an explicit navigation reset', () => {
    const button = new FakeNode('button', {}, ['Export']);
    const store = Ax.getSharedRefStore();
    const ref = Ax.assignElementRef(store, button, 1);
    assert.equal(Ax.resolveElementRef(store, ref, 2).__error.includes('Stale'), true);
    const next = Ax.assignElementRef(store, button, 2);
    assert.notEqual(next, ref);
    Ax.expireRefStore(store, 3);
    assert.match(Ax.resolveElementRef(store, next, 3).__error, /Stale element ref/);
  });

  it('ranks find matches by name, role, and case-insensitive text', () => {
    const nodes = [
      { ref: 'cic:1:0', role: 'button', name: 'Export CSV', tag: 'button', rect: { x: 1, y: 1, width: 10, height: 10 } },
      { ref: 'cic:1:1', role: 'link', name: 'Export settings', tag: 'a', rect: { x: 2, y: 2, width: 10, height: 10 } },
      { ref: 'cic:1:2', role: 'textbox', name: 'Search', tag: 'input', text: 'export box', rect: { x: 3, y: 3, width: 10, height: 10 } },
      { ref: 'cic:1:3', role: 'heading', name: 'Organic keywords', tag: 'h1', rect: { x: 4, y: 4, width: 10, height: 10 } },
    ];

    const exportMatches = Ax.rankFindMatches(nodes, 'export csv', 10);
    assert.equal(exportMatches[0].ref, 'cic:1:0');
    assert.ok(exportMatches[0].score > exportMatches[1].score);

    const roleMatches = Ax.rankFindMatches(nodes, 'BUTTON', 5);
    assert.equal(roleMatches[0].role, 'button');

    const heading = Ax.rankFindMatches(nodes, 'organic', 5);
    assert.equal(heading[0].name, 'Organic keywords');
    assert.equal(Ax.rankFindMatches(nodes, 'nope', 5).length, 0);
  });

  it('sets native values and dispatches input/change so React-style listeners can see them', () => {
    const input = new FakeNode('input', { type: 'text', 'aria-label': 'Name' });
    const result = Ax.applyFormInput(input, { value: 'Ada' });
    assert.equal(result.filled, true);
    assert.equal(input.value, 'Ada');
    assert.deepEqual(input.events.filter((name) => name === 'input' || name === 'change'), ['input', 'change']);
  });

  it('checks radios and checkboxes, then fires click/change', () => {
    const box = new FakeNode('input', { type: 'checkbox', 'aria-label': 'Agree' });
    const radio = new FakeNode('input', { type: 'radio', name: 'mode', 'aria-label': 'Exact' });

    const checked = Ax.applyFormInput(box, { checked: true });
    assert.equal(checked.kind, 'checkbox');
    assert.equal(box.checked, true);
    assert.ok(box.events.includes('click'));
    assert.ok(box.events.includes('change'));

    const radioResult = Ax.applyFormInput(radio, { checked: true });
    assert.equal(radioResult.kind, 'radio');
    assert.equal(radio.checked, true);
  });

  it('selects dropdown options by value or label', () => {
    const select = new FakeNode('select', {
      'aria-label': 'Country',
      options: [
        { value: 'us', text: 'United States', label: 'United States', selected: false },
        { value: 'es', text: 'Spain', label: 'Spain', selected: false },
      ],
    });
    const byLabel = Ax.applyFormInput(select, { value: 'Spain' });
    assert.equal(byLabel.filled, true);
    assert.equal(select.value, 'es');
    assert.ok(select.events.includes('change'));

    const missing = Ax.applyFormInput(select, { value: 'France' });
    assert.match(missing.__error, /No matching select option/);
  });

  it('leaves no text field on walked nodes', () => {
    const { document, body } = createPage([
      new FakeNode('nav', { 'aria-label': 'Primary' }, [new FakeNode('a', { href: '/' }, ['Home'])]),
      new FakeNode('main', {}, [
        new FakeNode('h1', {}, ['Keyword report']),
        new FakeNode('button', {}, ['Export CSV']),
      ]),
    ]);

    const walked = Ax.walkAxTree(body, { filter: 'all', maxNodes: 50 }, { document, refStore: Ax.createRefStore(), domVersion: 1 });

    assert.ok(walked.nodes.length > 0);
    for (const node of walked.nodes) {
      assert.equal(Object.prototype.hasOwnProperty.call(node, 'text'), false);
    }
  });

  it('resolves label[for] names from one document sweep per walk', () => {
    const input = new FakeNode('input', { id: 'q', type: 'text' });
    const { document, body } = createPage([
      new FakeNode('label', { for: 'q' }, ['Search keywords']),
      input,
    ]);

    let labelSweeps = 0;
    const originalAll = document.querySelectorAll.bind(document);
    document.querySelectorAll = (selector) => {
      if (selector === 'label[for]') {
        labelSweeps += 1;
      }
      return originalAll(selector);
    };
    document.querySelector = () => {
      throw new Error('per-element label lookup should not run during a walk');
    };

    const walked = Ax.walkAxTree(body, { filter: 'all', maxNodes: 50 }, { document, refStore: Ax.createRefStore(), domVersion: 1 });
    const field = walked.nodes.find((node) => node.tag === 'input');

    assert.equal(field.name, 'Search keywords');
    assert.equal(labelSweeps, 1);
  });

  it('skips value, checked, disabled, rect, and name work on excluded nodes', () => {
    const wrapper = new CountingNode('div', {}, []);
    const button = new CountingNode('button', {}, ['Export CSV']);
    const { document, body } = createPage([wrapper, button]);

    const walked = Ax.walkAxTree(body, { filter: 'interactive', maxNodes: 50 }, { document, refStore: Ax.createRefStore(), domVersion: 1 });

    assert.deepEqual(walked.nodes.map((node) => node.name), ['Export CSV']);
    assert.equal(wrapper.rectReads, 0);
    assert.equal(wrapper.closestCalls, 0);
    assert.equal(wrapper.innerTextReads, 0);
    assert.equal(button.rectReads, 1);
  });
});

describe('AX tree injection guard', () => {
  it('keeps the shared ref store when the same version is injected twice', () => {
    const context = vm.createContext({});
    vm.runInContext(AX_TREE_SOURCE, context);

    const first = context.UmbraAxTree;
    assert.equal(typeof first.version, 'string');
    const store = first.getSharedRefStore();
    const button = new FakeNode('button', {}, ['Export CSV']);
    const ref = first.assignElementRef(store, button, 7);
    assert.equal(store.domVersion, 7);

    vm.runInContext(AX_TREE_SOURCE, context);

    const second = context.UmbraAxTree;
    assert.equal(second, first);
    assert.equal(second.getSharedRefStore(), store);
    assert.equal(store.domVersion, 7);

    const resolved = second.resolveElementRef(second.getSharedRefStore(), ref, 7);
    assert.equal(resolved.__error, undefined);
    assert.equal(resolved.element, button);
  });

  it('replaces the helpers when the injected version differs', () => {
    const context = vm.createContext({});
    vm.runInContext(AX_TREE_SOURCE, context);
    const first = context.UmbraAxTree;

    const bumped = AX_TREE_SOURCE.replace(/const AX_TREE_VERSION = '[^']*';/, "const AX_TREE_VERSION = '99.0.0';");
    assert.notEqual(bumped, AX_TREE_SOURCE);
    vm.runInContext(bumped, context);

    assert.notEqual(context.UmbraAxTree, first);
    assert.equal(context.UmbraAxTree.version, '99.0.0');
    assert.notEqual(context.UmbraAxTree.getSharedRefStore(), first.getSharedRefStore());
  });
});
