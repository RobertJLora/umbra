import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';

const DOWNLOAD_DIR = '/Users/RobertLora/Documents/Downloads';
const SHARED_KEY_FILE = '/Users/RobertLora/.umbra/shared-key';
const PROJECT_DIR = '/Users/RobertLora/Documents/Workspaces/uSERP/13_Projects/Felipe_Anchor_Consults/Bulk_Office_Supply_2026-04-16';
const REPORTS_ROOT = path.resolve('../reports');
const GROUP_TITLE = 'Ahrefs BOS Supplier Research';
const GROUP_COLOR = 'cyan';
const PORT_START = 47829;
const PORT_END = 47852;
const TIMEOUT_MS = 180_000;

const BOS_PAGES = [
  ['acco', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Acco-BULK.aspx'],
  ['avery', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Avery-BULK.aspx'],
  ['smead', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Smead-BULK.aspx'],
  ['tops', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Tops-BULK.aspx'],
];

const SERP_KEYWORDS = [
  ['bulk-acco-binders', 'bulk acco binders'],
  ['wholesale-avery-labels', 'wholesale avery labels'],
  ['bulk-smead-folders', 'bulk smead folders'],
  ['wholesale-tops-paper', 'wholesale tops paper'],
];

const COMPETITOR_PAGES = [
  ['acco-officecrave-binders', 'acco', 'officecrave.com', 'https://www.officecrave.com/acco-brands-54032.html'],
  ['acco-officecrave-binding-supplies', 'acco', 'officecrave.com', 'https://www.officecrave.com/binders-binding-supplies.html?manufacturer=acco'],
  ['acco-ontimesupplies-binders', 'acco', 'ontimesupplies.com', 'https://www.ontimesupplies.com/acco-binders.html'],
  ['acco-officesupply-brand', 'acco', 'officesupply.com', 'https://www.officesupply.com/349-a-acco-office-supplies.html'],
  ['avery-officecrave-labels', 'avery', 'officecrave.com', 'https://www.officecrave.com/avery-labels.html'],
  ['avery-ontimesupplies-labels', 'avery', 'ontimesupplies.com', 'https://www.ontimesupplies.com/avery-labels.html'],
  ['avery-officesupply-labels', 'avery', 'officesupply.com', 'https://www.officesupply.com/office-supplies/labels-labeling-systems/labels/c200199.html?brand=Avery&facet=true'],
  ['smead-officecrave-file-folders', 'smead', 'officecrave.com', 'https://www.officecrave.com/smead-11904.html'],
  ['smead-officecrave-folders-filing', 'smead', 'officecrave.com', 'https://www.officecrave.com/folders-filing.html?manufacturer=smead'],
  ['smead-ontimesupplies-file-folders', 'smead', 'ontimesupplies.com', 'https://www.ontimesupplies.com/smead-file-folders.html'],
  ['smead-officesupply-brand', 'smead', 'officesupply.com', 'https://www.officesupply.com/office-supplies/c200002.html?brand=Smead&facet=true'],
  ['tops-officecrave-all-products', 'tops', 'officecrave.com', 'https://www.officecrave.com/tops.html'],
  ['tops-officecrave-products', 'tops', 'officecrave.com', 'https://www.officecrave.com/TOPSProducts.html'],
  ['tops-officesupply-paper-pads', 'tops', 'officesupply.com', 'https://www.officesupply.com/office-supplies/paper-pads/c200208.html?brand=TOPS&facet=true'],
];

const BROAD_PAGES = [
  ['bos-manufacturer-directory', 'all', 'bulkofficesupply.com', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/', 'prefix'],
  ['acco-officecrave-binders-broad', 'acco', 'officecrave.com', 'https://www.officecrave.com/binders.html', 'exact'],
  ['acco-officesupply-binders-broad', 'acco', 'officesupply.com', 'https://www.officesupply.com/office-supplies/binders-accessories/binders/c200131.html', 'exact'],
  ['avery-officecrave-labels-broad', 'avery', 'officecrave.com', 'https://www.officecrave.com/labels.html', 'exact'],
  ['avery-officesupply-labels-broad', 'avery', 'officesupply.com', 'https://www.officesupply.com/office-supplies/labels-labeling-systems/labels/c200199.html', 'exact'],
  ['smead-officecrave-file-folders-broad', 'smead', 'officecrave.com', 'https://www.officecrave.com/file-folders.html', 'exact'],
  ['smead-officecrave-folders-filing-broad', 'smead', 'officecrave.com', 'https://www.officecrave.com/folders-filing.html', 'exact'],
  ['smead-officesupply-office-supplies-broad', 'smead', 'officesupply.com', 'https://www.officesupply.com/office-supplies/c200002.html', 'exact'],
  ['tops-officecrave-paper-broad', 'tops', 'officecrave.com', 'https://www.officecrave.com/paper.html', 'exact'],
  ['tops-officecrave-paper-pads-broad', 'tops', 'officecrave.com', 'https://www.officecrave.com/paper-pads-note-pads.html', 'exact'],
  ['tops-officesupply-paper-pads-broad', 'tops', 'officesupply.com', 'https://www.officesupply.com/office-supplies/paper-pads/c200208.html', 'exact'],
];

function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function loadSharedKey() {
  const fromEnv = process.env.UMBRA_SHARED_KEY?.trim();
  if (fromEnv) return fromEnv;
  return fs.readFileSync(process.env.UMBRA_SHARED_KEY_FILE || SHARED_KEY_FILE, 'utf8').trim();
}

function siteExplorerOrganicUrl(targetUrl, mode = 'exact') {
  const params = new URLSearchParams({
    target: targetUrl,
    mode,
    country: 'us',
    currentDate: 'today',
    volume_type: 'monthly',
    brandedMode: 'all',
    limit: '100',
  });
  return `https://app.ahrefs.com/v2-site-explorer/organic-keywords?${params.toString()}`;
}

function keywordSerpUrl(keyword) {
  return `https://app.ahrefs.com/keywords-explorer/google/us/serp-overview?keyword=${encodeURIComponent(keyword)}`;
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
  throw new Error(`${task} timed out. Last text: ${lastText.slice(0, 600)}`);
}

async function clickTextWithRetry(bridge, params, timeoutMs, task) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await bridge.sendCommand('browser_click_text', params).catch((error) => {
      lastError = error?.message || String(error);
      return null;
    });
    if (response?.clicked) return response;
    if (response?.__error) lastError = response.__error;
    await delay(750);
  }
  throw new Error(`${task} timed out. Last click error: ${lastError || 'none'}`);
}

async function waitForStableFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && stat.size > 0) {
      if (stat.size === lastSize) stableCount += 1;
      else stableCount = 0;
      lastSize = stat.size;
      if (stableCount >= 2) return { bytes: stat.size };
    }
    await delay(500);
  }
  return { bytes: Math.max(0, lastSize) };
}

