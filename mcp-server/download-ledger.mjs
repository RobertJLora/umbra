import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expandUserPath, resolveDownloadDir } from './config.js';
import { assertAllowedDirectory } from './fs-guard.js';

// Render a filesystem path for a message a user reads without printing the
// account name back at them. Anything inside the running user's home collapses
// to `~`, so a default install reports `~/Downloads`, and no error string this
// file produces can carry one machine's home directory to another machine.
export function describeUserPath(target) {
  const value = String(target || '').trim();
  if (!value) {
    return '(unset)';
  }
  const home = os.homedir();
  if (home && (value === home || value.startsWith(`${home}${path.sep}`))) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

function normalizeScope(scope) {
  const tabId = Number(scope?.tabId);
  return {
    tabId: Number.isFinite(tabId) ? tabId : null,
    sessionId: scope?.sessionId ? String(scope.sessionId) : null,
  };
}

// APFS stores a filename exactly as it was written, so a name Chrome built from
// page text arrives decomposed (NFD) while a token typed by a caller is composed
// (NFC), and a plain `includes` misses every accented filename. Both sides go
// through one normal form before they are compared. `waitForExact` is unaffected
// because it goes through the kernel, which does its own equivalence matching.
export function normalizeName(value) {
  return String(value ?? '').normalize('NFC').toLowerCase();
}

function lowerTokens(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeName(item))
    .filter(Boolean);
}

// A filename is a name inside the watched directory, never a path. Joining a
// caller-supplied `../..` produced a "completed download" outside the download
// directory, and `clearExact` runs an unlink on the same join.
export function containedFilename(filename) {
  const raw = String(filename ?? '').trim();
  const base = path.basename(raw);
  if (!base || base === '.' || base === '..') {
    throw new Error(`Not a usable download filename: ${raw}`);
  }
  return base;
}

// Cross-session download attribution.
//
// A filename substring plus an mtime window cannot tell two sessions apart, and
// it cannot tell a session's download from one the person started themselves,
// because Umbra drives their own signed-in Chrome. `chrome.downloads.DownloadItem`
// carries no tabId, so `chrome.downloads.search` cannot be filtered by the tab
// that started the download and the `downloads` permission would buy nothing.
//
// The tab-linked signal is the CDP event `Page.downloadWillBegin`, reachable
// through the `debugger` permission the extension already declares and already
// attaches per owned tab. Its payload carries `suggestedFilename`, `guid`, and
// the frame that started the download. An extension build that subscribes to it
// reports each event to the companion, and the companion feeds it here through
// `claimExpectedDownload({ suggestedFilename, tabId, sessionId, guid, at })` or
// through the `attributionSource` callback this class polls while it waits.
//
// Matching runs in three tiers and never starves, so a build with no such signal
// behaves exactly as this ledger did before:
//   2. a file whose name equals a claimed `suggestedFilename` for this scope;
//   1. a file matching the caller's filters and one of `nameIncludesAny`, which
//      is how a report token separates an export from an unrelated file
//      that happens to share the domain name;
//   0. a file matching the caller's filters, which is the original behaviour.
// Chrome renames on filename conflict, so a claimed name can legitimately fail
// to appear; the lower tiers still answer rather than waiting out the timeout.
export class FileDownloadLedger {
  constructor({
    downloadDir,
    pollMs = 250,
    stableSamples = 2,
    scope = null,
    attributionSource = null,
  } = {}) {
    if (!downloadDir) {
      throw new Error('FileDownloadLedger requires downloadDir.');
    }
    this.downloadDir = downloadDir;
    this.pollMs = pollMs;
    this.stableSamples = stableSamples;
    this.events = [];
    this.scope = normalizeScope(scope);
    this.attributionSource = typeof attributionSource === 'function' ? attributionSource : null;
    this.expectedDownloads = [];
    this.downloadDirVerified = false;
  }

  record(type, payload = {}) {
    const event = {
      type,
      at: Date.now(),
      ...payload,
    };
    this.events.push(event);
    return event;
  }

  snapshot() {
    return [...this.events];
  }

