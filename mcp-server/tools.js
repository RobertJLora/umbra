import fs from 'node:fs';
import path from 'node:path';
import { assertReadableUploadFile } from './fs-guard.js';

export const CHROME_GROUP_COLORS = ['blue', 'green', 'yellow', 'pink', 'purple', 'cyan', 'orange'];
export const MAX_BROWSER_BATCH_CALLS = 25;
export const BROWSER_SHORTCUT_CATALOG = [
  { name: 'Enter', keys: ['Enter'] },
  { name: 'Escape', keys: ['Escape'] },
  { name: 'Tab', keys: ['Tab'] },
  { name: 'Meta+l', keys: ['l'], modifiers: { meta: true } },
  { name: 'Meta+a', keys: ['a'], modifiers: { meta: true } },
  { name: 'Meta+c', keys: ['c'], modifiers: { meta: true } },
  { name: 'Meta+v', keys: ['v'], modifiers: { meta: true } },
  { name: 'ArrowDown', keys: ['ArrowDown'] },
  { name: 'ArrowUp', keys: ['ArrowUp'] },
];
export const MCP_LOCAL_TOOL_NAMES = new Set([
  'browser_batch',
  'browser_wait_click_read',
  'browser_navigate_wait_read',
  'browser_click_wait_selector_read',
  'browser_wait_for_download',
]);

const GROUP_COLOR_SCHEMA = {
  type: 'string',
  enum: CHROME_GROUP_COLORS,
};