async function waitForNewCsv({ sinceMs, timeoutMs }) {
  const startedAt = Date.now();
  let lastCandidate = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const entries = await fsp.readdir(DOWNLOAD_DIR, { withFileTypes: true }).catch(() => []);
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      if (!name.endsWith('.csv') || name.endsWith('.crdownload')) continue;
      const filePath = path.join(DOWNLOAD_DIR, entry.name);
      if (fs.existsSync(`${filePath}.crdownload`)) continue;
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
  throw new Error(`Timed out waiting for new Ahrefs CSV. Last candidate: ${lastCandidate || 'none'}`);
}

async function countLines(filePath) {
  const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length;
}

async function exportCurrentTable({ bridge, url, label, normalizedPath, reportDir }) {
  const startedAt = Date.now();
  const sinceMs = Date.now();
  const tab = await bridge.sendCommand('browser_create_tab', {
    url,
    activate: false,
    groupTitle: GROUP_TITLE,
    groupColor: GROUP_COLOR,
    groupCollapsed: false,
  });

  const row = {
    label,
    url,
    tabId: tab.tabId,
    status: 'started',
    normalizedPath,
    startedAt: new Date().toISOString(),
  };

  try {
    const page = await waitForPageText(
      bridge,
      tab.tabId,
      (bodyText) => /export/i.test(bodyText),
      TIMEOUT_MS,
      `${label}: wait for export button`,
    );
    row.pageTitle = page.title;
    row.pageUrl = page.url;

    await clickTextWithRetry(bridge, {
      tabId: tab.tabId,
      text: 'Export',
      selector: 'button,[role="button"]',
      exact: true,
      index: -1,
    }, 45_000, `${label}: click page export button`);

    await waitForPageText(
      bridge,
      tab.tabId,
      (bodyText) => /CSV|Google Sheets|Export/i.test(bodyText),
      30_000,
      `${label}: wait for export modal`,
    );

    const modalHtml = await bridge.sendCommand('browser_get_page_content', {
      tabId: tab.tabId,
      format: 'html',
    }).catch(() => null);
    const modalContent = modalHtml?.html || modalHtml?.content || '';
    const csvUtf8AppearsSelected = /checked=\"\"[^>]+name=\"export-encoding-options\"[\s\S]{0,800}CSV \(UTF-8/i.test(modalContent);
    if (!csvUtf8AppearsSelected) {
      for (const attempt of [
        { text: 'CSV (UTF-8', selector: '[role="dialog"] label,[role="dialog"] span,[role="dialog"] div', exact: false },
        { text: 'CSV', selector: '[role="dialog"] label,[role="dialog"] span,[role="dialog"] div', exact: false },
      ]) {
        try {
          await clickTextWithRetry(bridge, { tabId: tab.tabId, ...attempt }, 10_000, `${label}: select CSV export format`);
          break;
        } catch {
          // Try next label.
        }
      }
    }

    await clickTextWithRetry(bridge, {
      tabId: tab.tabId,
      text: 'Export',
      selector: '[role="dialog"] button,button',
      exact: true,
      index: -1,
    }, 20_000, `${label}: click modal export button`);

    const downloaded = await waitForNewCsv({ sinceMs, timeoutMs: TIMEOUT_MS });
    await fsp.copyFile(downloaded.filePath, normalizedPath);
    row.status = 'pass';
    row.sourceDownloadPath = downloaded.filePath;
    row.bytes = downloaded.bytes;
    row.lines = await countLines(normalizedPath);
    row.elapsedMs = Date.now() - startedAt;
  } catch (error) {
    const screenshot = await bridge.sendCommand('browser_screenshot', { tabId: tab.tabId }).catch(() => null);
    if (screenshot?.data) {
      const screenshotPath = path.join(reportDir, `${label}-failure.png`);
      await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      row.screenshotPath = screenshotPath;
    }
    row.status = 'fail';
    row.error = error?.message || String(error);
    row.elapsedMs = Date.now() - startedAt;
  }
  return row;
}

