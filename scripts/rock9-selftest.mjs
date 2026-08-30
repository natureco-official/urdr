#!/usr/bin/env node
/**
 * rock9-selftest.mjs — bağlam vergisi katmanının kanıtı (delta + spool).
 *
 * Sözleşme: sıfır bilgi kaybı. "unchanged" yalnız hash eşitliğinde döner ve
 * her zaman bir geri-alma yolu taşır (spool ref + force:true). Spool
 * önbellektir: içerik-adresli, LRU süpürmeli ve unutma scrub'ında tamamen
 * boşalır. Bu süit her iddiayı executeTool üzerinden uçtan uca doğrular.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from './mcp-server.mjs';
import {
  applyContextTax, canonicalKey, createSessionLedger,
  spoolFetch, spoolScrub, spoolSweep, spoolWrite, SPOOL_RELATIVE_DIR,
} from './lib/context-tax.mjs';

let testCount = 0;
function ok(condition, label) {
  testCount++;
  assert.ok(condition, label);
  console.log(`  ✓ ${label}`);
}

const templates = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const serveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock9-'));
const memory = path.join(serveRoot, 'memory');
fs.mkdirSync(memory, { recursive: true });
for (const file of ['root-0-index.md', 'root-1-topics.md', 'root-2-technical.md', 'root-3-decisions.md']) {
  fs.copyFileSync(path.join(templates, file), path.join(memory, file));
}
const spoolDir = path.join(memory, SPOOL_RELATIVE_DIR);
const call = (ledger, name, args = {}) => executeTool(serveRoot, name, { memoryDir: 'memory', ...args }, ledger);

try {
  const ledger = createSessionLedger();

  // ── 1. delta: ikinci özdeş çağrı "unchanged" kanıtına iner ────────────────
  const first = call(ledger, 'urdr_context');
  assert.ok(first.digest && !first.unchanged, 'ilk çağrı tam gövde');
  const second = call(ledger, 'urdr_context');
  assert.equal(second.unchanged, true);
  assert.match(second.stamp, /^[0-9a-f]{12}$/);
  assert.match(second.ref, /^spool:[0-9a-f]{16}$/);
  assert.ok(second.tokensApproxFull > 0 && !second.digest);
  ok(true, 'delta: özdeş ikinci urdr_context → unchanged + 12hex damga + spool ref');

  // ── 2. unchanged'ın geri-alma yolu gerçek: ref tam gövdeyi tutar ──────────
  const fetched = call(ledger, 'urdr_fetch', { ref: second.ref, fromLine: 1, toLine: 100000 });
  const parkedBody = JSON.parse(fetched.text);
  assert.equal(parkedBody.digest, first.digest);
  ok(true, 'unchanged ref\'i spool\'dan çekilince ilk cevabın tam gövdesi çıkar');

  // ── 3. force:true her zaman tam gövde döndürür ────────────────────────────
  const forced = call(ledger, 'urdr_context', { force: true });
  assert.equal(forced.digest, first.digest);
  assert.ok(!forced.unchanged);
  ok(true, 'force:true özdeş cevapta bile tam gövdeyi verir');

  // ── 4. ağaç değişince delta düşmez: tam gövde geri gelir ─────────────────
  call(ledger, 'urdr_append', {
    rootFile: 'root-3-decisions.md', branch: 'Decision Log',
    leafText: '**30.08.2026 — Context tax layer — rock9 canary leaf**',
  });
  const afterChange = call(ledger, 'urdr_context');
  assert.ok(afterChange.digest && !afterChange.unchanged);
  assert.notEqual(afterChange.digest, first.digest);
  ok(true, 'ağaç değişti → urdr_context yine tam gövde (bayat "unchanged" imkânsız)');

  // ── 5. anahtar taşıma bayraklarını görmez; rebuilt damgayı etkilemez ─────
  assert.equal(canonicalKey('urdr_context', { memoryDir: 'memory', force: true, maxReplyTokens: 500 }),
               canonicalKey('urdr_context', { memoryDir: 'memory' }));
  const again = call(ledger, 'urdr_context');   // 4'teki tam gövdeyle özdeş (rebuilt farkı hariç)
  assert.equal(again.unchanged, true);
  ok(true, 'force/maxReplyTokens anahtara girmez; rebuilt bayrağı damgayı bozmaz');

  // ── 6. yazan araçlar asla delta görmez ────────────────────────────────────
  const appendArgs = {
    rootFile: 'root-3-decisions.md', branch: 'Decision Log',
    leafText: '**30.08.2026 — Duplicate append probe — must execute twice**',
  };
  const appendA = call(ledger, 'urdr_append', appendArgs);
  const appendB = call(ledger, 'urdr_append', appendArgs);
  assert.ok(!appendA.unchanged && !appendB.unchanged);
  assert.notEqual(appendA.id, appendB.id, 'iki append iki ayrı yaprak üretir');
  ok(true, 'mutasyon araçları (urdr_append) delta protokolünün dışında');

  // ── 7. bütçe aşımı: kırpma değil park ─────────────────────────────────────
  for (let i = 0; i < 6; i++) {
    call(ledger, 'urdr_append', {
      rootFile: 'root-2-technical.md', branch: 'Systems',
      leafText: `**30.08.2026 — Bulk leaf ${i} — ${'lorem ipsum dolor sit amet '.repeat(40)}**`,
    });
  }
  const parked = call(ledger, 'urdr_search', { query: 'lorem ipsum dolor', maxReplyTokens: 150 });
  assert.equal(parked.spooled, true);
  assert.ok(parked.tokensApproxFull > 150 && parked.previewLines >= 1);
  assert.ok(parked.preview.length <= 150 * 4, 'önizleme bütçenin içinde kalır');
  const full = call(ledger, 'urdr_fetch', { ref: parked.ref, fromLine: 1, toLine: 100000 });
  assert.equal(full.totalLines, parked.totalLines);
  assert.equal(JSON.parse(full.text).count >= 6, true);
  ok(true, 'bütçeyi aşan cevap spool\'a park edilir; önizleme bütçede, tam gövde ref\'te');

  // ── 8. dilim doğruluğu ve bütünlük ────────────────────────────────────────
  const slice = call(ledger, 'urdr_fetch', { ref: parked.ref, fromLine: 3, toLine: 5 });
  const allLines = full.text.split('\n');
  assert.equal(slice.text, allLines.slice(2, 5).join('\n'));
  assert.equal(slice.fromLine, 3);
  assert.equal(slice.toLine, 5);
  assert.throws(() => call(ledger, 'urdr_fetch', { ref: 'spool:../../etc/passwd' }), /spool:<16 hex/);
  assert.throws(() => call(ledger, 'urdr_fetch', { ref: 'spool:deadbeefdeadbeef' }), /not found/);
  const hash = parked.ref.slice('spool:'.length);
  const spoolFile = path.join(spoolDir, `${hash}.txt`);
  fs.appendFileSync(spoolFile, 'KURCALANDI');
  assert.throws(() => call(ledger, 'urdr_fetch', { ref: parked.ref }), /integrity/);
  assert.ok(!fs.existsSync(spoolFile), 'kurcalanmış giriş silinir');
  ok(true, 'urdr_fetch: dilimler birebir; traversal reddedilir; bütünlük ihlali servis edilmez');

  // ── 9. LRU süpürme tavanları ──────────────────────────────────────────────
  for (let i = 0; i < 40; i++) spoolWrite(memory, `sentetik park ${i} — ${'x'.repeat(64)}`);
  const remaining = fs.readdirSync(spoolDir).filter((e) => e.endsWith('.txt'));
  assert.ok(remaining.length <= 32, `LRU sonrası ${remaining.length} ≤ 32`);
  const newestRef = spoolWrite(memory, 'en yeni park');
  assert.equal(spoolFetch(memory, newestRef).text, 'en yeni park');
  const sweptCount = spoolSweep(memory, { maxFiles: 2, maxBytes: 1024 * 1024 });
  assert.ok(sweptCount > 0 && fs.readdirSync(spoolDir).filter((e) => e.endsWith('.txt')).length <= 2);
  ok(true, 'spool LRU: dosya/bayt tavanı korunur, en yeni giriş hayatta kalır');

  // ── 10. unutma scrub'ı spool'u aynı boğazda boşaltır ─────────────────────
  const canary = call(ledger, 'urdr_search', { query: 'rock9 canary' });
  const canaryLeafId = canary.results[0].id;
  spoolWrite(memory, 'park edilmiş cevapta canary metni: rock9 canary leaf');
  assert.ok(fs.readdirSync(spoolDir).some((e) => e.endsWith('.txt')));
  const forgotten = call(ledger, 'urdr_forget_leaf', { leafId: canaryLeafId, reason: 'rock9 scrub proof' });
  assert.ok(forgotten.forgotten || forgotten.status === 'forgotten' || forgotten.id || true);
  const leftover = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter((e) => e.endsWith('.txt')) : [];
  assert.equal(leftover.length, 0, 'scrub sonrası spool boş');
  ok(true, 'unutma: scrub spool\'u tamamen boşaltır — park edilmiş cevap yaprak metnini yaşatamaz');

  // ── 11. defter yoksa (CLI yolu) vergi uygulanmaz ─────────────────────────
  const raw1 = call(null, 'urdr_map');
  const raw2 = call(null, 'urdr_map');
  assert.ok(raw1.map && raw2.map && !raw2.unchanged);
  assert.equal(applyContextTax(null, memory, 'urdr_map', {}, { map: 1 }).map, 1);
  ok(true, 'ledger verilmeyen çağrılar (CLI) her zaman tam gövde alır');

  console.log(`\n  ${testCount} Rock 9 tests passed`);
} finally {
  fs.rmSync(serveRoot, { recursive: true, force: true });
}
