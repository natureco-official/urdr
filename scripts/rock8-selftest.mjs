#!/usr/bin/env node
/**
 * rock8-selftest.mjs — token-autopsy tezgâhının kanıtı.
 *
 * Sentetik bir Claude Code dökümü (JSONL) kurar ve otopsinin her israf
 * tanımını bilinen değerlere karşı doğrular: usage toplamları, araç bazında
 * sayım, değişmemiş/değişmiş dosyada tekrar okuma israfı, cerrahi oran,
 * bozuk satır dayanıklılığı ve dizin toplama davranışı.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSession, collectTranscripts, contentChars, estimateTokens } from './token-autopsy.mjs';

let testCount = 0;
function ok(condition, label) {
  testCount++;
  assert.ok(condition, label);
  console.log(`  ✓ ${label}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock8-'));
try {
  // ── sentetik döküm ────────────────────────────────────────────────────────
  // Kurgu: A dosyası okunur (1000 karakter), değişmeden tekrar okunur (1000
  // karakter → tamamı israf). B dosyası okunur (800), 120 karakteri yeni olan
  // bir Edit yapılır (old 80 + new 120), sonra tekrar okunur (840 → israf
  // 840-120=720). Bash bir kez 400 karakter döker. Bir satır bozuk JSON'dur.
  const asst = (id, name, input, usage) => JSON.stringify({
    type: 'assistant',
    message: {
      usage,
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
  const result = (id, text) => JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
  const resultArr = (id, text) => JSON.stringify({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result', tool_use_id: id,
        content: [{ type: 'text', text }, { type: 'image', source: {} }],
      }],
    },
  });
  const u = (out, inp, cr, cw) => ({ output_tokens: out, input_tokens: inp, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

  const A = '/proje/a.js', B = '/proje/b.js';
  const lines = [
    asst('t1', 'Read', { file_path: A }, u(10, 5, 100, 20)),
    result('t1', 'x'.repeat(1000)),
    asst('t2', 'Read', { file_path: A }, u(10, 5, 200, 0)),      // değişmedi → 1000 israf
    result('t2', 'x'.repeat(1000)),
    asst('t3', 'Read', { file_path: B }, u(10, 5, 300, 0)),
    resultArr('t3', 'y'.repeat(800)),                              // dizi biçimli içerik + görsel
    asst('t4', 'Edit', { file_path: B, old_string: 'o'.repeat(80), new_string: 'n'.repeat(120) }, u(10, 5, 400, 0)),
    result('t4', 'edited ok'),                                     // 9 karakter
    'BOZUK SATIR — JSON değil {{{',                                // parse hatası yutulmalı
    asst('t5', 'Read', { file_path: B }, u(10, 5, 500, 0)),        // değişti → 840-120=720 israf
    result('t5', 'z'.repeat(840)),
    asst('t6', 'Bash', { command: 'npm test' }, u(10, 5, 600, 0)),
    result('t6', 'b'.repeat(400)),
  ];
  const transcript = path.join(dir, 'session-1.jsonl');
  fs.writeFileSync(transcript, lines.join('\n') + '\n');

  const r = await analyzeSession(transcript);

  // ── usage toplamları (gerçek alanlar) ────────────────────────────────────
  assert.equal(r.usage.requests, 6);
  assert.equal(r.usage.out, 60);
  assert.equal(r.usage.freshIn, 30);
  assert.equal(r.usage.cacheRead, 2100);
  assert.equal(r.usage.cacheWrite, 20);
  ok(true, 'usage toplamları: 6 istek, out=60, taze=30, önbellek okuma=2100, yazma=20');

  // ── araç bazında sayım ────────────────────────────────────────────────────
  assert.equal(r.perTool.get('Read').calls, 4);
  assert.equal(r.perTool.get('Read').chars, 1000 + 1000 + 800 + 840);
  assert.equal(r.perTool.get('Bash').chars, 400);
  assert.equal(r.perTool.get('Edit').chars, 'edited ok'.length);
  ok(true, 'araç bazında: Read 4 çağrı/3640 karakter, Bash 400, Edit 9');

  // ── tekrar okuma israfı ───────────────────────────────────────────────────
  // A: değişmeden tekrar → 1000. B: arada 120 yeni karakter → 840-120=720.
  assert.equal(r.repeatWaste, 1000 + 720);
  ok(true, 'tekrar israfı: değişmemişte tamamı (1000), değişmişte yeni düşülür (720)');

  // ── cerrahi oran ─────────────────────────────────────────────────────────
  // Yalnız B okunup düzenlendi: ilk okuma 800, dokunulan 80+120=200 → 4.0×
  assert.equal(r.surgicalRead, 800);
  assert.equal(r.surgicalTouch, 200);
  assert.equal(r.editedFileCount, 1);
  ok(true, 'cerrahi oran: yalnız düzenlenen dosya sayılır (800/200 = 4.0×)');

  // ── keşif ve içerik biçimleri ────────────────────────────────────────────
  assert.equal(r.exploreChars, 400);
  assert.equal(contentChars([{ type: 'text', text: 'ab' }, { type: 'image' }]), 2);
  assert.equal(contentChars('abcd'), 4);
  assert.equal(contentChars(null), 0);
  ok(true, 'keşif=Bash(400); içerik dizi/dize/null biçimleri doğru sayılır');

  // ── dayanıklılık: bozuk satır süreci düşürmedi, toplam karakter doğru ────
  assert.equal(r.toolResultChars, 3640 + 9 + 400);
  assert.equal(estimateTokens(r.toolResultChars), Math.round(4049 / 4));
  ok(true, 'bozuk JSONL satırı yutulur; toplam karakter ve token yaklaşımı doğru');

  // ── collectTranscripts: dizin + eşik + sıralama ──────────────────────────
  fs.writeFileSync(path.join(dir, 'kucuk.jsonl'), 'x');
  fs.writeFileSync(path.join(dir, 'ikinci.jsonl'), 'y'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'degil.txt'), 'z'.repeat(9000));
  const all = collectTranscripts([dir]);
  assert.deepEqual(all.map((t) => path.basename(t.path)).sort(),
    ['ikinci.jsonl', 'kucuk.jsonl', 'session-1.jsonl']);
  assert.ok(all[0].size >= all[1].size && all[1].size >= all[2].size, 'boyuta göre azalan sıra');
  const filtered = collectTranscripts([dir], { minBytes: 2000 });
  assert.ok(filtered.every((t) => t.size >= 2000) && filtered.length === 2);
  ok(true, 'collectTranscripts: yalnız .jsonl, boyut eşiği ve azalan sıralama çalışır');

  // ── boş usage'lı oturum istek saymaz ─────────────────────────────────────
  const empty = path.join(dir, 'ikinci.jsonl');   // usage alanı olmayan sahte içerik
  const rEmpty = await analyzeSession(empty);
  assert.equal(rEmpty.usage.requests, 0);
  assert.equal(rEmpty.toolResultChars, 0);
  ok(true, 'usage içermeyen döküm: 0 istek, 0 araç karakteri (çökmez)');

  console.log(`\n  ${testCount} Rock 8 tests passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
