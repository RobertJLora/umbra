import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertAllowedDirectory,
  assertReadableUploadFile,
  isPathInsideRoot,
} from '../../mcp-server/fs-guard.js';
import { assertLocalUploadFile } from '../../mcp-server/tools.js';
import { resolveOutputPath } from '../../mcp-server/index.js';
import {
  PROCESS_STARTED_AT_MS,
  resolveDownloadSinceMs,
  resolveDownloadWaitDir,
} from '../../mcp-server/download-ledger.mjs';

const tempRoots = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('filesystem allowlist', () => {
  it('treats a path as inside a root only when it is that root or a descendant', () => {
    assert.equal(isPathInsideRoot('/home/demo/.ssh', '/home/demo'), true);
    assert.equal(isPathInsideRoot('/home/demo', '/home/demo'), true);
    assert.equal(isPathInsideRoot('/home/demonic/.ssh', '/home/demo'), false);
  });

  it('allows an existing file under home or tmpdir', () => {
    const existing = fileURLToPath(import.meta.url);
    assert.equal(assertLocalUploadFile(existing), fs.realpathSync(existing));

    const dir = makeTempDir('umbra-upload-ok-');
    const filePath = path.join(dir, 'fixture.txt');
    fs.writeFileSync(filePath, 'ok');
    assert.equal(assertReadableUploadFile(filePath), fs.realpathSync(filePath));
  });

  it('refuses a symlink that resolves into a credential directory', () => {
    const fakeHome = makeTempDir('umbra-home-');
    const sshDir = path.join(fakeHome, '.ssh');
    fs.mkdirSync(sshDir);
    const secret = path.join(sshDir, 'id_rsa');
    fs.writeFileSync(secret, 'SECRET');
    const baitDir = makeTempDir('umbra-bait-');
    const bait = path.join(baitDir, 'upload.txt');
    fs.symlinkSync(secret, bait);

    assert.throws(
      () => assertReadableUploadFile(bait, {
        homedir: fakeHome,
        sharedKeyPath: path.join(fakeHome, '.umbra', 'shared-key'),
      }),
      /blocked credential path/,
    );
  });

  it('refuses the pairing-key directory even when it sits under home', () => {
    const fakeHome = makeTempDir('umbra-keyhome-');
    const umbraHome = path.join(fakeHome, '.umbra');
    fs.mkdirSync(umbraHome);
    const keyPath = path.join(umbraHome, 'shared-key');
    fs.writeFileSync(keyPath, 'pairing-key\n');

    assert.throws(
      () => assertReadableUploadFile(keyPath, { homedir: fakeHome, sharedKeyPath: keyPath }),
      /blocked credential path/,
    );
  });

  it('lets UMBRA_UPLOAD_DIR add a root outside the defaults', () => {
    const outside = makeTempDir('umbra-extra-root-');
    const filePath = path.join(outside, 'extra.txt');
    fs.writeFileSync(filePath, 'extra');
    const fakeHome = makeTempDir('umbra-extra-home-');

    assert.throws(
      () => assertReadableUploadFile(filePath, {
        homedir: fakeHome,
        tmpdir: path.join(fakeHome, 'tmp'),
        cwd: fakeHome,
        systemTemp: [],
        env: {},
      }),
      /not inside an allowed directory/,
    );

    assert.equal(
      assertReadableUploadFile(filePath, {
        homedir: fakeHome,
        tmpdir: path.join(fakeHome, 'tmp'),
        cwd: fakeHome,
        systemTemp: [],
        env: { UMBRA_UPLOAD_DIR: outside },
      }),
      fs.realpathSync(filePath),
    );
  });

  it('refuses screenshot output through a symlink and a non-file target', () => {
    const dir = makeTempDir('umbra-shot-');
    const target = path.join(dir, 'shot.png');
    const victim = path.join(dir, 'victim.bin');
    fs.writeFileSync(victim, 'keep-me');
    fs.symlinkSync(victim, target);
    assert.throws(() => resolveOutputPath(target), /overwrite a symlink/);

    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    assert.throws(() => resolveOutputPath(nested), /not a regular file/);
  });

  it('keeps overwriting an existing regular screenshot file in tmp', () => {
    const dir = makeTempDir('umbra-shot-ok-');
    const target = path.join(dir, 'shot.png');
    fs.writeFileSync(target, 'PRIOR');
    assert.equal(resolveOutputPath(target), target);
  });

  it('refuses a download wait directory that resolves into a credential path', () => {
    const fakeHome = makeTempDir('umbra-dl-home-');
    const sshDir = path.join(fakeHome, '.ssh');
    fs.mkdirSync(sshDir);
    assert.throws(
      () => assertAllowedDirectory(sshDir, {
        homedir: fakeHome,
        sharedKeyPath: path.join(fakeHome, '.umbra', 'shared-key'),
      }),
      /blocked credential path/,
    );

    const okDir = makeTempDir('umbra-dl-ok-');
    assert.equal(resolveDownloadWaitDir({ dir: okDir }), fs.realpathSync(okDir));
    assert.throws(() => resolveDownloadWaitDir({ dir: 'relative-downloads' }), /absolute/);
  });

  it('floors createdAfterMs at process start so historical files cannot be enumerated', () => {
    assert.equal(resolveDownloadSinceMs({ createdAfterMs: 0 }), PROCESS_STARTED_AT_MS);
    const recent = PROCESS_STARTED_AT_MS + 5_000;
    assert.equal(resolveDownloadSinceMs({ createdAfterMs: recent }), recent);
  });

  it('accepts an allowed directory for download waits', () => {
    const dir = makeTempDir('umbra-dl-dir-');
    assert.equal(assertAllowedDirectory(dir), fs.realpathSync(dir));
  });
});
