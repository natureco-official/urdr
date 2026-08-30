#!/usr/bin/env node
/**
 * context-bench.mjs — "kanıt, vaat değil": Bağlam Paketi'nin token ekonomisi.
 *
 * Sentetik ama gerçekçi ağaçlar kurar (tarihli yapraklar, bkz: çaprazları,
 * Türkçe/İngilizce karışık metin) ve AYNI görevlerin maliyetini iki
 * protokolde ölçer:
 *
 *   ESKİ  oturum başı : root-0 + root-3 + agent-personality + architecture.md tam okuma
 *   YENİ  oturum başı : tek urdr_context çağrısının döndürdüğü digest
 *   ESKİ  tekil sorgu : "hiyerarşi önce" — ilgili kök dosyasının tamamı
 *   YENİ  tekil sorgu : urdr_search sonucu + 2 yaprağın urdr_read tam metni
 *
 * Token kestirimi chars/4'tür ve raporda açıkça böyle etiketlenir; bench
 * kendi zayıf noktasını gizlemez (Urðr geleneği: ISSUES.md kültürü).
 *
 *   node scripts/context-bench.mjs            # üç ölçek: 1.1k / 4.5k / 9k yaprak
 *   node scripts/context-bench.mjs --json     # makine okunur çıktı
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack, estimateTokens, readLeavesById, writePack } from './lib/context-pack.mjs';
import { searchMemory } from './search.mjs';

const KONULAR = [
  'PayTR webhook tutar doğrulaması', 'Cloudflare Pages dağıtım damgası',
  'Supabase RLS politikası', 'kontenjan advisory lock', 'MCP stdio el sıkışması',
  'IndexNow anahtar dosyası', 'e-Fatura entegrasyon taslağı', 'DMARC hizalaması',
  'forklift envanter kartı', 'sözleşme onay akışı', 'retention scrub sınırı',
  'trigram araması Türkçe ekler', 'event log jenerasyon işaretçisi',
];
const SONUCLAR = [
  'canlıda doğrulandı', 'geri alındı', 'runbook’a işlendi', 'testle sabitlendi',
  'ertelendi — sebep not edildi', 'müşteriyle teyit edildi', 'ölçüm bekliyor',
];

function pad2(n) { return String(n).padStart(2, '0'); }

/** Deterministik sözde-rastgele (sabit tohum) — bench tekrar üretilebilir. */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export function buildSyntheticTree(directory, { roots, branchesPerRoot, leavesPerBranch, seed = 42 }) {
  const rng = makeRng(seed);
  fs.mkdirSync(directory, { recursive: true });
  const rootNames = [];
  for (let r = 0; r < roots; r++) {
    const file = r === 0 ? 'root-0-index.md' : `root-${r}-alan${r}.md`;
    rootNames.push(file);
    const lines = [`# Kök ${r}`, ''];
    for (let b = 0; b < branchesPerRoot; b++) {
      lines.push(`## Dal ${r}.${b}`, '');
      for (let l = 0; l < leavesPerBranch; l++) {
        const day = pad2(1 + Math.floor(rng() * 28));
        const month = pad2(1 + Math.floor(rng() * 12));
        const topic = KONULAR[Math.floor(rng() * KONULAR.length)];
        const outcome = SONUCLAR[Math.floor(rng() * SONUCLAR.length)];
        const cross = rng() < 0.12 ? ` (bkz: root-${Math.floor(rng() * roots)} / Dal ${Math.floor(rng() * roots)}.${Math.floor(rng() * branchesPerRoot)})` : '';
        lines.push(`**${day}.${month}.2026 — ${topic} — ${outcome}**${cross}`,
          `  Bağlam: ${topic} işi ${outcome}; karar gerekçesi ve alternatifler not edildi. Ek ayrıntı satırı ${l}.`, '');
      }
    }
    fs.writeFileSync(path.join(directory, file), lines.join('\n'));
  }
  // Eski protokolün okuttuğu sabit dosyalar (gerçek depo boyutlarıyla)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixed = {
    'agent-personality.md': path.join(here, '..', 'templates', 'agent-personality.md'),
    'architecture.md': path.join(here, '..', 'protocols', 'architecture.md'),
  };
  const fixedBytes = {};
  for (const [name, source] of Object.entries(fixed)) {
    try { fixedBytes[name] = fs.statSync(source).size; } catch { fixedBytes[name] = 0; }
  }
  return { rootNames, fixedBytes };
}

