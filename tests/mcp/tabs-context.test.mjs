import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_SHORTCUT_CATALOG,
  assertLocalUploadFile,
  getToolDefinition,
} from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function schemaFor(name) {
  const tool = getToolDefinition(name);
  assert.ok(tool, `${name} should exist`);
  return tool.inputSchema;
}

describe('Claude parity tabs context, file upload, and shortcuts', () => {
  it('exposes a read-only tabs context schema with createIfEmpty and includeInternal', () => {
    const tool = getToolDefinition('browser_tabs_context');
    const schema = schemaFor('browser_tabs_context');

    assert.equal(schema.properties.createIfEmpty.type, 'boolean');
    assert.equal(schema.properties.includeInternal.type, 'boolean');
    assert.match(schema.properties.createIfEmpty.description, /about:blank/);
    assert.match(schema.properties.createIfEmpty.description, /collapsed/);
    assert.match(tool.description, /ownership/);
    assert.match(tool.description, /Read-only/);
    assert.match(tool.description, /does not adopt, activate, or close tabs/i);
    assert.equal(schema.properties.activate, undefined);
    assert.notEqual(getToolDefinition('browser_list_tabs').description, tool.description);
    assert.match(getToolDefinition('browser_list_tabs').description, /owned by the current session only/);
  });

  it('requires an absolute existing file for browser_file_upload', () => {
    const schema = schemaFor('browser_file_upload');
    assert.deepEqual(schema.required, ['filePath']);
    assert.equal(schema.properties.filePath.type, 'string');
    assert.equal(schema.properties.selector.type, 'string');
    assert.equal(schema.properties.ref.type, 'string');
    assert.equal(schema.properties.activate.type, 'boolean');
    assert.match(schema.properties.activate.description, /Defaults to false/);
    assert.match(getToolDefinition('browser_file_upload').description, /absolute local path/);

    assert.throws(() => assertLocalUploadFile(''), /filePath/);
    assert.throws(() => assertLocalUploadFile('relative/path.txt'), /absolute/);
    assert.throws(() => assertLocalUploadFile('/tmp/cb-parity-missing-upload-file.txt'), /does not exist/);
    // A directory exists, so reporting it as missing sends a caller looking for
    // the wrong problem.
    assert.throws(() => assertLocalUploadFile(os.tmpdir()), /is a directory, not a file/);

    const existing = fileURLToPath(import.meta.url);
    assert.equal(assertLocalUploadFile(existing), fs.realpathSync(existing));
  });

  it('lists the shortcut catalog without requiring a dispatch target', () => {
    const schema = schemaFor('browser_shortcut');
    assert.equal(schema.properties.list.type, 'boolean');
    assert.match(schema.properties.list.description, /catalog/);
    assert.match(schema.properties.list.description, /do not dispatch/);
    assert.equal(schema.properties.name.type, 'string');
    assert.ok(schema.properties.keys);
    assert.equal(schema.properties.modifiers.type, 'object');
    assert.equal(schema.properties.activate.type, 'boolean');
    assert.match(schema.properties.activate.description, /Defaults to false/);
    assert.equal(schema.required, undefined);

    const names = BROWSER_SHORTCUT_CATALOG.map((item) => item.name);
    for (const name of ['Enter', 'Escape', 'Tab', 'Meta+l', 'Meta+a', 'Meta+c', 'Meta+v', 'ArrowDown', 'ArrowUp']) {
      assert.ok(names.includes(name), `${name} should be in the shortcut catalog`);
    }

    const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');
    const start = background.indexOf("if (tool === 'browser_shortcut')");
    const next = background.indexOf('\n  if (tool ===', start + 1);
    const block = background.slice(start, next);
    assert.match(block, /params\.list === true/);
    assert.match(block, /SHORTCUT_CATALOG/);
    assert.match(block, /getOrCreateSessionTab/);
    assert.doesNotMatch(block, /chrome\.tabs\.query\(\{\}\)/);
    for (const name of names) {
      assert.match(background, new RegExp(name.replace('+', '\\+')));
    }
  });
});
