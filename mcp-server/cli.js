#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  expandUserPath,
  resolveBrokerSocketPath,
  resolveLaunchdLabel,
  resolveSharedKeyPath,
} from './config.js';

// One entry point for the companion server, so a public install has a single
// command from "just installed" to "paired and running":
//
//   umbra pair [key]        write the shared key and print the client config
//   umbra start             run the MCP server on stdio (what a client invokes)
//   umbra doctor            run the local diagnostic
//   umbra broker install    install the optional launchd job for the Rust broker
//
// The `bin` mapping that makes `npx umbra` work lives in package.json.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHARED_KEY_BYTES = 32;
const SHARED_KEY_FILE_MODE = 0o600;
const SHARED_KEY_DIR_MODE = 0o700;
const LOG_DIR_NAME = 'logs';
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+__/g;
// A separate non-global copy. `test` on a global regex advances lastIndex, so
// reusing PLACEHOLDER_PATTERN inside a replace callback would corrupt the very
// scan that invoked it.
const PLACEHOLDER_PROBE = /__[A-Z0-9_]+__/;

const USAGE = `umbra - companion server for the Umbra Chrome extension

Usage:
  umbra pair [key]           Write the shared key to disk and print the environment
                             block to paste into your MCP client config. With no
                             key, an existing key is reused and a missing one is
                             generated. Pass --rotate to replace an existing key.
                             A key passed as an argument lands in shell history and
                             in ps output, so prefer --stdin or --key-file.
  umbra start                Run the MCP server on stdio. This is the command an
                             MCP client should invoke.
  umbra doctor [options]     Run the local diagnostic and print its JSON report.
                             Options are passed straight through.
  umbra broker install       Install and start the optional launchd job that keeps
                             the Rust broker running. Pass --dry-run to print the
                             rendered job and the commands without touching launchd.

Options for "umbra pair":
  --rotate                   Replace an existing key with a fresh one
  --stdin                    Read the key from standard input
  --key-file <path>          Read the key from a file
  --quiet                    Confirm the pairing without reprinting the key

Options for "umbra broker install":
  --dry-run                  Print the rendered job and the commands only
  --force                    Install even when the rendered job disagrees with
                             this server's resolved label

Options:
  -h, --help                 Show this help
  -v, --version              Show the companion server version

Every path is configurable through the environment: UMBRA_SHARED_KEY,
UMBRA_SHARED_KEY_FILE, UMBRA_DOWNLOAD_DIR, UMBRA_BROKER_SOCKET,
UMBRA_BROKER_LAUNCHD_LABEL, UMBRA_BROKER_BIN.`;

