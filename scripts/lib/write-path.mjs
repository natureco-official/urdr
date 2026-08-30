/**
 * write-path.mjs — yazma yolunun cerrahi hazırlığı (v1.4).
 *
 * Ölçüm bu modülün sınırlarını çizdi (docs/design/2026-08-30-write-path.md):
 * leave-one-out deneyinde sözcüksel dal seçimi top-1 %23.9'da kaldı — hedef
 * dal tür×konu ile belirlenir ve kelime torbası türü göremez. Bu yüzden
 * burada hiçbir şey KARAR VERMEZ; karar, taslağı zaten gören ajandadır.
 * Modülün işi karara giren gerçekleri ucuz ve kusursuz vermektir:
 *
 *   buildWriteContext → birebir dal envanteri (amaç satırları + format
 *     ipuçları), yakın-kopya uyarıları, açıkça "danışma" etiketli sıralama.
 *   suggestBranches   → "branch not found" anında deterministik
 *     "did you mean" önerisi (gözlenen iki gerçek hatanın katili).
 *   nearDuplicates    → lint ile aynı token-Jaccard ölçüsü; dupeGuard eşiği
 *     lint'in DUP_THRESHOLD'uyla (0.85) hizalıdır.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listRootFiles } from './markdown-model.mjs';
import { loadPack, readLeavesById } from './context-pack.mjs';

export const DUPE_GUARD_THRESHOLD = 0.85;   // lint DUP_THRESHOLD ile hizalı
export const DUPE_WARN_THRESHOLD = 0.60;
export const ADVISORY_LIMIT = 5;
const FULL_TEXT_LEAF_CAP = 2000;            // üstünde başlıklarla yetinilir

const tokenize = (text) => [...String(text).toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)].map((m) => m[0]);
const stem = (word) => (word.length > 5 ? word.slice(0, 5) : word);

export function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const item of setA) if (setB.has(item)) hits++;
  return hits / (setA.size + setB.size - hits);
}

function levenshtein(a, b) {
  const rows = a.length + 1, cols = b.length + 1;
  const dist = new Uint16Array(rows * cols);
  for (let i = 0; i < rows; i++) dist[i * cols] = i;
  for (let j = 0; j < cols; j++) dist[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dist[i * cols + j] = Math.min(
        dist[(i - 1) * cols + j] + 1,
        dist[i * cols + j - 1] + 1,
        dist[(i - 1) * cols + j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dist[rows * cols - 1];
}

/** Kök dosyaların envanteri: amaç satırı + BİREBİR dal adları + format ipuçları. */
export function listRootInventory(memoryDir) {
  const roots = [];
  for (const entry of listRootFiles(memoryDir)) {
    const fullPath = path.isAbsolute(entry) ? entry : path.join(memoryDir, entry);
    const file = path.basename(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    const purpose = (content.match(/^>\s*\*\*(?:Purpose|Amaç)[:*]*\*?\*?:?\s*(.+)$/mi) || [])[1]?.trim() || null;
    const branches = [];
    let current = null;
    for (const line of lines) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) { current = { name: heading[1], format: null }; branches.push(current); continue; }
      if (current && !current.format) {
        const format = line.match(/<!--\s*(?:Format|Biçim):\s*(.+?)\s*-->/i);
        if (format) current.format = format[1];
      }
    }
    roots.push({ file, purpose, branches });
  }
  return roots;
}

/**
 * "branch not found" kurtarıcısı: mevcut dal adları içinde istenene en yakın
 * olan(lar)ı deterministik skorla önerir — token kesişimi + normalize edit
 * mesafesi, eşitlik sözlük sırasıyla kırılır.
 */
