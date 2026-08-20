import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';

const SHARED_KEY_FILE = '/Users/RobertLora/.umbra/shared-key';
const PROJECT_DIR = '/Users/RobertLora/Documents/Workspaces/uSERP/13_Projects/Felipe_Anchor_Consults/Bulk_Office_Supply_2026-04-16';
const REPORTS_ROOT = path.resolve('../reports');
const GROUP_TITLE = 'BOS Ahrefs Target Sweep';
const GROUP_COLOR = 'cyan';
const PORT_START = 47829;
const PORT_END = 47852;
const TIMEOUT_MS = 90_000;

const TARGET_PAGES = [
  ['homepage', 'https://www.bulkofficesupply.com/', 'exact'],
  ['back-to-school', 'https://www.bulkofficesupply.com/Back-to-School-Supply-Station', 'exact'],
  ['paper-writing-pads', 'https://www.bulkofficesupply.com/Categories/Office-Supplies/Paper-and-Writing-Pads.aspx', 'exact'],
  ['wholesale-janitorial', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Wholesale-Janitorial-BULK.aspx', 'exact'],
  ['avery-new', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Avery-BULK.aspx', 'exact'],
  ['avery-old', 'https://www.bulkofficesupply.com/Manufacturers/Avery.aspx', 'exact'],
  ['acco-new', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/Acco-BULK.aspx', 'exact'],
  ['acco-old', 'https://www.bulkofficesupply.com/Manufacturers/ACCO.aspx', 'exact'],
  ['manufacturer-directory', 'https://www.bulkofficesupply.com/Categories/Wholesale-by-Manufacturer-BULK/', 'prefix'],
];

const KEYWORDS = [
  ['homepage-bulk-office-supplies', 'bulk office supplies'],
  ['homepage-office-supplies-wholesale', 'office supplies wholesale'],
  ['school-supplies-wholesale', 'school supplies wholesale'],
  ['wholesale-school-supplies', 'wholesale school supplies'],
  ['bulk-notebooks', 'bulk notebooks'],
  ['bulk-notepads', 'bulk notepads'],
  ['wholesale-janitorial-supplies', 'wholesale janitorial supplies'],
  ['bulk-janitorial-supplies', 'bulk janitorial supplies'],
  ['bulk-toilet-paper', 'bulk toilet paper'],
  ['bulk-paper-towels', 'bulk paper towels'],
  ['bulk-snacks', 'bulk snacks'],
  ['bulk-business-cards', 'bulk business cards'],
  ['bulk-pens', 'bulk pens'],
  ['pencils-in-bulk', 'pencils in bulk'],
  ['wholesale-projectors', 'wholesale projectors'],
  ['rustoleum-wholesale', 'rustoleum wholesale'],
  ['rust-oleum-marking-paint', 'rust-oleum marking paint'],
  ['marking-paint-bulk', 'marking paint bulk'],
  ['bulk-marking-paint', 'bulk marking paint'],
  ['avery-wholesale', 'avery wholesale'],
  ['bulk-avery-labels', 'bulk avery labels'],
  ['bulk-acco-office-supplies', 'bulk acco office supplies'],
  ['acco-folders', 'acco folders'],
];

function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
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

function keywordOverviewUrl(keyword) {
  return `https://app.ahrefs.com/keywords-explorer/google/us/overview?keyword=${encodeURIComponent(keyword)}`;
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
  let lastPage = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const page = await bridge.sendCommand('browser_get_page_content', { tabId, format: 'text' }).catch(() => null);
    if (page) {
      const bodyText = page.bodyText || page.content || '';
      lastPage = { ...page, bodyText };
      if (/sign in|log in/i.test(page.title || '') || /sign in to ahrefs|log in to ahrefs/i.test(bodyText)) {
        throw new Error(`Ahrefs auth appears unavailable on tab ${tabId}.`);
      }
      if (!/just a moment/i.test(page.title || '') && bodyText.trim().length > 0 && predicate(bodyText, page)) return lastPage;
    }
    await delay(1000);
  }
  if (lastPage?.bodyText?.trim() && !/just a moment/i.test(lastPage.title || '')) return lastPage;
  throw new Error(`${task} timed out before any readable Ahrefs page text.`);
}

async function capturePage({ bridge, url, label, kind, reportDir }) {
  const startedAt = Date.now();
  const tab = await bridge.sendCommand('browser_create_tab', {
    url,
    activate: false,
    groupTitle: GROUP_TITLE,
    groupColor: GROUP_COLOR,
    groupCollapsed: true,
  });
  const row = { label, kind, url, tabId: tab.tabId, startedAt: new Date().toISOString() };
  try {
    await delay(6000);
    const page = await waitForPageText(
      bridge,
      tab.tabId,
      (bodyText, currentPage) => {
        if (/SERP not found/i.test(bodyText)) return true;
        if (kind === 'target') return /Organic keywords/i.test(bodyText) || /Organic keywords/i.test(currentPage.title || '');
        return /Volume|KD|SERP overview|Traffic potential|Keyword ideas/i.test(bodyText);
      },
      TIMEOUT_MS,
      label,
    );
    const textPath = path.join(reportDir, `${slug(label)}.txt`);
    await fsp.writeFile(textPath, page.bodyText || '', 'utf8');
    row.status = 'pass';
    row.title = page.title;
    row.pageUrl = page.url;
    row.textPath = textPath;
    row.chars = (page.bodyText || '').length;
    row.elapsedMs = Date.now() - startedAt;
    row.serpNotFound = /SERP not found/i.test(page.bodyText || '');
  } catch (error) {
    row.status = 'fail';
    row.error = error?.message || String(error);
    row.elapsedMs = Date.now() - startedAt;
  } finally {
    await bridge.sendCommand('browser_close_tab', { tabId: tab.tabId }).catch(() => {});
  }
  return row;
}

async function main() {
  const runStamp = stampForPath();
  const reportDir = path.join(REPORTS_ROOT, `bos-target-sweep-${runStamp}`);
  await fsp.mkdir(reportDir, { recursive: true });
  await fsp.mkdir(PROJECT_DIR, { recursive: true });

  const bridge = new LocalBridgeServer({
    sharedKey: loadSharedKey(),
    sessionId: `cic_bos_target_sweep_${runStamp}`,
    portStart: PORT_START,
    portEnd: PORT_END,
    requestTimeoutMs: TIMEOUT_MS,
  });

  const results = [];
  const port = await bridge.start();
  console.error(`[bos-sweep] bridge listening on ${port}; waiting for CiC extension`);
  await waitForAuthenticatedBridge(bridge, `BOS target sweep ${runStamp}`, 60_000);
  console.error('[bos-sweep] CiC extension authenticated');

  try {
    for (const [label, targetUrl, mode] of TARGET_PAGES) {
      console.error(`[bos-sweep] target ${label}`);
      const row = await capturePage({
        bridge,
        url: siteExplorerOrganicUrl(targetUrl, mode),
        label: `target-${label}`,
        kind: 'target',
        reportDir,
      });
      row.targetUrl = targetUrl;
      row.mode = mode;
      results.push(row);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
      await delay(1200);
    }

    for (const [label, keyword] of KEYWORDS) {
      console.error(`[bos-sweep] keyword overview ${keyword}`);
      const overview = await capturePage({
        bridge,
        url: keywordOverviewUrl(keyword),
        label: `kw-overview-${label}`,
        kind: 'keyword-overview',
        reportDir,
      });
      overview.keyword = keyword;
      results.push(overview);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(overview)}\n`, 'utf8');
      await delay(1200);

      console.error(`[bos-sweep] keyword serp ${keyword}`);
      const serp = await capturePage({
        bridge,
        url: keywordSerpUrl(keyword),
        label: `kw-serp-${label}`,
        kind: 'keyword-serp',
        reportDir,
      });
      serp.keyword = keyword;
      results.push(serp);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(serp)}\n`, 'utf8');
      await delay(1200);
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  const outputPath = path.join(PROJECT_DIR, 'bos_target_sweep_manifest_2026-04-29.json');
  await fsp.writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), reportDir, results }, null, 2), 'utf8');
  console.log(JSON.stringify({ outputPath, reportDir, count: results.length }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
