#!/usr/bin/env node
/**
 * rock10-selftest.mjs — urdr_watch + urdr_delta kanıtı (v1.3).
 *
 * Sözleşme: "son baktığımdan beri ne değişti?" sorusu, kod tabanının değil
 * değişikliğin boyu kadar token'a cevaplanır; hunk'lar BİREBİR metindir,
 * asla özet değildir; hapsetme watch köküne bağlıdır; taban rapor sonrası
 * tazelenir; dev fark parka gider, kırpılmaz.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from './mcp-server.mjs';
import { createSessionLedger } from './lib/context-tax.mjs';
import {
  computeHunks, createWatchRegistry, deltaPaths, watchPaths,
  MAX_WATCH_FILE_BYTES,
} from './lib/file-watch.mjs';

let testCount = 0;
function ok(condition, label) {
  testCount++;
  assert.ok(condition, label);
  console.log(`  ✓ ${label}`);
}

const templates = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const serveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock10-'));
const memory = path.join(serveRoot, 'memory');
const code = path.join(serveRoot, 'code');
fs.mkdirSync(memory, { recursive: true });
fs.mkdirSync(path.join(code, 'src'), { recursive: true });
for (const file of ['root-0-index.md', 'root-1-topics.md', 'root-2-technical.md', 'root-3-decisions.md']) {
  fs.copyFileSync(path.join(templates, file), path.join(memory, file));
}

try {
  // ── 1. computeHunks: orta bölge değişikliği birebir çıkar ────────────────
  const oldText = ['a', 'b', 'c', 'd', 'e'].join('\n');
  const newText = ['a', 'b', 'X', 'Y', 'd', 'e'].join('\n');
  const hunks = computeHunks(oldText, newText);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], { oldStart: 3, newStart: 3, removed: ['c'], added: ['X', 'Y'] });
  assert.deepEqual(computeHunks(oldText, oldText), []);
  ok(true, 'computeHunks: tek hunk, 1-tabanlı satır, birebir removed/added; özdeş metin → []');

  // ── 2. birden çok ayrık hunk + salt ekleme/salt silme ────────────────────
  const multi = computeHunks('1\n2\n3\n4\n5\n6\n7', '1\nİKİ\n3\n4\n5\n6\n7\n8');
  assert.equal(multi.length, 2);
  assert.deepEqual(multi[0], { oldStart: 2, newStart: 2, removed: ['2'], added: ['İKİ'] });
  assert.deepEqual(multi[1], { oldStart: 8, newStart: 8, removed: [], added: ['8'] });
  const pureDelete = computeHunks('k\nl\nm', 'k\nm');
  assert.deepEqual(pureDelete, [{ oldStart: 2, newStart: 2, removed: ['l'], added: [] }]);
  ok(true, 'ayrık hunk\'lar, salt-ekleme ve salt-silme doğru sınırlarla ayrışır');

  // ── 3. LCS bütçe aşımı: kaba hunk, yine birebir, itiraf bayraklı ─────────
  const bigA = Array.from({ length: 3000 }, (_, i) => `satır ${i} A`).join('\n');
  const bigB = Array.from({ length: 3000 }, (_, i) => `satır ${i} B`).join('\n');
  const coarse = computeHunks(bigA, bigB);
  assert.equal(coarse.length, 1);
  assert.equal(coarse[0].coarse, true);
  assert.equal(coarse[0].removed.length, 3000);
  assert.equal(coarse[0].added.length, 3000);
  assert.equal(coarse[0].removed.join('\n'), bigA, 'kaba hunk bile birebir metindir — özet yok');
  ok(true, 'LCS bütçesini aşan fark tek kaba hunk olarak birebir döner (coarse:true itirafıyla)');

  // ── 4. watch: damga kaydı + hapsetme ─────────────────────────────────────
  fs.writeFileSync(path.join(code, 'src', 'app.js'), 'const x = 1;\nconst y = 2;\nexport { x, y };\n');
  fs.writeFileSync(path.join(code, 'notes.md'), 'birinci\nikinci\n');
  const registry = createWatchRegistry();
  const watched = watchPaths(registry, code, ['src/app.js', 'notes.md']);
  assert.equal(watched.watched.length, 2);
  assert.match(watched.watched[0].stamp, /^[0-9a-f]{12}$/);
  assert.equal(watched.watchedCount, 2);
  const escape = watchPaths(registry, code, ['../memory/root-0-index.md', '/etc/hosts']);
  assert.equal(escape.watched.length, 0);
  assert.equal(escape.errors.length, 2);
  ok(true, 'urdr_watch: damgalar kayıtlı; traversal ve mutlak yol dosya-bazında reddedilir');

  // ── 5. delta: değişmemiş dosya tek satır maliyetinde ─────────────────────
  const quiet = deltaPaths(registry, code, undefined);
  assert.equal(quiet.summary.unchanged, 2);
  assert.equal(quiet.summary.changed, 0);
  assert.ok(quiet.entries.every((entry) => entry.status === 'unchanged' && entry.stamp));
  ok(true, 'urdr_delta: değişmemiş izlenenler yalnız durum satırı taşır');

  // ── 6. değişiklik: yalnız değişen aralık döner, taban tazelenir ──────────
  fs.writeFileSync(path.join(code, 'src', 'app.js'), 'const x = 1;\nconst y = 99;\nconst z = 3;\nexport { x, y, z };\n');
  const changed = deltaPaths(registry, code, undefined);
  assert.equal(changed.summary.changed, 1);
  const entry = changed.entries.find((e) => e.path === 'src/app.js');
  assert.equal(entry.status, 'changed');
  assert.equal(entry.removedLines, 2);
  assert.equal(entry.addedLines, 3);
  assert.deepEqual(entry.hunks[0].removed, ['const y = 2;', 'export { x, y };']);
  assert.deepEqual(entry.hunks[0].added, ['const y = 99;', 'const z = 3;', 'export { x, y, z };']);
  const rebased = deltaPaths(registry, code, ['src/app.js']);
  assert.equal(rebased.entries[0].status, 'unchanged', 'rapor tabanı tazeler — ardışık delta artımlıdır');
  ok(true, 'değişen dosya yalnız hunk\'larını taşır; taban rapor sonrası tazelenir');

  // ── 7. silinen dosya bildirilir ve defterden düşer ───────────────────────
  fs.rmSync(path.join(code, 'notes.md'));
  const afterDelete = deltaPaths(registry, code, undefined);
  assert.equal(afterDelete.entries.find((e) => e.path === 'notes.md').status, 'deleted');
  assert.equal(afterDelete.summary.watched, 1, 'silinen dosya defterden düşer');
  const unwatchedProbe = deltaPaths(registry, code, ['notes.md']);
  assert.equal(unwatchedProbe.entries[0].status, 'unwatched');
  ok(true, 'silinen dosya deleted olarak bildirilir, defterden düşer; sonrası unwatched');

  // ── 8. tavanlar: dev dosya ve ikili dosya dosya-bazında reddedilir ───────
  fs.writeFileSync(path.join(code, 'huge.txt'), 'x'.repeat(MAX_WATCH_FILE_BYTES + 1));
  fs.writeFileSync(path.join(code, 'binary.bin'), Buffer.from([1, 2, 0, 3]));
  const capped = watchPaths(registry, code, ['huge.txt', 'binary.bin', 'src/app.js']);
  assert.equal(capped.watched.length, 1);
  assert.match(capped.errors.find((e) => e.path === 'huge.txt').error, /MB watch limit/);
  assert.match(capped.errors.find((e) => e.path === 'binary.bin').error, /binary/);
  assert.throws(() => watchPaths(registry, code, []), /1\.\.64/);
  ok(true, 'dosya boyu/ikili içerik tavanları dosya-bazında; boş paths çağrısı reddedilir');

  // ── 9. MCP yolu: executeTool üzerinden uçtan uca + hiç izlenmemişken ipucu ─
  const ledger = createSessionLedger();
  const watch = { registry: createWatchRegistry(), root: code };
  const empty = executeTool(serveRoot, 'urdr_delta', { memoryDir: 'memory' }, ledger, watch);
  assert.match(empty.hint, /urdr_watch/);
  executeTool(serveRoot, 'urdr_watch', { memoryDir: 'memory', paths: ['src/app.js'] }, ledger, watch);
  fs.appendFileSync(path.join(code, 'src', 'app.js'), 'const w = 4;\n');
  const viaMcp = executeTool(serveRoot, 'urdr_delta', { memoryDir: 'memory' }, ledger, watch);
  assert.equal(viaMcp.summary.changed, 1);
  assert.deepEqual(viaMcp.entries[0].hunks.at(-1).added.filter((l) => l.includes('const w')), ['const w = 4;']);
  assert.throws(() => executeTool(serveRoot, 'urdr_watch', { memoryDir: 'memory', paths: ['src/app.js'] }, ledger, null),
    /watch registry/);
  ok(true, 'MCP yolu: watch→edit→delta zinciri; watch bağlamı yokken dürüst hata');

  // ── 10. dev delta cevabı kırpılmaz, spool'a park edilir ──────────────────
  const bulk = Array.from({ length: 400 }, (_, i) => `eski içerik satırı ${i}`).join('\n');
  fs.writeFileSync(path.join(code, 'src', 'bulk.js'), bulk);
  executeTool(serveRoot, 'urdr_watch', { memoryDir: 'memory', paths: ['src/bulk.js'] }, ledger, watch);
  fs.writeFileSync(path.join(code, 'src', 'bulk.js'),
    Array.from({ length: 400 }, (_, i) => `yepyeni içerik satırı ${i} — tamamen farklı`).join('\n'));
  const parked = executeTool(serveRoot, 'urdr_delta', { memoryDir: 'memory', maxReplyTokens: 200 }, ledger, watch);
  assert.equal(parked.spooled, true);
  assert.match(parked.ref, /^spool:[0-9a-f]{16}$/);
  const fetched = executeTool(serveRoot, 'urdr_fetch', { memoryDir: 'memory', ref: parked.ref, fromLine: 1, toLine: 100000 }, ledger, watch);
  const parkedBody = JSON.parse(fetched.text);
  assert.equal(parkedBody.summary.changed, 1);
  assert.equal(parkedBody.entries.find((e) => e.path === 'src/bulk.js').removedLines, 400);
  ok(true, 'bütçeyi aşan delta parka gider; tam gövde urdr_fetch ile birebir geri gelir');

  console.log(`\n  ${testCount} Rock 10 tests passed`);
} finally {
  fs.rmSync(serveRoot, { recursive: true, force: true });
}