// A failure the user can act on. Anything else keeps its stack, because an
// unexpected throw is a bug report rather than a message to read and fix.
export class CliError extends Error {
  constructor(message, { exitCode = 1, hint = '' } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

function umbraHome() {
  return path.join(os.homedir(), '.umbra');
}

export function resolveBrokerBinPath() {
  const configured = process.env.UMBRA_BROKER_BIN?.trim();
  if (configured) {
    return configured;
  }
  // The path launch-mcp.sh copies the built binary to, which is also where the
  // launchd job has always pointed.
  return path.join(umbraHome(), 'bin', 'Umbra Helper');
}

export function resolveLogDir() {
  return path.join(umbraHome(), LOG_DIR_NAME);
}

export function generateSharedKey() {
  return crypto.randomBytes(SHARED_KEY_BYTES).toString('hex');
}

// A key file that exists but cannot be read is a different situation from one
// that is absent: the first must never be silently replaced with a fresh key,
// because the extension is still paired on the key nobody can read.
export function inspectSharedKeyFile(keyPath) {
  let stat;
  try {
    stat = fs.lstatSync(keyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: 'absent', key: null, mode: null };
    }
    return { state: 'unreadable', key: null, mode: null, code: error?.code || 'EACCES' };
  }
  if (stat.isSymbolicLink()) {
    return { state: 'symlink', key: null, mode: null };
  }
  if (stat.isDirectory()) {
    return { state: 'directory', key: null, mode: null };
  }
  try {
    const contents = fs.readFileSync(keyPath, 'utf8').trim();
    return {
      state: contents.length > 0 ? 'present' : 'empty',
      key: contents.length > 0 ? contents : null,
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    return { state: 'unreadable', key: null, mode: stat.mode & 0o777, code: error?.code || 'EACCES' };
  }
}

export function readSharedKeyFile(keyPath) {
  return inspectSharedKeyFile(keyPath).key;
}

// Ordinary, user-fixable filesystem states. Reporting them as a Node stack sends
// a person hunting a bug in this file instead of running the one command that
// clears the condition.
function keyFileWriteError(error, keyPath) {
  const remedies = {
    EISDIR: `${keyPath} is a directory. Remove it and rerun "umbra pair".`,
    ENOTDIR: `A path component of ${keyPath} is a file, not a directory. Remove it and rerun "umbra pair".`,
    EACCES: `No permission to write ${keyPath}. Fix the mode on it or on its parent directory.`,
    EPERM: `No permission to write ${keyPath}. Fix the mode on it or on its parent directory.`,
    EROFS: `${keyPath} is on a read-only filesystem. Set UMBRA_SHARED_KEY_FILE to a writable path.`,
    ENOSPC: `No space left to write ${keyPath}.`,
  };
  const remedy = remedies[error?.code];
  if (!remedy) {
    return error;
  }
  return new CliError(`Cannot write the shared key: ${remedy}`, {
    hint: 'Or set UMBRA_SHARED_KEY_FILE to a path you can write.',
  });
}

// writeFileSync applies its mode only when it creates the file, so an existing
// key file keeps whatever mode it already had, and mkdirSync applies its mode
// only when it creates the directory. Both are repaired explicitly. The write
// goes to a private temp file and is renamed onto the final path, so two
// concurrent `umbra pair --rotate` runs cannot interleave a partial write, and
// the caller can read the file back to learn which key actually won.
export function writeSharedKeyFile(keyPath, key) {
  const directory = path.dirname(keyPath);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: SHARED_KEY_DIR_MODE });
    const directoryMode = fs.statSync(directory).mode & 0o777;
    if (directoryMode & 0o077) {
      fs.chmodSync(directory, SHARED_KEY_DIR_MODE);
    }

    // Writing through a symlink truncates whatever it points at, and the link
    // survives, so the substitution is invisible in a later listing.
    const existing = fs.lstatSync(keyPath, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      throw new CliError(`The shared key path ${keyPath} is a symlink.`, {
        hint: 'Remove the link and rerun "umbra pair", or point UMBRA_SHARED_KEY_FILE at a real file.',
      });
    }
    if (existing?.isDirectory()) {
      throw new CliError(`Cannot write the shared key: ${keyPath} is a directory.`, {
        hint: 'Remove it and rerun "umbra pair".',
      });
    }

    const tempPath = `${keyPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, `${key}\n`, { mode: SHARED_KEY_FILE_MODE, flag: 'w' });
    fs.chmodSync(tempPath, SHARED_KEY_FILE_MODE);
    fs.renameSync(tempPath, keyPath);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw keyFileWriteError(error, keyPath);
  }
  return keyPath;
}

// The previous secret exists in exactly one place on disk, so replacing it is
// irreversible unless a copy is kept. Timestamped so a second rotation does not
// overwrite the first backup.
export function backupSharedKeyFile(keyPath, key) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${keyPath}.bak-${stamp}`;
  try {
    fs.writeFileSync(backupPath, `${key}\n`, { mode: SHARED_KEY_FILE_MODE, flag: 'w' });
    fs.chmodSync(backupPath, SHARED_KEY_FILE_MODE);
    return backupPath;
  } catch {
    return '';
  }
}

// The generator emits 32 random bytes as 64 hex characters. Anything without
// that much entropy is not a key, and a value carrying whitespace or a control
// character silently breaks both the printed environment block and the file
// round trip, because the loader trims what it reads.
export const SHARED_KEY_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

export function assertUsableSharedKey(key) {
  const value = String(key ?? '');
  if (!SHARED_KEY_PATTERN.test(value)) {
    throw new CliError(
      'That key is not a usable shared key.',
      {
        hint: [
          'A key is 32 to 512 characters of letters, digits, "-" or "_", with no spaces,',
          'newlines, or control characters. The generator writes 64 hex characters.',
          'Run "umbra pair --rotate" to have one generated, or paste the value the',
          'extension options page Generate button produced.',
        ].join('\n'),
      },
    );
  }
  return value;
}

