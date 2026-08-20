import { execFile } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const DEFAULT_MIN_AGE_MINUTES = 60;
const AUTOMATION_PROFILE_MARKERS = [
  'agent-browser-profile-',
  '.chrome-cdp-profile12-lanes/',
  'browser-use-user-data-dir-',
  'playwright_chromiumdev_profile-',
  'puppeteer_dev_chrome_profile-',
];

function parseArgs(argv) {
  const options = {
    dryRun: false,
    minAgeMinutes: DEFAULT_MIN_AGE_MINUTES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--min-age-minutes') {
      options.minAgeMinutes = Number(argv[++index]);
    } else if (arg.startsWith('--min-age-minutes=')) {
      options.minAgeMinutes = Number(arg.slice('--min-age-minutes='.length));
    } else {
      throw new Error(`Unknown cleanup-headless-chrome option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.minAgeMinutes) || options.minAgeMinutes < 0) {
    throw new Error(`Invalid min age: ${options.minAgeMinutes}`);
  }

  return options;
}

async function run(command, args) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 8 });
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      code: error.code || 1,
    };
  }
}

async function listProcesses() {
  const { stdout } = await run('ps', ['-axo', 'pid=,etime=,command=']);
  return stdout.split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }

    return {
      pid: Number(match[1]),
      ageSeconds: parseElapsedSeconds(match[2]),
      command: match[3],
    };
  }).filter((processInfo) => processInfo && Number.isFinite(processInfo.ageSeconds));
}

export function parseElapsedSeconds(value) {
  const text = String(value || '').trim();
  const dayParts = text.split('-');
  let days = 0;
  let timePart = text;

  if (dayParts.length === 2) {
    days = Number(dayParts[0]);
    timePart = dayParts[1];
  }

  const parts = timePart.split(':').map((part) => Number(part));
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) {
    return NaN;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  return NaN;
}

function isStaleAutomationChrome(processInfo, minAgeMinutes) {
  const command = processInfo.command;
  if (!command.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    return false;
  }

  if (!/\s--headless(?:=|\s|$)/.test(command)) {
    return false;
  }

  if (!AUTOMATION_PROFILE_MARKERS.some((marker) => command.includes(marker))) {
    return false;
  }

  return processInfo.ageSeconds >= minAgeMinutes * 60;
}

async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminate(pid, dryRun) {
  if (dryRun) {
    return 'dry-run';
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'already-exited';
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(100);
    if (!await isAlive(pid)) {
      return 'terminated';
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
    return 'killed';
  } catch {
    return 'already-exited';
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const processes = await listProcesses();
  const matches = processes.filter((processInfo) => isStaleAutomationChrome(processInfo, options.minAgeMinutes));
  const results = [];

  for (const match of matches) {
    const action = await terminate(match.pid, options.dryRun);
    results.push({
      pid: match.pid,
      ageSeconds: match.ageSeconds,
      action,
      command: match.command,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: options.dryRun,
    minAgeMinutes: options.minAgeMinutes,
    matched: matches.length,
    cleaned: results.filter((result) => result.action === 'terminated' || result.action === 'killed').length,
    results,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
