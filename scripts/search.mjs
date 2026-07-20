#!/usr/bin/env node
/**
 * search.mjs — Urðr branch-aware, dependency-free hybrid memory search.
 *
 * Structure remains primary: callers may pass `hierarchyFiles` (root basenames) and
 * those files are searched first. The safety net then scans every root and combines
 * literal/regex matching with token + trigram ranking. `mode` may force literal or regex
 * interpretation; unset/auto preserves metacharacter detection. Regex queries run in a
 * terminable subprocess; `regexTimeoutMs` (default 300 ms) is a hard deadline.
 *
 * Telemetry is disabled by default. `telemetry: true` (CLI: `--telemetry`) stores only
 * aggregate hierarchy/fallback/miss/timeout counters under `.urdr/`; it never stores a
 * query-derived value. There is intentionally no query-specific telemetry mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listRootFiles, parseMarkdown } from './lib/markdown-model.mjs';
import { recordSearchOutcome } from './lib/telemetry.mjs';

export { listRootFiles } from './lib/markdown-model.mjs';

const REGEX_META = /[.*+?^${}()|[\]\\]/;
const REGEX_WORKER = fileURLToPath(new URL('./lib/regex-match-worker.mjs', import.meta.url));
const TURKISH_SUFFIXES = ['larınız', 'leriniz', 'larımız', 'lerimiz', 'ları', 'leri', 'lar', 'ler'];
let regexWorker;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) {} }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function regexWorkerPaths(directory, requestId) {
  return {
    requestFile: path.join(directory, `${requestId}.request.json`),
    responseFile: path.join(directory, `${requestId}.response.json`),
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function disposeRegexWorker(worker, force = false) {
  if (!worker || worker.disposed) return;
  worker.disposed = true;
  if (regexWorker === worker) regexWorker = undefined;
  process.removeListener('exit', worker.cleanup);
  if (!force) {
    try { fs.writeFileSync(path.join(worker.directory, 'stop'), ''); } catch {}
  }
  if (force && processExists(worker.child.pid)) {
    try { worker.child.kill('SIGKILL'); } catch {}
  }
  const deadline = Date.now() + 1000;
  while (processExists(worker.child.pid) && Date.now() < deadline) sleepSync(5);
  if (processExists(worker.child.pid)) {
    try { worker.child.kill('SIGKILL'); } catch {}
  }
  try { fs.rmSync(worker.directory, { recursive: true, force: true }); } catch {}
}

function regexWorkerHandle() {
  if (regexWorker && processExists(regexWorker.child.pid)) return regexWorker;
  if (regexWorker) disposeRegexWorker(regexWorker, true);

  const directory = path.join(os.tmpdir(), `urdr-regex-worker-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory);
  const child = spawn(process.execPath, [REGEX_WORKER, '--server', directory, String(process.pid)], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  child.channel?.unref();
  const worker = { child, directory, disposed: false };
  worker.cleanup = () => disposeRegexWorker(worker);
  process.once('exit', worker.cleanup);
  regexWorker = worker;
  return worker;
}

function persistentRegexMatch(payload, timeoutMs) {
  const worker = regexWorkerHandle();
  const requestId = crypto.randomUUID();
  const files = regexWorkerPaths(worker.directory, requestId);
  try { writeJsonAtomic(files.requestFile, { requestId, ...payload }); }
  catch (error) {
    disposeRegexWorker(worker, true);
    return { error: error.message };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(files.responseFile)) {
      try {
        const response = JSON.parse(fs.readFileSync(files.responseFile, 'utf8'));
        try { fs.rmSync(files.responseFile, { force: true }); } catch {}
        return response;
      } catch {
        disposeRegexWorker(worker, true);
        return { error: 'regex worker returned invalid output' };
      }
    }
    if (!processExists(worker.child.pid)) {
      disposeRegexWorker(worker, true);
      return { error: 'regex worker failed' };
    }
    if (Date.now() >= deadline) {
      // A catastrophic regex blocks the worker's only JS thread. The process is no
      // longer reusable: kill it and let the next request create a clean replacement.
      disposeRegexWorker(worker, true);
      return { timeout: true };
    }
    sleepSync(1);
  }
}

function fold(value, caseSensitive = false) {
  const text = String(value).normalize('NFKC').replace(/[’`]/g, "'");
  return caseSensitive ? text : text.toLocaleLowerCase('tr-TR');
}

function stemToken(raw, caseSensitive = false) {
  let token = fold(raw, caseSensitive);
  const apostrophe = token.indexOf("'");
  if (apostrophe > 0) token = token.slice(0, apostrophe);
  for (const suffix of TURKISH_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      token = token.slice(0, -suffix.length);
      break;
    }
  }
  return token;
}

function tokens(value, caseSensitive = false) {
  return [...fold(value, caseSensitive).matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu)]
    .map((match) => stemToken(match[0], caseSensitive))
    .filter((token) => token.length > 1);
}

function trigrams(value) {
  const padded = `  ${value} `;
  const out = new Set();
  for (let i = 0; i <= padded.length - 3; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function trigramSimilarity(a, b) {
  if (a === b) return 1;
  const left = trigrams(a), right = trigrams(b);
  let overlap = 0;
  for (const gram of left) if (right.has(gram)) overlap++;
  return (2 * overlap) / (left.size + right.size || 1);
}

function fuzzyScore(query, text, caseSensitive) {
  const queryTokens = tokens(query, caseSensitive);
  const textTokens = tokens(text, caseSensitive);
  if (queryTokens.length === 0 || textTokens.length === 0) return 0;
  let total = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const textToken of textTokens) best = Math.max(best, trigramSimilarity(queryToken, textToken));
    // Do not let several generic exact tokens hide one unrelated content token
    // (for example `comment-only-key` must not match `code-only-key`).
    if (best < 0.4) return 0;
    total += best;
  }
  return total / queryTokens.length;
}

function readLeaves(files) {
  const leaves = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const leaf of parseMarkdown(content).leaves) {
      leaves.push({
        id: leaf.id || null,
        file: path.basename(file),
        branch: leaf.branch || '(root)',
        line: leaf.startLine,
        text: leaf.text.replace(/\s*\n\s*/g, ' ').slice(0, 300),
        searchText: leaf.text,
      });
    }
  }
  return leaves;
}