async function main() {
  const runStamp = stampForPath();
  const reportDir = path.join(REPORTS_ROOT, `bos-supplier-research-${runStamp}`);
  await fsp.mkdir(reportDir, { recursive: true });
  await fsp.mkdir(PROJECT_DIR, { recursive: true });

  const bridge = new LocalBridgeServer({
    sharedKey: loadSharedKey(),
    sessionId: `cic_bos_supplier_research_${runStamp}`,
    portStart: PORT_START,
    portEnd: PORT_END,
    requestTimeoutMs: TIMEOUT_MS,
  });

  const only = new Set((process.env.BOS_EXPORT_ONLY || '').split(',').map((value) => value.trim()).filter(Boolean));
  const shouldRun = (label) => only.size === 0 || only.has(label);
  const results = [];
  const port = await bridge.start();
  console.error(`[bos-export] bridge listening on ${port}; waiting for CiC extension`);
  await waitForAuthenticatedBridge(bridge, `BOS supplier research ${runStamp}`, 60_000);
  console.error('[bos-export] CiC extension authenticated');

  try {
    for (const [label, targetUrl] of BOS_PAGES) {
      const taskLabel = `supplier-${label}`;
      if (!shouldRun(taskLabel) && !shouldRun('suppliers')) continue;
      console.error(`[bos-export] exporting ${taskLabel}`);
      const result = await exportCurrentTable({
        bridge,
        url: siteExplorerOrganicUrl(targetUrl),
        label: taskLabel,
        normalizedPath: path.join(PROJECT_DIR, `supplier_pages_organic_kws_${label}_2026-04-29.csv`),
        reportDir,
      });
      results.push(result);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
      await delay(2_000);
    }

    for (const [slug, keyword] of SERP_KEYWORDS) {
      const taskLabel = `serp-${slug}`;
      if (!shouldRun(taskLabel) && !shouldRun('serps')) continue;
      console.error(`[bos-export] exporting ${taskLabel}: ${keyword}`);
      const result = await exportCurrentTable({
        bridge,
        url: keywordSerpUrl(keyword),
        label: taskLabel,
        normalizedPath: path.join(PROJECT_DIR, `representative_serp_${slug}_2026-04-29.csv`),
        reportDir,
      });
      results.push(result);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
      await delay(2_000);
    }

    for (const [slug, manufacturer, domain, targetUrl] of COMPETITOR_PAGES) {
      const taskLabel = `competitor-${slug}`;
      if (!shouldRun(taskLabel) && !shouldRun('competitors') && !shouldRun(`competitors-${manufacturer}`)) continue;
      console.error(`[bos-export] exporting ${taskLabel}: ${targetUrl}`);
      const result = await exportCurrentTable({
        bridge,
        url: siteExplorerOrganicUrl(targetUrl),
        label: taskLabel,
        normalizedPath: path.join(PROJECT_DIR, `competitor_keywords_${manufacturer}_${domain.replace(/[^a-z0-9]+/gi, '-')}_${slug}_2026-04-29.csv`),
        reportDir,
      });
      result.manufacturer = manufacturer;
      result.domain = domain;
      results.push(result);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
      await delay(2_000);
    }

    for (const [slug, manufacturer, domain, targetUrl, mode] of BROAD_PAGES) {
      const taskLabel = `broad-${slug}`;
      if (!shouldRun(taskLabel) && !shouldRun('broad') && !shouldRun(`broad-${manufacturer}`)) continue;
      console.error(`[bos-export] exporting ${taskLabel}: ${targetUrl}`);
      const result = await exportCurrentTable({
        bridge,
        url: siteExplorerOrganicUrl(targetUrl, mode),
        label: taskLabel,
        normalizedPath: path.join(PROJECT_DIR, `broad_keywords_${manufacturer}_${domain.replace(/[^a-z0-9]+/gi, '-')}_${slug}_2026-04-29.csv`),
        reportDir,
      });
      result.manufacturer = manufacturer;
      result.domain = domain;
      results.push(result);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
      await delay(2_000);
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const manifest = { generatedAt: new Date().toISOString(), groupTitle: GROUP_TITLE, reportDir, projectDir: PROJECT_DIR, results, passed, failed };
  await fsp.writeFile(path.join(reportDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
