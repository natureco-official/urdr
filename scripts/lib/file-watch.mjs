/**
 * file-watch.mjs — damgaların hafıza ağacının dışına genişlemesi (v1.3).
 *
 * Kod yazan bir ajanın asıl ihtiyacı "son baktığımdan beri ne değişti?"
 * sorusunun, kod tabanının değil DEĞİŞİKLİĞİN boyu kadar token'a cevabıdır:
 *
 *   urdr_watch(paths)  → dosya başına damga kaydeder (içerik taban alınır)
 *   urdr_delta()       → değişmemiş dosya 1 satır; değişmiş dosya yalnız
 *                        değişen satır aralıkları (hunks) — BİREBİR metin,
 *                        asla özet. Rapor sonrası taban otomatik tazelenir.
 *
 * Sıfır kalite kaybı sözü burada da geçerli: hunk'lar deterministik satır
 * LCS'siyle çıkar; LCS bütçeyi aşan dev orta bölge tek kaba hunk olarak
 * yine BİREBİR döner (coarse:true ile itiraf edilir), asla sessizce
 * özetlenmez. Kayıt defteri oturum-ömürlüdür: yeniden başlatma tabanları
 * unutur, urdr_watch yeniden çağrılır — bayatlık sınıfı doğmaz.
 *
 * Hapsetme: izlenen her yol, sunucu başlangıcında sabitlenen watch köküne
 * (varsayılan: bellek kökü; kod için --watch-root ile bilinçli açılır)
 * resolveConfinedTarget ile bağlanır — traversal imkânsız.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfinedTarget } from '../append.mjs';

export const MAX_WATCH_PATHS_PER_CALL = 64;
export const MAX_WATCH_FILES = 256;
export const MAX_WATCH_FILE_BYTES = 1024 * 1024;        // dosya başına 1 MB
export const MAX_WATCH_TOTAL_BYTES = 16 * 1024 * 1024;  // defter toplamı 16 MB
const LCS_CELL_BUDGET = 4_000_000;                      // ~2000×2000 satır

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export function createWatchRegistry() { return new Map(); }

function registryBytes(registry) {
  let total = 0;
  for (const entry of registry.values()) total += entry.bytes;
  return total;
}

function readWatchedFile(watchRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 1024) {
    throw new Error('path must be a non-empty relative path (max 1024 chars)');
  }
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
    throw new Error('path must be relative to the watch root; traversal is not allowed');
  }
  const { target } = resolveConfinedTarget(watchRoot, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('path is not a regular file');
  if (stat.size > MAX_WATCH_FILE_BYTES) {
    throw new Error(`file exceeds the ${MAX_WATCH_FILE_BYTES / 1024 / 1024} MB watch limit`);
  }
  const buffer = fs.readFileSync(target);
  if (buffer.includes(0)) throw new Error('binary file — line deltas are only meaningful for text');
  const content = buffer.toString('utf8');
  return { content, bytes: buffer.length };
}

/**
 * Yolları izlemeye alır (yeniden çağrı = tabanı tazelemek). Her yol için
 * ya bir damga satırı ya da dosya-özel hata döner; tek bozuk yol çağrının
 * kalanını düşürmez.
 */
export function watchPaths(registry, watchRoot, paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_WATCH_PATHS_PER_CALL) {
    throw new Error(`paths must contain 1..${MAX_WATCH_PATHS_PER_CALL} relative paths`);
  }
  const watched = [];
  const errors = [];
  for (const relativePath of paths) {
    try {
      if (!registry.has(relativePath) && registry.size >= MAX_WATCH_FILES) {
        throw new Error(`watch registry is full (${MAX_WATCH_FILES} files); unwatch by restarting or watch fewer files`);
      }
      const { content, bytes } = readWatchedFile(watchRoot, relativePath);
      const inRegistry = registry.get(relativePath)?.bytes ?? 0;
      if (registryBytes(registry) - inRegistry + bytes > MAX_WATCH_TOTAL_BYTES) {
        throw new Error(`watch registry byte budget exceeded (${MAX_WATCH_TOTAL_BYTES / 1024 / 1024} MB total)`);
      }
      const lines = content.split('\n').length;
      registry.set(relativePath, { content, bytes, lines, hash: sha256(content) });
      watched.push({ path: relativePath, stamp: sha256(content).slice(0, 12), lines, bytes });
    } catch (error) {
      errors.push({ path: String(relativePath).slice(0, 1024), error: error.message });
    }
  }
  return { watched, errors, watchedCount: registry.size };
}

