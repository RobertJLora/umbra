import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandUserPath, resolveSharedKeyPath } from './config.js';

// Credential locations that a page-triggered upload, screenshot write, or
// download-dir listing must never reach, even when they sit inside an otherwise
// allowed home subtree. The Umbra home is denied so the pairing key cannot be
// read back through browser_file_upload.

const CREDENTIAL_DIR_NAMES = [
  '.ssh',
  '.aws',
  '.gnupg',
  path.join('.config', 'gcloud'),
  '.kube',
  '.docker',
];

const CREDENTIAL_FILE_NAMES = [
  '.netrc',
  '.npmrc',
  '.git-credentials',
];

function splitEnvPaths(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(expandUserPath(entry)));
}

function canonicalizePath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function unique(paths) {
  return [...new Set(paths.filter(Boolean))];
}

export function isPathInsideRoot(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedCandidate.startsWith(prefix);
}

export function defaultAllowedFsRoots({
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
  cwd = process.cwd(),
  systemTemp = ['/tmp', '/private/tmp'],
} = {}) {
  return unique([
    homedir,
    path.join(homedir, 'Downloads'),
    tmpdir,
    ...systemTemp,
    cwd,
  ].map((entry) => canonicalizePath(entry)));
}

export function resolveAllowedFsRoots({
  env = process.env,
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
  cwd = process.cwd(),
  extraRoots = [],
  systemTemp = ['/tmp', '/private/tmp'],
} = {}) {
  const extras = [
    ...splitEnvPaths(env.UMBRA_UPLOAD_DIR),
    ...splitEnvPaths(env.UMBRA_FS_ROOTS),
    ...extraRoots.map((entry) => path.resolve(expandUserPath(entry))),
  ];
  return unique([
    ...defaultAllowedFsRoots({ homedir, tmpdir, cwd, systemTemp }),
    ...extras.map((entry) => canonicalizePath(entry)),
  ]);
}

export function resolveDeniedFsPaths({
  homedir = os.homedir(),
  sharedKeyPath = resolveSharedKeyPath(),
} = {}) {
  const keyPath = canonicalizePath(path.resolve(expandUserPath(sharedKeyPath)));
  const dirs = unique([
    canonicalizePath(path.dirname(keyPath)),
    ...CREDENTIAL_DIR_NAMES.map((relative) => canonicalizePath(path.join(homedir, relative))),
  ]);
  const files = unique([
    keyPath,
    ...CREDENTIAL_FILE_NAMES.map((relative) => canonicalizePath(path.join(homedir, relative))),
  ]);
  return { dirs, files };
}

export function describeFsDenial(realPath, {
  env = process.env,
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
  cwd = process.cwd(),
  extraRoots = [],
  systemTemp,
  sharedKeyPath = resolveSharedKeyPath(),
} = {}) {
  const denied = resolveDeniedFsPaths({ homedir, sharedKeyPath });
  if (denied.files.some((file) => realPath === file)) {
    return 'blocked credential path';
  }
  if (denied.dirs.some((dir) => isPathInsideRoot(realPath, dir))) {
    return 'blocked credential path';
  }
  const allowed = resolveAllowedFsRoots({ env, homedir, tmpdir, cwd, extraRoots, systemTemp });
  if (!allowed.some((root) => isPathInsideRoot(realPath, root))) {
    return 'not inside an allowed directory';
  }
  return '';
}

export function assertAllowedFsPath(realPath, options = {}) {
  const reason = describeFsDenial(realPath, options);
  if (reason) {
    throw new Error(`Path is ${reason}: ${realPath}`);
  }
  return realPath;
}

export function assertReadableUploadFile(filePath, options = {}) {
  const value = typeof filePath === 'string' ? filePath.trim() : '';
  if (!value) {
    throw new Error('browser_file_upload requires filePath.');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('filePath must be an absolute local path.');
  }

  let realPath;
  try {
    realPath = fs.realpathSync(value);
  } catch {
    throw new Error(`File does not exist: ${value}`);
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch {
    throw new Error(`File does not exist: ${value}`);
  }
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${value}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${value}`);
  }

  assertAllowedFsPath(realPath, { ...options, kind: 'file' });
  return realPath;
}

export function assertAllowedDirectory(dirPath, options = {}) {
  const value = typeof dirPath === 'string' ? dirPath.trim() : '';
  if (!value) {
    throw new Error('Directory path is required.');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('Directory path must be absolute.');
  }

  let realPath;
  try {
    realPath = fs.realpathSync(value);
  } catch {
    throw new Error(`Directory does not exist: ${value}`);
  }
  const stats = fs.statSync(realPath);
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${value}`);
  }
  assertAllowedFsPath(realPath, { ...options, kind: 'directory' });
  return realPath;
}
