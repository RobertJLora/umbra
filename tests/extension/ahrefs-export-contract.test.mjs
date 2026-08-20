import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AHREFS_REPORTS,
  ahrefsDownloadNeedle,
  encodeBatchAnalysisTargets,
  isChartKebabCsv,
  makeAhrefsReportUrl,
  pageActionResult,
  parseDelimitedTable,
} from '../../mcp-server/ahrefs-export.js';
import { isMcpLocalTool, getToolDefinition } from '../../mcp-server/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const SITE_EXPLORER_REPORTS = [
  'organic-keywords',
  'top-pages',
  'refdomains',
  'backlinks',
  'organic-competitors',
  'backlinks-internal',
  'linked-anchors-internal',
];
const NEW_REPORTS = ['keywords-explorer', 'batch-analysis', 'content-gap', 'position-history'];

describe('Umbra Ahrefs export contract', () => {
  it('keeps official Site Explorer URLs on v2 paths and adds KE, batch, and content gap', () => {
    assert.equal(
      makeAhrefsReportUrl({ target: 'travelbagexperts.com' }),
      'https://app.ahrefs.com/v2-site-explorer/organic-keywords?target=travelbagexperts.com&mode=subdomains&volume_type=monthly&country=us',
    );
    assert.match(
      makeAhrefsReportUrl({ target: 'userp.io', report: 'top-pages' }),
      /\/v2-site-explorer\/top-pages\?/,
    );
    assert.match(
      makeAhrefsReportUrl({ target: 'userp.io', report: 'refdomains' }),
      /\/site-explorer\/refdomains\?/,
    );
    assert.match(
      makeAhrefsReportUrl({ target: 'userp.io', compareDate: 'prevMonth' }),
      /compareDate=prevMonth/,
    );
    assert.deepEqual(Object.keys(AHREFS_REPORTS), [...SITE_EXPLORER_REPORTS, ...NEW_REPORTS]);
    assert.match(
      makeAhrefsReportUrl({ target: 'seo tools', report: 'keywords-explorer', country: 'us' }),
      /\/keywords-explorer\/google\/us\/overview\?keyword=seo%20tools/,
    );
    assert.equal(
      makeAhrefsReportUrl({ report: 'keywords-explorer', keywords: ['seo tools', 'link building'] }),
      'https://app.ahrefs.com/keywords-explorer',
    );
    assert.match(
      makeAhrefsReportUrl({ target: 'theatre lounge', report: 'position-history', country: 'au' }),
      /\/keywords-explorer\/google\/au\/overview\?keyword=theatre%20lounge/,
    );
    assert.equal(AHREFS_REPORTS['position-history'].allowChartCsv, true);
    assert.deepEqual(AHREFS_REPORTS['position-history'].expectHeaders, ['Date']);
    assert.match(
      makeAhrefsReportUrl({ target: 'a.com', report: 'content-gap', competitors: 'b.com', country: 'us' }),
      /\/competitive-analysis\/content-gap\?target=a\.com&country=us&competitors=b\.com/,
    );
    const batchUrl = makeAhrefsReportUrl({
      target: 'hubspot.com',
      report: 'batch-analysis',
      targets: ['hubspot.com', 'zendesk.com'],
    });
    assert.match(batchUrl, /^https:\/\/app\.ahrefs\.com\/batch-analysis\/report\?/);
    assert.match(batchUrl, /hiddenColumns=/);
    assert.match(batchUrl, /#v1:/);
    const encoded = batchUrl.split('#')[1].replace(/^v1:/, '');
    const payload = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8'));
    assert.equal(payload.p, 'both');
    assert.deepEqual(payload.c.map((item) => item.u), ['hubspot.com', 'zendesk.com']);
    assert.equal(encodeBatchAnalysisTargets(['hubspot.com']).startsWith('v1:'), true);
  });

  it('exposes a one-shot MCP export with destination, includeTop10, and compareDate', () => {
    assert.equal(isMcpLocalTool('browser_export_ahrefs'), true);
    assert.equal(isMcpLocalTool('browser_reload_extension'), false);
    const schema = getToolDefinition('browser_export_ahrefs').inputSchema;
    assert.equal(schema.required[0], 'target');
    for (const report of [...SITE_EXPLORER_REPORTS, ...NEW_REPORTS]) {
      assert.ok(schema.properties.report.enum.includes(report), report);
    }
    assert.deepEqual(schema.properties.destination.enum, ['csv', 'sheets']);
    assert.equal(schema.properties.includeTop10.type, 'boolean');
    assert.equal(schema.properties.unhideColumns.type, 'boolean');
    assert.ok(schema.properties.targets);
    assert.ok(schema.properties.keywords);
    assert.ok(schema.properties.compareDate);
    assert.ok(getToolDefinition('browser_reload_extension'));
  });

  it('opens the toolbar Export from the Columns-anchored React handler', () => {
    const background = fs.readFileSync(path.join(repoRoot, 'extension', 'background.js'), 'utf8');
    const helperStart = background.indexOf('const findExportUnderHeading');
    const helperEnd = background.indexOf('const selectSheetsRadio');
    const openHelper = background.slice(helperStart, helperEnd);
    const start = background.indexOf("if (action === 'ahrefs_open_table_export')");
    const end = background.indexOf("if (action === 'ahrefs_modal_state')");
    const openBlock = background.slice(start, end);
    const exportBlock = background.slice(
      background.indexOf("if (action === 'ahrefs_export_csv')"),
      background.indexOf("throw new Error(`Unsupported page action"),
    );
    const runner = fs.readFileSync(path.join(repoRoot, 'mcp-server', 'ahrefs-export.js'), 'utf8');

    assert.ok(helperStart >= 0);
    assert.ok(start >= 0);
    assert.match(openBlock, /openTableExport/);
    assert.match(openHelper, /Columns/);
    assert.match(openHelper, /columns_adjacent/);
    assert.match(openHelper, /findToolbarExportFallback/);
    assert.match(openHelper, /findExportUnderHeading/);
    assert.match(openHelper, /SERP overview/);
    assert.match(openHelper, /exportY - headingY < 72/);
    assert.match(openHelper, /ke_skip_columns/);
    assert.match(openHelper, /ke_last_export/);
    assert.match(openHelper, /ke_list_columns/);
    assert.match(openHelper, /keywords-explorer\\\/list\\\//);
    assert.match(openHelper, /Last 2 years|Last \\d\+ \(days\|months\|years\)/);
    assert.match(openHelper, /scrollIntoView/);
    assert.doesNotMatch(openHelper, /topmost_export_click/);
    assert.match(background, /enter keywords/i);
    assert.match(background, /textarea_not_found/);
    assert.match(runner, /pageActionResult/);
    assert.match(runner, /textarea not found after paste/);
    assert.match(runner, /list table did not show Columns after paste/);
    assert.match(runner, /search-volume-history/);
    assert.match(background, /action === 'ahrefs_select_sheets'/);
    assert.match(background, /action === 'ahrefs_unhide_columns'/);
    assert.match(background, /action === 'ahrefs_include_top10'/);
    assert.match(background, /action === 'ahrefs_update_if_empty'/);
    assert.match(background, /No data for this keyword/);
    assert.match(runner, /ahrefs_update_if_empty/);
    assert.match(exportBlock, /destination === 'sheets'/);
    assert.match(exportBlock, /radioCount === 5|radios\.length === 5/);
    assert.match(exportBlock, /modal_did_not_open/);
    assert.match(background, /action === 'wait_for_text'/);
    assert.match(background, /action === 'ahrefs_export_position_history'/);
    assert.match(background, /position_history_heading_not_found/);
    assert.match(runner, /allowChartCsv/);
    assert.match(runner, /ahrefs_export_position_history/);
    assert.match(runner, /compareDate/);
    assert.match(runner, /destination === 'sheets'/);
    assert.match(runner, /sheets_readback\.py/);
    assert.match(runner, /isChartKebabCsv/);
    assert.match(runner, /browser_close_tab/);
    assert.match(runner, /ahrefsDownloadNeedle/);
    assert.match(runner, /downloadRecovered/);
    assert.match(background, /__reactFiber\$/);
    assert.match(background, /memoizedProps/);
    assert.match(background, /submitted_click/);
    assert.match(background, /sheets-already-checked/);
    assert.doesNotMatch(runner, /browser_close_session_tabs/);
  });

  it('waits on the hostname for exact-URL Ahrefs CSV names', () => {
    assert.equal(
      ahrefsDownloadNeedle('https://cymulate.com/cybersecurity-glossary/siem-correlation-rules/'),
      'cymulate.com',
    );
    assert.equal(
      ahrefsDownloadNeedle('https://cymulate.com/cybersecurity-glossary/siem-correlation-rules/', {
        report: 'organic-keywords',
      }),
      'cymulate.com',
    );
    assert.equal(ahrefsDownloadNeedle('cymulate.com'), 'cymulate.com');
    assert.equal(ahrefsDownloadNeedle('www.cymulate.com'), 'cymulate.com');
    assert.notEqual(
      ahrefsDownloadNeedle('https://cymulate.com/cybersecurity-glossary/siem-correlation-rules/'),
      'https:',
    );
    assert.equal(
      ahrefsDownloadNeedle('seo tools', { report: 'keywords-explorer', keywords: ['seo tools'] }),
      'seo-tools',
    );
  });

  it('parses a Keyword CSV the same way the runner proves an export', () => {
    const fixture = path.join(repoRoot, 'tests', 'fixtures', 'organic-keywords-sample.csv');
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, 'Keyword,Volume\ntravel backpack,100\ncarry on bag,80\n');
    const parsed = parseDelimitedTable(fixture);
    assert.equal(parsed.rowCount, 2);
    assert.deepEqual(parsed.columns.slice(0, 2), ['Keyword', 'Volume']);
    assert.equal(isChartKebabCsv(parsed.columns), false);
  });

  it('unwraps page-action payloads without reading result on null', () => {
    assert.deepEqual(pageActionResult(null), {});
    assert.deepEqual(pageActionResult(undefined), {});
    assert.deepEqual(pageActionResult({ pasted: true, reason: 'ok' }), { pasted: true, reason: 'ok' });
    assert.deepEqual(
      pageActionResult({ result: { pasted: false, reason: 'textarea_not_found' } }),
      { pasted: false, reason: 'textarea_not_found' },
    );
    assert.deepEqual(pageActionResult({ result: null }), { result: null });
  });

  it('rejects a chart kebab CSV that has Date and no Keyword', () => {
    assert.equal(isChartKebabCsv(['Date', 'https://travelbagexperts.com/']), true);
    assert.equal(isChartKebabCsv(['Keyword', 'Volume', 'Date']), false);
    const fixture = path.join(repoRoot, 'tests', 'fixtures', 'chart-kebab-sample.csv');
    fs.writeFileSync(fixture, 'Date,https://travelbagexperts.com/\n2026-01-01,120\n');
    const parsed = parseDelimitedTable(fixture);
    assert.equal(isChartKebabCsv(parsed.columns), true);
  });
});