export function suggestBranches(availableNames, wantedName, { max = 3 } = {}) {
  const wantedTokens = new Set(tokenize(wantedName).map(stem));
  const wantedLower = String(wantedName).toLowerCase();
  return availableNames
    .map((name) => {
      const nameTokens = new Set(tokenize(name).map(stem));
      const overlap = jaccard(wantedTokens, nameTokens);
      const nameLower = name.toLowerCase();
      const editScore = 1 - levenshtein(wantedLower, nameLower) / Math.max(wantedLower.length, nameLower.length);
      const containment = nameLower.includes(wantedLower) || wantedLower.includes(nameLower) ? 0.5 : 0;
      return { name, score: 2 * overlap + editScore + containment };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .filter((entry) => entry.score > 0.3);
}

function leafTexts(memoryDir, pack) {
  const texts = new Map();
  if (pack.leaves.length > FULL_TEXT_LEAF_CAP) {
    for (const leaf of pack.leaves) texts.set(leaf.id, leaf.headline || '');
    return { texts, source: 'headlines' };
  }
  for (let i = 0; i < pack.leaves.length; i += 32) {
    for (const leaf of readLeavesById(memoryDir, pack.leaves.slice(i, i + 32).map((l) => l.id))) {
      if (!leaf.error) texts.set(leaf.id, leaf.text || '');
    }
  }
  return { texts, source: 'full-text' };
}

/** Taslağa yakın mevcut yapraklar (lint ile aynı ölçü): kopyala değil genişlet. */
export function nearDuplicates(pack, texts, draftText, { threshold = DUPE_WARN_THRESHOLD, max = 3 } = {}) {
  const draftSet = new Set(tokenize(draftText));
  const matches = [];
  for (const leaf of pack.leaves) {
    const similarity = jaccard(draftSet, new Set(tokenize(texts.get(leaf.id) ?? leaf.headline)));
    if (similarity >= threshold) matches.push({ id: leaf.id, headline: leaf.headline, similarity: Math.round(similarity * 100) / 100 });
  }
  return matches.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, max);
}

/**
 * Danışma sıralaması — ölçülmüş sınırları üstünde yazar (top-1 %23.9,
 * top-5 %56.9; leave-one-out, gerçek ağaç). Spot ışığıdır, hakem değildir.
 */
export function advisoryRanking(pack, texts, draftText, { limit = ADVISORY_LIMIT } = {}) {
  const branchDocs = new Map();
  for (const leaf of pack.leaves) {
    const key = `${leaf.file}::${leaf.branch}`;
    if (!branchDocs.has(key)) branchDocs.set(key, new Set());
    const doc = branchDocs.get(key);
    for (const word of tokenize(texts.get(leaf.id) ?? leaf.headline)) doc.add(stem(word));
  }
  const documentFrequency = new Map();
  for (const doc of branchDocs.values()) {
    for (const word of doc) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  }
  const branchCount = branchDocs.size;
  const idf = (word) => Math.log(1 + branchCount / (documentFrequency.get(word) || 1));
  const draftWords = new Set(tokenize(draftText).map(stem));
  const ranked = [];
  for (const [key, doc] of branchDocs) {
    const nameWords = new Set(tokenize(key.split('::')[1]).map(stem));
    let score = 0;
    const evidence = [];
    for (const word of draftWords) {
      if (doc.has(word)) { score += idf(word); evidence.push(word); }
      if (nameWords.has(word)) score += 2 * idf(word);
    }
    if (score > 0) {
      const [file, branch] = key.split('::');
      ranked.push({ file, branch, score: Math.round(score * 100) / 100, evidence: evidence.sort().slice(0, 5) });
    }
  }
  return ranked.sort((a, b) => b.score - a.score || `${a.file}::${a.branch}`.localeCompare(`${b.file}::${b.branch}`)).slice(0, limit);
}

/** Yazma öncesi tek çağrılık brifing — karar vermez, karara girenleri verir. */
export function buildWriteContext(memoryDir, draftText) {
  const pack = loadPack(memoryDir);
  const { texts, source } = leafTexts(memoryDir, pack);
  const roots = listRootInventory(memoryDir).map((root) => ({
    file: root.file,
    purpose: root.purpose,
    branches: root.branches.map((branch) => branch.name),          // BİREBİR adlar
    formatHints: Object.fromEntries(root.branches.filter((b) => b.format).map((b) => [b.name, b.format])),
  }));
  return {
    roots,
    nearDuplicates: nearDuplicates(pack, texts, draftText),
    advisory: {
      note: `advisory only — measured leave-one-out accuracy on a real tree: top-1 23.9%, top-5 56.9% (${source}); the decision is yours`,
      candidates: advisoryRanking(pack, texts, draftText),
    },
    receipt: 'urdr_append returns a compact receipt (leaf id, file, branch, event hash) — do not re-read the file to verify',
    stamp: pack.stamp,
  };
}
