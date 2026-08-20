import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_LAUNCHD_TEMPLATE,
  CliError,
  buildBrokerJob,
  buildClientConfigSnippet,
  buildEnvBlock,
  commandBrokerInstall,
  commandDoctor,
  commandPair,
  describeFileMode,
  generateSharedKey,
  loadLaunchdTemplate,
  parseArgs,
  readPlistLabel,
  readPlistProgram,
  readPlistString,
  readSharedKeyFile,
  renderLaunchdPlist,
  resolveBrokerBinPath,
  resolveStartSharedKey,
  runCli,
  writeSharedKeyFile,
} from '../../mcp-server/cli.js';
import {
  AUTHOR_HANDLE_RE,
  AUTHOR_LAUNCHD_LABEL_RE,
  AUTHOR_NAME_RE,
  AUTHOR_SURNAME_RE,
  HOME_PATH_RE,
} from '../identity-needles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const cliScript = path.join(repoRoot, 'mcp-server', 'cli.js');
const cliSource = fs.readFileSync(cliScript, 'utf8');

const tempRoots = [];

function makeTempDir(prefix = 'umbra-cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Every test that touches the shared key runs against a throwaway path, so a
// run of this suite can never read or overwrite the key file a real install
// pairs on.
function withKeyPath(run) {
  const dir = makeTempDir();
  const keyPath = path.join(dir, '.umbra', 'shared-key');
  const previous = process.env.UMBRA_SHARED_KEY_FILE;
  const previousInline = process.env.UMBRA_SHARED_KEY;
  process.env.UMBRA_SHARED_KEY_FILE = keyPath;
  delete process.env.UMBRA_SHARED_KEY;
  try {
    return run(keyPath, dir);
  } finally {
    if (previous === undefined) {
      delete process.env.UMBRA_SHARED_KEY_FILE;
    } else {
      process.env.UMBRA_SHARED_KEY_FILE = previous;
    }
    if (previousInline === undefined) {
      delete process.env.UMBRA_SHARED_KEY;
    } else {
      process.env.UMBRA_SHARED_KEY = previousInline;
    }
  }
}

function collector() {
  const chunks = [];
  const write = (text) => chunks.push(text);
  write.text = () => chunks.join('');
  return write;
}

async function invoke(argv, io = {}) {
  const stdout = io.stdout || collector();
  const stderr = io.stderr || collector();
  const code = await runCli(argv, { ...io, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function runCliProcess(args, env = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = execFile(
      process.execPath,
      [cliScript, ...args],
      { env: { ...process.env, ...env }, timeout: 20_000 },
      () => {},
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('umbra cli argument parsing', () => {
  it('routes help, version, and the broker subcommand', () => {
    assert.equal(parseArgs(['--help']).command, 'help');
    assert.equal(parseArgs(['-h']).command, 'help');
    assert.equal(parseArgs(['help']).command, 'help');
    assert.equal(parseArgs(['-v']).command, 'version');
    assert.equal(parseArgs(['--version']).command, 'version');

    const broker = parseArgs(['broker', 'install', '--dry-run']);
    assert.equal(broker.command, 'broker');
    assert.equal(broker.subcommand, 'install');
    assert.deepEqual(broker.flags, ['--dry-run']);

    const pair = parseArgs(['pair', 'abc123', '--rotate']);
    assert.equal(pair.command, 'pair');
    assert.deepEqual(pair.positionals, ['abc123']);
    assert.deepEqual(pair.flags, ['--rotate']);
  });

  it('prints usage naming all four subcommands and exits 0 on --help', async () => {
    const { code, stdout } = await invoke(['--help']);
    assert.equal(code, 0);
    for (const command of ['umbra pair', 'umbra start', 'umbra doctor', 'umbra broker install']) {
      assert.ok(stdout.includes(command), `usage is missing ${command}`);
    }
  });

  it('exits non-zero with usage on stderr when no command is given', async () => {
    const { code, stdout, stderr } = await invoke([]);
    assert.notEqual(code, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /Usage:/);
  });

  it('names the unknown command rather than failing silently', async () => {
    await assert.rejects(() => invoke(['pear']), (error) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /Unknown command: pear/);
      assert.match(error.hint, /pair, start, doctor, and broker install/);
      return true;
    });
  });

  it('reports the version as a bare string', async () => {
    const { code, stdout } = await invoke(['--version']);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});

describe('umbra pair', () => {
  it('writes a generated key with mode -rw------- and prints the environment block', () => {
    withKeyPath((keyPath) => {
      const stdout = collector();
      const code = commandPair({ positionals: [], flags: [], stdout });
      assert.equal(code, 0);

      const key = readSharedKeyFile(keyPath);
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.equal(describeFileMode(keyPath), '-rw-------');

      const text = stdout.text();
      assert.ok(text.includes(keyPath), 'output does not name the key file');
      assert.ok(text.includes(key), 'output does not print the key to paste into the options page');
      assert.ok(text.includes(`UMBRA_SHARED_KEY_FILE=${keyPath}`));
      assert.ok(text.includes(`UMBRA_SHARED_KEY=${key}`));
    });
  });

  it('prints a client entry that parses as JSON and carries the key file', () => {
    withKeyPath((keyPath) => {
      const snippet = JSON.parse(buildClientConfigSnippet({ keyPath }));
      assert.equal(snippet.mcpServers.umbra.env.UMBRA_SHARED_KEY_FILE, keyPath);
      assert.deepEqual(snippet.mcpServers.umbra.args.slice(-1), ['start']);

      const block = buildEnvBlock({ key: 'k', keyPath });
      assert.ok(block.includes(`UMBRA_SHARED_KEY_FILE=${keyPath}`));
      assert.ok(block.includes('UMBRA_SHARED_KEY=k'));
    });
  });

  it('reuses an existing key, rotates only when asked, and writes a supplied key verbatim', () => {
    withKeyPath((keyPath) => {
      commandPair({ positionals: [], flags: [], stdout: collector() });
      const first = readSharedKeyFile(keyPath);

      commandPair({ positionals: [], flags: [], stdout: collector() });
      assert.equal(readSharedKeyFile(keyPath), first, 'a second pair rotated the key');

      commandPair({ positionals: [], flags: ['--rotate'], stdout: collector() });
      const rotated = readSharedKeyFile(keyPath);
      assert.notEqual(rotated, first);
      assert.match(rotated, /^[0-9a-f]{64}$/);

      commandPair({ positionals: ['supplied-key-value'], flags: [], stdout: collector() });
      assert.equal(readSharedKeyFile(keyPath), 'supplied-key-value');
    });
  });

  it('repairs a key file that was created by hand with a readable mode', () => {
    withKeyPath((keyPath) => {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, 'handmade-key\n', { mode: 0o644 });
      fs.chmodSync(keyPath, 0o644);

      commandPair({ positionals: [], flags: [], stdout: collector() });
      assert.equal(readSharedKeyFile(keyPath), 'handmade-key');
      assert.equal(describeFileMode(keyPath), '-rw-------');
    });
  });

  it('refuses a key and --rotate together, and refuses an unknown flag by name', () => {
    withKeyPath(() => {
      assert.throws(
        () => commandPair({ positionals: ['abc'], flags: ['--rotate'], stdout: collector() }),
        /Pass either a key or --rotate, not both/,
      );
      assert.throws(
        () => commandPair({ positionals: [], flags: ['--force'], stdout: collector() }),
        /Unknown option for "umbra pair": --force/,
      );
    });
  });

  it('generates 32 bytes of hex and round-trips through the key file helpers', () => {
    const dir = makeTempDir();
    const keyPath = path.join(dir, 'nested', 'shared-key');
    const key = generateSharedKey();
    assert.equal(key.length, 64);
    assert.notEqual(key, generateSharedKey());

    writeSharedKeyFile(keyPath, key);
    assert.equal(readSharedKeyFile(keyPath), key);
    assert.equal(describeFileMode(keyPath), '-rw-------');
    assert.equal(readSharedKeyFile(path.join(dir, 'absent')), null);
  });
});

describe('umbra start key resolution', () => {
  it('prefers an inline key over any file', () => {
    const resolved = resolveStartSharedKey({ UMBRA_SHARED_KEY: 'inline', UMBRA_SHARED_KEY_FILE: '/nope' });
    assert.equal(resolved.source, 'UMBRA_SHARED_KEY');
  });

  it('names the configured file and the fix when that file is missing or empty', () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'absent-key');
    assert.throws(
      () => resolveStartSharedKey({ UMBRA_SHARED_KEY_FILE: missing }),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes(missing));
        assert.match(error.hint, /umbra pair/);
        return true;
      },
    );

    const empty = path.join(dir, 'empty-key');
    fs.writeFileSync(empty, '   \n');
    assert.throws(() => resolveStartSharedKey({ UMBRA_SHARED_KEY_FILE: empty }), /missing or empty/);
  });

  it('falls back to the key file umbra pair wrote when the variable is unset', () => {
    withKeyPath((keyPath) => {
      commandPair({ positionals: [], flags: [], stdout: collector() });
      const resolved = resolveStartSharedKey({});
      assert.equal(resolved.source, 'default key file');
      assert.equal(resolved.path, keyPath);
    });
  });

  it('names both pairing routes when nothing is configured at all', () => {
    withKeyPath(() => {
      assert.throws(
        () => resolveStartSharedKey({}),
        (error) => {
          assert.ok(error instanceof CliError);
          assert.match(error.message, /No shared key configured/);
          assert.match(error.hint, /umbra pair/);
          assert.match(error.hint, /Generate/);
          assert.match(error.hint, /options page/);
          return true;
        },
      );
    });
  });
});

describe('umbra doctor', () => {
  it('passes options through and returns the diagnostic exit status', () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    };
    const code = commandDoctor({
      flags: ['--verify-health'],
      positionals: [],
      stdout: collector(),
      stderr: collector(),
      spawn,
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.match(calls[0].args[0], /doctor\.mjs$/);
    assert.ok(calls[0].args.includes('--verify-health'));
    assert.equal(calls[0].options.stdio, 'inherit');
  });

  it('propagates a failing diagnostic rather than reporting success', () => {
    const code = commandDoctor({
      flags: [],
      positionals: [],
      stdout: collector(),
      stderr: collector(),
      spawn: () => ({ status: 3 }),
    });
    assert.equal(code, 3);
  });

  it('says the diagnostic is not part of an install that omits it', () => {
    const dir = makeTempDir();
    assert.throws(
      () =>
        commandDoctor({
          flags: [],
          positionals: [],
          stdout: collector(),
          stderr: collector(),
          spawn: () => {
            throw new Error('spawn should not run when the script is absent');
          },
          scriptPath: path.join(dir, 'doctor.mjs'),
        }),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.match(error.message, /doctor\.mjs\) is not part of this install/);
        assert.match(error.hint, /node mcp-server\/doctor\.mjs/);
        return true;
      },
    );
  });

  it('reports a signal and a spawn failure as failures', () => {
    const stderr = collector();
    const signalled = commandDoctor({
      flags: [],
      positionals: [],
      stdout: collector(),
      stderr,
      spawn: () => ({ status: null, signal: 'SIGKILL' }),
    });
    assert.equal(signalled, 1);
    assert.match(stderr.text(), /SIGKILL/);

    assert.throws(
      () =>
        commandDoctor({
          flags: [],
          positionals: [],
          stdout: collector(),
          stderr: collector(),
          spawn: () => ({ error: new Error('ENOENT') }),
        }),
      /Could not run the diagnostic: ENOENT/,
    );
  });
});