  // Fail fast and by name when the download directory does not exist. Without
  // this a misconfigured directory reads as "no files yet" and every wait runs
  // its full timeout, which is 30 seconds for a download wait and 90 seconds for
  // a plugin-driven report export, with nothing in the error that names the cause.
  async assertDownloadDirExists(context = 'wait') {
    if (this.downloadDirVerified) {
      return;
    }
    const raw = String(this.downloadDir || '');
    const stat = await fsp.stat(raw).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      this.record('download_dir_missing', { context });
      // describeUserPath collapses the home directory to `~`, which is right for
      // keeping an account name out of an error but makes an unexpanded literal
      // `~/Downloads` render identically to the working default. Say which one
      // this is, because "not found: ~/Downloads" on a machine where that folder
      // plainly exists leaves a person with no lead at all.
      let detail = '';
      if (raw.startsWith('~')) {
        detail = ' The value starts with a literal "~", which nothing expanded, so it names a relative path rather than your home directory.';
      } else if (!path.isAbsolute(raw)) {
        detail = ` The value is relative, so it resolved to ${path.resolve(raw)}.`;
      } else if (stat) {
        detail = ' That path exists but is a file, not a directory.';
      }
      throw new Error(
        `Download directory not found: ${describeUserPath(raw)}.${detail} `
        + 'Set UMBRA_DOWNLOAD_DIR to the folder Chrome saves downloads into.',
      );
    }
    this.downloadDirVerified = true;
  }

  // Record one CDP Page.downloadWillBegin event. Returns the stored claim, or
  // null when the record carries no filename or repeats one already held.
  claimExpectedDownload(record = {}) {
    const suggested = String(record.suggestedFilename || record.filename || '').trim();
    if (!suggested) {
      return null;
    }
    const tabId = Number(record.tabId);
    const claim = {
      suggestedFilename: path.basename(suggested),
      tabId: Number.isFinite(tabId) ? tabId : null,
      sessionId: record.sessionId ? String(record.sessionId) : null,
      guid: record.guid ? String(record.guid) : null,
      at: Number.isFinite(Number(record.at)) ? Number(record.at) : Date.now(),
    };
    const duplicate = this.expectedDownloads.some((item) => (
      (claim.guid && item.guid === claim.guid)
      || (item.tabId === claim.tabId
        && normalizeName(item.suggestedFilename) === normalizeName(claim.suggestedFilename))
    ));
    if (duplicate) {
      return null;
    }
    this.expectedDownloads.push(claim);
    this.record('download_will_begin', claim);
    return claim;
  }

  isClaimInScope(claim) {
    if (this.scope.tabId !== null && claim.tabId !== null && claim.tabId !== this.scope.tabId) {
      return false;
    }
    if (this.scope.sessionId && claim.sessionId && claim.sessionId !== this.scope.sessionId) {
      return false;
    }
    return true;
  }

  expectedFilenames() {
    const names = new Set();
    for (const claim of this.expectedDownloads) {
      if (this.isClaimInScope(claim)) {
        names.add(normalizeName(claim.suggestedFilename));
      }
    }
    return names;
  }

  // Poll the optional attribution source and fold whatever it returns into the
  // claim list. Any failure is swallowed: the source is an optimization, and the
  // caller falls back to the filename and mtime tiers without it.
  async collectAttribution() {
    if (this.attributionSource) {
      try {
        const reported = await this.attributionSource({
          scope: this.scope,
          downloadDir: this.downloadDir,
        });
        for (const item of Array.isArray(reported) ? reported : []) {
          this.claimExpectedDownload(item);
        }
      } catch {
        // No attribution available on this build. Lower tiers still answer.
      }
    }
    return this.expectedFilenames();
  }

  async clearExact(filename) {
    const safeName = containedFilename(filename);
    const finalPath = path.join(this.downloadDir, safeName);
    const partialPath = `${finalPath}.crdownload`;
    await fsp.rm(finalPath, { force: true }).catch(() => {});
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    this.record('clear_exact', { filename: safeName, finalPath });
  }

  // `sinceMs` is the wait's own start time unless the caller supplied one. A
  // tool named wait_for_download must not report a download that never happened,
  // and export workflows reuse filenames, so an untouched file from last month
  // sitting at the expected path used to answer immediately with stale data.
  async waitForExact({ filename, timeoutMs, removeExisting = false, sinceMs = null } = {}) {
    if (!filename) {
      throw new Error('waitForExact requires filename.');
    }
    await this.assertDownloadDirExists('wait_exact');
    const safeName = containedFilename(filename);
    if (removeExisting) {
      await this.clearExact(safeName);
    }

    const finalPath = path.join(this.downloadDir, safeName);
    const partialPath = `${finalPath}.crdownload`;
    const startedAt = Date.now();
    const freshAfterMs = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : startedAt - 1_000;
    let lastSize = -1;
    let stableCount = 0;
    let sawPartial = false;
    let sawStale = false;
    this.record('wait_exact_start', { filename: safeName, finalPath, timeoutMs, sinceMs: freshAfterMs });

    while (Date.now() - startedAt <= timeoutMs) {
      if (fs.existsSync(partialPath)) {
        sawPartial = true;
      }
      if (fs.existsSync(finalPath) && !fs.existsSync(partialPath)) {
        const stat = fs.statSync(finalPath);
        const size = stat.size;
        if (stat.mtimeMs < freshAfterMs) {
          // A file that predates the call is not this download. Keep waiting for
          // Chrome to replace it rather than reporting it as complete.
          sawStale = true;
          lastSize = -1;
          stableCount = 0;
          await delay(this.pollMs);
          continue;
        }
        if (size > 0 && size === lastSize) {
          stableCount += 1;
        } else {
          stableCount = 0;
        }
        lastSize = size;
        if (stableCount >= this.stableSamples) {
          const result = {
            filePath: finalPath,
            path: finalPath,
            bytes: size,
            sawPartial,
            elapsedMs: Date.now() - startedAt,
            ledgerEvents: this.snapshot(),
          };
          this.record('wait_exact_complete', { filename: safeName, finalPath, bytes: size, sawPartial });
          return result;
        }
      }
      await delay(this.pollMs);
    }

    this.record('wait_exact_timeout', { filename: safeName, finalPath, timeoutMs });
    throw new Error(
      `Timed out after ${timeoutMs} ms waiting for ${safeName} in ${describeUserPath(this.downloadDir)}.`
      + (sawStale
        ? ` A file with that name is already there but predates this call, so it was not treated as the download.`
        : ''),
    );
  }

  async waitForNew({
    sinceMs,
    timeoutMs,
    extension = '',
    nameIncludes = [],
    nameIncludesAny = [],
  } = {}) {
    await this.assertDownloadDirExists('wait_new');
    const startedAt = Date.now();
    const normalizedIncludes = lowerTokens(nameIncludes);
    const normalizedHints = lowerTokens(nameIncludesAny);
    this.record('wait_new_start', {
      sinceMs,
      timeoutMs,
      extension,
      nameIncludes: normalizedIncludes,
      nameIncludesAny: normalizedHints,
    });

    while (Date.now() - startedAt <= timeoutMs) {
      const expectedNames = await this.collectAttribution();
      const matches = await this.findNew({
        sinceMs,
        extension,
        nameIncludes: normalizedIncludes,
        nameIncludesAny: normalizedHints,
        expectedNames,
      });
      if (matches[0]) {
        const result = {
          ...matches[0],
          elapsedMs: Date.now() - startedAt,
          ledgerEvents: this.snapshot(),
        };
        this.record('wait_new_complete', {
          filePath: result.filePath,
          bytes: result.bytes,
          mtimeMs: result.mtimeMs,
          attributed: result.attributed,
        });
        return result;
      }
      await delay(Math.max(this.pollMs, 500));
    }

    this.record('wait_new_timeout', {
      sinceMs,
      timeoutMs,
      extension,
      nameIncludes: normalizedIncludes,
    });
    throw new Error(
      `Timed out after ${timeoutMs} ms waiting for a new download in `
      + `${describeUserPath(this.downloadDir)}. Set UMBRA_DOWNLOAD_DIR if Chrome saves `
      + 'downloads somewhere else.',
    );
  }

  // Stays tolerant of a missing directory on purpose: this runs as the recovery
  // branch inside a catch in an export runner, where a throw would
  // replace the original error and lose the real cause. The named directory
  // error belongs at wait entry, which is assertDownloadDirExists.
  async findNew({
    sinceMs = 0,
    extension = '',
    nameIncludes = [],
    nameIncludesAny = [],
    expectedNames = null,
  } = {}) {
    const entries = await fsp.readdir(this.downloadDir, { withFileTypes: true }).catch(() => []);
    const normalizedExtension = String(extension || '').toLowerCase();
    const normalizedIncludes = lowerTokens(nameIncludes);
    const normalizedHints = lowerTokens(nameIncludesAny);
    const expected = expectedNames instanceof Set
      ? expectedNames
      : new Set(lowerTokens(expectedNames));
    const ranked = [];

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.crdownload')) {
        continue;
      }
      const lowerName = normalizeName(entry.name);
      const expectedMatch = expected.has(lowerName);
      const filtersMatch = (!normalizedExtension || lowerName.endsWith(normalizedExtension))
        && !normalizedIncludes.some((token) => !lowerName.includes(token));
      if (!expectedMatch && !filtersMatch) {
        continue;
      }

      const filePath = path.join(this.downloadDir, entry.name);
      const partialPath = `${filePath}.crdownload`;
      if (fs.existsSync(partialPath)) {
        continue;
      }
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat || stat.mtimeMs <= sinceMs + 100 || stat.size <= 0) {
        continue;
      }

      const hintMatch = filtersMatch
        && (!normalizedHints.length || normalizedHints.some((token) => lowerName.includes(token)));
      ranked.push({
        tier: expectedMatch ? 2 : (hintMatch ? 1 : 0),
        filePath,
        path: filePath,
        filename: entry.name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }

    if (!ranked.length) {
      return [];
    }
    const bestTier = ranked.reduce((best, item) => Math.max(best, item.tier), 0);
    return ranked
      .filter((item) => item.tier === bestTier)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map(({ tier, ...rest }) => ({ ...rest, attributed: tier === 2 }));
  }
}

