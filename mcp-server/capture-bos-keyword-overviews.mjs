import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBridgeServer } from './bridge-core.js';

const SHARED_KEY_FILE = '/Users/RobertLora/.umbra/shared-key';
const PROJECT_DIR = '/Users/RobertLora/Documents/Workspaces/uSERP/13_Projects/Felipe_Anchor_Consults/Bulk_Office_Supply_2026-04-16';
const REPORTS_ROOT = path.resolve('../reports');
const GROUP_TITLE = 'Ahrefs BOS Keyword Metrics';
const GROUP_COLOR = 'cyan';
const PORT_START = 47829;
const PORT_END = 47852;
const TIMEOUT_MS = 90_000;

const KEYWORDS = [
  ['acco', 'acco binders'],
  ['acco', 'bulk acco binders'],
  ['acco', 'acco binders bulk'],
  ['acco', 'wholesale binders'],
  ['acco', 'bulk binders'],
  ['avery', 'avery labels wholesale'],
  ['avery', 'bulk avery labels'],
  ['avery', 'avery labels bulk'],
  ['avery', 'avery address labels bulk'],
  ['avery', 'avery shipping labels bulk'],
  ['avery', 'bulk labels for business'],
  ['smead', 'smead file folders'],
  ['smead', 'smead folders bulk'],
  ['smead', 'bulk smead folders'],
  ['smead', 'wholesale file folders'],
  ['smead', 'bulk file folders'],
  ['tops', 'tops paper wholesale'],
  ['tops', 'wholesale tops paper'],
  ['tops', 'tops legal pads bulk'],
  ['tops', 'tops writing pads bulk'],
  ['tops', 'bulk legal pads'],
  ['tops', 'wholesale legal pads'],
];

function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function loadSharedKey() {
  const fromEnv = process.env.UMBRA_SHARED_KEY?.trim();
  if (fromEnv) return fromEnv;
  return fs.readFileSync(process.env.UMBRA_SHARED_KEY_FILE || SHARED_KEY_FILE, 'utf8').trim();
}

function keywordUrl(keyword) {
  return `https://app.ahrefs.com/keywords-explorer/google/us/overview?keyword=${encodeURIComponent(keyword)}`;
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

async function waitForKeywordPage(bridge, tabId, keyword) {
  const startedAt = Date.now();
  let lastPage = null;
  while (Date.now() - startedAt <= TIMEOUT_MS) {
    const page = await bridge.sendCommand('browser_get_page_content', { tabId, format: 'text' }).catch(() => null);
    if (page) {
      const bodyText = page.bodyText || page.content || '';
      lastPage = { ...page, bodyText };
      if (/sign in|log in/i.test(page.title || '') || /sign in to ahrefs|log in to ahrefs/i.test(bodyText)) {
        throw new Error('Ahrefs auth appears unavailable.');
      }
      if (bodyText.toLowerCase().includes(keyword.toLowerCase()) && /Volume|Difficulty|KD|CPC|SERP overview/i.test(bodyText)) {
        return lastPage;
      }
    }
    await delay(1000);
  }
  return lastPage || { bodyText: '', title: '', url: '' };
}

function extractMetricNear(text, label) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  if (index >= 0) return lines.slice(index, index + 6);
  return [];
}

function summarizeText(text) {
  return {
    volumeBlock: extractMetricNear(text, 'Volume'),
    kdBlock: extractMetricNear(text, 'KD'),
    cpcBlock: extractMetricNear(text, 'CPC'),
    trafficPotentialBlock: extractMetricNear(text, 'Traffic potential'),
    serpNotFound: /SERP not found/i.test(text),
    noData: /not enough data|no data|not found/i.test(text),
  };
}

async function main() {
  const runStamp = stampForPath();
  const reportDir = path.join(REPORTS_ROOT, `bos-keyword-overviews-${runStamp}`);
  await fsp.mkdir(reportDir, { recursive: true });
  const bridge = new LocalBridgeServer({
    sharedKey: loadSharedKey(),
    sessionId: `cic_bos_keyword_overviews_${runStamp}`,
    portStart: PORT_START,
    portEnd: PORT_END,
    requestTimeoutMs: TIMEOUT_MS,
  });

  const results = [];
  const port = await bridge.start();
  console.error(`[bos-keywords] bridge listening on ${port}; waiting for CiC extension`);
  await waitForAuthenticatedBridge(bridge, `BOS keyword overviews ${runStamp}`, 60_000);
  console.error('[bos-keywords] CiC extension authenticated');

  try {
    for (const [manufacturer, keyword] of KEYWORDS) {
      console.error(`[bos-keywords] reading ${keyword}`);
      const tab = await bridge.sendCommand('browser_create_tab', {
        url: keywordUrl(keyword),
        activate: false,
        groupTitle: GROUP_TITLE,
        groupColor: GROUP_COLOR,
        groupCollapsed: false,
      });
      const page = await waitForKeywordPage(bridge, tab.tabId, keyword);
      const safeSlug = keyword.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
      const textPath = path.join(reportDir, `${safeSlug}.txt`);
      await fsp.writeFile(textPath, page.bodyText || '', 'utf8');
      const result = {
        manufacturer,
        keyword,
        url: keywordUrl(keyword),
        tabId: tab.tabId,
        title: page.title,
        pageUrl: page.url,
        textPath,
        chars: (page.bodyText || '').length,
        summary: summarizeText(page.bodyText || ''),
      };
      results.push(result);
      await fsp.appendFile(path.join(reportDir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
      await bridge.sendCommand('browser_close_tab', { tabId: tab.tabId }).catch(() => {});
      await delay(1000);
    }
  } finally {
    await bridge.stop().catch(() => {});
  }

  const outputPath = path.join(PROJECT_DIR, 'keyword_overview_capture_manifest_2026-04-29.json');
  await fsp.writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), reportDir, results }, null, 2), 'utf8');
  console.log(JSON.stringify({ outputPath, reportDir, count: results.length }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