function exactMatchIndices(query, leaves, caseSensitive, timeoutMs, mode, hierarchyCount = 0) {
  const useRegex = mode === 'regex' || (mode === 'auto' && REGEX_META.test(query));
  if (!useRegex) {
    const needle = fold(query, caseSensitive);
    const matching = (leaf) => fold(leaf.searchText, caseSensitive).includes(needle);
    const hierarchyIndices = hierarchyCount > 0
      ? leaves.slice(0, hierarchyCount).flatMap((leaf, index) => matching(leaf) ? [index] : [])
      : [];
    if (hierarchyIndices.length > 0) return { indices: hierarchyIndices, useRegex };
    return { indices: leaves.flatMap((leaf, index) => (!hierarchyCount || index >= hierarchyCount) && matching(leaf) ? [index] : []), useRegex };
  }
  const result = persistentRegexMatch({
    query,
    caseSensitive,
    texts: leaves.map((leaf) => leaf.searchText),
    hierarchyCount,
  }, timeoutMs);
  if (result.timeout) return { timeout: true, useRegex };
  if (result.error) return { error: result.error, useRegex };
  return { indices: result.matches, useRegex };
}

function rankLeaves(leaves, query, opts, knownExact = null) {
  const exact = knownExact || exactMatchIndices(query, leaves, opts.caseSensitive, opts.regexTimeoutMs, opts.mode);
  if (exact.timeout || exact.error) return exact;
  const exactSet = new Set(exact.indices);
  const ranked = leaves.map((leaf, index) => ({
    ...leaf,
    match: exactSet.has(index) ? 'exact' : 'fuzzy',
    score: exactSet.has(index) ? 1 : fuzzyScore(query, leaf.searchText, opts.caseSensitive),
  })).filter((leaf) => leaf.match === 'exact' || leaf.score >= opts.fuzzyThreshold);
  ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return { results: ranked.map(({ searchText, ...result }) => result) };
}

function compareResults(a, b) {
  const matchDifference = (b.match === 'exact' ? 1 : 0) - (a.match === 'exact' ? 1 : 0);
  return matchDifference || b.score - a.score
    || (b.route === 'hierarchy' ? 1 : 0) - (a.route === 'hierarchy' ? 1 : 0)
    || a.file.localeCompare(b.file) || a.line - b.line;
}

