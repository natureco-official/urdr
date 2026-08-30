#!/usr/bin/env node
/**
 * Rock 7 — Bağlam Paketi, grafik zekâsı ve Urðr Tree odaklı takım.
 *
 * Kanıtlanan iddialar:
 *   1. Paket deterministiktir: aynı ağaç → aynı digest, aynı kenar listesi.
 *   2. Damga bayatlamayı yakalar: yaprak eklenince loadPack yeniden derler.
 *   3. Unutma garantisi: forget sonrası pack dizini yoktur, yeniden üretilen
 *      pakette unutulan metin geçmez (scrub doğrulaması pack yüzünden düşmez).
 *   4. Çok haneli kök: root-10 artık listelenir, arama onu görür.
 *   5. urdr_related bütçeye uyar ve EXTRACTED kenarları önce döndürür.
 *   6. Louvain deterministiktir ve bkz ile bağlanan çapraz-kök yaprakları
 *      aynı topluluğa koyar.
 *   7. Digest karakter bütçesini aşmaz.
 *   8. Yerleşim deterministiktir: aynı veri → aynı koordinatlar.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLeaf } from './append.mjs';
import {
  buildPack, DIGEST_CHAR_BUDGET, loadPack, PACK_RELATIVE_DIR, readLeavesById, relatedLeaves,
} from './lib/context-pack.mjs';
import { detectCommunities, summarizeCommunities } from './lib/graph-intel.mjs';
import { forgetMemoryLeaf } from './lib/forgetting.mjs';
import { listRootFiles } from './lib/markdown-model.mjs';
import { searchMemory } from './search.mjs';
import { buildTreeData, layoutGraph } from './tree.mjs';
import { askMemory, pathBetween } from './lib/memory-query.mjs';
import { buildReport } from './lib/graph-intel.mjs';

let passed = 0;
function ok(condition, label) {
  if (!condition) { console.error(`  ✗ ${label}`); process.exit(1); }
  passed++;
}

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock7-'));
  const templates = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates');
  for (const name of ['root-0-index.md', 'root-1-topics.md', 'root-2-technical.md', 'root-3-decisions.md']) {
    fs.copyFileSync(path.join(templates, name), path.join(dir, name));
  }
  appendLeaf(dir, 'root-3-decisions.md', 'Decision Log', '**29.08.2026 — PayTR canlıya alındı — tutar doğrulaması açık** (bkz: root-2 / APIs)');
  appendLeaf(dir, 'root-2-technical.md', 'APIs', '**28.08.2026 — MCP ucu apm_ anahtarlarını kabul ediyor**');
  appendLeaf(dir, 'root-1-topics.md', 'Projects', '**30.08.2026 — Bağlam paketi geliştirmesi başladı**');
  return dir;
}

// ── 1+7: determinizm ve digest bütçesi ──────────────────────────────────────
{
  const dir = makeTree();
  const a = buildPack(dir);
  const b = buildPack(dir);
  ok(a.digest === b.digest, 'pack: digest deterministik');
  ok(JSON.stringify(a.edges) === JSON.stringify(b.edges), 'pack: kenar listesi deterministik');
  ok(a.digest.length <= DIGEST_CHAR_BUDGET, `pack: digest bütçe içinde (${a.digest.length} ≤ ${DIGEST_CHAR_BUDGET})`);
  ok(a.leaves.some((leaf) => leaf.stable), 'pack: kararlı id\'li yapraklar var');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 2: damga bayatlamayı yakalar ────────────────────────────────────────────
{
  const dir = makeTree();
  const first = loadPack(dir);
  ok(first.rebuilt === true, 'loadPack: ilk çağrı derler');
  const second = loadPack(dir);
  ok(second.rebuilt === false, 'loadPack: taze pakette önbellek isabeti');
  appendLeaf(dir, 'root-2-technical.md', 'Systems', '**30.08.2026 — Yeni sistem yaprağı — damga testi**');
  const third = loadPack(dir);
  ok(third.rebuilt === true, 'loadPack: yaprak eklenince yeniden derler');
  ok(third.leaves.length === second.leaves.length + 1, 'loadPack: yeni yaprak katalogda');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3: unutma garantisi ─────────────────────────────────────────────────────
{
  const dir = makeTree();
  const pack = loadPack(dir);
  const target = pack.leaves.find((leaf) => /apm_ anahtar/.test(leaf.headline));
  ok(Boolean(target?.stable), 'forget: hedef yaprak kararlı id taşıyor');
  ok(fs.existsSync(path.join(dir, PACK_RELATIVE_DIR, 'digest.md')), 'forget: paket unutmadan önce diskte');
  forgetMemoryLeaf(dir, target.id, { reason: 'rock7 testi' });
  ok(!fs.existsSync(path.join(dir, PACK_RELATIVE_DIR)), 'forget: paket dizini scrub ile silindi');
  const rebuilt = loadPack(dir);
  ok(!rebuilt.leaves.some((leaf) => /apm_ anahtar/.test(leaf.headline)), 'forget: yeniden üretilen pakette iz yok');
  ok(!rebuilt.digest.includes('apm_ anahtar'), 'forget: digest\'te iz yok');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 4: çok haneli kök ───────────────────────────────────────────────────────
{
  const dir = makeTree();
  fs.writeFileSync(path.join(dir, 'root-10-arsiv.md'),
    '# Kök 10\n\n## Arşiv\n\n**01.01.2026 — root-on testi — çok haneli kök görünür**\n');
  const files = listRootFiles(dir).map((file) => path.basename(file));
  ok(files.includes('root-10-arsiv.md'), 'regex: root-10 listelenir');
  const found = searchMemory(dir, 'root-on testi', { maxResults: 5 });
  ok(found.count > 0 && found.results[0].file === 'root-10-arsiv.md', 'regex: arama root-10 içinde bulur');
  const pack = buildPack(dir);
  ok(pack.roots.some((root) => root.file === 'root-10-arsiv.md' && root.rootNumber === 10), 'regex: pakette rootNumber=10');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 5: related bütçe ve katman önceliği ─────────────────────────────────────
{
  const dir = makeTree();
  for (let i = 0; i < 30; i++) {
    appendLeaf(dir, 'root-2-technical.md', 'APIs', `**0${(i % 9) + 1}.03.2026 — API notu ${i} — dolgu**`);
  }
  const pack = loadPack(dir);
  const origin = pack.leaves.find((leaf) => /PayTR/.test(leaf.headline));
  const tight = relatedLeaves(pack, origin.id, { budgetTokens: 120, depth: 2 });
  const loose = relatedLeaves(pack, origin.id, { budgetTokens: 2000, depth: 2 });
  ok(tight.related.length > 0, 'related: dar bütçede de sonuç var');
  ok(tight.related.length < loose.related.length, 'related: bütçe sonucu gerçekten sınırlar');
  ok(JSON.stringify(tight.related).length <= 120 * 4 + 200, 'related: karakter maliyeti bütçeye yakın kalır');
  ok(tight.related[0].tier === 'EXTRACTED', 'related: EXTRACTED önce gelir');
  const unknown = relatedLeaves(pack, 'yok-boyle-id', {});
  ok(unknown.error && unknown.related.length === 0, 'related: bilinmeyen id düzgün hata döner');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6: Louvain determinizmi ve bkz kümelemesi ───────────────────────────────
{
  const dir = makeTree();
  const pack = loadPack(dir);
  const a = detectCommunities(pack);
  const b = detectCommunities(pack);
  ok(JSON.stringify([...a.entries()].sort()) === JSON.stringify([...b.entries()].sort()), 'louvain: deterministik');
  const paytr = pack.leaves.find((leaf) => /PayTR/.test(leaf.headline));
  const api = pack.leaves.find((leaf) => /apm_ anahtar/.test(leaf.headline));
  ok(a.get(paytr.id) === a.get(api.id), 'louvain: bkz ile bağlı çapraz-kök yapraklar aynı toplulukta');
  const summaries = summarizeCommunities(pack, a);
  ok(summaries.some((community) => community.crossBranch), 'louvain: çapraz-dal topluluk raporlanır');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 8: yerleşim ve ağaç verisi determinizmi ────────────────────────────────
{
  const nodesA = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const nodesB = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const links = [{ source: 'a', target: 'b', weight: 2 }, { source: 'c', target: 'd', weight: 1 }];
  layoutGraph(nodesA, links, { iterations: 60 });
  layoutGraph(nodesB, links, { iterations: 60 });
  ok(JSON.stringify(nodesA) === JSON.stringify(nodesB), 'layout: aynı girdi → aynı koordinatlar');

  const dir = makeTree();
  const t1 = buildTreeData(dir);
  const t2 = buildTreeData(dir);
  ok(JSON.stringify(t1.nodes) === JSON.stringify(t2.nodes), 'tree: veri deterministik');
  ok(t1.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.sx)), 'tree: 2B + küre koordinatları tam');
  ok(!t1.links.some((link) => String(link.source).startsWith('branch:') || String(link.target).startsWith('branch:')),
    'tree: bkz kenarları temsilci yaprağa çözülür');
  fs.rmSync(dir, { recursive: true, force: true });

  // readLeavesById cerrahi okuma
  const dir2 = makeTree();
  const pack2 = loadPack(dir2);
  const wanted = pack2.leaves.filter((leaf) => leaf.stable).slice(0, 2).map((leaf) => leaf.id);
  const got = readLeavesById(dir2, [...wanted, 'stale-id']);
  ok(got.length === wanted.length + 1, 'read: her id için satır döner');
  ok(got.slice(0, wanted.length).every((row) => row.text && !row.error), 'read: kararlı id\'ler tam metin döndürür');
  ok(Boolean(got.at(-1).error), 'read: bilinmeyen id hata alanıyla işaretlenir');
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ── 9: ask / path / report ─────────────────────────────────────────────────
{
  const dir = makeTree();
  const cevap = askMemory(dir, 'PayTR canlıya alındı mı acaba', { budgetTokens: 400 });
  ok(cevap.seeds.length > 0, 'ask: gevşetme merdiveniyle tohum bulunur');
  ok(/PayTR canlıya alındı/.test(cevap.markdown), 'ask: cevap yaprağın tam metnini içerir');
  ok(cevap.tokensApprox <= 400, 'ask: bütçe aşılmaz');
  const bos = askMemory(dir, 'zzz-hicbir-yerde-yok-qqq', {});
  ok(bos.seeds.length === 0 && /kaydedilmemiş/.test(bos.markdown), 'ask: bilinmeyen konuda uydurma yok');

  const yol = pathBetween(dir, 'PayTR', 'apm_ anahtar');
  ok(!yol.error && yol.path.length >= 2, 'path: iki kavram arası zincir bulunur');
  ok(yol.path.some((step) => step.via === 'bkz'), 'path: zincir açık bkz adımından geçer');
  const ayni = pathBetween(dir, 'PayTR', 'PayTR');
  ok(ayni.path.length === 1, 'path: aynı yaprak tek adım döner');

  const pack = loadPack(dir);
  const rapor = buildReport(pack, (await import('./lib/graph-intel.mjs')).detectCommunities(pack));
  ok(rapor.includes('URDR'), 'report: üretiliyor');
  ok(buildReport(pack, (await import('./lib/graph-intel.mjs')).detectCommunities(pack)) === rapor, 'report: deterministik');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${passed} Rock 7 tests passed`);
