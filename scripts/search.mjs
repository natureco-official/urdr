#!/usr/bin/env node
/**
 * search.mjs — Urðr last-resort memory search (LLM-free, cross-platform)
 *
 * The 4-step hierarchical protocol (identify → root → branch → leaf) is the PRIMARY
 * retrieval path. But if the agent guesses the wrong root/branch — or the info is
 * genuinely cross-cutting — hierarchy alone can report "not found" while the data is
 * right there. This is the safety net: a branch-aware, dependency-free full scan of
 * every `root-*.md` (and Turkish `kök-*.md`) so information is never *unreachable*,
 * only ever slower to reach.
 *
 * Pure Node — works on macOS, Windows, and Linux with no `grep`/`rg`/`awk` dependency
 * (a real portability trap: shell `grep -ril` simply does not exist on stock Windows).
 * ripgrep is used ONLY as an optional pre-filter when a tree is very large; results are
 * always re-parsed in Node so every hit carries its `## branch` context.
 *
 * Usage:
 *   node search.mjs <query> [memoryDir] [--case] [--json] [--max N] [--node]
 *   node search.mjs "sqlite" ./my-memory
 *
 * As a module:
 *   import { searchMemory } from './search.mjs';
 *   const { results } = searchMemory('./my-memory', 'sqlite');
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_FILE_RE = /^(root|kök|kok)-\d+.*\.md$/i;

/** List all root memory files in a directory (root-*.md + Turkish kök-*.md). */
export function listRootFiles(memoryDir) {
  let entries;
  try { entries = fs.readdirSync(memoryDir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && ROOT_FILE_RE.test(e.name))
    .map((e) => path.join(memoryDir, e.name))
    .sort();
}

/** Is ripgrep available? (optional accelerator only) */
function hasRipgrep() {
  try {
    const r = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; }
}

/** Build a case-(in)sensitive matcher; falls back to literal if regex is invalid. */
function buildMatcher(query, caseSensitive) {
  const flags = caseSensitive ? '' : 'i';
  try { return new RegExp(query, flags); }
  catch { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
}

/**
 * Parse a single root file, tracking the current `## branch`, and collect matching
 * NON-empty, non-heading lines as leaves. Each hit carries file, branch, line, text.
 */
function scanFile(file, matcher, out, maxResults) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { return; }
  const lines = content.split(/\r?\n/);
  let branch = '(root)';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { branch = h[1]; continue; }
    // skip structural noise: blank, HTML comments, placeholders, hr, top heading
    const t = line.trim();
    if (!t || t.startsWith('<!--') || t.startsWith('#') || t === '---' || /^_no entries yet\._$/i.test(t)) continue;
    matcher.lastIndex = 0;
    if (matcher.test(line)) {
      out.push({ file: path.basename(file), branch, line: i + 1, text: t.slice(0, 300) });
      if (out.length >= maxResults) return;
    }
  }
}

/**
 * Search a memory tree. Returns { tool, count, results:[{file,branch,line,text}] }.
 * Results are ordered by file then line — deterministic and branch-aware.
 */
export function searchMemory(memoryDir, query, opts = {}) {
  const { caseSensitive = false, maxResults = 25, forceNode = false } = opts;
  if (!query || !String(query).trim()) return { tool: 'none', count: 0, results: [], error: 'empty query' };
  let files = listRootFiles(memoryDir);
  if (files.length === 0) return { tool: 'none', count: 0, results: [], error: 'no root-*.md files in ' + memoryDir };

  // Optional accelerator: on very large trees, use ripgrep to pre-filter which files
  // even contain the term, then parse only those in Node (still branch-aware).
  let tool = 'node';
  if (!forceNode && files.length > 40 && hasRipgrep()) {
    try {
      const args = ['-l', caseSensitive ? '-s' : '-i', '--', query, ...files];
      const rg = spawnSync('rg', args, { encoding: 'utf8' });
      if (rg.status === 0 && rg.stdout.trim()) {
        files = rg.stdout.trim().split(/\r?\n/).filter(Boolean);
        tool = 'ripgrep+node';
      } else if (rg.status === 1) {
        files = []; // rg exit 1 = no matches at all
        tool = 'ripgrep+node';
      }
    } catch { /* fall through to pure-node */ }
  }

  const matcher = buildMatcher(query, caseSensitive);
  const results = [];
  for (const f of files) {
    scanFile(f, matcher, results, maxResults);
    if (results.length >= maxResults) break;
  }
  return { tool, count: results.length, results };
}

/** Human-readable one-liner per hit: `file › ## branch › leaf`. */
export function formatResults(res) {
  if (res.error) return `⚠️  ${res.error}`;
  if (res.count === 0) return 'No matches — the information may not have been saved yet.';
  return res.results
    .map((r) => `${r.file} › ## ${r.branch} › ${r.text}`)
    .join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────
// fileURLToPath is the ONLY portable way to compare here: new URL().pathname yields
// "/C:/..." on Windows and never matches process.argv1's "C:\...". (Exactly the kind
// of cross-platform trap this project exists to help agents avoid.)
function isMain() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.');
  } catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const query = positional[0];
  const memoryDir = positional[1] || process.cwd();
  const maxIdx = argv.indexOf('--max');
  const maxResults = maxIdx >= 0 ? parseInt(argv[maxIdx + 1], 10) || 25 : 25;

  if (!query) {
    console.error('Usage: node search.mjs <query> [memoryDir] [--case] [--json] [--max N] [--node]');
    process.exit(2);
  }
  const res = searchMemory(memoryDir, query, {
    caseSensitive: flags.has('--case'),
    forceNode: flags.has('--node'),
    maxResults,
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(formatResults(res));
  }
  // exit 0 if found, 1 if not (grep convention) — lets agents branch on it
  process.exit(res.count > 0 ? 0 : 1);
}