describe('umbra broker install', () => {
  function stubJob(dir) {
    const plist = renderLaunchdPlist(BUILTIN_LAUNCHD_TEMPLATE, {
      HOME: dir,
      LABEL: 'dev.umbra.broker',
      BROKER_BIN: path.join(dir, 'bin', 'umbra-rust-broker'),
      SHARED_KEY_FILE: path.join(dir, '.umbra', 'shared-key'),
      BROKER_SOCKET: path.join(dir, '.umbra', 'run', 'broker.sock'),
      LOG_DIR: path.join(dir, '.umbra', 'logs'),
    });
    return {
      label: 'dev.umbra.broker',
      configuredLabel: 'dev.umbra.broker',
      templateSource: 'test template',
      plist,
      plistPath: path.join(dir, 'LaunchAgents', 'dev.umbra.broker.plist'),
      brokerBin: readPlistProgram(plist),
      socketPath: readPlistString(plist, 'UMBRA_BROKER_SOCKET'),
      sharedKeyFile: readPlistString(plist, 'UMBRA_SHARED_KEY_FILE'),
      logPaths: [readPlistString(plist, 'StandardOutPath'), readPlistString(plist, 'StandardErrorPath')],
      logDirs: [path.join(dir, '.umbra', 'logs')],
    };
  }

  it('renders a complete plist and touches nothing on --dry-run', async () => {
    const calls = [];
    const { code, stdout } = await invoke(['broker', 'install', '--dry-run'], {
      spawn: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 0, 'a dry run invoked launchctl');
    assert.match(stdout, /Would write: .*LaunchAgents\/dev\.umbra\.broker\.plist/);
    assert.match(stdout, /launchctl bootstrap gui\/\d+/);
    assert.match(stdout, /<key>Label<\/key>/);
    assert.doesNotMatch(stdout, /__[A-Z0-9_]+__/, 'the rendered plist still holds placeholders');
    assert.equal(readPlistLabel(stdout), 'dev.umbra.broker');
  });

  it('names the build command when the broker binary is missing, and writes nothing', () => {
    const dir = makeTempDir();
    const job = stubJob(dir);
    const calls = [];
    assert.throws(
      () =>
        commandBrokerInstall({
          flags: [],
          stdout: collector(),
          stderr: collector(),
          buildJob: () => job,
          spawn: (command, args) => {
            calls.push([command, ...args].join(' '));
            return { status: 0 };
          },
        }),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.ok(error.message.includes(job.brokerBin));
        assert.match(error.hint, /cargo build --release --manifest-path rust-broker\/Cargo\.toml/);
        assert.match(error.hint, /UMBRA_BROKER_BIN/);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'launchctl ran for a job with no binary');
    assert.equal(fs.existsSync(job.plistPath), false, 'a job file was written for a missing binary');
  });

  it('installs the job and starts it once the binary is staged', () => {
    const dir = makeTempDir();
    const job = stubJob(dir);
    fs.mkdirSync(path.dirname(job.brokerBin), { recursive: true });
    fs.writeFileSync(job.brokerBin, '#!/bin/sh\n', { mode: 0o755 });

    const calls = [];
    const stdout = collector();
    const code = commandBrokerInstall({
      flags: [],
      stdout,
      stderr: collector(),
      buildJob: () => job,
      spawn: (command, args) => {
        calls.push([command, ...args].join(' '));
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(code, 0);
    assert.equal(fs.readFileSync(job.plistPath, 'utf8'), job.plist);
    for (const logPath of job.logPaths) {
      assert.equal(fs.existsSync(path.dirname(logPath)), true, `log directory missing for ${logPath}`);
    }
    assert.equal(calls.length, 4);
    assert.match(calls[0], /^launchctl bootout gui\/\d+\/dev\.umbra\.broker$/);
    assert.match(calls[1], /^launchctl bootstrap gui\/\d+ /);
    assert.match(calls[2], /^launchctl enable /);
    assert.match(calls[3], /^launchctl kickstart -k /);
    assert.match(stdout.text(), /Installed dev\.umbra\.broker/);
    assert.match(stdout.text(), /status:   started/);
  });

  it('reports a failed bootstrap with launchctl output and keeps the job file for inspection', () => {
    const dir = makeTempDir();
    const job = stubJob(dir);
    fs.mkdirSync(path.dirname(job.brokerBin), { recursive: true });
    fs.writeFileSync(job.brokerBin, '#!/bin/sh\n', { mode: 0o755 });

    assert.throws(
      () =>
        commandBrokerInstall({
          flags: [],
          stdout: collector(),
          stderr: collector(),
          buildJob: () => job,
          spawn: (command, args) =>
            args[0] === 'bootstrap'
              ? { status: 5, stdout: '', stderr: 'Load failed: 5: Input/output error' }
              : { status: 0, stdout: '', stderr: '' },
        }),
      (error) => {
        assert.match(error.message, /launchctl bootstrap failed for dev\.umbra\.broker/);
        assert.match(error.message, /Input\/output error/);
        assert.ok(error.hint.includes(job.plistPath));
        return true;
      },
    );
    assert.equal(fs.existsSync(job.plistPath), true);
  });

  it('warns when the job file and this server disagree on a path', () => {
    const dir = makeTempDir();
    const job = { ...stubJob(dir), socketPath: path.join(dir, 'somewhere-else.sock') };
    const stderr = collector();
    commandBrokerInstall({
      flags: ['--dry-run'],
      stdout: collector(),
      stderr,
      buildJob: () => job,
      spawn: () => ({ status: 0 }),
    });
    assert.match(stderr.text(), /broker socket/);
    assert.match(stderr.text(), /somewhere-else\.sock/);
    assert.match(stderr.text(), /The job file wins/);
  });

  it('rejects an unknown option instead of installing anyway', () => {
    assert.throws(
      () =>
        commandBrokerInstall({
          flags: ['--now'],
          stdout: collector(),
          stderr: collector(),
          buildJob: () => {
            throw new Error('buildJob should not run for a rejected option');
          },
        }),
      /Unknown option for "umbra broker install": --now/,
    );
  });

  it('requires a known broker subcommand', async () => {
    await assert.rejects(() => invoke(['broker']), /umbra broker needs a subcommand/);
    await assert.rejects(() => invoke(['broker', 'uninstall']), /Unknown broker subcommand: uninstall/);
  });
});

describe('launchd template rendering', () => {
  it('renders the repository template through the same path the built-in copy uses', () => {
    const template = loadLaunchdTemplate(repoRoot);
    assert.equal(template.source, path.join(repoRoot, 'launchd', 'dev.umbra.broker.plist.template'));

    const job = buildBrokerJob({ repoRoot });
    assert.equal(job.label, 'dev.umbra.broker');
    assert.equal(path.basename(job.plistPath), 'dev.umbra.broker.plist');
    assert.doesNotMatch(job.plist, /__[A-Z0-9_]+__/);
    assert.ok(job.brokerBin.length > 0);
    assert.equal(job.logPaths.length, 2);
    assert.ok(job.logDirs.length >= 1);
    // The paths this command prints and creates come out of the rendered file,
    // so they describe the job launchd will run rather than the inputs.
    for (const logPath of job.logPaths) {
      assert.ok(job.logDirs.includes(path.dirname(logPath)));
    }
  });

  it('falls back to the built-in template when the repository copy is absent', () => {
    const dir = makeTempDir();
    const template = loadLaunchdTemplate(dir);
    assert.equal(template.source, 'built-in template');
    assert.equal(template.text, BUILTIN_LAUNCHD_TEMPLATE);
  });

  it('refuses to write a plist that still holds placeholders', () => {
    assert.throws(
      () => renderLaunchdPlist('<string>__HOME__</string><string>__MYSTERY__</string>', { HOME: '/h' }),
      /placeholders this version cannot fill: __MYSTERY__/,
    );
  });

  it('escapes rendered values and reads them back unescaped', () => {
    const rendered = renderLaunchdPlist(BUILTIN_LAUNCHD_TEMPLATE, {
      HOME: '/tmp/a&b',
      LABEL: 'dev.umbra.broker',
      BROKER_BIN: '/tmp/a&b/bin/umbra-rust-broker',
      SHARED_KEY_FILE: '/tmp/a&b/shared-key',
      BROKER_SOCKET: '/tmp/a&b/broker.sock',
      LOG_DIR: '/tmp/a&b/logs',
    });
    assert.ok(rendered.includes('/tmp/a&amp;b/bin/umbra-rust-broker'));
    assert.equal(readPlistProgram(rendered), '/tmp/a&b/bin/umbra-rust-broker');
    assert.equal(readPlistString(rendered, 'StandardOutPath'), '/tmp/a&b/logs/broker.log');
  });

  it('resolves the broker binary from the environment when one is set', () => {
    const previous = process.env.UMBRA_BROKER_BIN;
    try {
      process.env.UMBRA_BROKER_BIN = '/opt/umbra/broker';
      assert.equal(resolveBrokerBinPath(), '/opt/umbra/broker');
      delete process.env.UMBRA_BROKER_BIN;
      assert.equal(resolveBrokerBinPath(), path.join(os.homedir(), '.umbra', 'bin', 'Umbra Helper'));
    } finally {
      if (previous === undefined) {
        delete process.env.UMBRA_BROKER_BIN;
      } else {
        process.env.UMBRA_BROKER_BIN = previous;
      }
    }
  });
});

describe('umbra cli as a process', () => {
  it('pairs, then exits non-zero with an actionable message when the key file is removed', async () => {
    const dir = makeTempDir();
    const keyPath = path.join(dir, '.umbra', 'shared-key');
    const env = { UMBRA_SHARED_KEY_FILE: keyPath, UMBRA_SHARED_KEY: '' };

    const paired = await runCliProcess(['pair'], env);
    assert.equal(paired.code, 0);
    assert.equal(describeFileMode(keyPath), '-rw-------');
    assert.match(paired.stdout, new RegExp(`UMBRA_SHARED_KEY_FILE=${keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    fs.rmSync(keyPath);
    const started = await runCliProcess(['start'], env);
    assert.notEqual(started.code, 0);
    assert.match(started.stderr, /umbra: /);
    assert.match(started.stderr, /umbra pair/);
  });

  it('exits 0 on help and non-zero on an unknown command', async () => {
    const help = await runCliProcess(['--help'], {});
    assert.equal(help.code, 0);
    assert.match(help.stdout, /umbra pair/);

    const unknown = await runCliProcess(['nope'], {});
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /Unknown command: nope/);
  });

  it('runs the diagnostic and prints its JSON report', async () => {
    const dir = makeTempDir();
    const result = await runCliProcess(['doctor'], {
      UMBRA_SHARED_KEY_FILE: path.join(dir, 'shared-key'),
      UMBRA_BROKER_SOCKET: path.join(dir, 'broker.sock'),
    });
    assert.equal(typeof result.code, 'number');
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report, 'object');
    assert.notEqual(report, null);
  });
});

describe('umbra cli ships nothing machine-specific', () => {
  it('carries no author identity and no absolute home path', () => {
    assert.doesNotMatch(cliSource, AUTHOR_NAME_RE);
    assert.doesNotMatch(cliSource, AUTHOR_SURNAME_RE);
    assert.doesNotMatch(cliSource, AUTHOR_HANDLE_RE);
    assert.doesNotMatch(cliSource, HOME_PATH_RE);
    assert.doesNotMatch(cliSource, AUTHOR_LAUNCHD_LABEL_RE);
  });

  it('derives every default from the shared resolvers rather than a literal', () => {
    assert.match(cliSource, /from '\.\/config\.js'/);
    assert.match(cliSource, /resolveSharedKeyPath/);
    assert.match(cliSource, /resolveBrokerSocketPath/);
    assert.match(cliSource, /resolveLaunchdLabel/);
    assert.doesNotMatch(cliSource, /\/tmp\/umbra/);
  });
});
