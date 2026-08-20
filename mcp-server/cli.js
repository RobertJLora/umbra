#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
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

const USAGE = `umbra - companion server for the Umbra Chrome extension

Usage:
  umbra pair [key]           Write the shared key to disk and print the environment
                             block to paste into your MCP client config. With no
                             key, an existing key is reused and a missing one is
                             generated. Pass --rotate to replace an existing key.
  umbra start                Run the MCP server on stdio. This is the command an
                             MCP client should invoke.
  umbra doctor [options]     Run the local diagnostic and print its JSON report.
                             Options are passed straight through.
  umbra broker install       Install and start the optional launchd job that keeps
                             the Rust broker running. Pass --dry-run to print the
                             rendered job and the commands without touching launchd.

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
  return path.join(umbraHome(), 'bin', 'umbra-rust-broker');
}

export function resolveLogDir() {
  return path.join(umbraHome(), LOG_DIR_NAME);
}

export function generateSharedKey() {
  return crypto.randomBytes(SHARED_KEY_BYTES).toString('hex');
}

export function readSharedKeyFile(keyPath) {
  try {
    const contents = fs.readFileSync(keyPath, 'utf8').trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

// writeFileSync applies its mode only when it creates the file, so an existing
// key file keeps whatever mode it already had. The explicit chmod repairs a key
// that was created by hand with a readable mode.
export function writeSharedKeyFile(keyPath, key) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: SHARED_KEY_DIR_MODE });
  fs.writeFileSync(keyPath, `${key}\n`, { mode: SHARED_KEY_FILE_MODE });
  fs.chmodSync(keyPath, SHARED_KEY_FILE_MODE);
  return keyPath;
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
export function buildEnvBlock({ key, keyPath }) {
  return [
    `UMBRA_SHARED_KEY_FILE=${keyPath}`,
    '',
    'or, for a client that cannot reference a file:',
    '',
    `UMBRA_SHARED_KEY=${key}`,
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
  return { command, subcommand, positionals: rest, flags };
}

function rejectUnknownFlags(flags, allowed, command) {
  const unknown = flags.filter((flag) => !allowed.includes(flag.split('=')[0]));
  if (unknown.length > 0) {
    throw new CliError(`Unknown option for "umbra ${command}": ${unknown.join(' ')}`, {
      hint: 'Run "umbra --help" for the full command list.',
    });
  }
}

export function commandPair({ positionals, flags, stdout }) {
  rejectUnknownFlags(flags, ['--rotate'], 'pair');
  if (positionals.length > 1) {
    throw new CliError('umbra pair accepts at most one key argument.');
  }

  const keyPath = resolveSharedKeyPath();
  const supplied = positionals[0]?.trim() || '';
  const rotate = flags.includes('--rotate');
  const existing = readSharedKeyFile(keyPath);

  if (supplied && rotate) {
    throw new CliError('Pass either a key or --rotate, not both.');
  }

  let key = supplied;
  let action = 'wrote the key you supplied to';
  if (!key) {
    if (existing && !rotate) {
      key = existing;
      action = 'reused the existing key at';
    } else {
      key = generateSharedKey();
      action = existing ? 'replaced the key at' : 'generated a new key at';
    }
  }

  writeSharedKeyFile(keyPath, key);
  const mode = describeFileMode(keyPath);

  const lines = [
    `Umbra ${action} ${keyPath} (${mode})`,
    '',
    'Paste this key into the extension options page, in the Shared key field:',
    '',
    `  ${key}`,
    '',
    'Then give your MCP client this environment:',
    '',
    ...buildEnvBlock({ key, keyPath }).map((line) => (line ? `  ${line}` : '')),
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

export function commandDoctor({ flags, positionals, stdout, stderr, spawn = spawnSync }) {
  const script = path.join(__dirname, 'doctor.mjs');
  if (!fs.existsSync(script)) {
    throw new CliError('The diagnostic script (doctor.mjs) is not part of this install.', {
      hint: 'Run it from a checkout of the repository: node mcp-server/doctor.mjs',
    });
  }

  const result = spawn(process.execPath, [script, ...positionals, ...flags], {
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
  void stdout;
  return result.status ?? 1;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/umbra-broker.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/umbra-broker.err.log</string>
</dict>
</plist>
`;

