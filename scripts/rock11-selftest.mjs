#!/usr/bin/env node
/**
 * rock11-selftest.mjs — yazma yolu kanıtı (v1.4).
 *
 * Sözleşme: write_context karar VERMEZ — birebir dal adları, amaç satırları,
 * yakın-kopya uyarıları ve ölçülmüş sınırları üstünde yazılı danışma
 * sıralaması verir. Append sertleştirmesi gözlenen iki gerçek hatayı
 * ("Systems", "Active Constraints") öz-düzeltmeye çevirir; dupeGuard
 * kopyayı yazılmadan yakalar; her şey deterministiktir ve vergi
 * katmanından geçer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from './mcp-server.mjs';
import { createSessionLedger } from './lib/context-tax.mjs';
import { advisoryRanking, buildWriteContext, listRootInventory, nearDuplicates, suggestBranches } from './lib/write-path.mjs';
import { loadPack, readLeavesById } from './lib/context-pack.mjs';
import { evaluateTree } from './write-bench.mjs';

let testCount = 0;
function ok(condition, label) {
  testCount++;
  assert.ok(condition, label);
  console.log(`  ✓ ${label}`);
}

const templates = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const serveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock11-'));
const memory = path.join(serveRoot, 'memory');
fs.mkdirSync(memory, { recursive: true });
for (const file of ['root-0-index.md', 'root-1-topics.md', 'root-2-technical.md', 'root-3-decisions.md']) {
  fs.copyFileSync(path.join(templates, file), path.join(memory, file));
}
const ledger = createSessionLedger();
const call = (name, args = {}) => executeTool(serveRoot, name, { memoryDir: 'memory', ...args }, ledger);

try {
  // tohum yapraklar
  call('urdr_append', { rootFile: 'root-3-decisions.md', branch: 'Decision Log',
    leafText: '**30.08.2026 — Decided to use SQLite for rental data storage — single-writer fits**' });
  call('urdr_append', { rootFile: 'root-2-technical.md', branch: 'Systems',
    leafText: '**30.08.2026 — Paddle webhook signature verification uses raw request body**' });

  // ── 1. envanter: birebir dal adları + amaç satırları ─────────────────────
  const inventory = listRootInventory(memory);
  const technical = inventory.find((root) => root.file === 'root-2-technical.md');
  assert.ok(technical.purpose && technical.purpose.length > 10, 'amaç satırı okunur');
  assert.ok(technical.branches.some((branch) => branch.name === 'Systems'));
  const decisions = inventory.find((root) => root.file === 'root-3-decisions.md');
  assert.ok(decisions.branches.some((branch) => branch.name === 'Decision Log'));
  ok(true, 'envanter: kök amaçları + dal adları şablondan BİREBİR okunur');

  // ── 2. format ipucu şablon yorumundan çıkar ──────────────────────────────
  const withFormat = inventory.flatMap((r) => r.branches).find((b) => b.format);
  assert.ok(withFormat, 'en az bir dal <!-- Format: --> ipucu taşır');
  assert.ok(withFormat.format.length > 5);
  ok(true, 'format ipuçları <!-- Format: ... --> yorumlarından çıkarılır');

  // ── 3. tarihi hatalar öz-düzeltmeye dönüşür ──────────────────────────────
  const sugSystems = suggestBranches(['Systems & Stack', 'APIs', 'Workflows'], 'Systems');
  assert.equal(sugSystems[0].name, 'Systems & Stack');
  const sugConstraints = suggestBranches(['Constraints (Kırmızı Çizgiler)', 'Lessons Learned'], 'Active Constraints');
  assert.equal(sugConstraints[0].name, 'Constraints (Kırmızı Çizgiler)');
  ok(true, 'suggestBranches: gözlenen iki gerçek hata ("Systems", "Active Constraints") doğru öneriye gider');

  // ── 4. append hatası "did you mean" taşır ────────────────────────────────
  assert.throws(
    () => call('urdr_append', { rootFile: 'root-3-decisions.md', branch: 'Decisions', leafText: '**30.08.2026 — probe**' }),
    /branch not found.*did you mean "Decision Log"/s,
  );
  ok(true, 'urdr_append: yanlış dal adı deterministik "did you mean" önerisiyle döner');

  // ── 5. write_context: uçtan uca yapı ─────────────────────────────────────
  const context = call('urdr_write_context', { draftText: '**30.08.2026 — Decided to switch rental storage from SQLite to Postgres**' });
  assert.ok(context.roots.length >= 3);
  assert.ok(context.roots.every((root) => Array.isArray(root.branches) && root.branches.length > 0));
  assert.match(context.advisory.note, /advisory only.*23\.9%/s);
  assert.ok(context.receipt.includes('urdr_append'));
  ok(true, 'urdr_write_context: envanter + danışma etiketi (ölçülmüş doğrulukla) + fiş sözleşmesi');

  // ── 6. yakın-kopya uyarısı: ekili kopyada öter, alakasızda susar ─────────
  const dupeContext = call('urdr_write_context', { draftText: '**30.08.2026 — Decided to use SQLite for rental data storage — single-writer fits**', force: true });
  assert.ok(dupeContext.nearDuplicates.length >= 1);
  assert.ok(dupeContext.nearDuplicates[0].similarity >= 0.6);
  const cleanContext = call('urdr_write_context', { draftText: '**30.08.2026 — Hired a new accountant for the Berlin office**', force: true });
  assert.equal(cleanContext.nearDuplicates.length, 0);
  ok(true, 'yakın-kopya: ekili kopyada uyarı (id ile), alakasız taslakta sessizlik');

  // ── 7. dupeGuard: reddeder, id verir; force yolu açık; farklı metin geçer ─
  const refused = call('urdr_append', { rootFile: 'root-3-decisions.md', branch: 'Decision Log', dupeGuard: true,
    leafText: '**30.08.2026 — Decided to use SQLite for rental data storage — single-writer fits**' });
  assert.equal(refused.refused, true);
  assert.ok(refused.nearDuplicates[0].id);
  const passed = call('urdr_append', { rootFile: 'root-3-decisions.md', branch: 'Decision Log', dupeGuard: true,
    leafText: '**30.08.2026 — Decided to adopt weekly retro meetings for the sales team**' });
  assert.ok(passed.id && !passed.refused);
  ok(true, 'dupeGuard: kopyayı yazılmadan reddeder (mevcut id ile); farklı metin geçer');

  // ── 8. danışma sıralaması deterministik ve kanıt taşır ───────────────────
  const pack = loadPack(memory);
  const texts = new Map();
  for (const leaf of readLeavesById(memory, pack.leaves.map((l) => l.id))) texts.set(leaf.id, leaf.text || '');
  const rankA = advisoryRanking(pack, texts, 'Paddle webhook raw body signature');
  const rankB = advisoryRanking(pack, texts, 'Paddle webhook raw body signature');
  assert.deepEqual(rankA, rankB);
  assert.ok(rankA.length >= 1 && rankA[0].evidence.length >= 1);
  assert.equal(`${rankA[0].file}::${rankA[0].branch}`, 'root-2-technical.md::Systems');
  ok(true, 'danışma sıralaması deterministik, kanıt kelimeleri taşır, açık sinyalde doğru dalı bulur');

  // ── 9. vergi katmanı: write_context delta protokolünde ───────────────────
  // (7. adımdaki append ağacı değiştirdiği için önceki damgalar haklı olarak düştü)
  const fresh = call('urdr_write_context', { draftText: '**30.08.2026 — Hired a new accountant for the Berlin office**' });
  assert.ok(fresh.roots && !fresh.unchanged, 'ağaç değişince tam gövde');
  const repeat = call('urdr_write_context', { draftText: '**30.08.2026 — Hired a new accountant for the Berlin office**' });
  assert.equal(repeat.unchanged, true);
  assert.match(repeat.ref, /^spool:/);
  ok(true, 'write_context vergi katmanında: yazı sonrası tam gövde, özdeş tekrar → unchanged + spool ref');

  // ── 10. bench: sentetik ağaçta deterministik ve sınırlar içinde ──────────
  const resultA = evaluateTree(memory);
  const resultB = evaluateTree(memory);
  assert.deepEqual(resultA, resultB);
  assert.ok(resultA.probes >= 3 && resultA.top1 >= 0 && resultA.top1 <= 100 && resultA.top5 >= resultA.top1);
  ok(true, 'write-bench: deterministik, top-5 ≥ top-1, oranlar [0,100] içinde');

  // ── 11. boş ağaç zarafeti ────────────────────────────────────────────────
  const bare = path.join(serveRoot, 'bare');
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(bare, 'root-1-topics.md'), '# Root-1: Topics\n\n> **Purpose:** test.\n\n## People\n\n_no entries yet._\n');
  const bareContext = buildWriteContext(bare, 'brand new fact about someone');
  assert.equal(bareContext.nearDuplicates.length, 0);
  assert.equal(bareContext.advisory.candidates.length, 0);
  assert.deepEqual(bareContext.roots[0].branches, ['People']);
  ok(true, 'boş ağaç: envanter dolu, uyarılar/danışma boş — çökmek yok, uydurmak yok');

  console.log(`\n  ${testCount} Rock 11 tests passed`);
} finally {
  fs.rmSync(serveRoot, { recursive: true, force: true });
}