export const TOOL_DEFINITIONS = [
  {
    name: 'browser_navigate',
    description: 'Navigate a session-owned tab to a URL or create a new owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination URL.' },
        tabId: { type: 'integer', minimum: 1, description: 'Optional owned tab to reuse.' },
        newTab: { type: 'boolean', description: 'When true, create a fresh session-owned tab.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' },
        groupTitle: { type: 'string', description: 'Optional Chrome tab group title to set or update for this session.' },
        groupColor: {
          ...GROUP_COLOR_SCHEMA,
          description: 'Optional Chrome tab group color to set or update for this session.'
        },
        groupCollapsed: { type: 'boolean', description: 'Whether the session tab group should be collapsed.' },
        newWindow: { type: 'boolean', description: 'When true, open a dedicated unfocused Chrome window owned by this session. Use for KPI screenshot framing.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the tab to finish loading. Defaults to 45000. A timeout returns loadTimedOut instead of failing.' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back to the previous page on a session-owned tab. urlChanged is the authoritative field: the tabs-API lane reports moved true whenever Chrome accepted the call, whether or not the URL actually changed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before navigating back. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the tab to settle after the move. Defaults to 45000.' }
      }
    }
  },
  {
    name: 'browser_navigate_forward',
    description: 'Go forward to the next page on a session-owned tab. urlChanged is the authoritative field: the tabs-API lane reports moved true whenever Chrome accepted the call, whether or not the URL actually changed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before navigating forward. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the tab to settle after the move. Defaults to 45000.' }
      }
    }
  },
  {
    name: 'browser_list_tabs',
    description: 'List tabs owned by the current session only.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'browser_tabs_context',
    description: 'List open http, https, file, and about tabs with ownership flags. Read-only: does not adopt, activate, or close tabs. Session-owned tabs are listed first and are never dropped by the URL filter. When createIfEmpty is true and this session owns no tabs, create an about:blank tab owned by the session and include it in the result. Each row carries groupId, and url is exactly what Chrome reports unless urlMaxLength turns shortening on. The response also reports ownedCount, matchedCount, returnedCount and truncatedByLimit.',
    inputSchema: {
      type: 'object',
      properties: {
        createIfEmpty: { type: 'boolean', description: 'When true and this session owns no tabs, create an about:blank owned tab in a collapsed group without activating it, and return it in the tabs array. Defaults to false.' },
        includeInternal: { type: 'boolean', description: 'When true, include chrome and extension internal pages. Applies to unowned tabs only, since owned tabs are always listed. Defaults to false.' },
        ownedOnly: { type: 'boolean', description: 'When true, list only the tabs this session owns and skip the rest of the browser. Defaults to false.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum rows to return, owned tabs first. Defaults to 200, max 500. truncatedByLimit reports when rows were dropped.' },
        urlMaxLength: { type: 'integer', minimum: 0, description: 'Maximum characters per returned URL, after the query and fragment collapse to a marker. Pass 0, the default, to get the URL exactly as Chrome reports it. A positive value turns shortening on and is clamped to 40 minimum, 4096 maximum; rows that were shortened carry urlTruncated true and their url is no longer navigable.' }
      }
    }
  },
  {
    name: 'browser_find_tabs',
    description: 'Find existing Chrome tabs by title or URL without claiming ownership.',
    inputSchema: {
      type: 'object',
      properties: {
        titleIncludes: { type: 'string', description: 'Optional case-insensitive title substring.' },
        urlIncludes: { type: 'string', description: 'Optional case-insensitive URL substring.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of matching tabs to return. Defaults to 50, max 200.' }
      }
    }
  },
  {
    name: 'browser_adopt_tab',
    description: 'Adopt an existing non-internal Chrome tab into the current session so session-owned read tools can inspect it.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Existing Chrome tab ID to adopt.' },
        groupTitle: { type: 'string', description: 'Optional Chrome tab group title to set or update for this session.' },
        groupColor: {
          ...GROUP_COLOR_SCHEMA,
          description: 'Optional Chrome tab group color to set or update for this session.'
        },
        groupCollapsed: { type: 'boolean', description: 'Whether the session tab group should be collapsed.' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser_find_groups',
    description: 'Find visible Chrome tab groups and report ownership before adoption or cleanup.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional exact Chrome group title.' },
        titleIncludes: { type: 'string', description: 'Optional case-insensitive group title substring.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of groups to return. Defaults to 50, max 200.' }
      }
    }
  },
  {
    name: 'browser_adopt_group',
    description: 'Adopt every safe tab in an existing Chrome group into the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'integer', description: 'Existing Chrome group ID to adopt.' },
        groupTitle: { type: 'string', description: 'Optional Chrome tab group title to set after adoption.' },
        groupColor: {
          ...GROUP_COLOR_SCHEMA,
          description: 'Optional Chrome group color to set after adoption.'
        },
        groupCollapsed: { type: 'boolean', description: 'Whether the adopted group should be collapsed.' }
      },
      required: ['groupId']
    }
  },
  {
    name: 'browser_get_session_status',
    description: 'Report the current session group, owned tabs, connection metadata, and whether owned-tab cleanup is safe.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'browser_create_tab',
    description: 'Create a new tab owned by the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to open. Defaults to about:blank.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' },
        allowForeground: { type: 'boolean', description: 'When true with activate:true, Chrome may come to the foreground. Defaults to false. Requires an explicit Robert allow (FOREGROUND RULE).' },
        groupTitle: { type: 'string', description: 'Optional Chrome tab group title to set or update for this session.' },
        groupColor: {
          ...GROUP_COLOR_SCHEMA,
          description: 'Optional Chrome tab group color to set or update for this session.'
        },
        groupCollapsed: { type: 'boolean', description: 'Whether the session tab group should be collapsed.' },
        newWindow: { type: 'boolean', description: 'When true, open a dedicated unfocused Chrome window owned by this session. Use for KPI screenshot framing.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the tab to finish loading. Defaults to 45000. A timeout returns loadTimedOut instead of failing.' }
      }
    }
  },
  {
    name: 'browser_group_tabs',
    description: 'Put session-owned tabs into a Chrome tab group, similar to Chrome Add Tabs to Group.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional owned tab IDs to group. Defaults to every tab owned by this session.'
        },
        title: { type: 'string', description: 'Optional group title.' },
        color: {
          ...GROUP_COLOR_SCHEMA,
          description: 'Optional Chrome group color.'
        },
        collapsed: { type: 'boolean', description: 'Whether the group should be collapsed.' },
        newGroup: { type: 'boolean', description: 'When true, force a fresh group instead of reusing the session group.' },
        groupId: { type: 'integer', description: 'Optional existing group ID owned by this session.' }
      }
    }
  },
  {
    name: 'browser_switch_tab',
    description: 'Retarget the session active tab to an owned tab. Defaults to session-only (no Chrome focus). Pass activate:true to select the tab inside its window without stealing OS focus; pass allowForeground:true with activate:true only when Robert explicitly allows Chrome to come forward.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to make the session active tab.' },
        activate: { type: 'boolean', description: 'Whether to select the tab inside its Chrome window. Defaults to false so the session can retarget without touching Chrome focus.' },
        allowForeground: { type: 'boolean', description: 'When true with activate:true, Chrome may come to the foreground. Defaults to false. Requires an explicit Robert allow.' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser_resize',
    description: 'Resize the Chrome window that holds a session-owned tab. Refuses windows that also contain unowned tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, description: 'Target window width in CSS pixels.' },
        height: { type: 'integer', minimum: 1, description: 'Target window height in CSS pixels.' },
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab whose window should be resized. Defaults to the active owned tab.' }
      },
      required: ['width', 'height']
    }
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab owned by the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to close.' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser_close_session_tabs',
    description: 'Close every Chrome tab owned by the current session. Close a whole window only when every tab in it is owned by this session.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'browser_freeze_session_tabs',
    description: 'Discard or preview discard candidates for tabs owned by the current session. Defaults to a dry run and never targets unowned tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional owned tab IDs to consider. Defaults to every tab owned by this session.'
        },
        dryRun: { type: 'boolean', description: 'When true, report candidate owned tabs without discarding them. Defaults to true.' },
        includeActive: { type: 'boolean', description: 'When true, allow the currently active owned tab to be discarded. Defaults to false.' },
        maxTabs: { type: 'number', description: 'Safety cap for owned tabs to affect. Defaults to 20.' }
      }
    }
  },
  {
    name: 'browser_cleanup_groups',
    description: 'Inspect or clean visible Chrome tab groups by exact title or title prefix. Groups that contain a tab owned by another session are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Exact Chrome tab group title to match.' },
        titlePrefix: { type: 'string', description: 'Chrome tab group title prefix to match when exact title is not provided.' },
        mode: {
          type: 'string',
          enum: ['closeTabs', 'ungroupOnly'],
          description: 'Cleanup mode. closeTabs removes tabs in matching groups; ungroupOnly keeps tabs but removes the group.'
        },
        dryRun: { type: 'boolean', description: 'When true, report matching groups without closing or ungrouping tabs.' },
        maxGroups: { type: 'number', description: 'Safety cap for groups to affect. Defaults to 12.' }
      }
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of a session-owned tab, optionally saving the image to a local path. Defaults to silent background capture (no Chrome focus). Set silent:false or activate:true only when a visible capture is required.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to capture. Defaults to the active owned tab.' },
        outputPath: { type: 'string', description: 'Optional local filesystem path where the image should be written. Must be absolute, or start with ~ for the home directory of the account running the companion server. A relative path is refused, and so is a path whose parent folder does not already exist. The parent must sit inside an allowed root (home, Downloads, the process temp directory, /tmp, the server working directory, plus UMBRA_UPLOAD_DIR or UMBRA_FS_ROOTS). Credential paths and the Umbra home are refused. jpeg is inferred from .jpg or .jpeg.' },
        region: {
          type: 'object',
          description: 'Optional CSS-pixel crop region {x,y,width,height} or {x,y,w,h}.'
        },
        ref: { type: 'string', description: 'Optional short-lived ref from browser_read_page or browser_read_interactive to crop around.' },
        selector: { type: 'string', description: 'Optional selector scope used when resolving a ref crop.' },
        fullPage: { type: 'boolean', description: 'When true, capture the full scrollable page by stitching viewports.' },
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description: 'Image format. Defaults to png.'
        },
        zoom: { type: 'number', description: 'Optional zoom factor applied to a region or ref crop. Defaults to 1. Values above 1 return a tighter crop of that rect.' },
        silent: { type: 'boolean', description: 'When true (default), capture without activating the tab via debugger Page.captureScreenshot. Set false only for a visible captureVisibleTab path. Fails if background capture is unavailable.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before capture. Defaults to false. Forces a non-silent path when true.' }
      }
    }
  },
  {
    name: 'browser_get_page_content',
    description: 'Return bounded text or HTML content from a session-owned tab, with optional selector scoping and rendered-image inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to read. Defaults to the active owned tab.' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Content format. Defaults to text.' },
        mode: {
          type: 'string',
          enum: ['page', 'body', 'main', 'selector', 'article'],
          description: 'Content root to read when selector is not supplied. Defaults to page. Article picks the densest body-text block on the page and leaves out navigation, sidebars, share widgets and related-link rails. It reports which node it chose as articleRootSelector only when the in-page content agent served the read, which contentAgent.fallback tells you; the one-shot fallback omits that field.'
        },
        selector: { type: 'string', description: 'Optional CSS selector to scope the content read.' },
        maxChars: { type: 'integer', minimum: 1, description: 'Maximum characters to return from text or HTML content. Defaults to 500000, which is also the hard ceiling: a larger value is clamped down to it. Content longer than the limit is truncated, and the result reports truncated: true with the full originalLength.' },
        includeImages: { type: 'boolean', description: 'When true, include the compact visible rendered-image inventory. Defaults to false for text-only reads.' }
      }
    }
  },
  {
    name: 'browser_console_messages',
    description: 'Read page console messages captured in a session-owned tab by the content agent.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to read. Defaults to the active owned tab.' },
        level: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'debug'],
          description: 'Minimum console level to return. Defaults to info.'
        },
        all: { type: 'boolean', description: 'When true, return every captured message instead of the latest window.' }
      }
    }
  },
  {
    name: 'browser_get_bridge_pressure',
    description: 'Return a read-only pressure report for the current bridge session, including owned-tab and extension queue signals when available.',
    inputSchema: {
      type: 'object',
      properties: {
        includeTabs: { type: 'boolean', description: 'When true, include owned-tab samples in the pressure report. Defaults to true.' },
        includePerformance: { type: 'boolean', description: 'When true, include browser performance or memory signals when Chrome exposes them.' },
        maxTabSamples: { type: 'number', description: 'Maximum owned-tab samples to include. Defaults to 20.' }
      }
    }
  },
  {
    name: 'browser_read_interactive',
    description: 'Read a compact list of visible interactive elements from a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to read. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'Optional CSS selector scope or custom interactive selector.' },
        maxItems: { type: 'number', description: 'Maximum controls to return. Defaults to 80, max 300.' }
      }
    }
  },
  {
    name: 'browser_read_page',
    description: 'Read a structured accessibility tree from a session-owned tab, with stable refs for click, fill, hover, and form input.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to read. Defaults to the active owned tab.' },
        filter: {
          type: 'string',
          enum: ['all', 'interactive', 'landmarks'],
          description: 'Which nodes to include. Defaults to interactive.'
        },
        maxNodes: { type: 'integer', minimum: 1, description: 'Maximum nodes to return. Defaults to 200, max 500.' },
        selector: { type: 'string', description: 'Optional CSS selector to scope the accessibility tree.' }
      }
    }
  },
  {
    name: 'browser_find',
    description: 'Find elements on a session-owned tab by visible name, role, or description and return ranked refs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to search. Defaults to the active owned tab.' },
        query: { type: 'string', description: 'Case-insensitive name, role, or description to match.' },
        selector: { type: 'string', description: 'Optional CSS selector constraining the search. Every element it matches, and everything inside those elements, is searched. Omit to search the whole page.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum matches to return. Defaults to 10.' }
      },
      required: ['query']
    }
  },
  {
    name: 'browser_form_input',
    description: 'Set a form field on a session-owned tab by ref or selector so React and native inputs both see the change.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        selector: { type: 'string', description: 'CSS selector for the field when a ref is not provided.' },
        value: { type: 'string', description: 'Value for text, textarea, contenteditable, or select fields.' },
        checked: { type: 'boolean', description: 'Checked state for checkbox or radio inputs.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before filling. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_get_technical_snapshot',
    description: 'Read safe rendered-page technical SEO signals from a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to inspect. Defaults to the active owned tab.' },
        includeHtml: { type: 'boolean', description: 'When true, include rendered DOM HTML in the response.' }
      }
    }
  },
  {
    name: 'browser_run_page_action',
    description: 'Run a predefined JavaScript page action in a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        action: {
          type: 'string',
          enum: ['render_wait', 'element_positions', 'inspect_controls', 'click_control', 'limit_table_rows', 'scroll_selector', 'restore_table_rows', 'wait_for_text'],
          description: 'Named action to run. An installed local page-recipe plugin adds its own namespaced actions to this list.'
        },
        params: { type: 'object', description: 'Action-specific JSON parameters.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds. Defaults to 10000.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before running the action. Defaults to false.' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_javascript',
    description: 'Run JavaScript in a session-owned tab so the page DOM and React handlers are reachable. The code runs as an async function body, so top-level await works. Use return to send a value back. Does not activate the tab unless asked.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        code: { type: 'string', description: 'JavaScript to run in the page as an async function body.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds. Defaults to 10000.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before running the code. Defaults to false.' }
      },
      required: ['code']
    }
  },
  {
    name: 'browser_click',
    description: 'Click a CSS selector, interactive ref, or viewport point in a session-owned tab. Provide selector, ref, or both x and y.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector to click.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        x: { type: 'number', description: 'CSS-pixel X coordinate in the viewport. Provide both x and y to click that point.' },
        y: { type: 'number', description: 'CSS-pixel Y coordinate in the viewport. Provide both x and y to click that point.' },
        doubleClick: { type: 'boolean', description: 'When true, perform a double click. Same thing as clickCount 2.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
        clickCount: { type: 'integer', minimum: 1, maximum: 3, description: '1 for a single click, 2 for a double, 3 for a triple. Defaults to 1.' },
        modifiers: {
          type: 'object',
          description: 'Modifier keys held during the click.',
          properties: {
            ctrl: { type: 'boolean' },
            shift: { type: 'boolean' },
            alt: { type: 'boolean' },
            meta: { type: 'boolean' }
          }
        },
        activate: { type: 'boolean', description: 'Whether to activate the tab before clicking. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_drag',
    description: 'Drag from one point or element to another in a session-owned tab, firing the pointer sequence and, for draggable elements, the drag and drop events.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        startX: { type: 'number', description: 'Start point, CSS-pixel X in the viewport.' },
        startY: { type: 'number', description: 'Start point, CSS-pixel Y in the viewport.' },
        x: { type: 'number', description: 'End point, CSS-pixel X in the viewport.' },
        y: { type: 'number', description: 'End point, CSS-pixel Y in the viewport.' },
        startRef: { type: 'string', description: 'Short-lived ref for the drag source, used instead of startX and startY.' },
        startSelector: { type: 'string', description: 'CSS selector for the drag source, used instead of startX and startY.' },
        ref: { type: 'string', description: 'Short-lived ref for the drop target, used instead of x and y.' },
        selector: { type: 'string', description: 'CSS selector for the drop target, used instead of x and y.' },
        steps: { type: 'integer', minimum: 2, maximum: 40, description: 'Intermediate move events between the two points. Defaults to 12.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' }
      }
    }
  },
  {
    name: 'browser_hover',
    description: 'Hover a selector or interactive ref in a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector to hover.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before hovering. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_click_text',
    description: 'Click visible text in a session-owned tab, with optional selector scoping and match index.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        text: { type: 'string', description: 'Visible text to click.' },
        exact: { type: 'boolean', description: 'Whether to require an exact normalized text match. Defaults to true.' },
        selector: { type: 'string', description: 'Optional CSS selector scope such as button or label.' },
        index: { type: 'number', description: 'Zero-based match index. Negative values count from the end.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before clicking. Defaults to false.' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_fill',
    description: 'Fill a form field or contenteditable editor in a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector for an input, textarea, select, or contenteditable editor.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        value: { type: 'string', description: 'Value to enter.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before filling. Defaults to false.' }
      },
      required: ['value']
    }
  },
  {
    name: 'browser_file_upload',
    description: 'Set files on a file input in a session-owned tab from an absolute local path. Refuses a missing file, a path outside the allowed roots, and well-known credential locations including the Umbra pairing key.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector for an input[type=file] element.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        filePath: { type: 'string', description: 'Absolute local path to the file to upload. Must sit inside an allowed root (home, Downloads, the process temp directory, /tmp, the server working directory, plus UMBRA_UPLOAD_DIR or UMBRA_FS_ROOTS). Credential paths and the Umbra home are refused.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before uploading. Defaults to false.' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'browser_upload_image',
    description: 'Put a local image into a session-owned tab, either by populating a file input named by ref or selector, or by dropping it at a viewport point on a drop zone.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        filePath: { type: 'string', description: 'Absolute local path to the image. Must sit inside an allowed root, the same roots browser_file_upload accepts.' },
        ref: { type: 'string', description: 'Short-lived ref for a file input. Preferred: this mode has no file size limit.' },
        selector: { type: 'string', description: 'CSS selector for a file input. Preferred: this mode has no file size limit.' },
        x: { type: 'number', description: 'Drop point, CSS-pixel X in the viewport. A file dropped this way is capped at 700 KB.' },
        y: { type: 'number', description: 'Drop point, CSS-pixel Y in the viewport. A file dropped this way is capped at 700 KB.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'browser_type',
    description: 'Type text into a field in a session-owned tab, optionally slowly and with Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector for an input, textarea, or contenteditable editor.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        text: { type: 'string', description: 'Text to type into the field.' },
        slowly: { type: 'boolean', description: 'When true, type one character at a time instead of filling instantly.' },
        submit: { type: 'boolean', description: 'When true, press Enter after typing and let Enter submit the form the way a real keypress would.' },
        defaultAction: { type: 'boolean', description: 'When true, the Enter that submit sends also does what Enter does in a browser: click the form default submit button, or submit a form that has none. Defaults to true. Set false for raw event dispatch only.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before typing. Defaults to false.' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_select_option',
    description: 'Select dropdown option(s) in a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector for a select element.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Option values or labels to select. Pass more than one value for multi-select.'
        },
        activate: { type: 'boolean', description: 'Whether to activate the tab before selecting. Defaults to false.' }
      },
      required: ['values']
    }
  },
  {
    name: 'browser_press_key',
    description: 'Dispatch a keyboard keypress in a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        key: { type: 'string', description: 'Key value such as Enter or Escape. Accepts a space-separated sequence such as Tab Tab Enter, dispatched in order.' },
        repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'How many times to run the whole sequence. Defaults to 1.' },
        selector: { type: 'string', description: 'Optional CSS selector to focus and aim the key at. Defaults to the focused element.' },
        defaultAction: { type: 'boolean', description: 'When true, Enter also does what Enter does in a browser: click the form default submit button, or submit a form that has none. Defaults to true. Set false for raw event dispatch only.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before dispatching the key. Defaults to false.' }
      },
      required: ['key']
    }
  },
  {
    name: 'browser_shortcut',
    description: 'Dispatch a named keyboard shortcut in a session-owned tab, or list the supported catalog. Supported names include Enter, Escape, Tab, Meta+l, Meta+a, Meta+c, Meta+v, ArrowDown, and ArrowUp.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        name: { type: 'string', description: 'Catalog shortcut name such as Enter or Meta+l.' },
        keys: {
          description: 'Shortcut chord such as Enter or Meta+l, or an array of key names. Combine with modifiers when needed.',
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ]
        },
        modifiers: {
          type: 'object',
          description: 'Optional modifier flags for keys.',
          properties: {
            meta: { type: 'boolean' },
            ctrl: { type: 'boolean' },
            alt: { type: 'boolean' },
            shift: { type: 'boolean' }
          }
        },
        list: { type: 'boolean', description: 'When true, return the supported shortcut catalog and do not dispatch. Defaults to false.' },
        defaultAction: { type: 'boolean', description: 'When true, Enter also does what Enter does in a browser: click the form default submit button, or submit a form that has none. Defaults to true. Set false for raw event dispatch only.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before dispatching. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll a session-owned tab by selector, direction, or pixel delta, optionally at a point so an inner pane scrolls instead of the window.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'Optional CSS selector to scroll into view.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        x: { type: 'number', description: 'Horizontal scroll delta.' },
        y: { type: 'number', description: 'Vertical scroll delta.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction. Used with amount instead of x and y.' },
        amount: { type: 'integer', minimum: 1, maximum: 30, description: 'Scroll clicks in the given direction, about 100 CSS pixels each. Defaults to 3.' },
        atX: { type: 'number', description: 'CSS-pixel X of the point to scroll at, so an inner scrollable pane under that point scrolls instead of the window.' },
        atY: { type: 'number', description: 'CSS-pixel Y of the point to scroll at, so an inner scrollable pane under that point scrolls instead of the window.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before scrolling. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_wait',
    description: 'Wait for a selector, a URL change, or a fixed number of milliseconds in a session-owned tab without foregrounding Chrome.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        durationMs: { type: 'number', minimum: 50, maximum: 30000, description: 'Sleep this many milliseconds. On its own it is a plain sleep that never touches the page, for an animation that settles with no DOM signal to wait on. Combined with a selector or a URL predicate it runs first, then the predicate is checked.' },
        urlContains: { type: 'string', description: 'Wait until the tab URL contains this substring and the page has finished loading. Use it to confirm that a submit or a click actually navigated.' },
        urlChanged: { type: 'boolean', description: 'Wait until the tab URL differs from where it was when the wait started. Defaults to false.' },
        fromUrl: { type: 'string', description: 'Optional baseline URL for urlChanged. Defaults to the tab URL when the wait starts.' },
        visible: { type: 'boolean', description: 'When true, wait for a visible selector match. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds. Defaults to 10000.' }
      }
    }
  },
  {
    name: 'browser_wait_click_read',
    description: 'MCP-local recipe: wait for a selector, click selector/ref, then read page content. The result carries an ok flag: when a step fails, ok is false, stopIndex and the last labelled entry in results name the step that stopped the recipe, and the MCP response is marked as an error.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID.' },
        waitSelector: { type: 'string', description: 'Selector to wait for before clicking.' },
        clickSelector: { type: 'string', description: 'Selector to click.' },
        ref: { type: 'string', description: 'Optional interactive ref to click instead of clickSelector.' },
        readSelector: { type: 'string', description: 'Optional selector scope for the final read.' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Final read format. Defaults to text.' },
        visible: { type: 'boolean', description: 'When true, the wait step requires a visible selector match. Defaults to false.' },
        maxChars: { type: 'integer', minimum: 1, description: 'Optional character cap on the final read.' },
        activate: { type: 'boolean', description: 'Whether the click and navigate steps may foreground Chrome. Defaults to false. A child result reporting active true means the tab is the active tab of its own window, not that Chrome came forward; read the activated field on this result instead.' },
        timeoutMs: { type: 'number', description: 'Total recipe timeout in milliseconds.' }
      },
      required: ['waitSelector']
    }
  },
  {
    name: 'browser_navigate_wait_read',
    description: 'MCP-local recipe: navigate, wait for a selector, then read page content. The result carries an ok flag: when a step fails, ok is false, stopIndex and the last labelled entry in results name the step that stopped the recipe, and the MCP response is marked as an error.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination URL.' },
        tabId: { type: 'integer', minimum: 1, description: 'Optional owned tab to reuse.' },
        waitSelector: { type: 'string', description: 'Selector to wait for after navigation.' },
        readSelector: { type: 'string', description: 'Optional selector scope for the final read.' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Final read format. Defaults to text.' },
        visible: { type: 'boolean', description: 'When true, the wait step requires a visible selector match. Defaults to false.' },
        maxChars: { type: 'integer', minimum: 1, description: 'Optional character cap on the final read.' },
        activate: { type: 'boolean', description: 'Whether the click and navigate steps may foreground Chrome. Defaults to false. A child result reporting active true means the tab is the active tab of its own window, not that Chrome came forward; read the activated field on this result instead.' },
        timeoutMs: { type: 'number', description: 'Total recipe timeout in milliseconds.' }
      },
      required: ['url', 'waitSelector']
    }
  },
  {
    name: 'browser_click_wait_selector_read',
    description: 'MCP-local recipe: click selector/ref, wait for a selector, then read page content. The result carries an ok flag: when a step fails, ok is false, stopIndex and the last labelled entry in results name the step that stopped the recipe, and the MCP response is marked as an error.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID.' },
        clickSelector: { type: 'string', description: 'Selector to click.' },
        ref: { type: 'string', description: 'Optional interactive ref to click instead of clickSelector.' },
        waitSelector: { type: 'string', description: 'Selector to wait for after clicking.' },
        readSelector: { type: 'string', description: 'Optional selector scope for the final read.' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Final read format. Defaults to text.' },
        visible: { type: 'boolean', description: 'When true, the wait step requires a visible selector match. Defaults to false.' },
        maxChars: { type: 'integer', minimum: 1, description: 'Optional character cap on the final read.' },
        activate: { type: 'boolean', description: 'Whether the click and navigate steps may foreground Chrome. Defaults to false. A child result reporting active true means the tab is the active tab of its own window, not that Chrome came forward; read the activated field on this result instead.' },
        timeoutMs: { type: 'number', description: 'Total recipe timeout in milliseconds.' }
      },
      required: ['waitSelector']
    }
  },
  {
    name: 'browser_reload_extension',
    description: 'Reload the unpacked Umbra extension without opening chrome://extensions. Advertised only when UMBRA_ALLOW_EXTENSION_RELOAD=1. Store installs refuse this tool; use the options-page Reload button instead.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'browser_wait_for_download',
    description: 'MCP-local wait for a stable file download using the local file ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Exact filename to wait for.' },
        pattern: { type: 'string', description: 'Case-insensitive filename substring to wait for.' },
        extension: { type: 'string', description: 'Optional file extension filter such as .csv.' },
        createdAfterMs: { type: 'number', description: 'Only match files modified after this epoch millisecond timestamp.' },
        dir: { type: 'string', description: 'Absolute path to the folder to watch for the new file. Must sit inside an allowed root or the configured download directory. Defaults to UMBRA_DOWNLOAD_DIR when that variable is set, otherwise the Downloads folder inside the home directory of the account running the companion server. Set this per call when Chrome saves downloads somewhere else.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds. Defaults to 30000.' }
      }
    }
  },
  {
    name: 'browser_mark_debug_group',
    description: 'Rename the current session group with a Debug suffix for failed workflow inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'integer', description: 'Optional owned/current group ID. Defaults to current session group.' },
        title: { type: 'string', description: 'Optional base title before the Debug suffix.' },
        groupColor: {
          ...GROUP_COLOR_SCHEMA,
          description: 'Optional Chrome group color.'
        },
        collapsed: { type: 'boolean', description: 'Whether to collapse the debug group.' },
        leaveOpen: { type: 'boolean', description: 'Whether the caller intends to leave the group open. Defaults to true.' }
      }
    }
  },
  {
    name: 'browser_batch',
    description: 'Run a bounded sequence of non-batch browser tools within one MCP call and return per-step results. The result carries an ok flag: when a child call fails, ok is false, the failing step is reported in the results array with its own ok false and an error code, stopIndex names it when the batch stops early, and the MCP response is marked as an error. With stopOnError true the remaining calls are skipped; with it false the batch runs to the end and ok is still false.',
    inputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BROWSER_BATCH_CALLS,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Browser tool name to run. browser_batch cannot be nested.' },
              params: { type: 'object', description: 'Arguments for the child tool. Values can reference earlier results with {"$ref":"prev.tabId"}, {"$ref":"0.tabId"}, or {"$ref":"create.tabId"}.' },
              label: { type: 'string', description: 'Optional caller label echoed in the result.' }
            },
            required: ['tool']
          },
          description: `Ordered child tool calls. Maximum ${MAX_BROWSER_BATCH_CALLS}.`
        },
        stopOnError: { type: 'boolean', description: 'When true, stop after the first child-tool error. Defaults to true.' },
        timeoutMs: { type: 'number', description: 'Maximum total batch time in milliseconds. Defaults to 30000.' }
      },
      required: ['calls']
    }
  },
  {
    name: 'browser_cursor',
    description: 'Turn the on-page agent cursor on or off for this session, or read its current state. The cursor draws a pointer that glides to each target and pulses on action.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Turn the session cursor on or off. Omit to read the current state without changing it.' },
        tabId: { type: 'integer', minimum: 1, description: 'Optional owned tab to report state for.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' }
      }
    }
  },
  {
    name: 'browser_gif',
    description: 'Record an animated GIF of one owned tab. Start a recording, stop it, export the frames to a file on disk, or clear the buffer without exporting.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'export', 'clear', 'status'],
          description: 'Recording control. Start begins capture, stop ends it and keeps the frames, export writes the animation to outputPath, clear discards the frames, status reports frame count and state.'
        },
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab to record. Required when the session owns more than one tab.' },
        fps: { type: 'number', minimum: 1, maximum: 10, description: 'Interval frames per second while recording. Defaults to 4. Frames are also captured around each action regardless of this value.' },
        maxFrames: { type: 'integer', minimum: 2, maximum: 300, description: 'Frame buffer ceiling. Defaults to 120. Oldest frames drop first once the buffer is full.' },
        maxWidth: { type: 'integer', minimum: 160, maximum: 1600, description: 'Frame width in CSS pixels, aspect preserved. Defaults to 800. Lower values encode faster and smaller.' },
        quality: { type: 'integer', minimum: 1, maximum: 30, description: 'Palette quality, 1 for the richest colours and 30 for the smallest file. Defaults to 10.' },
        overlays: { type: 'boolean', description: 'Draw click indicators, drag arrows, action labels, the progress bar and the watermark onto the exported frames. Defaults to true.' },
        watermark: { type: 'string', maxLength: 40, description: 'Corner text drawn on each exported frame. Defaults to Umbra. Pass an empty string to omit it.' },
        outputPath: { type: 'string', description: 'Absolute path, or a path starting with ~/, that the exported GIF is written to. Required for export. The parent directory must already exist.' },
        timeoutMs: { type: 'number', description: 'Maximum time for this call in milliseconds. Defaults to 60000.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_read_network_requests',
    description: 'Read the HTTP request log for one owned tab. The first call starts logging and usually returns nothing, so act on the page and read again. Pass stop to end logging.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab to read. Required when the session owns more than one tab.' },
        urlPattern: { type: 'string', maxLength: 300, description: 'Case-insensitive substring that a request URL must contain to be returned.' },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['xhr', 'fetch', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'other']
          },
          description: 'Resource types to return. Defaults to xhr, fetch and document.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum entries to return, newest first. Defaults to 50.' },
        clear: { type: 'boolean', description: 'Discard the buffered entries after returning them. Defaults to false.' },
        stop: { type: 'boolean', description: 'Stop logging on this tab and release the attachment. Defaults to false.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab. Defaults to false so the session can work in the background.' }
      }
    }
  }
];

