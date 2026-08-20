import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class FileDownloadLedger {
  constructor({ downloadDir, pollMs = 250, stableSamples = 2 } = {}) {
    if (!downloadDir) {
      throw new Error('FileDownloadLedger requires downloadDir.');
    }
    this.downloadDir = downloadDir;
    this.pollMs = pollMs;
    this.stableSamples = stableSamples;
    this.events = [];
  }

  record(type, payload = {}) {
    const event = {
      type,
      at: Date.now(),
      ...payload,
    };
    this.events.push(event);
    return event;
  }

  snapshot() {
    return [...this.events];
  }

  async clearExact(filename) {
    const finalPath = path.join(this.downloadDir, filename);
    const partialPath = `${finalPath}.crdownload`;
    await fsp.rm(finalPath, { force: true }).catch(() => {});
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    this.record('clear_exact', { filename, finalPath });
  }

  async waitForExact({ filename, timeoutMs, removeExisting = false } = {}) {
    if (!filename) {
      throw new Error('waitForExact requires filename.');
    }
    if (removeExisting) {
      await this.clearExact(filename);
    }

    const finalPath = path.join(this.downloadDir, filename);
    const partialPath = `${finalPath}.crdownload`;
    const startedAt = Date.now();
    let lastSize = -1;
    let stableCount = 0;
    let sawPartial = false;
    this.record('wait_exact_start', { filename, finalPath, timeoutMs });

    while (Date.now() - startedAt <= timeoutMs) {
      if (fs.existsSync(partialPath)) {
        sawPartial = true;
      }
      if (fs.existsSync(finalPath) && !fs.existsSync(partialPath)) {
        const size = fs.statSync(finalPath).size;
        if (size > 0 && size === lastSize) {
          stableCount += 1;
        } else {
          stableCount = 0;
        }
        lastSize = size;
        if (stableCount >= this.stableSamples) {
          const result = {
            filePath: finalPath,
            path: finalPath,
            bytes: size,
            sawPartial,
            elapsedMs: Date.now() - startedAt,
            ledgerEvents: this.snapshot(),
          };
          this.record('wait_exact_complete', { filename, finalPath, bytes: size, sawPartial });
          return result;
        }
      }
      await delay(this.pollMs);
    }

    this.record('wait_exact_timeout', { filename, finalPath, timeoutMs });
    throw new Error(`Timed out waiting for download: ${finalPath}`);
  }

  async waitForNew({ sinceMs, timeoutMs, extension = '', nameIncludes = [] } = {}) {
    const startedAt = Date.now();
    const normalizedIncludes = nameIncludes.map((item) => String(item).toLowerCase()).filter(Boolean);
    this.record('wait_new_start', { sinceMs, timeoutMs, extension, nameIncludes: normalizedIncludes });

    while (Date.now() - startedAt <= timeoutMs) {
      const matches = await this.findNew({ sinceMs, extension, nameIncludes: normalizedIncludes });
      if (matches[0]) {
        const result = {
          ...matches[0],
          elapsedMs: Date.now() - startedAt,
          ledgerEvents: this.snapshot(),
        };
        this.record('wait_new_complete', {
          filePath: result.filePath,
          bytes: result.bytes,
          mtimeMs: result.mtimeMs,
        });
        return result;
      }
      await delay(Math.max(this.pollMs, 500));
    }

    this.record('wait_new_timeout', { sinceMs, timeoutMs, extension, nameIncludes: normalizedIncludes });
    throw new Error(`Timed out waiting for a new download in ${this.downloadDir}.`);
  }

  async findNew({ sinceMs = 0, extension = '', nameIncludes = [] } = {}) {
    const entries = await fsp.readdir(this.downloadDir, { withFileTypes: true }).catch(() => []);
    const matches = [];
    const normalizedExtension = String(extension || '').toLowerCase();
    const normalizedIncludes = nameIncludes.map((item) => String(item).toLowerCase()).filter(Boolean);

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.crdownload')) {
        continue;
      }
      const lowerName = entry.name.toLowerCase();
      if (normalizedExtension && !lowerName.endsWith(normalizedExtension)) {
        continue;
      }
      if (normalizedIncludes.some((token) => !lowerName.includes(token))) {
        continue;
      }

      const filePath = path.join(this.downloadDir, entry.name);
      const partialPath = `${filePath}.crdownload`;
      if (fs.existsSync(partialPath)) {
        continue;
      }
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs > sinceMs + 100 && stat.size > 0) {
        matches.push({
          filePath,
          path: filePath,
          filename: entry.name,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }

    matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return matches;
  }
}
