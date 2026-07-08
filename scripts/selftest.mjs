#!/usr/bin/env node
/**
 * selftest.mjs — Urðr tooling self-test (cross-platform, LLM-free, zero-dependency)
 *
 * Exercises every tool against a temporary fixture and exits non-zero on any failure.
 * Runs identically on macOS, Windows, and Linux — used by CI (3-OS matrix) and locally.
 *
 * Usage:  node scripts/selftest.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchMemory } from './search.mjs';
import { appendLeaf, insertLeaf } from './append.mjs';
import { lintTree } from './lint.mjs';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

const root2 = '# Root-2: Technical\n\n---\n\n## APIs\n\n_No entries yet._\n\n---\n\n## Fixes\n\n_No entries yet._\n\n---\n';

function tmpTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root2);
  return dir;
}

console.log('\n  🌳 Urðr self-test\n  ' + '─'.repeat(50));

// ── append.mjs ──────────────────────────────────────────────────────
{
  const dir = tmpTree();
  appendLeaf(dir, 'root-2-technical.md', 'APIs', '**01.01.2026 — sqlite — chose SQLite**');
  let c = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(c.includes('SQLite'), 'append: leaf written');
  ok(!/## APIs[\s\S]*?_No entries yet\._/.test(c.split('## Fixes')[0]), 'append: placeholder replaced in APIs');
  appendLeaf(dir, 'root-2-technical.md', 'APIs', '**02.02.2026 — redis — chose Redis**');
  c = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(c.includes('SQLite') && c.includes('Redis'), 'append: append-only (keeps siblings)');
  ok((c.match(/^## APIs/gm) || []).length === 1, 'append: file structure intact');
  // wrong branch → throws
  let threw = false;
  try { appendLeaf(dir, 'root-2-technical.md', 'NoSuchBranch', 'x'); } catch { threw = true; }
  ok(threw, 'append: unknown branch rejected');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── insertLeaf (pure) ───────────────────────────────────────────────
{
  const out = insertLeaf(root2, 'Fixes', '**03.03.2026 — bugfix — patched**');
  ok(out.includes('patched') && out.split('## Fixes')[1].includes('patched'), 'insertLeaf: places under correct branch');
}

// ── search.mjs ──────────────────────────────────────────────────────
{
  const dir = tmpTree();
  appendLeaf(dir, 'root-2-technical.md', 'APIs', '**01.01.2026 — sqlite — chose SQLite for storage**');
  appendLeaf(dir, 'root-2-technical.md', 'Fixes', '**02.02.2026 — oauth — fixed refresh loop**');
  const hit = searchMemory(dir, 'oauth');
  ok(hit.count === 1, 'search: finds the leaf');
  ok(hit.results[0].branch === 'Fixes', 'search: branch-aware result');
  ok(searchMemory(dir, 'kubernetes').count === 0, 'search: miss returns empty');
  ok(searchMemory(dir, '').error != null, 'search: empty query guarded');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── lint.mjs ────────────────────────────────────────────────────────
{
  const clean = tmpTree();
  appendLeaf(clean, 'root-2-technical.md', 'APIs', '**01.01.2026 — note — a unique fact about storage**');
  const lc = lintTree(clean);
  ok(lc.findings.filter((f) => f.level === 'error').length === 0, 'lint: clean tree has no errors');
  fs.rmSync(clean, { recursive: true, force: true });

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-bad-'));
  // broken bkz + near-duplicate
  fs.writeFileSync(path.join(bad, 'root-3-decisions.md'),
    '# Root-3: Decisions\n\n## Rules\n\n**01.01.2026 — rule — see also bkz: root-9-ghost (Missing)**\n' +
    '**02.02.2026 — never store plaintext secrets in the repo ever**\n' +
    '**03.03.2026 — never store plaintext secrets in the repo ever**\n');
  const lb = lintTree(bad);
  ok(lb.findings.some((f) => f.code === 'broken-ref'), 'lint: catches broken bkz: ref');
  ok(lb.findings.some((f) => f.code === 'duplication'), 'lint: catches near-duplicate');
  fs.rmSync(bad, { recursive: true, force: true });
}

// ── write fidelity (bench core) ─────────────────────────────────────
{
  const dir = tmpTree();
  const leaf = '**04.07.2026 — çğıöşü-fidelity — unicode + **bold** | pipe · dash**';
  appendLeaf(dir, 'root-2-technical.md', 'APIs', leaf);
  const c = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(c.includes(leaf), 'fidelity: stored == intended (unicode + markdown-hostile chars)');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n  ' + '─'.repeat(50));
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