/** Returns { tool, count, results }; timeout adds { timeout:true, error }. */
export function searchMemory(memoryDir, query, opts = {}) {
  const mode = opts.mode ?? 'auto';
  if (!['auto', 'literal', 'regex'].includes(mode)) throw new Error('search mode must be "auto", "literal", or "regex"');
  const options = {
    mode,
    caseSensitive: opts.caseSensitive === true,
    maxResults: Number.isFinite(opts.maxResults) ? Math.max(0, opts.maxResults) : 25,
    regexTimeoutMs: Number.isFinite(opts.regexTimeoutMs) ? Math.max(10, opts.regexTimeoutMs) : 300,
    fuzzyThreshold: Number.isFinite(opts.fuzzyThreshold) ? opts.fuzzyThreshold : 0.42,
  };
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { tool: 'none', count: 0, results: [], error: 'empty query' };
  const files = listRootFiles(memoryDir);
  if (files.length === 0) return { tool: 'none', count: 0, results: [], error: 'no root-*.md files in ' + memoryDir };

  const preferred = new Set((opts.hierarchyFiles || []).map((file) => path.basename(file)));
  const hierarchyFiles = files.filter((file) => preferred.has(path.basename(file)));
  const fallbackFiles = preferred.size > 0
    ? files.filter((file) => !preferred.has(path.basename(file)))
    : files;
  const hierarchyLeaves = readLeaves(hierarchyFiles);
  const fallbackLeaves = readLeaves(fallbackFiles);
  let knownHierarchyExact = null, knownFallbackExact = null;

  if (preferred.size > 0) {
    const exact = exactMatchIndices(cleanQuery, [...hierarchyLeaves, ...fallbackLeaves],
      options.caseSensitive, options.regexTimeoutMs, options.mode, hierarchyLeaves.length);
    if (exact.timeout) {
      recordSearchOutcome(memoryDir, opts.telemetry, 'timeout');
      return { tool: 'regex-subprocess', count: 0, results: [], timeout: true, error: `regex timed out after ${options.regexTimeoutMs} ms` };
    }
    if (exact.error) return { tool: 'regex-subprocess', count: 0, results: [], error: exact.error };
    knownHierarchyExact = { indices: exact.indices.filter((index) => index < hierarchyLeaves.length) };
    knownFallbackExact = { indices: exact.indices.filter((index) => index >= hierarchyLeaves.length).map((index) => index - hierarchyLeaves.length) };
  }
  const rankedResults = [];

  for (const stage of [
    { route: 'hierarchy', leaves: hierarchyLeaves, exact: knownHierarchyExact },
    { route: 'fallback', leaves: fallbackLeaves, exact: knownFallbackExact },
  ]) {
    if (stage.leaves.length === 0) continue;
    const ranked = rankLeaves(stage.leaves, cleanQuery, options, stage.exact);
    if (ranked.timeout) {
      recordSearchOutcome(memoryDir, opts.telemetry, 'timeout');
      return { tool: 'regex-subprocess', count: 0, results: [], timeout: true, error: `regex timed out after ${options.regexTimeoutMs} ms` };
    }
    if (ranked.error) return { tool: 'regex-subprocess', count: 0, results: [], error: ranked.error };
    rankedResults.push(...ranked.results.map((result) => ({ ...result, route: stage.route })));

    // An exact hierarchy winner is already in the highest match tier. Preserve the
    // structure-first fast path; fuzzy winners must compete with the rest of the tree.
    if (stage.route === 'hierarchy' && ranked.results[0]?.match === 'exact') {
      break;
    }
  }

  rankedResults.sort(compareResults);
  const results = rankedResults.slice(0, options.maxResults);
  const usesRegex = options.mode === 'regex' || (options.mode === 'auto' && REGEX_META.test(cleanQuery));
  const tool = usesRegex ? 'regex-subprocess+hybrid' : 'node+hybrid';
  if (results.length === 0) {
    recordSearchOutcome(memoryDir, opts.telemetry, 'miss');
    return { tool, count: 0, results: [] };
  }
  recordSearchOutcome(memoryDir, opts.telemetry, results[0].route);
  return { tool, count: results.length, results };
}

export function formatResults(res) {
  if (res.error) return `⚠️  ${res.error}`;
  if (res.count === 0) return 'No matches — the information may not have been saved yet.';
  return res.results.map((r) => `${r.file} › ## ${r.branch} › ${r.text}`).join('\n');
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  if (flags.has('--literal') && flags.has('--regex')) {
    console.error('--literal and --regex are mutually exclusive');
    process.exit(2);
  }
  const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const optionsWithValues = new Set([valueAfter('--max'), valueAfter('--regex-timeout')].filter(Boolean));
  const positional = argv.filter((arg) => !arg.startsWith('--') && !optionsWithValues.has(arg));
  const query = positional[0];
  const memoryDir = positional[1] || process.cwd();
  if (!query) {
    console.error('Usage: node search.mjs <query> [memoryDir] [--literal|--regex] [--case] [--json] [--max N] [--regex-timeout MS] [--telemetry]');
    process.exit(2);
  }
  const res = searchMemory(memoryDir, query, {
    mode: flags.has('--literal') ? 'literal' : flags.has('--regex') ? 'regex' : 'auto',
    caseSensitive: flags.has('--case'),
    maxResults: parseInt(valueAfter('--max'), 10) || 25,
    regexTimeoutMs: parseInt(valueAfter('--regex-timeout'), 10) || 300,
    telemetry: flags.has('--telemetry'),
  });
  console.log(flags.has('--json') ? JSON.stringify(res, null, 2) : formatResults(res));
  process.exit(res.count > 0 ? 0 : 1);
}
