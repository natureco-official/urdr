#!/usr/bin/env node
/**
 * write-bench.mjs — danışma sıralamasının tekrar-üretilebilir doğruluk ölçümü.
 *
 *   node scripts/write-bench.mjs --root <dir>
 *
 * Leave-one-out: ağaçtaki her yaprak tek tek "yeni taslak" muamelesi görür,
 * kendi dalı aday havuzundan çıkarılır ve gemideki advisoryRanking'e sorulur.
 * Yayınlanan rakamlar (top-1 %23.9 / top-5 %56.9, gerçek 111 yapraklı ağaç)
 * bu betikle herkes tarafından kendi ağacında yeniden ölçülebilir — danışma
 * sıralamasına güvenmeden önce çıtayı kendin gör.
 *
 * Reddedilen otomatik-yazma çözümleyicisinin geri gelme çıtası da budur:
 * top-1 ≥ %90'ı burada geçemeyen hiçbir skorlayıcı karar makamı olamaz.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPack, readLeavesById } from './lib/context-pack.mjs';

const tokenize = (text) => [...String(text).toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)].map((m) => m[0]);
const stem = (word) => (word.length > 5 ? word.slice(0, 5) : word);

/** Gemideki skorlayıcının leave-one-out değerlendirmesi (deterministik). */
export function evaluateTree(memoryDir) {
  const pack = loadPack(memoryDir);
  const texts = new Map();
  for (let i = 0; i < pack.leaves.length; i += 32) {
    for (const leaf of readLeavesById(memoryDir, pack.leaves.slice(i, i + 32).map((l) => l.id))) {
      if (!leaf.error) texts.set(leaf.id, leaf.text || '');
    }
  }
  const perLeafWords = new Map(pack.leaves.map((leaf) => [
    leaf.id, new Set(tokenize(texts.get(leaf.id) ?? leaf.headline).map(stem)),
  ]));
  const branches = new Map();
  for (const leaf of pack.leaves) {
    const key = `${leaf.file}::${leaf.branch}`;
    if (!branches.has(key)) branches.set(key, []);
    branches.get(key).push(leaf);
  }
  const documentFrequency = new Map();
  for (const members of branches.values()) {
    const doc = new Set(members.flatMap((leaf) => [...perLeafWords.get(leaf.id)]));
    for (const word of doc) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  }
  const branchCount = branches.size;
  const idf = (word) => Math.log(1 + branchCount / (documentFrequency.get(word) || 1));

  const counters = { top1: 0, top3: 0, top5: 0, rootTop1: 0, total: 0 };
  for (const probe of pack.leaves) {
    const probeWords = perLeafWords.get(probe.id);
    if (probeWords.size < 3) continue;
    const scores = [];
    for (const [key, members] of branches) {
      const others = members.filter((leaf) => leaf.id !== probe.id);
      if (others.length === 0) continue;
      const doc = new Set(others.flatMap((leaf) => [...perLeafWords.get(leaf.id)]));
      const nameWords = new Set(tokenize(key.split('::')[1]).map(stem));
      let score = 0;
      for (const word of probeWords) {
        if (doc.has(word)) score += idf(word);
        if (nameWords.has(word)) score += 2 * idf(word);
      }
      scores.push([score, key]);
    }
    scores.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    const truth = `${probe.file}::${probe.branch}`;
    const rank = scores.findIndex(([, key]) => key === truth);
    counters.total++;
    if (rank === 0) counters.top1++;
    if (rank >= 0 && rank < 3) counters.top3++;
    if (rank >= 0 && rank < 5) counters.top5++;
    if (scores.length && scores[0][1].split('::')[0] === probe.file) counters.rootTop1++;
  }
  const pct = (n) => (counters.total ? Math.round((1000 * n) / counters.total) / 10 : 0);
  return {
    leaves: pack.leaves.length, branches: branchCount, probes: counters.total,
    top1: pct(counters.top1), top3: pct(counters.top3), top5: pct(counters.top5),
    rootTop1: pct(counters.rootTop1),
  };
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf('--root');
  const memoryDir = rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd();
  if (!memoryDir) { console.error('usage: write-bench.mjs --root <dir>'); process.exit(2); }
  const result = evaluateTree(memoryDir);
  console.log(`ağaç: ${result.leaves} yaprak, ${result.branches} dal (${result.probes} deneme)`);
  console.log(`dal doğruluğu:  top-1 ${result.top1}%   top-3 ${result.top3}%   top-5 ${result.top5}%`);
  console.log(`kök doğruluğu:  top-1 ${result.rootTop1}%`);
  console.log('\nHatırlatma: bu sıralama urdr_write_context içinde DANIŞMA niteliğindedir;');
  console.log('karar ajanındır. Otomatik yazmanın geri gelme çıtası: top-1 ≥ %90.');
}
