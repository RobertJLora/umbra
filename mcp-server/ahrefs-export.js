import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDownloadDir } from './config.js';
import { FileDownloadLedger, describeUserPath } from './download-ledger.mjs';

// This module is the Ahrefs orchestration plugin. It is deliberately outside the
// published package's file allowlist, so a public install resolves it to null and
// hides browser_export_ahrefs, while a checkout of this repository keeps it.
//
// isAvailable() answers the other question: the file is present, but can it run?
// Returns { ok, reason } so the MCP entry point can report a named cause instead
// of surfacing a tool that fails 90 seconds later.
export function isAvailable() {
  const downloadDir = resolveDownloadDir();
  if (!fs.existsSync(downloadDir)) {
    return {
      ok: false,
      reason: `Ahrefs export needs a download directory. ${describeUserPath(downloadDir)} `
        + 'does not exist; set UMBRA_DOWNLOAD_DIR to the folder Chrome saves downloads into.',
    };
  }
  return { ok: true, reason: '' };
}

export const AHREFS_REPORTS = {
  'organic-keywords': {
    path: 'organic-keywords',
    extra: { volume_type: 'monthly' },
    expectHeaders: ['Keyword'],
    filenameHints: ['organic-keywords'],
  },
  'top-pages': {
    path: 'top-pages',
    extra: {},
    expectHeaders: ['URL', 'Page URL', 'Page'],
    filenameHints: ['top-pages'],
  },
  refdomains: {
    path: 'refdomains',
    host: 'site-explorer',
    omitCountry: true,
    extra: {},
    expectHeaders: ['Domain', 'Referring domain', 'DR'],
    filenameHints: ['refdomains', 'referring-domains'],
  },
  backlinks: {
    path: 'backlinks',
    host: 'site-explorer',
    omitCountry: true,
    extra: {},
    expectHeaders: ['Referring page', 'Page URL', 'URL'],
    filenameHints: ['backlinks'],
  },
  'organic-competitors': {
    path: 'organic-competitors',
    extra: {},
    expectHeaders: ['Domain', 'Competitor'],
    filenameHints: ['organic-competitors', 'competing-domains'],
  },
  'backlinks-internal': {
    path: 'backlinks-internal',
    extra: {},
    expectHeaders: ['Referring page', 'Page URL', 'URL'],
    filenameHints: ['backlinks-internal', 'internal-backlinks'],
  },
  'linked-anchors-internal': {
    path: 'linked-anchors-internal',
    extra: {},
    expectHeaders: ['Anchor', 'Anchor text'],
    filenameHints: ['linked-anchors', 'anchors'],
  },
  'keywords-explorer': {
    kind: 'keywords-explorer',
    path: 'keywords-explorer',
    extra: {},
    expectHeaders: ['Keyword', 'URL', 'Title', 'Type'],
    filenameHints: ['keywords-explorer', 'overview', 'matching-terms', 'serp-overview'],
  },
  'batch-analysis': {
    kind: 'batch-analysis',
    path: 'batch-analysis',
    extra: {},
    expectHeaders: ['Target', 'DR', 'UR'],
    filenameHints: ['batch-analysis'],
  },
  'content-gap': {
    kind: 'content-gap',
    path: 'content-gap',
    extra: {},
    expectHeaders: ['Keyword'],
    filenameHints: ['content-gap'],
  },
  'position-history': {
    kind: 'position-history',
    path: 'keywords-explorer',
    extra: {},
    expectHeaders: ['Date'],
    filenameHints: ['position-history', 'positions_', 'overview'],
    allowChartCsv: true,
  },
};

