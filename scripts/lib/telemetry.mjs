import fs from 'node:fs';
import path from 'node:path';

export const TELEMETRY_FILE = path.join('.urdr', 'search-telemetry.json');
const OUTCOMES = new Set(['hierarchy', 'fallback', 'miss', 'timeout']);

function telemetryPath(memoryDir, config) {
  if (!config) return null;
  if (config === true) return path.join(memoryDir, TELEMETRY_FILE);
  if (typeof config === 'object' && config.enabled === true) {
    return path.resolve(config.file || path.join(memoryDir, TELEMETRY_FILE));
  }
  return null;
}

/** Aggregate-only telemetry. No query, query hash, result text, or leaf ID is accepted. */
export function recordSearchOutcome(memoryDir, config, outcome) {
  const file = telemetryPath(memoryDir, config);
  if (!file || !OUTCOMES.has(outcome)) return false;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = { schemaVersion: 1, queries: { hierarchy: 0, fallback: 0, miss: 0, timeout: 0 } };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.schemaVersion === 1 && parsed?.queries) current = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  current.queries[outcome] = Number(current.queries[outcome] || 0) + 1;

  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', { flag: 'wx' });
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return true;
}
