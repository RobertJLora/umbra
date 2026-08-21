// Default-action emulation for the input paths.
//
// clickAtPoint, clickSelector and dragAtPoints are serialized into the page, so
// each one is a self-contained function this suite can lift out of the shipping
// source and run against a small DOM stub. That is the point of the file: the
// other extension suites assert what the source says, and these two behaviours
// were both reported as working by a result field while the page did not move.
// A synthetic pointer sequence gets no browser default action, so a range input
// kept its start value and a triple click selected nothing, and only running
// the function proves the emulation put them back.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');

function getFunctionBlock(source, functionName) {
  const found = source.indexOf(`function ${functionName}`);
  assert.ok(found >= 0, `${functionName} should exist`);
  // The declaration has to arrive whole: slicing at `function` alone dropped the
  // `async` keyword, and the body still had an await in it.
  const start = source.slice(found - 6, found) === 'async ' ? found - 6 : found;
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return source.slice(start, nextFn === -1 ? source.length : start + 1 + nextFn);
}

function makeEventClasses() {
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  return {
    Event: FakeEvent,
    MouseEvent: class extends FakeEvent {},
    PointerEvent: class extends FakeEvent {},
    DragEvent: class extends FakeEvent {},
  };
}

function makeRangeInput({ x = 320, width = 200, min = '0', max = '5', step = '0.5', value = '0' } = {}) {
  const events = [];
  const element = {
    tagName: 'INPUT',
    type: 'range',
    min,
    max,
    step,
    value,
    events,
    getAttribute: (name) => (name === 'type' ? 'range' : null),
    getBoundingClientRect: () => ({ x, y: 160, left: x, top: 160, width, height: 16, right: x + width, bottom: 176 }),
    matches: (selector) => selector === 'input[type="range"]',
    closest: (selector) => (selector === 'input[type="range"]' ? element : null),
    dispatchEvent: (event) => {
      events.push(event.type);
      return true;
    },
  };
  return element;
}

function loadPageFunction(name, sandbox) {
  vm.createContext(sandbox);
  // The slice can end on a comment line, so the closing paren needs its own.
  return vm.runInContext(`(\n${getFunctionBlock(background, name)}\n)`, sandbox, { filename: `background.js:${name}` });
}

function makeDragSandbox(rangeInput) {
  const classes = makeEventClasses();
  return {
    ...classes,
    DataTransfer: undefined,
    document: {
      body: { tagName: 'BODY' },
      elementFromPoint: () => rangeInput,
    },
    window: { name: 'page' },
    setTimeout,
    clearTimeout,
    console,
  };
}

describe('range drag emulation', () => {
  it('sets the value the end point lands on, snapped to the input step', async () => {
    const rangeInput = makeRangeInput();
    const sandbox = makeDragSandbox(rangeInput);
    const dragAtPoints = loadPageFunction('dragAtPoints', sandbox);

    // The track runs 320 to 520 for a 0 to 5 range on a 0.5 step, so letting go
    // at 455 is 0.675 of the way across, which snaps to 3.5.
    const result = await dragAtPoints(332, 168, 455, 168, {});

    assert.equal(result.dragged, true);
    assert.equal(result.emulatedRange, true);
    assert.equal(result.rangeValue, '3.5');
    assert.equal(rangeInput.value, '3.5');
    // A page listening for one and not the other would miss the move, and the
    // pair is what a real drag ends with.
    assert.ok(rangeInput.events.includes('input'));
    assert.ok(rangeInput.events.includes('change'));
  });

  it('clamps to the track and honours min and max', async () => {
    const rangeInput = makeRangeInput({ min: '10', max: '20', step: '1', value: '10' });
    const sandbox = makeDragSandbox(rangeInput);
    const dragAtPoints = loadPageFunction('dragAtPoints', sandbox);

    const result = await dragAtPoints(330, 168, 900, 168, {});

    assert.equal(result.rangeValue, '20');
    assert.equal(rangeInput.value, '20');
  });

  it('stays out of the way when the page moved the slider itself', async () => {
    const rangeInput = makeRangeInput();
    // A page that handles the pointer sequence is the case the emulation must
    // not touch, or the two would fight over the value.
    rangeInput.dispatchEvent = (event) => {
      rangeInput.events.push(event.type);
      if (event.type === 'pointerup') {
        rangeInput.value = '2';
      }
      return true;
    };
    const sandbox = makeDragSandbox(rangeInput);
    const dragAtPoints = loadPageFunction('dragAtPoints', sandbox);

    const result = await dragAtPoints(332, 168, 455, 168, {});

    assert.equal(result.dragged, true);
    assert.equal(Object.hasOwn(result, 'emulatedRange'), false);
    assert.equal(rangeInput.value, '2');
  });

  it('leaves a drag that is not on a range input alone', async () => {
    const plain = {
      tagName: 'DIV',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
      matches: () => false,
      closest: () => null,
      dispatchEvent: () => true,
    };
    const sandbox = makeDragSandbox(plain);
    const dragAtPoints = loadPageFunction('dragAtPoints', sandbox);

    const result = await dragAtPoints(10, 10, 90, 90, {});

    assert.equal(result.dragged, true);
    assert.equal(Object.hasOwn(result, 'emulatedRange'), false);
  });
});