export function normalizeAhrefsList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function encodeBatchAnalysisTargets(targets, mode = 'subdomains') {
  const payload = {
    p: 'both',
    c: normalizeAhrefsList(targets).map((domain) => ({ u: domain, m: mode || 'subdomains' })),
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const encoded = compressed.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return `v1:${encoded}`;
}

export function isChartKebabCsv(columns = []) {
  const lower = new Set(columns.map((item) => String(item || '').trim().toLowerCase()));
  return lower.has('date') && !lower.has('keyword');
}

export function pageActionResult(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  if (Object.prototype.hasOwnProperty.call(value, 'result') && value.result && typeof value.result === 'object') {
    return value.result;
  }
  return value;
}

export function ahrefsDownloadNeedle(target, { report, keywords, targets } = {}) {
  const raw = String(
    target || normalizeAhrefsList(keywords)[0] || normalizeAhrefsList(targets)[0] || report || '',
  ).trim();
  let host = raw;
  const hosted = raw.match(/^(?:https?:\/\/)?([^/:]+)(?:[:/?#]|$)/i);
  if (hosted) {
    host = hosted[1];
  }
  host = host.replace(/^www\./i, '');
  if (report === 'keywords-explorer') {
    const list = normalizeAhrefsList(keywords);
    if (list.length > 1) return 'overview';
    const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return slug.slice(0, 20) || 'serp-overview';
  }
  if (!host || /^https?:$/i.test(host)) {
    return String(report || 'csv').toLowerCase();
  }
  return host;
}

const MODAL_INSPECT = {
  selector: 'button,a,label,[role="button"],[role="link"],[role="menuitem"],[role="radio"],input',
  minX: 450,
  minY: 250,
  maxY: 700,
  limit: 40,
};

export function makeAhrefsReportUrl({
  target,
  report = 'organic-keywords',
  country = 'us',
  mode = 'subdomains',
  compareDate,
  keywords,
  targets,
  competitors,
} = {}) {
  const spec = AHREFS_REPORTS[report];
  if (!spec) {
    throw new Error(`Unsupported Ahrefs report: ${report}`);
  }
  const countryCode = String(country || 'us').trim() || 'us';
  const targetMode = String(mode || 'subdomains').trim() || 'subdomains';

  if (spec.kind === 'keywords-explorer' || spec.kind === 'position-history') {
    const list = normalizeAhrefsList(keywords);
    if (!list.length && target) {
      list.push(String(target).trim());
    }
    if (list.length === 1) {
      return `https://app.ahrefs.com/keywords-explorer/google/${countryCode}/overview?keyword=${encodeURIComponent(list[0])}`;
    }
    return 'https://app.ahrefs.com/keywords-explorer';
  }

  if (spec.kind === 'batch-analysis') {
    const list = normalizeAhrefsList(targets);
    if (!list.length && target) {
      list.push(...normalizeAhrefsList(target));
    }
    const params = new URLSearchParams({
      country: countryCode,
      hiddenColumns: '',
      limit: '100',
      offset: '0',
      sortDirection: 'desc',
      volume_type: 'monthly',
    });
    if (!list.length) {
      return 'https://app.ahrefs.com/batch-analysis';
    }
    return `https://app.ahrefs.com/batch-analysis/report?${params.toString()}#${encodeBatchAnalysisTargets(list, targetMode)}`;
  }

  if (spec.kind === 'content-gap') {
    const params = new URLSearchParams({
      target: String(target || '').trim(),
      country: countryCode,
    });
    const firstCompetitor = normalizeAhrefsList(competitors)[0];
    if (firstCompetitor) {
      params.set('competitors', firstCompetitor);
    }
    return `https://app.ahrefs.com/competitive-analysis/content-gap?${params.toString()}`;
  }

  const params = new URLSearchParams({
    target,
    mode: targetMode,
    ...spec.extra,
  });
  if (!spec.omitCountry) {
    params.set('country', countryCode);
  }
  if (compareDate) {
    params.set('compareDate', String(compareDate));
  }
  const host = spec.host === 'site-explorer' ? 'site-explorer' : 'v2-site-explorer';
  return `https://app.ahrefs.com/${host}/${spec.path}?${params.toString()}`;
}

// Decode a downloaded table to text. UTF-8 with or without a BOM is the format
// this runner asks Ahrefs for; a UTF-16 BOM is decoded too, because a file saved
// from a different export path would otherwise arrive as unreadable bytes and
// report a parse failure over a download that actually succeeded.
function decodeTableFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return buffer.subarray(2).swap16().toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

// Tab against comma, decided on the first record rather than the first line, so
// a header whose first field is quoted and holds a newline cannot skew the vote.
function detectDelimiter(text) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = false;
        }
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      break;
    }
    if (char === '\t') {
      return '\t';
    }
  }
  return ',';
}