function measureScale(label, shape) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-bench-'));
  try {
    const { rootNames, fixedBytes } = buildSyntheticTree(directory, shape);
    const bytesOf = (file) => fs.statSync(path.join(directory, file)).size;

    // ESKİ oturum başı: kök-0 + kök-3 (varsa) + kişilik + mimari
    const oldSession = bytesOf(rootNames[0])
      + (rootNames[3] ? bytesOf(rootNames[3]) : 0)
      + fixedBytes['agent-personality.md'] + fixedBytes['architecture.md'];

    // YENİ oturum başı: digest
    const t0 = process.hrtime.bigint();
    const pack = buildPack(directory);
    const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
    writePack(directory, pack);
    const newSession = pack.digest.length;

    // ESKİ tekil sorgu: alan kökünün tamamı (hiyerarşi-önce dosya okuması)
    const domainRoot = rootNames[Math.min(2, rootNames.length - 1)];
    const oldLookup = bytesOf(domainRoot);

    // YENİ tekil sorgu: arama sonucu + 2 yaprak tam metni
    const search = searchMemory(directory, 'PayTR webhook tutar', { maxResults: 5 });
    const searchChars = JSON.stringify(search.results).length;
    const ids = pack.leaves.filter((leaf) => /PayTR webhook/.test(leaf.headline)).slice(0, 2).map((leaf) => leaf.id);
    const readChars = JSON.stringify(readLeavesById(directory, ids)).length;
    const newLookup = searchChars + readChars;

    return {
      label,
      shape,
      leaves: pack.leaves.length,
      edges: pack.edges.length,
      buildMs: Math.round(buildMs),
      sessionOldTokens: estimateTokens(' '.repeat(oldSession)),
      sessionNewTokens: estimateTokens(pack.digest),
      sessionFactor: null, // aşağıda
      lookupOldTokens: Math.ceil(oldLookup / 4),
      lookupNewTokens: Math.ceil(newLookup / 4),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function run() {
  const scales = [
    ['olgun (4 kök)', { roots: 4, branchesPerRoot: 7, leavesPerBranch: 40 }],
    ['büyük (10 kök)', { roots: 10, branchesPerRoot: 9, leavesPerBranch: 50 }],
    ['devasa (12 kök)', { roots: 12, branchesPerRoot: 10, leavesPerBranch: 75 }],
  ];
  const rows = scales.map(([label, shape]) => {
    const row = measureScale(label, shape);
    row.sessionFactor = Math.round(row.sessionOldTokens / row.sessionNewTokens);
    row.lookupFactor = Math.round(row.lookupOldTokens / row.lookupNewTokens);
    return row;
  });
  return rows;
}

const isMain = (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
})();

if (isMain) {
  const rows = run();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('Bağlam Paketi ölçümü — token ≈ karakter/4 (belgelenmiş yaklaşıklık)\n');
    console.log('  ölçek            yaprak  derleme  oturum eski→yeni       kazanç   sorgu eski→yeni      kazanç');
    for (const row of rows) {
      console.log(`  ${row.label.padEnd(16)} ${String(row.leaves).padStart(6)}  ${String(row.buildMs).padStart(5)}ms  ${String(row.sessionOldTokens).padStart(7)} → ${String(row.sessionNewTokens).padStart(4)}   ${String(row.sessionFactor).padStart(6)}×   ${String(row.lookupOldTokens).padStart(6)} → ${String(row.lookupNewTokens).padStart(4)}   ${String(row.lookupFactor).padStart(5)}×`);
    }
    console.log('\n  Dürüstlük notları:');
    console.log('  - "eski oturum" = kök-0 + kök-3 + kişilik + mimari dosyalarının ham boyutu.');
    console.log('  - "yeni sorgu" arama sonucu + 2 yaprak tam metnidir; derin işlerde yaprak sayısı artar.');
    console.log('  - Sentetik yapraklar ~2 satırdır; uzun yapraklı ağaçlarda ESKİ maliyet daha da büyür.');
  }
}