function makeSelectionSandbox(paragraph, { selected = '' } = {}) {
  const selection = {
    text: selected,
    ranges: [],
    removeAllRanges() {
      this.ranges = [];
    },
    addRange(range) {
      this.ranges.push(range);
      this.text = range.contents;
    },
    toString() {
      return this.text;
    },
  };
  const classes = makeEventClasses();
  const sandbox = {
    ...classes,
    document: {
      body: { tagName: 'BODY' },
      elementFromPoint: () => paragraph,
      querySelector: () => paragraph,
      getSelection: () => selection,
      createRange: () => ({
        contents: '',
        selectNodeContents(node) {
          this.contents = node.textContent;
        },
      }),
    },
    window: { getComputedStyle: () => ({ display: 'block' }) },
    setTimeout,
    clearTimeout,
    console,
  };
  return { sandbox, selection };
}

function makeParagraph(text) {
  return {
    tagName: 'P',
    textContent: text,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 40, y: 300, left: 40, top: 300, width: 600, height: 40, right: 640, bottom: 340 }),
    matches: () => false,
    closest: () => null,
    scrollIntoView: () => {},
    click: () => {},
    dispatchEvent: () => true,
  };
}

describe('triple-click selection emulation', () => {
  for (const { name, triple, single } of [
    {
      name: 'clickAtPoint',
      triple: (fn) => fn(500, 320, false, { clickCount: 3 }),
      single: (fn) => fn(500, 320, false, {}),
    },
    {
      name: 'clickSelector',
      triple: (fn) => fn('p', false, { clickCount: 3 }),
      single: (fn) => fn('p', false, {}),
    },
  ]) {
    it(`${name} selects the block under the click`, () => {
      const text = 'Rhythm Watch is a Japanese watchmaker.';
      const paragraph = makeParagraph(text);
      // closest() is the first thing tried and is what a real paragraph answers.
      paragraph.closest = (selector) => (selector.startsWith('p, li') ? paragraph : null);
      const { sandbox, selection } = makeSelectionSandbox(paragraph);
      const clickFn = loadPageFunction(name, sandbox);

      const result = triple(clickFn);

      assert.equal(result.clicked, true);
      assert.equal(result.clickCount, 3);
      assert.equal(result.selectedTextLength, text.length);
      assert.equal(selection.toString(), text);
      assert.equal(selection.ranges.length, 1);
    });

    it(`${name} leaves a single click with no selection`, () => {
      const paragraph = makeParagraph('Rhythm Watch is a Japanese watchmaker.');
      paragraph.closest = (selector) => (selector.startsWith('p, li') ? paragraph : null);
      const { sandbox, selection } = makeSelectionSandbox(paragraph);
      const clickFn = loadPageFunction(name, sandbox);

      const result = single(clickFn);

      assert.equal(result.clicked, true);
      assert.equal(Object.hasOwn(result, 'selectedTextLength'), false);
      assert.equal(selection.ranges.length, 0);
    });
  }

  it('keeps a selection the page made for itself', () => {
    const paragraph = makeParagraph('Rhythm Watch is a Japanese watchmaker.');
    paragraph.closest = (selector) => (selector.startsWith('p, li') ? paragraph : null);
    const { sandbox, selection } = makeSelectionSandbox(paragraph, { selected: 'page picked this' });
    const clickAtPoint = loadPageFunction('clickAtPoint', sandbox);

    const result = clickAtPoint(500, 320, false, { clickCount: 3 });

    assert.equal(Object.hasOwn(result, 'selectedTextLength'), false);
    assert.equal(selection.toString(), 'page picked this');
    assert.equal(selection.ranges.length, 0);
  });

  it('walks up to the nearest block when the click lands on inline markup', () => {
    const text = 'Rhythm Watch is a Japanese watchmaker.';
    const paragraph = makeParagraph(text);
    paragraph.closest = () => null;
    const inline = {
      tagName: 'A',
      textContent: 'Japanese',
      parentElement: paragraph,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 200, y: 300, left: 200, top: 300, width: 60, height: 18, right: 260, bottom: 318 }),
      matches: () => false,
      closest: () => null,
      scrollIntoView: () => {},
      click: () => {},
      dispatchEvent: () => true,
    };
    const { sandbox, selection } = makeSelectionSandbox(inline);
    // The anchor is inline, so the walk has to keep going to the paragraph.
    sandbox.window.getComputedStyle = (node) => ({ display: node === inline ? 'inline' : 'block' });
    const clickAtPoint = loadPageFunction('clickAtPoint', sandbox);

    const result = clickAtPoint(230, 310, false, { clickCount: 3 });

    assert.equal(result.selectedTextLength, text.length);
    assert.equal(selection.toString(), text);
  });

  it('selects the field text when the triple click lands in an input', () => {
    const input = {
      tagName: 'INPUT',
      value: 'Umbra Verify 0.6.1',
      textContent: '',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 200, height: 24, right: 200, bottom: 24 }),
      matches: () => false,
      closest: () => null,
      scrollIntoView: () => {},
      click: () => {},
      dispatchEvent: () => true,
      selected: false,
      select() {
        this.selected = true;
      },
    };
    const { sandbox } = makeSelectionSandbox(input);
    const clickAtPoint = loadPageFunction('clickAtPoint', sandbox);

    const result = clickAtPoint(50, 12, false, { clickCount: 3 });

    assert.equal(input.selected, true);
    assert.equal(result.selectedTextLength, 'Umbra Verify 0.6.1'.length);
  });
});