// RFC 4180 scan: quoted fields may hold the delimiter and newlines, and a doubled
// quote inside a quoted field is one literal quote. Real Ahrefs exports contain
// both, so a naive line count inflates rowCount, and rowCount gates the ok
// verdict and is handed to the agent as evidence.
//
// Only the header's fields are materialized; later records are counted, not
// built, because nothing downstream reads a cell value.
function scanDelimitedText(text, delimiter) {
  const headerFields = [];
  let rowCount = 0;
  let recordIndex = 0;
  let field = '';
  let fieldCount = 0;
  let recordHasContent = false;
  let inQuotes = false;

  const endField = () => {
    if (recordIndex === 0) {
      headerFields.push(field);
    }
    field = '';
    fieldCount += 1;
  };
  const endRecord = () => {
    // A record with no characters at all is a blank line, which is not a row.
    // A record holding one empty quoted field is a row, which is why this reads
    // the raw character flag rather than the field value.
    if (!recordHasContent && fieldCount === 0 && field === '') {
      return;
    }
    endField();
    if (recordIndex > 0) {
      rowCount += 1;
    }
    recordIndex += 1;
    fieldCount = 0;
    recordHasContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      recordHasContent = true;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      recordHasContent = true;
      continue;
    }
    if (char === delimiter) {
      recordHasContent = true;
      endField();
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      endRecord();
      continue;
    }
    field += char;
    recordHasContent = true;
  }

  // A file ending in a newline leaves nothing here, which is how the trailing
  // blank line stays out of the count. Anything else is a final unterminated
  // record and counts.
  if (recordHasContent || field.length > 0 || fieldCount > 0) {
    endRecord();
  }

  return { headerFields, rowCount };
}

export function parseDelimitedTable(filePath) {
  let text;
  try {
    text = decodeTableFile(filePath);
  } catch (error) {
    // Only the basename and the error code, because the raw fs message carries
    // the absolute path and this string reaches the agent as a tool error.
    throw new Error(
      `CSV parse failed: cannot read ${path.basename(String(filePath))} (${error.code || 'read error'}).`,
    );
  }
  const delimiter = detectDelimiter(text);
  const { headerFields, rowCount } = scanDelimitedText(text, delimiter);
  // Twelve headers is the cap the ok verdict and the chart-CSV rejection have
  // always read, and columnLine stays the pipe-joined form both compare against.
  const columnLine = headerFields.slice(0, 12).join('|');
  return {
    rowCount,
    columns: columnLine.split('|').filter(Boolean),
    columnLine,
  };
}

function headersMatch(columns, expectHeaders) {
  const lower = new Set(columns.map((item) => item.trim().toLowerCase()));
  return expectHeaders.some((header) => lower.has(header.trim().toLowerCase()));
}

async function inspectModalControls(sendCommand, tabId, extra = {}) {
  const inspected = await sendCommand('browser_run_page_action', {
    tabId,
    action: 'inspect_controls',
    params: { ...MODAL_INSPECT, ...extra },
  }).catch(() => null);
  return pageActionResult(inspected).controls || [];
}

async function clickModalByInspect(sendCommand, tabId, result) {
  const utf8Controls = await inspectModalControls(sendCommand, tabId, { textIncludes: 'utf-8' });
  const utf8 = utf8Controls.find((item) => /csv\s*\(utf-8/i.test(item.text || ''))
    || utf8Controls[0];
  if (utf8) {
    await sendCommand('browser_run_page_action', {
      tabId,
      action: 'click_control',
      params: { selector: MODAL_INSPECT.selector, domIndex: utf8.domIndex },
    });
    result.clickedUtf8 = { domIndex: utf8.domIndex, text: utf8.text };
    await delay(400);
  }

  const exportControls = (await inspectModalControls(sendCommand, tabId, { textIncludes: 'export' }))
    .filter((item) => /^\s*Export\s*$/i.test(item.text || '') && item.tagName === 'button')
    .sort((left, right) => (left.rect?.y || 0) - (right.rect?.y || 0));
  const modalExport = exportControls.at(-1);
  if (!modalExport) {
    throw new Error('Modal Export control not found via inspect_controls.');
  }
  await sendCommand('browser_run_page_action', {
    tabId,
    action: 'click_control',
    params: { selector: MODAL_INSPECT.selector, domIndex: modalExport.domIndex },
  });
  result.clickedModalExport = { domIndex: modalExport.domIndex, y: modalExport.rect?.y };
}

async function waitForModal(sendCommand, tabId, result) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= 12_000) {
    const modal = await sendCommand('browser_run_page_action', {
      tabId,
      action: 'ahrefs_modal_state',
    }).catch(() => null);
    result.modalState = pageActionResult(modal);
    if (result.modalState.ready || result.modalState.utf8 || result.modalState.sheets) {
      return true;
    }
    const pageText = await sendCommand('browser_get_page_content', { tabId, format: 'text' }).catch(() => null);
    const body = pageText?.bodyText || pageText?.content || '';
    if (/CSV \(UTF-8|Google Sheets/i.test(body)) {
      result.modalState = { ...(result.modalState || {}), ready: true, via: 'page_text' };
      return true;
    }
    await delay(750);
  }
  return Boolean(result.modalState?.ready || result.modalState?.utf8);
}