// Any path this CLI prints for a person to paste has to survive a shell. A home
// directory with a space in it, and the binary name "Umbra Helper", both break
// an unquoted command line.
export function shellQuote(value) {
  const text = String(value ?? '');
  if (text !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function describeFileMode(filePath) {
  const bits = fs.statSync(filePath).mode & 0o777;
  const flags = ['r', 'w', 'x'];
  let out = '-';
  for (let group = 2; group >= 0; group -= 1) {
    for (let bit = 2; bit >= 0; bit -= 1) {
      out += (bits >> (group * 3 + bit)) & 1 ? flags[2 - bit] : '-';
    }
  }
  return out;
}

// The block a user pastes into an MCP client config. The key file is the
// recommended form because the key then lives in one place with a private mode;
// the inline variable is there for clients that cannot read a file path.
export function buildEnvBlock({ key, keyPath, quiet = false }) {
  return [
    `UMBRA_SHARED_KEY_FILE=${keyPath}`,
    '',
    'or, for a client that cannot reference a file:',
    '',
    quiet ? 'UMBRA_SHARED_KEY=<the key in that file>' : `UMBRA_SHARED_KEY=${key}`,
  ];
}

export function buildClientConfigSnippet({ keyPath }) {
  return JSON.stringify(
    {
      mcpServers: {
        umbra: {
          command: 'npx',
          args: ['-y', '@umbra-mcp/server', 'start'],
          env: { UMBRA_SHARED_KEY_FILE: keyPath },
        },
      },
    },
    null,
    2,
  );
}

function readPackageVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return manifest.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// argv is already stripped of the node binary and the script path.
export function parseArgs(argv) {
  const args = [...argv];
  const flags = [];
  const positionals = [];
  for (const arg of args) {
    if (arg.startsWith('-')) {
      flags.push(arg);
    } else {
      positionals.push(arg);
    }
  }

  if (flags.includes('-h') || flags.includes('--help') || positionals[0] === 'help') {
    return { command: 'help', subcommand: '', positionals: [], flags };
  }
  if (flags.includes('-v') || flags.includes('--version')) {
    return { command: 'version', subcommand: '', positionals: [], flags };
  }

  const command = positionals[0] || '';
  const subcommand = command === 'broker' ? positionals[1] || '' : '';
  const rest = command === 'broker' ? positionals.slice(2) : positionals.slice(1);
  // The raw tail in its original order. Splitting argv into flags and
  // positionals hoists a space-separated option value in front of the flag it
  // belongs to, so anything forwarded to a child process gets the untouched
  // sequence instead.
  const skip = command === 'broker' ? 2 : (command ? 1 : 0);
  let seen = 0;
  const raw = args.filter((arg) => {
    if (!arg.startsWith('-') && seen < skip) {
      seen += 1;
      return false;
    }
    return true;
  });
  return { command, subcommand, positionals: rest, flags, raw };
}

// A boolean flag that arrives with a value is rejected rather than allowlisted
// and then ignored. `--rotate=true` used to pass this check and then fail the
// exact-match test in commandPair, so a person who believed they had rotated a
// compromised key had not.
function rejectUnknownFlags(flags, allowed, command, { valueFlags = [] } = {}) {
  const problems = [];
  for (const flag of flags) {
    const name = flag.split('=')[0];
    if (!allowed.includes(name)) {
      problems.push(`Unknown option for "umbra ${command}": ${flag}`);
      continue;
    }
    if (flag.includes('=') && !valueFlags.includes(name)) {
      problems.push(`"umbra ${command}" option ${name} takes no value, but got ${flag}`);
    }
  }
  if (problems.length > 0) {
    throw new CliError(problems.join('\n'), {
      hint: 'Run "umbra --help" for the full command list.',
    });
  }
}

function flagValue(rawArgs, name) {
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === name) {
      return rawArgs[index + 1] ?? '';
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

function readKeyFromFile(rawPath) {
  const keyFilePath = path.resolve(expandUserPath(String(rawPath || '').trim()));
  let contents;
  try {
    contents = fs.readFileSync(keyFilePath, 'utf8');
  } catch (error) {
    throw new CliError(`Could not read the key file ${keyFilePath}: ${error?.code || error?.message}.`, {
      hint: 'Point --key-file at a readable file holding the key on its own line.',
    });
  }
  return contents.trim();
}

function readKeyFromStdin() {
  let contents;
  try {
    contents = fs.readFileSync(0, 'utf8');
  } catch (error) {
    throw new CliError(`Could not read the key from standard input: ${error?.code || error?.message}.`);
  }
  return contents.trim();
}

export function commandPair({ positionals, flags, raw = [], stdout, stderr = () => {} }) {
  rejectUnknownFlags(flags, ['--rotate', '--stdin', '--key-file', '--quiet'], 'pair', {
    valueFlags: ['--key-file'],
  });
  if (positionals.length > 1) {
    throw new CliError('umbra pair accepts at most one key argument.');
  }

  const keyPath = resolveSharedKeyPath();
  const rotate = flags.includes('--rotate');
  const quiet = flags.includes('--quiet');
  const useStdin = flags.includes('--stdin');
  const keyFileArg = flagValue(raw, '--key-file');
  const existing = inspectSharedKeyFile(keyPath);

  const sources = [];
  if (positionals[0]?.trim()) sources.push('a key argument');
  if (useStdin) sources.push('--stdin');
  if (keyFileArg !== null) sources.push('--key-file');
  if (sources.length > 1) {
    throw new CliError(`Pass the key exactly one way, but got ${sources.join(' and ')}.`);
  }

  let supplied = '';
  if (positionals[0]?.trim()) {
    supplied = positionals[0].trim();
    stderr('Note: a key passed as an argument lands in shell history and in ps output. Prefer "umbra pair --stdin" or "umbra pair --key-file <path>".\n');
  } else if (useStdin) {
    supplied = readKeyFromStdin();
  } else if (keyFileArg !== null) {
    if (!String(keyFileArg).trim()) {
      throw new CliError('umbra pair --key-file needs a path.');
    }
    supplied = readKeyFromFile(keyFileArg);
  }

  if (supplied && rotate) {
    throw new CliError('Pass either a key or --rotate, not both.');
  }
  if (supplied) {
    assertUsableSharedKey(supplied);
  }

  if (existing.state === 'unreadable') {
    throw new CliError(`The shared key file ${keyPath} exists but cannot be read (${existing.code}).`, {
      hint: 'Fix its mode, or move it aside first. Generating a replacement over a key nobody can read would silently unpair the extension.',
    });
  }

  let key = supplied;
  let action = 'wrote the key you supplied to';
  if (!key) {
    if (existing.key && !rotate) {
      key = existing.key;
      action = 'reused the existing key at';
    } else {
      key = generateSharedKey();
      action = existing.key ? 'replaced the key at' : 'generated a new key at';
    }
  }

  const replacing = Boolean(existing.key) && existing.key !== key;
  const backupPath = replacing ? backupSharedKeyFile(keyPath, existing.key) : '';

  writeSharedKeyFile(keyPath, key);
  // Read the file back rather than trusting the in-memory value, so two
  // concurrent runs both report the key that actually won the rename.
  const onDisk = readSharedKeyFile(keyPath);
  if (onDisk && onDisk !== key) {
    key = onDisk;
    action = 'found another pairing run had just written';
  }
  const mode = describeFileMode(keyPath);

  if (existing.mode !== null && (existing.mode & 0o077)) {
    stderr(`Note: the previous key file was mode ${existing.mode.toString(8)}, so other accounts on this machine could read it. Rotate it with "umbra pair --rotate" if that key was ever live.\n`);
  }

  const lines = [
    `Umbra ${action} ${keyPath} (${mode})`,
    ...(backupPath ? ['', `The previous key was copied to ${backupPath}`] : []),
    ...(quiet
      ? ['', 'The key is on disk. Rerun without --quiet to print it.']
      : [
        '',
        'Paste this key into the extension options page, in the Shared key field:',
        '',
        `  ${key}`,
      ]),
    '',
    'Then give your MCP client this environment:',
    '',
    ...buildEnvBlock({ key, keyPath, quiet }).map((line) => (line ? `  ${line}` : '')),
    '',
    'A full client entry looks like this:',
    '',
    ...buildClientConfigSnippet({ keyPath }).split('\n').map((line) => `  ${line}`),
    '',
    'The extension and this server pair on that one key. Change it in both places',
    'or neither.',
  ];
  stdout(`${lines.join('\n')}\n`);
  return 0;
}

// index.js reads UMBRA_SHARED_KEY_FILE only from the environment, so a user who
// ran `umbra pair` and left the variable unset would otherwise be told no key is
// configured while the canonical key file sits right there. An explicitly set
// variable always wins.
export function resolveStartSharedKey(env = process.env) {
  if (env.UMBRA_SHARED_KEY?.trim()) {
    return { source: 'UMBRA_SHARED_KEY', path: '' };
  }

  const configured = env.UMBRA_SHARED_KEY_FILE?.trim();
  if (configured) {
    if (!readSharedKeyFile(configured)) {
      throw new CliError(
        `UMBRA_SHARED_KEY_FILE points at ${configured}, which is missing or empty.`,
        { hint: 'Run "umbra pair" to write a key there, or correct the variable.' },
      );
    }
    return { source: 'UMBRA_SHARED_KEY_FILE', path: configured };
  }

  const defaultPath = resolveSharedKeyPath();
  if (readSharedKeyFile(defaultPath)) {
    return { source: 'default key file', path: defaultPath };
  }

  throw new CliError('No shared key configured, so the extension has nothing to pair with.', {
    hint: [
      'Fix it either way:',
      '  - run "umbra pair", which writes the key file and prints the block to paste, or',
      '  - click Generate on the Umbra extension options page and set UMBRA_SHARED_KEY',
      `    or UMBRA_SHARED_KEY_FILE (canonically ${defaultPath}) in your MCP client config.`,
    ].join('\n'),
  });
}

export async function commandStart({ flags, env = process.env }) {
  rejectUnknownFlags(flags, [], 'start');
  const key = resolveStartSharedKey(env);
  if (key.source === 'default key file') {
    env.UMBRA_SHARED_KEY_FILE = key.path;
  }

  const { main } = await import('./index.js');
  await main();
  // main() owns the process from here: it holds the stdio transport open and
  // exits through its own shutdown path.
  return 0;
}

// The published package's files allowlist covers the server and its runtime
// dependencies, not the development harness, so doctor.mjs is present in a
// checkout and absent from an npm install. Say which one this is rather than
// letting node report a module it cannot find.
// doctor.mjs exits with this status after printing a plain one-line message for
// a bad option, so the wrapper can report it the way every other subcommand
// reports a bad option instead of letting a child stack trace through.
export const DOCTOR_USAGE_EXIT_CODE = 2;

export function commandDoctor({
  flags,
  positionals,
  raw = null,
  stdout,
  stderr,
  spawn = spawnSync,
  scriptPath = path.join(__dirname, 'doctor.mjs'),
}) {
  const script = scriptPath;
  if (!fs.existsSync(script)) {
    throw new CliError('The diagnostic script (doctor.mjs) is not part of this install.', {
      hint: 'Run it from a checkout of the repository: node mcp-server/doctor.mjs',
    });
  }

  // Forward the tail exactly as it was typed. Rebuilding it from the split
  // positionals and flags moved `--ttl-ms 5000` to `5000 --ttl-ms`, so every
  // space-separated option value failed while its `=` form worked.
  const forwarded = Array.isArray(raw) ? raw : [...positionals, ...flags];
  const result = spawn(process.execPath, [script, ...forwarded], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw new CliError(`Could not run the diagnostic: ${result.error.message}`);
  }
  if (result.signal) {
    stderr(`umbra doctor stopped on signal ${result.signal}\n`);
    return 1;
  }
  if (result.status === DOCTOR_USAGE_EXIT_CODE) {
    throw new CliError('The diagnostic rejected one of its options.', {
      hint: 'Doctor options are --fix, --dry-run, --verify-health, --ttl-ms <ms>, and --min-age-ms <ms>.',
    });
  }
  void stdout;
  return result.status ?? 1;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlUnescape(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Kept in the same placeholder shape as launchd/dev.umbra.broker.plist.template
// so both render through one code path. This copy is what the published package
// uses, since the npm files allowlist covers mcp-server only.
export const BUILTIN_LAUNCHD_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>__LABEL__</string>
  <key>ProgramArguments</key>
  <array>
    <string>__BROKER_BIN__</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__HOME__/.umbra</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>UMBRA_SHARED_KEY_FILE</key>
    <string>__SHARED_KEY_FILE__</string>
    <key>UMBRA_BROKER_SOCKET</key>
    <string>__BROKER_SOCKET__</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>4096</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/broker.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/broker.err.log</string>
</dict>
</plist>
`;

// The repository template carries an authoring comment explaining how to render
// it. Substituting inside that comment produces an installed job file whose own
// instructions contradict it, so the comments come out before rendering and the
// two templates then render byte-identical output for the same inputs.
export function stripPlistComments(text) {
  return String(text).replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm, '');
}

export function loadLaunchdTemplate(repoRoot = path.resolve(__dirname, '..')) {
  const templatePath = path.join(repoRoot, 'launchd', 'dev.umbra.broker.plist.template');
  try {
    return { source: templatePath, text: stripPlistComments(fs.readFileSync(templatePath, 'utf8')) };
  } catch {
    return { source: 'built-in template', text: BUILTIN_LAUNCHD_TEMPLATE };
  }
}

// One pass over the document, so a value that happens to contain another
// placeholder is inserted verbatim rather than rescanned and expanded by a later
// iteration. Placeholders the caller did not supply survive for the guard below,
// which is what tells a template apart from a bad value.
export function renderLaunchdPlist(template, values) {
  const supplied = new Map(Object.entries(values).map(([name, value]) => [`__${name}__`, value]));
  const inserted = [];
  const rendered = String(template).replace(PLACEHOLDER_PATTERN, (match) => {
    if (!supplied.has(match)) {
      return match;
    }
    const value = String(supplied.get(match));
    if (PLACEHOLDER_PROBE.test(value)) {
      inserted.push(`${match} was filled with ${value}, which itself contains a placeholder`);
    }
    return xmlEscape(value);
  });
  if (inserted.length > 0) {
    throw new CliError(`A launchd job value carries a template placeholder: ${inserted.join('; ')}`, {
      hint: 'Set the offending environment variable to a literal path.',
    });
  }
  const unresolved = [...new Set(rendered.match(PLACEHOLDER_PATTERN) || [])];
  if (unresolved.length > 0) {
    throw new CliError(
      `The launchd template has placeholders this version cannot fill: ${unresolved.join(', ')}`,
      { hint: 'Update the template, or fill those values by hand after rendering.' },
    );
  }
  return rendered;
}

export function readPlistString(plistText, key) {
  const literal = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = plistText.match(new RegExp(`<key>${literal}</key>\\s*<string>([^<]*)</string>`));
  return match ? xmlUnescape(match[1]).trim() : '';
}

export function readPlistLabel(plistText) {
  return readPlistString(plistText, 'Label');
}

export function readPlistProgram(plistText) {
  const block = plistText.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) {
    return '';
  }
  const first = block[1].match(/<string>([^<]*)<\/string>/);
  return first ? xmlUnescape(first[1]).trim() : '';
}

// launchd reads the rendered file, not the values that went into it, and the
// repository template carries its own literal paths where the built-in copy
// carries placeholders. Reading the rendered plist back is the only way the
// existence check, the log directory this command creates, and the summary it
// prints are guaranteed to describe the job launchd will actually run.
export function buildBrokerJob({ repoRoot } = {}) {
  const home = os.homedir();
  const label = resolveLaunchdLabel();
  const template = loadLaunchdTemplate(repoRoot ?? path.resolve(__dirname, '..'));
  const plist = renderLaunchdPlist(template.text, {
    HOME: home,
    LABEL: label,
    BROKER_BIN: resolveBrokerBinPath(),
    SHARED_KEY_FILE: resolveSharedKeyPath(),
    BROKER_SOCKET: resolveBrokerSocketPath(),
    LOG_DIR: resolveLogDir(),
  });
  // The rendered Label is the authority for the filename, because launchd
  // refuses a job whose file name and Label disagree.
  const plistLabel = readPlistLabel(plist) || label;
  const brokerBin = readPlistProgram(plist) || resolveBrokerBinPath();
  const stdoutLog = readPlistString(plist, 'StandardOutPath');
  const stderrLog = readPlistString(plist, 'StandardErrorPath');
  const logPaths = [stdoutLog, stderrLog].filter(Boolean);
  const logDirs = [...new Set(logPaths.map((file) => path.dirname(file)))];
  return {
    label: plistLabel,
    configuredLabel: label,
    templateSource: template.source,
    plist,
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${plistLabel}.plist`),
    brokerBin,
    socketPath: readPlistString(plist, 'UMBRA_BROKER_SOCKET') || resolveBrokerSocketPath(),
    sharedKeyFile: readPlistString(plist, 'UMBRA_SHARED_KEY_FILE') || resolveSharedKeyPath(),
    logPaths,
    logDirs: logDirs.length > 0 ? logDirs : [resolveLogDir()],
  };
}

function launchctl(args, spawn) {
  return spawn('launchctl', args, { encoding: 'utf8' });
}

export function commandBrokerInstall({ flags, stdout, stderr, spawn = spawnSync, buildJob = buildBrokerJob }) {
  rejectUnknownFlags(flags, ['--dry-run', '--force'], 'broker install');
  const dryRun = flags.includes('--dry-run');
  const force = flags.includes('--force');
  const job = buildJob();
  const uid = process.getuid?.() ?? os.userInfo().uid;
  const serviceTarget = `gui/${uid}/${job.label}`;

  // The rendered file wins, so any value in it that disagrees with what this
  // server resolves means the server would look for a broker that is not there.
  // Say so at install time instead of leaving it to a failed connection later.
  for (const [name, fromPlist, resolved] of [
    ['broker socket', job.socketPath, resolveBrokerSocketPath()],
    ['shared key file', job.sharedKeyFile, resolveSharedKeyPath()],
    ['broker binary', job.brokerBin, resolveBrokerBinPath()],
  ]) {
    if (fromPlist && resolved && fromPlist !== resolved) {
      stderr(
        `Note: the job file sets ${name} to ${fromPlist} while this server resolves ${resolved}. The job file wins; set the matching environment variable for the server, or edit ${job.templateSource}.\n`,
      );
    }
  }

  // The Label is different in kind from the other three: install boots out and
  // replaces the service the rendered Label names, so a template whose Label
  // disagrees with the configured one tears down a job the caller never asked
  // about. Refuse instead of warning.
  if (!force && job.label && job.configuredLabel && job.label !== job.configuredLabel) {
    throw new CliError(
      `The rendered job is labelled ${job.label} while this install resolves ${job.configuredLabel}.`,
      {
        hint: `Installing would boot out and replace ${job.label}. Fix ${job.templateSource} so its Label renders from __LABEL__, unset UMBRA_BROKER_LAUNCHD_LABEL, or pass --force to install over ${job.label} on purpose.`,
      },
    );
  }

  if (dryRun) {
    stdout(
      [
        `Template:    ${job.templateSource}`,
        `Would write: ${job.plistPath}`,
        `Binary:      ${job.brokerBin}`,
        `Log files:   ${job.logPaths.join(' and ')}`,
        `Would run:   launchctl bootstrap gui/${uid} ${shellQuote(job.plistPath)}`,
        `             launchctl enable ${shellQuote(serviceTarget)}`,
        `             launchctl kickstart -k ${shellQuote(serviceTarget)}`,
        '',
        job.plist,
      ].join('\n'),
    );
    return 0;
  }

  if (process.platform !== 'darwin') {
    throw new CliError('launchd jobs are macOS only.', {
      hint: 'On Linux, run the broker under systemd or start it yourself; the companion server falls back to the pure-Node bridge either way.',
    });
  }

  if (!fs.existsSync(job.brokerBin)) {
    throw new CliError(`No Rust broker binary at ${job.brokerBin}.`, {
      hint: [
        'Build and stage it first:',
        '  cargo build --release --manifest-path rust-broker/Cargo.toml',
        `  mkdir -p ${shellQuote(path.dirname(job.brokerBin))} && cp rust-broker/target/release/umbra-rust-broker ${shellQuote(job.brokerBin)}`,
        'Or set UMBRA_BROKER_BIN to an existing binary and rerun. The broker is optional: without it the companion server uses the pure-Node bridge.',
      ].join('\n'),
    });
  }

  // launchd fails a job whose StandardOutPath directory does not exist, and it
  // reports that as a generic spawn failure rather than a missing directory.
  for (const dir of job.logDirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.dirname(job.plistPath), { recursive: true });
  fs.writeFileSync(job.plistPath, job.plist, { mode: 0o644 });

  // Booting out a job that is not loaded returns non-zero, which is the normal
  // first-install case rather than a failure. When a job WAS loaded, launchd
  // tears it down asynchronously after bootout returns, and a bootstrap issued
  // inside that window fails with a generic input/output error, so a failed
  // bootstrap is retried briefly before it is reported.
  launchctl(['bootout', serviceTarget], spawn);
  let bootstrapped = launchctl(['bootstrap', `gui/${uid}`, job.plistPath], spawn);
  for (let attempt = 0; bootstrapped.status !== 0 && attempt < 4; attempt += 1) {
    spawnSync('sleep', ['0.5']);
    bootstrapped = launchctl(['bootstrap', `gui/${uid}`, job.plistPath], spawn);
  }
  if (bootstrapped.status !== 0) {
    throw new CliError(
      `launchctl bootstrap failed for ${job.label}: ${(bootstrapped.stderr || bootstrapped.stdout || '').trim() || `exit ${bootstrapped.status}`}`,
      { hint: `The job file is written at ${job.plistPath}; fix the reported problem and rerun.` },
    );
  }
  launchctl(['enable', serviceTarget], spawn);
  const kicked = launchctl(['kickstart', '-k', serviceTarget], spawn);

  stdout(
    [
      `Installed ${job.label}`,
      `  job file: ${job.plistPath}`,
      `  binary:   ${job.brokerBin}`,
      `  socket:   ${job.socketPath}`,
      `  logs:     ${job.logPaths.join(' and ')}`,
      kicked.status === 0
        ? '  status:   started'
        : `  status:   bootstrapped but not started yet (launchctl kickstart exit ${kicked.status})`,
      '',
      `Check it with: node ${shellQuote(path.join(__dirname, 'check-rust-broker.mjs'))}`,
    ].join('\n') + '\n',
  );
  return 0;
}

export function commandBroker(context) {
  if (context.subcommand === 'install') {
    return commandBrokerInstall(context);
  }
  if (!context.subcommand) {
    throw new CliError('umbra broker needs a subcommand.', { hint: 'The only one is "umbra broker install".' });
  }
  throw new CliError(`Unknown broker subcommand: ${context.subcommand}`, {
    hint: 'The only one is "umbra broker install".',
  });
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text));
  const stderr = io.stderr || ((text) => process.stderr.write(text));
  const spawn = io.spawn || spawnSync;
  const env = io.env || process.env;
  const buildJob = io.buildJob || buildBrokerJob;
  const parsed = parseArgs(argv);
  const context = { ...parsed, stdout, stderr, spawn, env, buildJob };

  switch (parsed.command) {
    case 'help':
      stdout(`${USAGE}\n`);
      return 0;
    case 'version':
      stdout(`${readPackageVersion()}\n`);
      return 0;
    case 'pair':
      return commandPair(context);
    case 'start':
      return await commandStart(context);
    case 'doctor':
      return commandDoctor(context);
    case 'broker':
      return commandBroker(context);
    case '':
      stderr(`${USAGE}\n`);
      return 1;
    default:
      throw new CliError(`Unknown command: ${parsed.command}`, {
        hint: 'Commands are pair, start, doctor, and broker install. Run "umbra --help".',
      });
  }
}

async function main() {
  try {
    const code = await runCli(process.argv.slice(2));
    if (code !== 0) {
      process.exitCode = code;
    }
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`umbra: ${error.message}\n`);
      if (error.hint) {
        process.stderr.write(`${error.hint}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`umbra: ${error?.stack || error?.message || error}\n`);
    process.exitCode = 1;
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    // npm installs the bin as a symlink, so compare against the real path.
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  await main();
}
