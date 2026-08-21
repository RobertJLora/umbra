import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  UPLOAD_IMAGE_DROP_MAX_BYTES,
  getToolDefinition,
  prepareUploadImageParams,
} from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function withTempImage(bytes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-upload-image-'));
  const filePath = path.join(dir, 'shot.png');
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 7));
  try {
    return run(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('browser_upload_image', () => {
  it('reads the file only for a drop at a point', () => {
    withTempImage(64, (filePath) => {
      const dropped = prepareUploadImageParams({ filePath, x: 120, y: 240 });
      assert.equal(typeof dropped.fileData, 'string');
      assert.equal(Buffer.from(dropped.fileData, 'base64').length, 64);
      assert.equal(dropped.fileName, 'shot.png');
      assert.equal(dropped.mimeType, 'image/png');
      assert.equal(dropped.filePath, fs.realpathSync(filePath));
    });
  });

  it('never turns a file input upload into bytes on the wire', () => {
    withTempImage(64, (filePath) => {
      // The path travels to Chrome and DOM.setFileInputFiles opens it there, so
      // this mode has no size limit and no reason to read the file here.
      for (const params of [
        { filePath, ref: 'cic:3:4' },
        { filePath, selector: 'input[type=file]' },
        // A ref plus a point is still the ref mode: the input is the better
        // target and the one without a limit.
        { filePath, ref: 'cic:3:4', x: 10, y: 20 },
        { filePath },
      ]) {
        const prepared = prepareUploadImageParams(params);
        assert.equal(Object.hasOwn(prepared, 'fileData'), false);
        assert.equal(Object.hasOwn(prepared, 'mimeType'), false);
        assert.equal(prepared.filePath, fs.realpathSync(filePath));
      }
    });
  });

  it('refuses an over-cap drop and names the mode that has no limit', () => {
    withTempImage(UPLOAD_IMAGE_DROP_MAX_BYTES + 1, (filePath) => {
      assert.throws(
        () => prepareUploadImageParams({ filePath, x: 10, y: 20 }),
        (error) => {
          // Params travel the request direction, where the broker kills the
          // connection rather than returning an error past its line cap, so the
          // refusal has to happen here and has to say what to do instead.
          assert.match(error.message, /700 KB/);
          assert.match(error.message, /ref or selector/);
          return true;
        },
      );
    });
  });

  it('still refuses a path outside the allowed roots', () => {
    assert.throws(
      () => prepareUploadImageParams({ filePath: '/etc/hosts', x: 1, y: 2 }),
      /allowed|refus|outside/i,
    );
    assert.throws(() => prepareUploadImageParams({ filePath: 'relative.png' }), /absolute/);
  });

  it('hooks both transports, because the launcher silently falls back', () => {
    for (const file of ['bridge-core.js', 'rust-broker-client.js']) {
      const source = fs.readFileSync(path.join(repoRoot, 'mcp-server', file), 'utf8');
      assert.match(source, /if \(tool === 'browser_upload_image'\) \{\s*\n\s*params = prepareUploadImageParams\(params\);/);
    }
  });

  it('advertises both modes and keeps the size limit visible', () => {
    const definition = getToolDefinition('browser_upload_image');
    assert.ok(definition, 'browser_upload_image should exist');
    assert.deepEqual(definition.inputSchema.required, ['filePath']);
    assert.match(definition.inputSchema.properties.ref.description, /no file size limit/);
    assert.match(definition.inputSchema.properties.selector.description, /no file size limit/);
    assert.match(definition.inputSchema.properties.x.description, /700 KB/);
    assert.match(definition.inputSchema.properties.activate.description, /Defaults to false/);

    const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');
    assert.match(background, /if \(tool === 'browser_upload_image'\)/);
    const start = background.indexOf("if (tool === 'browser_upload_image')");
    const block = background.slice(start, background.indexOf('\n  if (tool ===', start + 1));
    assert.match(block, /getOrCreateSessionTab\(sessionId/);
    assert.match(block, /resolveFileInputSelector/);
    assert.match(block, /dropFileAtPoint/);
    assert.match(block, /requires ref, selector, or both x and y/);

    const dropStart = background.indexOf('function dropFileAtPoint');
    const drop = background.slice(dropStart, background.indexOf('\nfunction ', dropStart + 1));
    assert.match(drop, /DataTransfer/);
    assert.match(drop, /dragenter/);
    assert.match(drop, /dragover/);
    assert.match(drop, /'drop'/);
    assert.match(drop, /atob\(/);
  });
});
