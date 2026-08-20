// Optional local plugins.
//
// A plugin is one file at mcp-server/plugins/<name>.plugin.mjs. Nothing in the
// published package or in this repository names any individual plugin: the
// folder is local-only and this loader discovers whatever it finds there, so a
// public install loads zero plugins and advertises exactly the built-in tool
// surface. A checkout that carries a plugin file keeps the extra capability
// with no other change.
//
// A plugin module may export:
//   toolDefinitions   array of MCP tool definitions to advertise
//   pageActions       extra enum values for browser_run_page_action, whose
//                     implementations live in the matching extension recipe
//   mcpLocalToolNames tool names answered in this process, not by the extension
//   handlers          { [toolName]: async (sendCommand, params) => result }
//   isAvailable()     true, or { ok, reason }, checked before anything is
//                     registered so an unusable plugin never advertises a tool
//   suites            named live-smoke suites for full-suite-runner.mjs
//
// Everything is optional. A module that exports none of it registers nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN_SUFFIX = '.plugin.mjs';

export function resolvePluginDir(dir) {
  return dir ? path.resolve(dir) : path.join(HERE, 'plugins');
}

// Sorted so two runs of the same checkout advertise tools in the same order.
export function listPluginFiles(dir) {
  const pluginDir = resolvePluginDir(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(PLUGIN_SUFFIX))
    .map((entry) => path.join(pluginDir, entry.name))
    .sort();
}

// A plugin says whether it can actually run, so a tool that would fail ninety
// seconds later is never advertised in the first place.
export function readPluginAvailability(module) {
  const marker = module?.isAvailable;
  if (marker === undefined || marker === null) {
    return { available: true, reason: '' };
  }
  const value = typeof marker === 'function' ? marker() : marker;
  if (value === true || value === undefined || value === null) {
    return { available: true, reason: '' };
  }
  if (value === false) {
    return { available: false, reason: 'the plugin reported itself unavailable' };
  }
  if (typeof value === 'object') {
    const available = value.ok ?? value.available ?? true;
    return { available: Boolean(available), reason: String(value.reason || '') };
  }
  return { available: Boolean(value), reason: '' };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Load every plugin in the plugins folder and merge what they register.
 *
 * Returns the aggregate even when the folder is missing, so callers never
 * branch on whether a plugin exists.
 */
export async function loadPlugins({ dir, log = console.error } = {}) {
  const aggregate = {
    toolDefinitions: [],
    pageActions: [],
    mcpLocalToolNames: [],
    handlers: {},
    suites: {},
    modules: [],
  };

  for (const file of listPluginFiles(dir)) {
    const label = path.basename(file, PLUGIN_SUFFIX);
    let module = null;
    try {
      module = await import(pathToFileURL(file).href);
    } catch (error) {
      log(`[umbra] local plugin ${label} failed to load: ${error?.message || error}`);
      continue;
    }

    const { available, reason } = readPluginAvailability(module);
    if (!available) {
      log(`[umbra] local plugin ${label} is installed but unavailable${reason ? `: ${reason}` : ''}.`);
      continue;
    }

    aggregate.toolDefinitions.push(...asArray(module.toolDefinitions));
    aggregate.pageActions.push(...asArray(module.pageActions));
    aggregate.mcpLocalToolNames.push(...asArray(module.mcpLocalToolNames));
    for (const [name, handler] of Object.entries(module.handlers || {})) {
      if (typeof handler === 'function') {
        aggregate.handlers[name] = handler;
      }
    }
    for (const [name, suite] of Object.entries(module.suites || {})) {
      if (typeof suite === 'function') {
        aggregate.suites[name] = suite;
      }
    }
    aggregate.modules.push({ name: label, file, module });
  }

  return aggregate;
}
