import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';

const DOWNLOAD_DIR = '/Users/RobertLora/Documents/Downloads';
const SHARED_KEY_FILE = '/Users/RobertLora/.umbra/shared-key';
const REPORTS_ROOT = path.resolve('../reports');
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1c6756lI4UfJHo7ZN8NRjMnLQW7990lapU82qrnvoZnI/edit';
const GROUP_TITLE = 'Ahrefs Adaptive Rankings';
const GROUP_COLOR = 'cyan';
const PORT_START = 47829;
const PORT_END = 47852;
const TIMEOUT_MS = 180_000;
const CLEANUP_ON_SUCCESS = process.env.ADAPTIVE_KEEP_TABS_OPEN !== '1';
const CLEANUP_STALE_GROUPS = process.env.ADAPTIVE_CLEAN_STALE_GROUPS === '1';

const TARGETS = [
  {
    label: 'homepage',
    sheetSection: 'Homepage (https://www.adaptivesecurity.com/)',
    url: 'https://www.adaptivesecurity.com/',
    mode: 'exact',
  },
  {
    label: 'security-awareness-training',
    sheetSection: '/security-awareness-training',
    url: 'https://www.adaptivesecurity.com/security-awareness-training',
    mode: 'exact',
  },
  {
    label: 'blog-phishing-simulation',
    sheetSection: '/blog/phishing-simulation',
    url: 'https://www.adaptivesecurity.com/blog/phishing-simulation',
    mode: 'exact',
  },
  {
    label: 'blog-security-awareness-training-platforms',
    sheetSection: '/blog/security-awareness-training-platforms',
    url: 'https://www.adaptivesecurity.com/blog/security-awareness-training-platforms',
    mode: 'exact',
  },
];