export const DEV_ONLY_TOOL_NAMES = new Set(['browser_reload_extension']);

export function isDevOnlyToolEnabled(name, env = process.env) {
  if (!DEV_ONLY_TOOL_NAMES.has(name)) {
    return true;
  }
  const flag = String(env.UMBRA_ALLOW_EXTENSION_RELOAD || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

export function assertDevOnlyToolAllowed(name, env = process.env) {
  if (!isDevOnlyToolEnabled(name, env)) {
    throw new Error(
      'browser_reload_extension is disabled unless UMBRA_ALLOW_EXTENSION_RELOAD=1. Use the Reload button on the options page, or chrome://extensions.',
    );
  }
}

export function assertLocalUploadFile(filePath, options = {}) {
  return assertReadableUploadFile(filePath, options);
}

// Drop mode sends the file's bytes to the extension in params, because nothing
// running in the page can read a local path. Params travel the request direction,
// where the broker caps one shim line at 1 MiB and exceeding it kills the
// connection instead of returning an error, so the pre-encode size is capped
// well under that and the caller is pointed at the mode that has no limit.
export const UPLOAD_IMAGE_DROP_MAX_BYTES = 700 * 1024;

const UPLOAD_IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

// Called by both transports before a browser_upload_image leaves the server, so
// the legacy Node lane and the Rust broker lane cannot diverge. File-input mode
// passes the path through untouched and never reads the bytes.
export function prepareUploadImageParams(params = {}, options = {}) {
  const filePath = assertLocalUploadFile(params.filePath, options);
  const hasRefOrSelector = Boolean(
    (typeof params.ref === 'string' && params.ref.trim())
    || (typeof params.selector === 'string' && params.selector.trim()),
  );
  const hasPoint = Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y));
  if (hasRefOrSelector || !hasPoint) {
    return { ...params, filePath };
  }

  const stats = fs.statSync(filePath);
  if (stats.size > UPLOAD_IMAGE_DROP_MAX_BYTES) {
    throw new Error(
      `browser_upload_image cannot drop a file over ${Math.floor(UPLOAD_IMAGE_DROP_MAX_BYTES / 1024)} KB at a point (${filePath} is ${Math.round(stats.size / 1024)} KB). Name the file input with ref or selector instead, which has no size limit.`,
    );
  }
  const extension = path.extname(filePath).toLowerCase();
  return {
    ...params,
    filePath,
    fileName: path.basename(filePath),
    mimeType: UPLOAD_IMAGE_MIME_TYPES[extension] || 'application/octet-stream',
    fileData: fs.readFileSync(filePath).toString('base64'),
  };
}

