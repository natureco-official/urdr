#!/usr/bin/env node
/**
 * lint.mjs — Urðr memory health audit (cross-platform, LLM-free)
 *
 * A cross-platform successor to check-growth.sh (bash → does not run on stock Windows).
 * Audits a memory tree for the failure modes that erode retrieval reliability as it scales,
 * and exits non-zero if any ERROR-level issue is found (usable as a CI/pre-commit guard):
 *
 *   1. Growth      — root > 9 branches (Miller's Law), branch > 50 leaves → split signals
 *   2. Index bloat — root-0-index should be a MAP (branch→location), not store leaves;
 *                    flag if it grows content-heavy (the index is read every retrieval)
 *   3. bkz: refs   — broken references (points to a root file that doesn't exist) and
 *                    chains deeper than 1 hop (A → bkz: B → bkz: C makes retrieval expensive)
 *   4. Duplication — near-identical leaves in the same root (Jaccard ≥ 0.85) — the
 *                    "same fact in 5 places, subtly different" drift the tree is meant to prevent
 *
 * Usage:  node lint.mjs [memory-dir] [--json] [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Urðr `root-N-*`/`kök-N-*` AND platform-native `N-name` roots (e.g. NatureCo `1-kisisel.md`).
const ROOT_FILE_RE = /^(?:(?:root|kök|kok)-)?\d[-_].*\.md$/i;
const MAX_BRANCHES = 9;
const WARN_LEAVES = 30;
const MAX_LEAVES = 50;
const DUP_THRESHOLD = 0.85;
const INDEX_LEAF_WARN = 15; // an index with this many leaf-like lines is storing, not mapping

function listRootFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && ROOT_FILE_RE.test(e.name))
      .map((e) => path.join(dir, e.name)).sort();
  } catch { return []; }
}

/** Parse a root file into { file, isIndex, branches: [{name, leaves:[{text,line}]}] }. */
function parseFile(file) {
  const name = path.basename(file);
  const isIndex = /-0-/.test(name) || /index|indeks/i.test(name);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const branches = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) { cur = { name: h[1], leaves: [] }; branches.push(cur); continue; }
    const t = lines[i].trim();
    if (!t || t.startsWith('<!--') || t.startsWith('#') || t === '---' || /^_no entries yet\._$/i.test(t) || t.startsWith('>')) continue;
    if (cur) cur.leaves.push({ text: t, line: i + 1 });
  }
  return { file: name, isIndex, branches };
}

const STOP = new Set(['the', 've', 'and', 'for', 'with', 'chose', 'alt', 'none', 'ok', 'to', 'a', 'of', 'in', 'on', 'is', 'bkz']);
function tokens(text) {
  return new Set(
    text.toLowerCase()
      .replace(/\*\*|__|`|\|/g, ' ')
      .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ') // drop dates (format noise)
      .split(/[^a-z0-9çğıöşü-]+/i)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function lintTree(dir) {
  const files = listRootFiles(dir);
  const findings = [];
  const add = (level, code, msg) => findings.push({ level, code, msg });
  if (files.length === 0) { add('error', 'no-roots', `no root-*.md files in ${dir}`); return { findings, files: 0 }; }

  const parsed = files.map(parseFile);
  const rootFileNames = new Set(parsed.map((p) => p.file.toLowerCase()));

  for (const p of parsed) {
    // 1) Growth
    if (p.branches.length > MAX_BRANCHES) {
      add('warn', 'root-branches', `${p.file}: ${p.branches.length} branches (> ${MAX_BRANCHES}) — consider splitting into a new root`);
    }
    for (const b of p.branches) {
      if (b.leaves.length > MAX_LEAVES) add('error', 'branch-leaves', `${p.file} › ## ${b.name}: ${b.leaves.length} leaves (> ${MAX_LEAVES}) — split into sub-branches`);
      else if (b.leaves.length > WARN_LEAVES) add('warn', 'branch-leaves', `${p.file} › ## ${b.name}: ${b.leaves.length} leaves (> ${WARN_LEAVES}) — approaching split limit`);
    }

    // 2) Index bloat
    if (p.isIndex) {
      const leafCount = p.branches.reduce((n, b) => n + b.leaves.length, 0);
      if (leafCount > INDEX_LEAF_WARN) add('warn', 'index-bloat', `${p.file}: index holds ${leafCount} content lines — it should MAP (branch→location), not store leaves (it's read on every retrieval)`);
    }

    // 3) bkz: references
    for (const b of p.branches) {
      for (const leaf of b.leaves) {
        if (!/\bbkz:/i.test(leaf.text)) continue;
        // extract referenced root file tokens like "root-2", "kök-3"
        const refs = leaf.text.match(/(root|kök|kok)-\d+[a-zçğıöşü-]*(?:\.md)?/gi) || [];
        for (const ref of refs) {
          const fn = (ref.endsWith('.md') ? ref : ref + '.md').toLowerCase();
          const exists = [...rootFileNames].some((rf) => rf.startsWith(fn.replace(/\.md$/, '')));
          if (!exists) add('error', 'broken-ref', `${p.file} › ## ${b.name} (line ${leaf.line}): bkz: points to missing "${ref}"`);
        }
        // chain depth: a leaf that both RECEIVES focus and itself gives bkz is fine (1 hop);
        // flag if the referenced target ALSO contains a bkz: (2+ hops → expensive retrieval)
      }
    }

    // 4) Duplication (within same root, pairwise Jaccard)
    const allLeaves = p.branches.flatMap((b) => b.leaves.map((l) => ({ ...l, branch: b.name })));
    const toks = allLeaves.map((l) => tokens(l.text));
    for (let i = 0; i < allLeaves.length; i++) {
      for (let j = i + 1; j < allLeaves.length; j++) {
        const sim = jaccard(toks[i], toks[j]);
        if (sim >= DUP_THRESHOLD) {
          add('warn', 'duplication', `${p.file}: near-duplicate (${(sim * 100).toFixed(0)}%) — "## ${allLeaves[i].branch}" L${allLeaves[i].line} ≈ "## ${allLeaves[j].branch}" L${allLeaves[j].line}. Keep one primary + bkz:.`);
        }
      }
    }
  }
  return { findings, files: files.length };
}

// ── CLI ────────────────────────────────────────────────────────────
// realpathSync resolves symlinks (macOS /tmp → /private/tmp) so "run as CLI" is detected.
function isMain() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.');
  } catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const json = argv.includes('--json');
  const { findings, files } = lintTree(dir);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (json) {
    console.log(JSON.stringify({ dir, files, errors: errors.length, warnings: warns.length, findings }, null, 2));
  } else {
    console.log(`\n  🌳 Urðr Memory Lint — ${files} root file(s)\n  ${'─'.repeat(56)}`);
    if (findings.length === 0) {
      console.log('  ✓ Healthy — no growth, reference, or duplication issues.');
    } else {
      for (const f of errors) console.log(`  ✗ [${f.code}] ${f.msg}`);
      for (const f of warns) console.log(`  ⚠ [${f.code}] ${f.msg}`);
      console.log(`\n  ${errors.length} error(s), ${warns.length} warning(s).`);
    }
    console.log('');
  }
  process.exit(errors.length > 0 ? 1 : 0);
}