/**
 * Satır bazlı deterministik fark: ortak önek/sonek kırpılır, kalan orta
 * bölge LCS bütçesine sığıyorsa incelikli hunk'lara ayrılır; sığmıyorsa
 * tek kaba hunk (coarse:true) olarak birebir döner. Satır numaraları
 * 1-tabanlıdır; removed/added dizileri BİREBİR metindir.
 */
export function computeHunks(oldText, newText) {
  if (oldText === newText) return [];
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let endA = a.length, endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(prefix, endA);
  const midB = b.slice(prefix, endB);
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > LCS_CELL_BUDGET) {
    return [{
      oldStart: prefix + 1, newStart: prefix + 1,
      removed: midA, added: midB,
      ...(midA.length * midB.length > LCS_CELL_BUDGET ? { coarse: true } : {}),
    }];
  }

  // LCS tablosu (satır eşitliği üzerinden), sonra geri iz sürerek op listesi.
  const rows = midA.length + 1, cols = midB.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * cols + j] = midA[i] === midB[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const hunks = [];
  let current = null;
  let i = 0, j = 0;
  const flush = () => { if (current) { hunks.push(current); current = null; } };
  const touch = () => {
    if (!current) current = { oldStart: prefix + i + 1, newStart: prefix + j + 1, removed: [], added: [] };
  };
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      flush(); i++; j++;
    } else if (j < midB.length && (i >= midA.length || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) {
      touch(); current.added.push(midB[j]); j++;
    } else {
      touch(); current.removed.push(midA[i]); i++;
    }
  }
  flush();
  return hunks;
}

/**
 * İzlenen dosyaların (veya verilen altkümenin) farkını raporlar ve tabanı
 * tazeler: değişmemiş dosya tek satır maliyetindedir, değişmiş dosya yalnız
 * hunk'larının boyu kadar token taşır. Silinen dosya bildirilir ve
 * defterden düşer (yeniden izlemek istenirse urdr_watch).
 */
export function deltaPaths(registry, watchRoot, paths) {
  if (registry.size === 0 && (!paths || paths.length === 0)) {
    return { entries: [], summary: { watched: 0, changed: 0, unchanged: 0, deleted: 0 },
             hint: 'nothing is watched yet — call urdr_watch with relative paths first' };
  }
  const targets = (paths && paths.length > 0) ? paths : [...registry.keys()].sort();
  if (targets.length > MAX_WATCH_FILES) throw new Error(`paths must contain at most ${MAX_WATCH_FILES} entries`);
  const entries = [];
  const summary = { watched: registry.size, changed: 0, unchanged: 0, deleted: 0 };
  for (const relativePath of targets) {
    const baseline = registry.get(relativePath);
    if (!baseline) {
      entries.push({ path: relativePath, status: 'unwatched', hint: 'call urdr_watch for this path first' });
      continue;
    }
    let fresh;
    try {
      fresh = readWatchedFile(watchRoot, relativePath);
    } catch (error) {
      registry.delete(relativePath);
      summary.deleted++;
      entries.push({ path: relativePath, status: 'deleted', detail: error.message });
      continue;
    }
    const freshHash = sha256(fresh.content);
    if (freshHash === baseline.hash) {
      summary.unchanged++;
      entries.push({ path: relativePath, status: 'unchanged', stamp: baseline.hash.slice(0, 12) });
      continue;
    }
    const hunks = computeHunks(baseline.content, fresh.content);
    summary.changed++;
    entries.push({
      path: relativePath, status: 'changed', stamp: freshHash.slice(0, 12),
      hunks,
      removedLines: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0),
      addedLines: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
    });
    registry.set(relativePath, {
      content: fresh.content, bytes: fresh.bytes,
      lines: fresh.content.split('\n').length, hash: freshHash,
    });
  }
  summary.watched = registry.size;
  return { entries, summary };
}