export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}

export function isMcpLocalTool(name) {
  return MCP_LOCAL_TOOL_NAMES.has(name);
}

// Both guards that keep an encoded animation off the wire key on the top-level
// tool name: the pre-call check in index.js and the disk-write branch in
// buildMcpResponse. Inside a batch the top-level name is browser_batch for both,
// so a browser_gif export run as a child slipped past them, encoded up to
// MAX_GIF_BYTES, and landed as roughly 32 MB of base64 in one MCP text block.
// This is the same rule stated once, for every lane that dispatches a child.
// Returns an error message, or an empty string when the child is allowed.
export function batchChildRejectionReason(name, params = {}) {
  if (name === 'browser_gif' && String(params?.action || '') === 'export') {
    return 'browser_gif export cannot run inside browser_batch, because the encoded animation would be returned inline instead of written to disk. Call browser_gif directly with outputPath.';
  }
  return '';
}

export const PAGE_ACTION_TOOL_NAME = 'browser_run_page_action';

// Build the advertised tool list for one server build. TOOL_DEFINITIONS is the
// surface every build has. `plugins` is the aggregate an optional local
// page-recipe plugin contributes, from loadPlugins() in plugins-loader.mjs:
// extra tool definitions, and extra namespaced values for the page-action enum
// whose implementations live in the matching extension recipe file. No plugin
// installed means no additions, which is what a published package sees.
export function buildToolDefinitions({ plugins = null, env = process.env } = {}) {
  const extraTools = Array.isArray(plugins?.toolDefinitions) ? plugins.toolDefinitions : [];
  const extraActions = Array.isArray(plugins?.pageActions) ? plugins.pageActions : [];
  const catalog = TOOL_DEFINITIONS.filter((tool) => isDevOnlyToolEnabled(tool.name, env));
  if (extraTools.length === 0 && extraActions.length === 0) {
    return catalog.slice();
  }

  const definitions = catalog.map((tool) => {
    if (tool.name !== PAGE_ACTION_TOOL_NAME || extraActions.length === 0) {
      return tool;
    }
    // Copied rather than mutated: TOOL_DEFINITIONS is the shared catalog and a
    // second call would otherwise keep appending to the same enum array.
    const action = tool.inputSchema.properties.action;
    const merged = [...action.enum, ...extraActions.filter((name) => !action.enum.includes(name))];
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          action: { ...action, enum: merged },
        },
      },
    };
  });

  const known = new Set(definitions.map((tool) => tool.name));
  return [...definitions, ...extraTools.filter((tool) => !known.has(tool.name))];
}

// The MCP-local tool names for one server build, matching buildToolDefinitions.
// A plugin tool is answered inside this process rather than forwarded to the
// extension, so it belongs in this set whenever its plugin is installed.
export function buildMcpLocalToolNames({ plugins = null } = {}) {
  const extra = Array.isArray(plugins?.mcpLocalToolNames) ? plugins.mcpLocalToolNames : [];
  return new Set([...MCP_LOCAL_TOOL_NAMES, ...extra]);
}