// The one tool that runs entirely in this process. Shared by both transports so
// the exact-filename path and the pattern path cannot drift apart again on which
// arguments they honour.
export const PROCESS_STARTED_AT_MS = Date.now();

function expandAbsoluteDir(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return '';
  }
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return path.resolve(expandUserPath(trimmed));
  }
  return trimmed;
}

export function resolveDownloadWaitDir(params = {}) {
  const requestedDir = expandAbsoluteDir(params.dir);
  const downloadDir = requestedDir || resolveDownloadDir();
  if (!path.isAbsolute(downloadDir)) {
    throw new Error('dir must be an absolute path.');
  }
  return assertAllowedDirectory(downloadDir, { extraRoots: [resolveDownloadDir()] });
}

export function resolveDownloadSinceMs(params = {}, now = Date.now()) {
  const requested = Number.isFinite(Number(params.createdAfterMs))
    ? Number(params.createdAfterMs)
    : now - 1_000;
  return Math.max(requested, PROCESS_STARTED_AT_MS);
}

export async function resolveDownloadWait(params = {}, isConnected = () => true, sessionId = '') {
  const rawTimeoutMs = Number(params.timeoutMs);
  if (params.timeoutMs !== undefined && (!Number.isFinite(rawTimeoutMs) || rawTimeoutMs <= 0)) {
    throw new Error(`browser_wait_for_download needs a positive timeoutMs, but got ${params.timeoutMs}.`);
  }
  // Because it runs locally it is also the one tool that can burn its whole
  // timeout and then blame the download folder for a browser that was never
  // attached in the first place.
  if (!isConnected()) {
    throw new Error(
      `Chrome extension is not connected${sessionId ? ` for session ${sessionId}` : ''}, so no download can arrive. Open the extension and configure the shared key first.`,
    );
  }

  const ledger = new FileDownloadLedger({ downloadDir: resolveDownloadWaitDir(params) });
  const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
    ? Math.min(rawTimeoutMs, 300_000)
    : 30_000;
  const sinceMs = resolveDownloadSinceMs(params);

  if (typeof params.filename === 'string' && params.filename.trim()) {
    // createdAfterMs used to be dropped on this path, so a stale file sitting at
    // the expected name answered at once and the caller parsed last month's
    // export as this run's output.
    return await ledger.waitForExact({ filename: params.filename.trim(), timeoutMs, sinceMs });
  }
  const nameIncludes = [];
  if (typeof params.pattern === 'string' && params.pattern.trim()) {
    nameIncludes.push(params.pattern.trim());
  }
  return await ledger.waitForNew({
    sinceMs,
    timeoutMs,
    extension: params.extension || '',
    nameIncludes,
  });
}
