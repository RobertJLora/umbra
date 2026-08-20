// Ahrefs page automation for Umbra's browser_run_page_action tool.
//
// background.js injects this file into an owned tab's ISOLATED world before it
// runs any ahrefs_* page action, then calls into globalThis.__umbraPageRecipes.
// It is a classic script rather than a module because chrome.scripting
// executeScript injects a `files` list as classic scripts, and because
// runPageAction is stringified and injected: free identifiers inside it resolve
// in the injected world, which an import could never reach.
//
// The packaged public extension deliberately ships without this file. When it
// is absent the ahrefs_* dispatch in background.js reports that the recipe is
// not installed in this build, so nothing crashes and no other page action is
// affected. An unpacked install loaded from this repository keeps the full
// capability.
(() => {
  const RECIPE_VERSION = '1.0.0';
  const existing = globalThis.__umbraPageRecipes;
  if (existing?.ahrefs?.version === RECIPE_VERSION) {
    // Re-injection happens once per page action. Rebuilding the whole recipe on
    // a page that already carries this exact version would be wasted work.
    return;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const fireReact = (element, handlerName, extraEvent = {}) => {
    if (!element) return false;
    const makeEvent = (currentTarget) => ({
      preventDefault() {},
      stopPropagation() {},
      nativeEvent: { preventDefault() {}, stopPropagation() {} },
      currentTarget,
      target: element,
      ...extraEvent,
    });
    const callHandler = (props, currentTarget) => {
      const handler = props?.[handlerName];
      if (typeof handler !== 'function') return false;
      handler(makeEvent(currentTarget));
      return true;
    };
    const propsOf = (node) => {
      if (!node) return null;
      const propsKey = Object.keys(node).find((item) => item.startsWith('__reactProps$'));
      if (propsKey) return node[propsKey];
      const fiberKey = Object.keys(node).find((item) => item.startsWith('__reactFiber$'));
      const fiber = fiberKey ? node[fiberKey] : null;
      return fiber?.memoizedProps || fiber?.pendingProps || null;
    };
    let node = element;
    for (let depth = 0; depth < 10 && node; depth += 1) {
      if (callHandler(propsOf(node), node)) return true;
      const fiberKey = Object.keys(node).find((item) => item.startsWith('__reactFiber$'));
      let fiber = fiberKey ? node[fiberKey] : null;
      for (let up = 0; up < 10 && fiber; up += 1) {
        if (callHandler(fiber.memoizedProps || fiber.pendingProps, fiber.stateNode || node)) {
          return true;
        }
        fiber = fiber.return;
      }
      node = node.parentElement;
    }
    return false;
  };

  const isVisibleElement = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const visibleExact = (root, selector, pattern) =>
    [...root.querySelectorAll(selector)]
      .filter((element) => pattern.test(String(element.innerText || element.textContent || '').trim()))
      .filter((element) => isVisibleElement(element))
      .sort((left, right) => left.getBoundingClientRect().y - right.getBoundingClientRect().y);

  const clickElement = async (element, waitMsAfter = 400) => {
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await wait(80);
    const eventInit = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent('mouseover', eventInit));
    element.dispatchEvent(new MouseEvent('mousedown', eventInit));
    element.dispatchEvent(new MouseEvent('mouseup', eventInit));
    element.dispatchEvent(new MouseEvent('click', eventInit));
    try {
      element.click();
    } catch {
      // some custom elements reject a second click
    }
    fireReact(element, 'onClick');
    await wait(waitMsAfter);
    return true;
  };

  const modalRoot = () => {
    const candidates = [...document.querySelectorAll('dialog[open], dialog, [role="dialog"], [aria-modal="true"]')];
    const exportModal = candidates.find((node) => /CSV \(UTF-8|Google Sheets/i.test(node.textContent || ''));
    return exportModal || candidates.find((node) => node.matches?.('dialog[open]')) || candidates[0] || null;
  };

  const collectModalState = () => {
    const root = modalRoot() || document;
    const radios = [...document.querySelectorAll('input[type=radio]')];
    const labels = [...root.querySelectorAll('label')].map((label) => (label.textContent || '').trim());
    const allLabel = labels.find((text) => /^All\s+[\d,]+$/.test(text)) || null;
    const dialog = modalRoot();
    return {
      ready: radios.length >= 2 && labels.some((text) => /CSV \(UTF-8/i.test(text)),
      sheetsReady: radios.length === 5,
      radioCount: radios.length,
      allLabel,
      hasDialog: Boolean(dialog),
      utf8: labels.some((text) => /CSV \(UTF-8/i.test(text)),
      sheets: labels.some((text) => /google sheets/i.test(text)),
      includeTop10: labels.some((text) => /include top 10/i.test(text)),
    };
  };

  const findColumnsButton = () =>
    [...document.querySelectorAll('button')]
      .find((button) => /^\s*Columns\s*$/i.test(button.textContent || ''));

  const findColumnsAdjacentExport = () => {
    const cols = findColumnsButton();
    if (!cols) return { button: null, reason: 'columns_not_found' };
    let scope = cols.parentElement;
    for (let i = 0; i < 5 && scope; i += 1) {
      const exportButton = [...scope.querySelectorAll('button,a')]
        .find((button) => /^\s*Export\s*$/i.test(button.textContent || ''));
      if (
        exportButton
        && Math.abs(exportButton.getBoundingClientRect().y - cols.getBoundingClientRect().y) < 40
      ) {
        return { button: exportButton, reason: 'columns_adjacent', columns: cols };
      }
      scope = scope.parentElement;
    }
    return { button: null, reason: 'columns_adjacent_export_not_found', columns: cols };
  };

  const findExportUnderHeading = (pattern) => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5,[role="heading"]')]
      .filter((node) => {
        const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length < 120 && pattern.test(text);
      })
      .at(-1);
    if (!heading) return null;
    const headingY = heading.getBoundingClientRect().y;
    let scope = heading.parentElement;
    for (let i = 0; i < 8 && scope; i += 1) {
      const button = [...scope.querySelectorAll('button,a,[role="button"]')]
        .find((item) => {
          if (!/^\s*Export\s*$/i.test(item.textContent || '') || !isVisibleElement(item)) {
            return false;
          }
          const exportY = item.getBoundingClientRect().y;
          return exportY >= headingY - 8 && exportY - headingY < 72;
        });
      if (button) return button;
      scope = scope.parentElement;
    }
    return null;
  };

  const findToolbarExportFallback = () => {
    const exports = visibleExact(document, 'button,a,[role="button"]', /^\s*Export\s*$/i);
    if (!exports.length) {
      return { button: null, reason: 'toolbar_export_not_found', exportCount: 0 };
    }
    const serp = findExportUnderHeading(/^SERP overview/i);
    if (serp) {
      return { button: serp, reason: 'serp_overview_export', exportCount: exports.length };
    }
    const nearChart = (element) => {
      const y = element.getBoundingClientRect().y;
      return [...document.querySelectorAll('button,span,div')].some((node) => {
        const text = String(node.textContent || '').trim();
        if (!/^(Last \d+ (days|months|years)|Last year|All time|Daily|Weekly|Monthly)$/i.test(text)) {
          return false;
        }
        return Math.abs(node.getBoundingClientRect().y - y) < 48;
      });
    };
    const blocked = new Set(
      [findExportUnderHeading(/^Position history$/i), findExportUnderHeading(/^Ads position history/i)]
        .filter(Boolean),
    );
    const tableCandidates = exports.filter((button) => !blocked.has(button) && !nearChart(button));
    const button = tableCandidates[0] || exports[0];
    return {
      button,
      reason: tableCandidates.length ? (exports.length === 1 ? 'single_export' : 'toolbar_export_fallback') : 'chart_adjacent_export_fallback',
      exportCount: exports.length,
    };
  };

  const clickExportButton = async (button, reason, extra = {}) => {
    if (!button) {
      return { fired: false, reason, exportCount: extra.exportCount || 0, ...extra };
    }
    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await wait(200);
    let fired = fireReact(button, 'onClick');
    if (!fired) {
      fired = await clickElement(button, 600);
    } else {
      await wait(600);
    }
    return {
      fired,
      reason,
      y: Math.round(button.getBoundingClientRect().y),
      ...extra,
      exportCount: extra.exportCount || 1,
    };
  };

  const openKeListExport = async () => {
    const readyAt = Date.now();
    while (!findColumnsButton() && Date.now() - readyAt < 12_000) {
      await wait(300);
    }
    const columnsFound = findColumnsAdjacentExport();
    const exportCount = visibleExact(document, 'button,a,[role="button"]', /^\s*Export\s*$/i).length;
    if (!columnsFound.button) {
      return {
        fired: false,
        reason: columnsFound.reason || 'ke_list_columns_not_found',
        exportCount,
      };
    }
    return await clickExportButton(columnsFound.button, 'ke_list_columns', { exportCount });
  };

  const openTableExport = async (params = {}) => {
    const onKeywordsExplorer = /keywords-explorer/i.test(location.pathname);
    const onKeList = /keywords-explorer\/list\//i.test(location.pathname);
    if (onKeList || params.includeTop10 === true) {
      return await openKeListExport();
    }
    if (onKeywordsExplorer && !findColumnsButton()) {
      const listKeExports = () => [...document.querySelectorAll('button,a,[role="button"]')]
        .filter((button) => /^\s*Export\s*$/i.test(button.textContent || ''))
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .sort((left, right) => left.getBoundingClientRect().y - right.getBoundingClientRect().y);
      const readyAt = Date.now();
      while (listKeExports().length < 3 && Date.now() - readyAt < 12_000) {
        await wait(300);
      }
      const keExports = listKeExports();
      const lastExport = keExports.at(-1);
      if (lastExport) {
        return await clickExportButton(lastExport, 'ke_last_export', { exportCount: keExports.length });
      }
    }
    const columnsFound = onKeywordsExplorer ? { button: null, reason: 'ke_skip_columns' } : findColumnsAdjacentExport();
    const found = columnsFound.button
      ? { ...columnsFound, reason: 'columns_adjacent' }
      : findToolbarExportFallback();
    if (!found.button) {
      return { fired: false, reason: found.reason, exportCount: found.exportCount || 0 };
    }
    return await clickExportButton(found.button, found.reason, { exportCount: found.exportCount || 1 });
  };

  const selectSheetsRadio = () => {
    const root = modalRoot() || document;
    const label = [...root.querySelectorAll('label')]
      .find((item) => /google sheets/i.test(item.textContent || ''));
    const radio = label && (
      label.querySelector('input[type=radio]')
      || document.getElementById(label.getAttribute('for'))
    );
    if (!radio) {
      return { selected: false, reason: 'no-sheets-radio' };
    }
    radio.checked = true;
    const fired = fireReact(radio, 'onChange')
      || fireReact(radio, 'onClick')
      || fireReact(label, 'onClick')
      || fireReact(label, 'onChange');
    return {
      selected: fired || radio.checked,
      reason: fired ? 'sheets-selected' : (radio.checked ? 'sheets-already-checked' : 'sheets_onchange_missing'),
    };
  };

  const clickAllRows = () => {
    const root = modalRoot() || document;
    const allLabel = [...root.querySelectorAll('label')]
      .find((label) => /^All\s+[\d,]+$/.test((label.textContent || '').trim()));
    if (!allLabel) return false;
    const input = allLabel.querySelector('input') || document.getElementById(allLabel.getAttribute('for'));
    if (input) {
      input.checked = true;
      if (fireReact(input, 'onChange') || fireReact(input, 'onClick')) return true;
    }
    return fireReact(allLabel, 'onClick');
  };

  const includeTop10 = async () => {
    const root = modalRoot() || document;
    const label = [...root.querySelectorAll('label')]
      .find((item) => /include top 10/i.test(item.textContent || ''));
    if (!label) {
      return { checked: false, reason: 'include_top10_not_found' };
    }
    const input = label.querySelector('input[type=checkbox]')
      || document.getElementById(label.getAttribute('for'));
    const target = input || label;
    if (input) input.checked = true;
    const fired = fireReact(target, 'onChange') || fireReact(target, 'onClick');
    if (!fired) {
      await clickElement(target, 200);
    }
    const allRowsRestored = clickAllRows();
    return { checked: true, reason: 'include_top10', allRowsRestored };
  };

  const pageLooksEmpty = () => {
    const text = String(document.body?.innerText || '');
    return /No data for this keyword|SERP not found|No SERP data|Keyword difficulty unknown|Nothing found/i.test(text);
  };

  const updateIfEmpty = async () => {
    if (!pageLooksEmpty()) {
      return { clicked: false, reason: 'has_data' };
    }
    const button = [...document.querySelectorAll('button,a,[role="button"]')]
      .find((item) => /^\s*Update(\s+SERP)?\s*$/i.test(String(item.textContent || '').trim()) && isVisibleElement(item));
    if (!button) {
      return { clicked: false, reason: 'update_not_found', empty: true };
    }
    const fired = fireReact(button, 'onClick') || await clickElement(button, 800);
    return { clicked: Boolean(fired), reason: 'updated_empty_serp', empty: true };
  };

  const unhideColumns = async () => {
    const columnsBtn = findColumnsButton();
    if (!columnsBtn) {
      return { unhidden: [], reason: 'columns_not_found' };
    }
    fireReact(columnsBtn, 'onClick') || await clickElement(columnsBtn, 300);
    await wait(400);
    const wanted = [
      /^cpc$/i,
      /^organic traffic$/i,
      /^traffic$/i,
      /^value$/i,
      /^organic value$/i,
      /^page type$/i,
      /^ai content level$/i,
      /^status$/i,
    ];
    const enabled = [];
    const nodes = [...document.querySelectorAll('label, [role="menuitemcheckbox"], [role="checkbox"]')];
    for (const node of nodes) {
      const text = String(node.textContent || '').trim();
      if (!wanted.some((pattern) => pattern.test(text))) continue;
      const input = node.querySelector('input[type=checkbox]');
      const checked = node.getAttribute('aria-checked') === 'true' || input?.checked === true;
      if (checked) continue;
      const target = input || node;
      if (input) input.checked = true;
      if (!fireReact(target, 'onChange')) {
        fireReact(target, 'onClick');
      }
      enabled.push(text);
    }
    fireReact(columnsBtn, 'onClick');
    return {
      unhidden: enabled,
      reason: enabled.length ? 'unhidden' : 'none_or_already_visible',
    };
  };

  const findKeywordTextarea = () => {
    const areas = [...document.querySelectorAll('textarea')].filter((element) => isVisibleElement(element));
    return areas.find((element) => /enter keywords/i.test(element.placeholder || element.getAttribute('aria-label') || ''))
      || areas.find((element) => !/ask ai/i.test(element.placeholder || ''))
      || areas[0]
      || null;
  };

  const pasteKeywords = async (rawKeywords, params = {}) => {
    const list = Array.isArray(rawKeywords)
      ? rawKeywords.map((item) => String(item || '').trim()).filter(Boolean)
      : String(rawKeywords || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    const waitLimit = Math.max(2_000, Math.min(Number(params.timeoutMs) || 15_000, 30_000));
    const startedAt = Date.now();
    let textarea = findKeywordTextarea();
    while (!textarea && Date.now() - startedAt < waitLimit) {
      await wait(300);
      textarea = findKeywordTextarea();
    }
    if (!textarea) {
      return {
        pasted: false,
        reason: 'textarea_not_found',
        count: list.length,
        waitedMs: Date.now() - startedAt,
        textareaCount: document.querySelectorAll('textarea').length,
      };
    }
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, list.join('\n'));
    else textarea.value = list.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    fireReact(textarea, 'onChange');
    fireReact(textarea, 'onInput');
    const search = [...document.querySelectorAll('button')]
      .find((button) => /^\s*Search\s*$/i.test(button.textContent || '') && isVisibleElement(button));
    let searched = false;
    if (search) {
      searched = fireReact(search, 'onClick');
      if (!searched) searched = await clickElement(search, 400);
    }
    return {
      pasted: true,
      count: list.length,
      searched,
      placeholder: textarea.placeholder || null,
    };
  };

  const submitSheetsExport = async () => {
    const dialog = modalRoot();
    if (!dialog) {
      return { submitted: false, reason: 'no-dialog' };
    }
    const buttons = [...dialog.querySelectorAll('button,[role="button"]')]
      .filter((button) => /^\s*Export\s*$/i.test(String(button.textContent || '').trim()))
      .filter((button) => isVisibleElement(button));
    if (!buttons.length) {
      return { submitted: false, reason: 'no-export-button' };
    }
    const button = buttons[buttons.length - 1];
    if (fireReact(button, 'onClick')) {
      await wait(600);
      return { submitted: true, reason: 'submitted' };
    }
    const clicked = await clickElement(button, 600);
    return {
      submitted: Boolean(clicked),
      reason: clicked ? 'submitted_click' : 'export_onclick_missing',
    };
  };

  const readToast = () => {
    const nodes = [...document.querySelectorAll('[role="status"], [role="alert"], [class*="toast"], [class*="Toast"]')];
    const fromNode = nodes.map((node) => String(node.textContent || '').trim()).find(Boolean);
    if (fromNode) return fromNode.slice(0, 240);
    const body = document.body?.innerText || '';
    const match = body.match(/Export successful[^\n]{0,120}/i);
    return match ? match[0].trim() : null;
  };

  const submitTableExport = async () => {
    const dialog = modalRoot();
    const scope = dialog || document;
    const utf8Label = [...scope.querySelectorAll('label')]
      .find((label) => /CSV \(UTF-8/i.test(label.textContent || ''));
    let utf8 = 'missing';
    if (utf8Label) {
      await clickElement(utf8Label, 200);
      utf8 = 'clicked';
    }
    const allLabel = [...scope.querySelectorAll('label')]
      .find((label) => /^All\s+[\d,]+$/.test((label.textContent || '').trim()));
    let allRows = 'missing';
    if (allLabel) {
      await clickElement(allLabel, 200);
      allRows = 'clicked';
    }
    const exportButtons = visibleExact(scope, 'button,[role="button"]', /^\s*Export\s*$/i);
    const submitButton = exportButtons.at(-1) || null;
    let submitted = false;
    if (submitButton) {
      submitted = fireReact(submitButton, 'onClick');
      if (!submitted) {
        submitted = await clickElement(submitButton, 600);
      } else {
        await wait(600);
      }
    }
    return {
      utf8,
      allRows,
      exportButtonCount: exportButtons.length,
      submitted,
      reason: submitted ? 'modal_export_click' : 'export_button_not_found',
    };
  };

  const exportPositionHistory = async (params = {}) => {
    const rangeWanted = String(params.range || params.chartRange || '2 years').trim();
    const addDomain = String(params.addDomain || params.domain || '').trim();
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5')]
      .find((node) => /^Position history$/i.test(String(node.textContent || '').trim()));
    if (!heading) {
      return { exported: false, reason: 'position_history_heading_not_found' };
    }
    heading.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await wait(250);

    const headingY = heading.getBoundingClientRect().y;
    const nearHeading = (element) => {
      const y = element.getBoundingClientRect().y;
      return y >= headingY - 12 && y - headingY < 220;
    };
    const rangeButton = [...document.querySelectorAll('button,[role="button"]')]
      .find((button) => {
        if (!isVisibleElement(button) || !nearHeading(button)) return false;
        const text = String(button.textContent || '').trim();
        return /^(Last \d+ (days|months|years)|All time|2 years|24 months)$/i.test(text);
      });
    let rangeClicked = null;
    if (rangeButton && !new RegExp(rangeWanted.replace(/\s+/g, '\\s+'), 'i').test(rangeButton.textContent || '')) {
      fireReact(rangeButton, 'onClick') || await clickElement(rangeButton, 400);
      await wait(250);
      const optionLabels = ['All time', 'Last 2 years', '2 years', 'Last year', 'Last 12 months'];
      const option = optionLabels
        .map((label) => [...document.querySelectorAll('button,[role="menuitem"],[role="option"],li')]
          .find((item) => isVisibleElement(item) && new RegExp(`^${label}$`, 'i').test(String(item.textContent || '').trim())))
        .find(Boolean);
      if (option) {
        fireReact(option, 'onClick') || await clickElement(option, 400);
        rangeClicked = String(option.textContent || '').trim();
        await wait(400);
      }
    }

    let domainAdded = null;
    if (addDomain) {
      const addButton = [...document.querySelectorAll('button,[role="button"]')]
        .find((button) => {
          if (!isVisibleElement(button) || !nearHeading(button)) return false;
          return /Add domain to compare|Add domain/i.test(button.textContent || '');
        });
      if (addButton) {
        fireReact(addButton, 'onClick') || await clickElement(addButton, 400);
        await wait(300);
      }
      const input = [...document.querySelectorAll('input')]
        .find((field) => {
          if (!isVisibleElement(field)) return false;
          const rect = field.getBoundingClientRect();
          return rect.y >= headingY - 12 && rect.y - headingY < 260;
        });
      if (input) {
        input.focus();
        input.value = addDomain;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        domainAdded = addDomain;
        await wait(500);
      }
    }

    const exportButton = findExportUnderHeading(/^Position history$/i);
    if (!exportButton) {
      return {
        exported: false,
        reason: 'position_history_export_not_found',
        rangeClicked,
        domainAdded,
      };
    }
    exportButton.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await wait(150);
    const fired = fireReact(exportButton, 'onClick') || await clickElement(exportButton, 500);
    return {
      exported: Boolean(fired),
      reason: fired ? 'position_history_export' : 'position_history_export_click_failed',
      rangeClicked,
      domainAdded,
      y: Math.round(exportButton.getBoundingClientRect().y),
    };
  };

  const ahrefs = {
    version: RECIPE_VERSION,

    async ahrefs_open_table_export(params = {}) {
      return await openTableExport(params);
    },

    ahrefs_modal_state() {
      return collectModalState();
    },

    async ahrefs_submit_export() {
      return await submitTableExport();
    },

    ahrefs_select_sheets() {
      return selectSheetsRadio();
    },

    async ahrefs_unhide_columns() {
      return await unhideColumns();
    },

    async ahrefs_include_top10() {
      return await includeTop10();
    },

    async ahrefs_update_if_empty() {
      return await updateIfEmpty();
    },

    async ahrefs_paste_keywords(params = {}) {
      return await pasteKeywords(params.keywords ?? params.value ?? params.text, params);
    },

    async ahrefs_export_position_history(params = {}) {
      return await exportPositionHistory(params);
    },

    async ahrefs_export_csv(params = {}) {
      const destination = params.destination === 'sheets' ? 'sheets' : 'csv';
      const waitLimit = Math.max(1_000, Math.min(Number(params.timeoutMs) || 20_000, 90_000));
      const waitUntil = async (predicate, limitMs = waitLimit, tickMs = 250) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < limitMs) {
          if (predicate()) return true;
          await wait(tickMs);
        }
        return predicate();
      };

      if (params.unhideColumns) {
        await unhideColumns();
        await wait(300);
      }

      if (!(await waitUntil(() => Boolean(findColumnsButton()) || visibleExact(document, 'button,a,[role="button"]', /^\s*Export\s*$/i).length > 0))) {
        return { exported: false, destination, reason: 'toolbar_export_not_found', modal: collectModalState() };
      }

      let modal = collectModalState();
      let openResult = null;
      const modalOpen = () => {
        const next = collectModalState();
        return destination === 'sheets'
          ? next.radioCount === 5
          : next.ready || next.utf8;
      };
      if (!modalOpen()) {
        openResult = await openTableExport(params);
        await wait(400);
        modal = collectModalState();
        if (!modalOpen()) {
          await waitUntil(modalOpen, destination === 'sheets' ? 20_000 : waitLimit, destination === 'sheets' ? 1_000 : 250);
          modal = collectModalState();
        }
      }

      if (destination === 'sheets' ? modal.radioCount !== 5 : (!modal.ready && !modal.utf8)) {
        return {
          exported: false,
          destination,
          reason: 'modal_did_not_open',
          openResult,
          modal,
        };
      }

      if (params.includeTop10 && !modal.includeTop10) {
        await waitUntil(() => collectModalState().includeTop10, 8_000, 250);
        modal = collectModalState();
      }
      if (params.includeTop10 && !modal.includeTop10 && !/keywords-explorer\/list\//i.test(location.pathname)) {
        const serp = findExportUnderHeading(/^SERP overview/i);
        if (serp && openResult?.reason !== 'serp_overview_export') {
          openResult = {
            fired: fireReact(serp, 'onClick') || await clickElement(serp, 500),
            reason: 'serp_overview_retry',
            y: Math.round(serp.getBoundingClientRect().y),
            exportCount: visibleExact(document, 'button,a,[role="button"]', /^\s*Export\s*$/i).length,
          };
          await waitUntil(modalOpen, 12_000, 400);
          modal = collectModalState();
        }
      }
      if (params.includeTop10) {
        await includeTop10();
      }

      if (destination === 'sheets') {
        const selected = selectSheetsRadio();
        const submitResult = await submitSheetsExport();
        await wait(800);
        const nextModal = collectModalState();
        return {
          exported: Boolean(submitResult.submitted),
          submitted: Boolean(submitResult.submitted),
          destination: 'sheets',
          allLabel: nextModal.allLabel,
          toast: readToast(),
          reason: submitResult.reason,
          openResult,
          selected,
          submitResult,
          modal: nextModal,
        };
      }

      const submitResult = await submitTableExport();
      const nextModal = collectModalState();
      return {
        exported: Boolean(submitResult.submitted),
        submitted: Boolean(submitResult.submitted),
        destination: 'csv',
        allLabel: nextModal.allLabel,
        reason: submitResult.reason,
        openResult,
        submitResult,
        modal: nextModal,
      };
    },
  };

  globalThis.__umbraPageRecipes = { ...(existing || {}), ahrefs };
})();