function selectedTargets() {
  const requested = (process.env.ADAPTIVE_TARGET_LABELS || '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (requested.length === 0) return TARGETS;
  const requestedSet = new Set(requested);
  return TARGETS.filter((target) => requestedSet.has(target.label));
}

function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function loadSharedKey() {
  const fromEnv = process.env.UMBRA_SHARED_KEY?.trim();
  if (fromEnv) return fromEnv;
  return fs.readFileSync(process.env.UMBRA_SHARED_KEY_FILE || SHARED_KEY_FILE, 'utf8').trim();
}

function makeAhrefsUrl(target) {
  const params = new URLSearchParams({
    target: target.url,
    mode: target.mode,
    country: 'us',
    compareDate: 'prevMonth',
    currentDate: 'today',
    volume_type: 'monthly',
  });
  return `https://app.ahrefs.com/v2-site-explorer/organic-keywords?${params.toString()}`;
}

async function waitForAuthenticatedBridge(bridge, label, timeoutMs) {
  if (bridge.registry.isConnected()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for ${label} authentication.`));
    }, timeoutMs);
    const onAuth = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      bridge.registry.off('authenticated', onAuth);
    };
    bridge.registry.on('authenticated', onAuth);
  });
}

async function waitForPageText(bridge, tabId, predicate, timeoutMs, task) {
  const startedAt = Date.now();
  let lastText = '';
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const page = await bridge.sendCommand('browser_get_page_content', { tabId, format: 'text' });
      lastText = page.bodyText || page.content || '';
      if (/sign in|log in/i.test(page.title || '') || /sign in to ahrefs|log in to ahrefs/i.test(lastText)) {
        throw new Error(`Ahrefs auth appears unavailable on tab ${tabId}.`);
      }
      if (predicate(lastText, page)) return page;
    } catch (error) {
      if (/auth appears unavailable/i.test(error?.message || '')) throw error;
    }
    await delay(750);
  }
  throw new Error(`${task} timed out. Last text: ${lastText.slice(0, 400)}`);
}

async function clickTextWithRetry(bridge, params, timeoutMs, task) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await bridge.sendCommand('browser_click_text', params).catch((error) => {
      lastError = error?.message || String(error);
      return null;
    });
    if (response?.clicked) {
      return response;
    }
    if (response?.__error) {
      lastError = response.__error;
    }
    await delay(750);
  }
  throw new Error(`${task} timed out. Last click error: ${lastError || 'none'}`);
}

async function waitForNewAdaptiveCsv({ sinceMs, timeoutMs }) {
  const startedAt = Date.now();
  let lastCandidate = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const entries = await fsp.readdir(DOWNLOAD_DIR, { withFileTypes: true }).catch(() => []);
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      if (!name.endsWith('.csv') || name.endsWith('.crdownload')) continue;
      if (!name.includes('adaptivesecurity')) continue;
      const filePath = path.join(DOWNLOAD_DIR, entry.name);
      const crdownloadPath = `${filePath}.crdownload`;
      if (fs.existsSync(crdownloadPath)) continue;
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs > sinceMs + 100 && stat.size > 0) {
        matches.push({ filePath, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
    if (matches[0]) {
      const stable = await waitForStableFile(matches[0].filePath, 5_000);
      return { ...matches[0], bytes: stable.bytes, elapsedMs: Date.now() - startedAt };
    }
    if (matches[0]?.filePath) lastCandidate = matches[0].filePath;
    await delay(750);
  }
  throw new Error(`Timed out waiting for new Adaptive Security CSV. Last candidate: ${lastCandidate || 'none'}`);
}

async function waitForStableFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && stat.size > 0) {
      if (stat.size === lastSize) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastSize = stat.size;
      if (stableCount >= 2) {
        return { bytes: stat.size };
      }
    }
    await delay(500);
  }
  return { bytes: Math.max(0, lastSize) };
}

async function countLines(filePath) {
  const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length;
}

async function exportTarget({ bridge, target, outputDir, reportDir, runStamp }) {
  const startedAt = Date.now();
  const ahrefsUrl = makeAhrefsUrl(target);
  const sinceMs = Date.now();
  const tab = await bridge.sendCommand('browser_create_tab', {
    url: ahrefsUrl,
    activate: false,
    groupTitle: GROUP_TITLE,
    groupColor: GROUP_COLOR,
    groupCollapsed: false,
  });

  const row = {
    target: target.url,
    sheetSection: target.sheetSection,
    label: target.label,
    mode: target.mode,
    ahrefsUrl,
    tabId: tab.tabId,
    status: 'started',
    startedAt: new Date().toISOString(),
  };

  try {
    const page = await waitForPageText(
      bridge,
      tab.tabId,
      (bodyText) => /export/i.test(bodyText),
      TIMEOUT_MS,
      `${target.label}: wait for Ahrefs export button`,
    );
    row.pageTitle = page.title;
    row.pageUrl = page.url;

    await clickTextWithRetry(bridge, {
      tabId: tab.tabId,
      text: 'Export',
      selector: 'button,[role="button"]',
      exact: true,
      index: -1,
    }, 45_000, `${target.label}: click page export button`);

    await waitForPageText(
      bridge,
      tab.tabId,
      (bodyText) => /CSV|Google Sheets|Export/i.test(bodyText),
      30_000,
      `${target.label}: wait for export modal`,
    );

    const modalHtml = await bridge.sendCommand('browser_get_page_content', {
      tabId: tab.tabId,
      format: 'html',
    }).catch(() => null);
    const modalContent = modalHtml?.html || modalHtml?.content || '';
    const csvUtf8AppearsSelected = /checked=\"\"[^>]+name=\"export-encoding-options\"[\s\S]{0,800}CSV \(UTF-8/i.test(modalContent);
    let selectedCsv = csvUtf8AppearsSelected;
    for (const attempt of [
      { text: 'CSV (UTF-8', selector: '[role="dialog"] label,[role="dialog"] span,[role="dialog"] div', exact: false },
      { text: 'CSV', selector: '[role="dialog"] label,[role="dialog"] span,[role="dialog"] div', exact: false },
    ]) {
      if (selectedCsv) break;
      try {
        await clickTextWithRetry(bridge, {
          tabId: tab.tabId,
          ...attempt,
        }, 10_000, `${target.label}: select CSV export format`);
        selectedCsv = true;
      } catch {
        // Try the next visible label.
      }
    }

    await clickTextWithRetry(bridge, {
      tabId: tab.tabId,
      text: 'Export',
      selector: '[role="dialog"] button',
      exact: true,
      index: 0,
    }, 20_000, `${target.label}: click modal export button`);

    const downloaded = await waitForNewAdaptiveCsv({ sinceMs, timeoutMs: TIMEOUT_MS });
    const lineCount = await countLines(downloaded.filePath);
    const normalizedName = `adaptive-security_${target.label}_organic-keywords_changes-prev-month_${runStamp}.csv`;
    const normalizedPath = path.join(outputDir, normalizedName);
    await fsp.copyFile(downloaded.filePath, normalizedPath);

    row.status = 'pass';
    row.sourceDownloadPath = downloaded.filePath;
    row.normalizedPath = normalizedPath;
    row.bytes = downloaded.bytes;
    row.lines = lineCount;
    row.elapsedMs = Date.now() - startedAt;
    row.note = selectedCsv
      ? 'CSV UTF-8 selected or already selected.'
      : 'CSV selection not confirmed; downloaded CSV copied after filename/type verification.';
  } catch (error) {
    const screenshot = await bridge.sendCommand('browser_screenshot', { tabId: tab.tabId }).catch(() => null);
    if (screenshot?.data) {
      const screenshotPath = path.join(reportDir, `${target.label}-failure.png`);
      await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      row.screenshotPath = screenshotPath;
    }
    row.status = 'fail';
    row.error = error?.message || String(error);
    row.elapsedMs = Date.now() - startedAt;
  }

  return row;
}

async function cleanupStaleTaskGroups(bridge) {
  if (!CLEANUP_STALE_GROUPS) {
    return { skipped: true, reason: 'ADAPTIVE_CLEAN_STALE_GROUPS is not 1' };
  }

  return await bridge.sendCommand('browser_cleanup_groups', {
    title: GROUP_TITLE,
    mode: 'closeTabs',
    includeConnected: false,
    maxGroups: 24,
  }).catch((error) => ({
    skipped: true,
    reason: error?.message || String(error),
  }));
}

async function closeSuccessfulTabs(bridge, results) {
  if (!CLEANUP_ON_SUCCESS) {
    return { skipped: true, reason: 'ADAPTIVE_KEEP_TABS_OPEN=1' };
  }

  const successfulTabIds = results
    .filter((result) => result.status === 'pass' && Number.isInteger(result.tabId))
    .map((result) => result.tabId);

  const closed = [];
  for (const tabId of successfulTabIds) {
    const result = await bridge.sendCommand('browser_close_tab', { tabId })
      .then(() => ({ tabId, closed: true }))
      .catch((error) => ({ tabId, closed: false, error: error?.message || String(error) }));
    closed.push(result);
  }

  return {
    skipped: false,
    requestedTabCount: successfulTabIds.length,
    closedTabCount: closed.filter((result) => result.closed).length,
    results: closed,
  };
}

async function main() {
  const runStamp = stampForPath();
  const reportDir = path.join(REPORTS_ROOT, `adaptive-keyword-changes-${runStamp}`);
  const outputDir = path.join(DOWNLOAD_DIR, `adaptive-security-keyword-changes-${runStamp}`);
  await fsp.mkdir(reportDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });

  const bridge = new LocalBridgeServer({
    sharedKey: loadSharedKey(),
    sessionId: `cic_adaptive_keyword_changes_${runStamp}`,
    portStart: PORT_START,
    portEnd: PORT_END,
    requestTimeoutMs: TIMEOUT_MS,
  });

  const results = [];
  let staleGroupCleanup = null;
  let successTabCleanup = null;
  const port = await bridge.start();
  console.error(`[adaptive-export] bridge listening on ${port}; waiting for CiC extension`);
  await waitForAuthenticatedBridge(bridge, `adaptive keyword changes ${runStamp}`, 60_000);
  console.error('[adaptive-export] CiC extension authenticated');

  try {
    staleGroupCleanup = await cleanupStaleTaskGroups(bridge);
    if (staleGroupCleanup?.skipped) {
      console.error(`[adaptive-export] stale group cleanup skipped: ${staleGroupCleanup.reason}`);
    } else {
      console.error(`[adaptive-export] cleaned ${staleGroupCleanup.cleanedTabCount || 0} stale tabs from ${staleGroupCleanup.matchedGroupCount || 0} prior "${GROUP_TITLE}" groups`);
    }

    for (const target of selectedTargets()) {
      console.error(`[adaptive-export] exporting ${target.label}: ${target.url}`);
      const result = await exportTarget({ bridge, target, outputDir, reportDir, runStamp });
      results.push(result);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
      if (result.status === 'fail') {
        console.error(`[adaptive-export] failed ${target.label}: ${result.error}`);
      } else {
        console.error(`[adaptive-export] saved ${result.normalizedPath} (${result.lines} lines)`);
      }
      await delay(2_000);
    }

    const failed = results.some((result) => result.status === 'fail');
    if (failed) {
      await bridge.sendCommand('browser_group_tabs', {
        title: `${GROUP_TITLE} Debug`,
        color: GROUP_COLOR,
        collapsed: false,
      }).catch(() => {});
    }
    successTabCleanup = await closeSuccessfulTabs(bridge, results);
  } finally {
    await bridge.stop().catch(() => {});
  }

  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const markdown = `# Adaptive Security Keyword Changes Export

Generated: ${new Date().toISOString()}

Source target Sheet: ${SHEET_URL}

Ahrefs settings: Site Explorer > Organic Keywords, exact URL mode, country US, compareDate=prevMonth, currentDate=today, monthly volume.

Chrome group: ${GROUP_TITLE} (${GROUP_COLOR})

Downloads folder: ${outputDir}

Stale group cleanup: ${staleGroupCleanup?.skipped ? `skipped (${staleGroupCleanup.reason})` : `closed ${staleGroupCleanup?.cleanedTabCount || 0} tabs from ${staleGroupCleanup?.matchedGroupCount || 0} prior groups`}

Success tab cleanup: ${successTabCleanup?.skipped ? `skipped (${successTabCleanup.reason})` : `closed ${successTabCleanup?.closedTabCount || 0} successful export tabs`}

| Target | Status | Lines | File | Ahrefs URL | Error |
|---|---|---:|---|---|---|
${results.map((result) => `| ${result.sheetSection} | ${result.status} | ${result.lines || 0} | ${result.normalizedPath || result.sourceDownloadPath || ''} | ${result.ahrefsUrl} | ${(result.error || '').replace(/\|/g, '\\|')} |`).join('\n')}

Summary: ${passed} passed, ${failed} failed.
`;
  const reportPath = path.join(reportDir, 'Adaptive_Security_Keyword_Changes_Export.md');
  await fsp.writeFile(reportPath, markdown, 'utf8');
  await fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({ sheetUrl: SHEET_URL, generatedAt: new Date().toISOString(), staleGroupCleanup, successTabCleanup, results }, null, 2), 'utf8');

  console.log(JSON.stringify({ reportPath, outputDir, passed, failed, staleGroupCleanup, successTabCleanup, results }, null, 2));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