async function fallbackOpenAndSubmit(sendCommand, tabId, result) {
  const opened = await sendCommand('browser_run_page_action', {
    tabId,
    action: 'ahrefs_open_table_export',
    params: {
      includeTop10: result.includeTop10 === true,
    },
  }).catch(() => null);
  result.clickedControl = pageActionResult(opened);
  if (!(await waitForModal(sendCommand, tabId, result))) {
    throw new Error('Export modal did not open after Columns-anchored Export.');
  }
  await clickModalByInspect(sendCommand, tabId, result);
  result.submitResult = { submitted: true, via: 'columns_adjacent' };
}

export async function runAhrefsExport(sendCommand, options = {}) {
  const requestedDownloadDir = typeof options.downloadDir === 'string' && options.downloadDir.trim()
    ? options.downloadDir.trim()
    : '';
  const report = String(options.report || 'organic-keywords').trim();
  const spec = AHREFS_REPORTS[report];
  if (!spec) {
    throw new Error(`Unsupported Ahrefs report: ${report}`);
  }

  const keywords = normalizeAhrefsList(options.keywords);
  const targets = normalizeAhrefsList(options.targets);
  const competitors = normalizeAhrefsList(options.competitors);
  const target = String(options.target || '').trim() || targets[0] || keywords[0] || '';
  if (!target && report !== 'keywords-explorer' && report !== 'batch-analysis' && report !== 'position-history') {
    throw new Error('browser_export_ahrefs requires target.');
  }

  const country = String(options.country || 'us').trim() || 'us';
  const mode = String(options.mode || 'subdomains').trim() || 'subdomains';
  const compareDate = options.compareDate ? String(options.compareDate).trim() : '';
  const destination = options.destination === 'sheets' ? 'sheets' : 'csv';
  const includeTop10 = options.includeTop10 === true;
  const unhideColumns = options.unhideColumns === true
    || (destination === 'sheets' && options.unhideColumns !== false);
  const keepTabs = options.keepTabs === true;
  const groupTitle = String(options.groupTitle || 'Ahrefs Export').slice(0, 80);
  const url = makeAhrefsReportUrl({
    target,
    report,
    country,
    mode,
    compareDate,
    keywords,
    targets,
    competitors,
  });
  const needle = ahrefsDownloadNeedle(target, { report, keywords, targets });
  const result = {
    ok: false,
    target,
    report,
    country,
    mode,
    compareDate: compareDate || null,
    destination,
    includeTop10,
    unhideColumns,
    url,
    downloadNeedle: needle,
  };
  const sinceMs = Date.now();

  try {
    const created = await sendCommand('browser_create_tab', {
      url: 'about:blank',
      activate: false,
      groupTitle,
      groupCollapsed: true,
    });
    const tabId = created.tabId ?? created.id;
    result.tabId = tabId;

    await sendCommand('browser_navigate', {
      tabId,
      url,
      activate: false,
      timeoutMs: Number(options.navigateTimeoutMs) || 45_000,
    }).catch((error) => {
      result.navigateError = error.message;
    });

    if (report === 'keywords-explorer' && keywords.length > 1) {
      const runPaste = () => sendCommand('browser_run_page_action', {
        tabId,
        action: 'ahrefs_paste_keywords',
        params: { keywords },
        timeoutMs: 40_000,
      }).catch((error) => ({ pasted: false, error: error.message }));
      result.pasteKeywords = pageActionResult(await runPaste());
      if (!result.pasteKeywords.pasted) {
        await sendCommand('browser_navigate', {
          tabId,
          url,
          activate: false,
          timeoutMs: Number(options.navigateTimeoutMs) || 45_000,
        }).catch((error) => {
          result.pasteRetryNavigateError = error.message;
        });
        await delay(1_500);
        result.pasteKeywords = pageActionResult(await runPaste());
        result.pasteKeywordsRetry = true;
      }
      if (!result.pasteKeywords.pasted) {
        throw new Error(
          `Keywords Explorer textarea not found after paste. ${result.pasteKeywords.reason || 'unknown'}`,
        );
      }
      await delay(2_000);
      const waitForColumns = () => sendCommand('browser_run_page_action', {
        tabId,
        action: 'wait_for_text',
        params: { text: 'Columns', timeoutMs: 30_000 },
        timeoutMs: 35_000,
      }).catch((error) => ({ found: false, error: error.message }));
      result.waitForColumns = pageActionResult(await waitForColumns());
      if (!result.waitForColumns.found) {
        await delay(1_500);
        result.waitForColumns = pageActionResult(await waitForColumns());
      }
      if (!result.waitForColumns.found) {
        throw new Error('Keywords Explorer list table did not show Columns after paste.');
      }
    }

    if (report === 'keywords-explorer') {
      const updated = await sendCommand('browser_run_page_action', {
        tabId,
        action: 'ahrefs_update_if_empty',
        timeoutMs: 15_000,
      }).catch((error) => ({ clicked: false, error: error.message }));
      result.updateIfEmpty = pageActionResult(updated);
      if (result.updateIfEmpty?.clicked) {
        await sendCommand('browser_run_page_action', {
          tabId,
          action: 'wait_for_text',
          params: { text: 'Export', timeoutMs: 60_000 },
          timeoutMs: 65_000,
        }).catch(() => null);
      }
    }

    const waitText = await sendCommand('browser_run_page_action', {
      tabId,
      action: 'wait_for_text',
      params: { text: 'Export', timeoutMs: 90_000 },
      timeoutMs: 95_000,
    }).catch((error) => {
      result.waitError = error.message;
      return null;
    });
    result.waitForExport = pageActionResult(waitText);

    const page = await sendCommand('browser_get_page_content', { tabId, format: 'text' });
    result.pageTitle = page.title;
    result.pageUrl = page.url;
    const body = page.bodyText || page.content || '';
    if (/user\/login/i.test(page.url || '') || /sign in to ahrefs|log in to ahrefs/i.test(body)) {
      throw new Error('Ahrefs redirected to login.');
    }
    if (/being used on another device|sessions? exceeded/i.test(body)) {
      throw new Error('Ahrefs sessions-exceeded logout.');
    }

    if (unhideColumns) {
      const unhidden = await sendCommand('browser_run_page_action', {
        tabId,
        action: 'ahrefs_unhide_columns',
        timeoutMs: 15_000,
      }).catch((error) => ({ unhidden: [], error: error.message }));
      result.unhideResult = pageActionResult(unhidden);
    }

    const exportParams = report === 'position-history'
      ? {
          range: '2 years',
          addDomain: competitors[0] || '',
          timeoutMs: 25_000,
        }
      : {
          destination,
          includeTop10,
          unhideColumns: false,
          timeoutMs: destination === 'sheets' ? 30_000 : 25_000,
        };
    const exportActionName = report === 'position-history'
      ? 'ahrefs_export_position_history'
      : 'ahrefs_export_csv';
    const exported = await sendCommand('browser_run_page_action', {
      tabId,
      action: exportActionName,
      params: exportParams,
      timeoutMs: destination === 'sheets' ? 45_000 : 40_000,
    }).catch((error) => ({ exported: false, error: error.message }));
    result.exportAction = pageActionResult(exported);

    if (!result.exportAction?.exported && !result.exportAction?.submitted) {
      if (report === 'position-history') {
        throw new Error(`Position history export did not fire. ${result.exportAction?.reason || 'unknown'}`);
      }
      if (destination === 'sheets') {
        const retry = await sendCommand('browser_run_page_action', {
          tabId,
          action: 'ahrefs_export_csv',
          params: exportParams,
          timeoutMs: 45_000,
        }).catch((error) => ({ exported: false, error: error.message }));
        result.exportAction = pageActionResult(retry);
      } else {
        await fallbackOpenAndSubmit(sendCommand, tabId, result);
      }
    }

    if (destination === 'sheets') {
      const allLabel = result.exportAction?.allLabel
        || result.exportAction?.modal?.allLabel
        || result.modalState?.allLabel
        || null;
      result.allLabel = allLabel;
      result.toast = result.exportAction?.toast || null;
      result.readback = 'Use sheets_readback.py to pull the Drive sheet as CSV. Do not invent a Drive API client.';
      if (!result.exportAction?.exported && !result.exportAction?.submitted) {
        throw new Error('Sheets export did not submit.');
      }
      result.ok = true;
      return result;
    }

    let downloaded;
    try {
      downloaded = await sendCommand('browser_wait_for_download', {
        pattern: needle,
        extension: '.csv',
        createdAfterMs: sinceMs,
        timeoutMs: Number(options.downloadTimeoutMs) || 90_000,
        ...(requestedDownloadDir ? { dir: requestedDownloadDir } : {}),
      });
    } catch (error) {
      // Recovery, so it stays tolerant: findNew never throws on a missing
      // directory, because a throw here would replace the wait's error and hide
      // the real cause. The report's filename hints rank an actual Ahrefs export
      // above any other file in the folder that happens to carry the domain
      // name, and the tab scope pins a claimed download when the extension
      // reports one.
      const ledger = new FileDownloadLedger({
        downloadDir: requestedDownloadDir || resolveDownloadDir(),
        scope: { tabId: result.tabId },
      });
      const recovered = (await ledger.findNew({
        sinceMs,
        extension: '.csv',
        nameIncludes: [needle],
        nameIncludesAny: spec.filenameHints || [],
        expectedNames: await ledger.collectAttribution(),
      }))[0];
      if (!recovered?.filePath) {
        throw error;
      }
      downloaded = recovered;
      result.downloadRecovered = true;
      result.downloadAttributed = recovered.attributed === true;
    }
    const sourcePath = downloaded.filePath || downloaded.path;
    if (!sourcePath) {
      throw new Error('Download wait returned no file path.');
    }
    const destPath = options.out
      ? path.resolve(String(options.out))
      : sourcePath;
    if (path.resolve(destPath) !== path.resolve(sourcePath)) {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(sourcePath, destPath);
    }

    // Assigned before the parse so any parse failure still returns where the
    // file landed. The download has already succeeded by this point.
    result.sourceDownloadPath = sourcePath;
    result.destPath = destPath;
    result.bytes = downloaded.bytes || fs.statSync(destPath).size;

    const parsed = parseDelimitedTable(destPath);
    if (/search-volume-history/i.test(path.basename(destPath))) {
      throw new Error(
        `Chart kebab CSV rejected. Filename is search-volume-history, the KE Search Volume chart, not the list table. columns=${parsed.columnLine}`,
      );
    }
    if (isChartKebabCsv(parsed.columns) && !spec.allowChartCsv) {
      throw new Error(
        `Chart kebab CSV rejected. Date is present and Keyword is missing, so this is the chart export, not the table. columns=${parsed.columnLine}`,
      );
    }
    const hasExpectedHeader = headersMatch(parsed.columns, spec.expectHeaders);
    result.rowCount = parsed.rowCount;
    result.columns = parsed.columnLine;
    result.hasExpectedHeader = hasExpectedHeader;
    result.allLabel = result.exportAction?.allLabel || result.exportAction?.modal?.allLabel || result.modalState?.allLabel || null;
    if (!parsed.rowCount || !hasExpectedHeader) {
      throw new Error(`Bad CSV. rows=${parsed.rowCount} columns=${parsed.columnLine}`);
    }
    result.ok = true;
    return result;
  } catch (error) {
    result.error = error.message;
    return result;
  } finally {
    if (!keepTabs && result.tabId) {
      try {
        const closed = await sendCommand('browser_close_tab', { tabId: result.tabId });
        result.closedTabCount = closed.closedTabCount ?? 1;
        result.closedOnlyExportTab = true;
      } catch {
        // already closed or never opened
      }
    }
  }
}
