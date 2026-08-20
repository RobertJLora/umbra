import fs from 'node:fs';
import path from 'node:path';

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
    description: 'Go back to the previous page on a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before navigating back. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_navigate_forward',
    description: 'Go forward to the next page on a session-owned tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before navigating forward. Defaults to false.' }
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
    description: 'List open http, https, file, and about tabs with ownership flags. Read-only: does not adopt, activate, or close tabs. When createIfEmpty is true and this session owns no tabs, create an about:blank tab owned by the session.',
    inputSchema: {
      type: 'object',
      properties: {
        createIfEmpty: { type: 'boolean', description: 'When true and this session owns no tabs, create an about:blank owned tab in a collapsed group without activating it. Defaults to false.' },
        includeInternal: { type: 'boolean', description: 'When true, include chrome and extension internal pages. Defaults to false.' }
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
    description: 'Activate a tab owned by the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to activate.' }
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
    description: 'Inspect or clean visible Chrome tab groups by exact title or title prefix. Defaults protect currently connected sessions.',
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
        includeConnected: { type: 'boolean', description: 'When true, allow cleanup of groups owned by currently connected bridge sessions. Defaults to false.' },
        maxGroups: { type: 'number', description: 'Safety cap for groups to affect. Defaults to 12.' }
      }
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of a session-owned tab, optionally saving the image to a local path. The default path activates the tab so the visible viewport can be captured. Set silent to true to capture without activating the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID to capture. Defaults to the active owned tab.' },
        outputPath: { type: 'string', description: 'Optional local filesystem path where the image should be written. Must be absolute, or start with ~ for the home directory of the account running the companion server. A relative path is refused, and so is a path whose parent folder does not already exist. jpeg is inferred from .jpg or .jpeg.' },
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
        silent: { type: 'boolean', description: 'When true, capture without activating the tab. Fails if background capture is unavailable.' }
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
          enum: ['page', 'body', 'main', 'selector'],
          description: 'Content root to read when selector is not supplied. Defaults to page.'
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
        selector: { type: 'string', description: 'Optional CSS selector to scope the search.' },
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
        doubleClick: { type: 'boolean', description: 'When true, perform a double click.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before clicking. Defaults to false.' }
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
    description: 'Set files on a file input in a session-owned tab from an absolute local path. Refuses a missing file.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector for an input[type=file] element.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        filePath: { type: 'string', description: 'Absolute local path to the file to upload.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before uploading. Defaults to false.' }
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
        submit: { type: 'boolean', description: 'When true, press Enter after typing the text.' },
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
        key: { type: 'string', description: 'Key value such as Enter or Escape.' },
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
        activate: { type: 'boolean', description: 'Whether to activate the tab before dispatching. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll a session-owned tab by selector or pixel delta.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'Optional CSS selector to scroll into view.' },
        ref: { type: 'string', description: 'Short-lived ref returned by browser_read_page, browser_find, or browser_read_interactive.' },
        x: { type: 'number', description: 'Horizontal scroll delta.' },
        y: { type: 'number', description: 'Vertical scroll delta.' },
        activate: { type: 'boolean', description: 'Whether to activate the tab before scrolling. Defaults to false.' }
      }
    }
  },
  {
    name: 'browser_wait',
    description: 'Wait for a selector state in a session-owned tab without foregrounding Chrome.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'Owned tab ID. Defaults to the active owned tab.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        visible: { type: 'boolean', description: 'When true, wait for a visible selector match. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds. Defaults to 10000.' }
      },
      required: ['selector']
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
        timeoutMs: { type: 'number', description: 'Total recipe timeout in milliseconds.' }
      },
      required: ['waitSelector']
    }
  },
  {
    name: 'browser_reload_extension',
    description: 'Reload the unpacked Umbra extension without opening chrome://extensions. Use after syncing extension files to the Active folder.',
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
        dir: { type: 'string', description: 'Absolute path to the folder to watch for the new file. Defaults to UMBRA_DOWNLOAD_DIR when that variable is set, otherwise the Downloads folder inside the home directory of the account running the companion server. Set this per call when Chrome saves downloads somewhere else.' },
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
  }
];

export function assertLocalUploadFile(filePath) {
  const value = typeof filePath === 'string' ? filePath.trim() : '';
  if (!value) {
    throw new Error('browser_file_upload requires filePath.');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('filePath must be an absolute local path.');
  }
  let stats;
  try {
    stats = fs.statSync(value);
  } catch {
    throw new Error(`File does not exist: ${value}`);
  }
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${value}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${value}`);
  }
  return value;
}

export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}

export function isMcpLocalTool(name) {
  return MCP_LOCAL_TOOL_NAMES.has(name);
}

export const PAGE_ACTION_TOOL_NAME = 'browser_run_page_action';

// Build the advertised tool list for one server build. TOOL_DEFINITIONS is the
// surface every build has. `plugins` is the aggregate an optional local
// page-recipe plugin contributes, from loadPlugins() in plugins-loader.mjs:
// extra tool definitions, and extra namespaced values for the page-action enum
// whose implementations live in the matching extension recipe file. No plugin
// installed means no additions, which is what a published package sees.
export function buildToolDefinitions({ plugins = null } = {}) {
  const extraTools = Array.isArray(plugins?.toolDefinitions) ? plugins.toolDefinitions : [];
  const extraActions = Array.isArray(plugins?.pageActions) ? plugins.pageActions : [];
  if (extraTools.length === 0 && extraActions.length === 0) {
    return TOOL_DEFINITIONS.slice();
  }

  const definitions = TOOL_DEFINITIONS.map((tool) => {
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
