'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

/** @type {Map<string, { path: string, createdAt: number }>} */
const registry = new Map();

let ttlMs = DEFAULT_TTL_MS;
let tmpDir = '';
let sweeper = null;

async function init({ dir, ttl = DEFAULT_TTL_MS } = {}) {
  tmpDir = dir;
  ttlMs = ttl;
  // Ensure directory exists, then clear leftover PDFs from previous runs.
  // Skip dot-files so things like .gitkeep survive.
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const entries = await fs.readdir(tmpDir);
    await Promise.all(
      entries
        .filter((name) => !name.startsWith('.') && name.endsWith('.pdf'))
        .map((name) => fs.unlink(path.join(tmpDir, name)).catch(() => {})),
    );
  } catch (_) {
    // ignore
  }
  registry.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Do not keep the process alive just for the sweeper.
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

function register(id, filePath) {
  registry.set(id, { path: filePath, createdAt: Date.now() });
}

function get(id) {
  const entry = registry.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ttlMs) return null;
  return entry;
}

function getTtlMs() {
  return ttlMs;
}

function getTmpDir() {
  return tmpDir;
}

async function sweep() {
  const now = Date.now();
  const expired = [];
  for (const [id, entry] of registry.entries()) {
    if (now - entry.createdAt > ttlMs) {
      expired.push({ id, path: entry.path });
    }
  }
  for (const { id, path: p } of expired) {
    registry.delete(id);
    try {
      await fs.unlink(p);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Swallow; file may have been removed manually.
      }
    }
  }
}

async function shutdown() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

module.exports = {
  init,
  register,
  get,
  sweep,
  shutdown,
  getTtlMs,
  getTmpDir,
};