export function loadLaunchdTemplate(repoRoot = path.resolve(__dirname, '..')) {
  const templatePath = path.join(repoRoot, 'launchd', 'dev.umbra.broker.plist.template');
  try {
    return { source: templatePath, text: fs.readFileSync(templatePath, 'utf8') };
  } catch {
    return { source: 'built-in template', text: BUILTIN_LAUNCHD_TEMPLATE };
  }
}

export function renderLaunchdPlist(template, values) {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.split(`__${name}__`).join(xmlEscape(value));
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

export function readPlistLabel(plistText) {
  const match = plistText.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/);
  return match ? match[1].trim() : '';
}

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
  return {
    label: plistLabel,
    configuredLabel: label,
    templateSource: template.source,
    plist,
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${plistLabel}.plist`),
    brokerBin: resolveBrokerBinPath(),
    logDir: resolveLogDir(),
  };
}

function launchctl(args, spawn) {
  return spawn('launchctl', args, { encoding: 'utf8' });
}

export function commandBrokerInstall({ flags, stdout, stderr, spawn = spawnSync }) {
  rejectUnknownFlags(flags, ['--dry-run'], 'broker install');
  const dryRun = flags.includes('--dry-run');
  const job = buildBrokerJob();
  const uid = process.getuid?.() ?? os.userInfo().uid;
  const serviceTarget = `gui/${uid}/${job.label}`;

  if (job.label !== job.configuredLabel) {
    stderr(
      `Note: the template Label is ${job.label} while UMBRA_BROKER_LAUNCHD_LABEL resolves to ${job.configuredLabel}. Installing as ${job.label}.\n`,
    );
  }

  if (dryRun) {
    stdout(
      [
        `Template:   ${job.templateSource}`,
        `Would write: ${job.plistPath}`,
        `Log files:   ${job.logDir}/umbra-broker.log and ${job.logDir}/umbra-broker.err.log`,
        `Would run:   launchctl bootstrap gui/${uid} ${job.plistPath}`,
        `             launchctl enable ${serviceTarget}`,
        `             launchctl kickstart -k ${serviceTarget}`,
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
        `  mkdir -p ${path.dirname(job.brokerBin)} && cp rust-broker/target/release/umbra-rust-broker ${job.brokerBin}`,
        'Or set UMBRA_BROKER_BIN to an existing binary. The broker is optional: without it the companion server uses the pure-Node bridge.',
      ].join('\n'),
    });
  }

  // launchd fails a job whose StandardOutPath directory does not exist.
  fs.mkdirSync(job.logDir, { recursive: true });
  fs.mkdirSync(path.dirname(job.plistPath), { recursive: true });
  fs.writeFileSync(job.plistPath, job.plist, { mode: 0o644 });

  // Booting out a job that is not loaded returns non-zero, which is the normal
  // first-install case rather than a failure.
  launchctl(['bootout', serviceTarget], spawn);
  const bootstrapped = launchctl(['bootstrap', `gui/${uid}`, job.plistPath], spawn);
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
      `  socket:   ${resolveBrokerSocketPath()}`,
      `  logs:     ${job.logDir}`,
      kicked.status === 0
        ? '  status:   started'
        : `  status:   bootstrapped but not started yet (launchctl kickstart exit ${kicked.status})`,
      '',
      `Check it with: node ${path.join(__dirname, 'check-rust-broker.mjs')}`,
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
  const parsed = parseArgs(argv);
  const context = { ...parsed, stdout, stderr, spawn, env };

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
