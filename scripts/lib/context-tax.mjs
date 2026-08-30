/**
 * context-tax.mjs — bağlam vergisi katmanı: oturum delta protokolü + spool.
 *
 * Ölçülen gerçek (scripts/token-autopsy.mjs): bağlama giren her token,
 * oturumun kalan HER isteğinde önbellekten yeniden okunur — bir araç
 * cevabının gerçek maliyeti boyu değil, boyu × kalan istek sayısıdır.
 * Bu katman iki şeyi garanti eder, ikisi de SIFIR bilgi kaybıyla:
 *
 *   1. DELTA: aynı oturumda aynı sorunun cevabı değişmediyse tam gövde
 *      yerine ~30 token'lık "unchanged" kanıtı döner (hash'le ispatlı).
 *      Tam gövde her zaman spool'dan veya force:true ile geri alınabilir.
 *   2. SPOOL: bütçeyi aşan cevap kırpılmaz; tam hali içerik-adresli bir
 *      dosyaya park edilir, bağlama önizleme + referans girer. urdr_fetch
 *      istenen satır aralığını getirir; referans içerik hash'inin kendisi
 *      olduğu için getirilen dilimin aidiyeti kanıtlıdır.
 *
 * Defter (ledger) oturum-ömürlüdür ve yalnız sunucu belleğinde yaşar:
 * yeniden başlatma onu unutur, ilk çağrılar yine tam gövde alır — yeni bir
 * bayatlık sınıfı doğmaz. Spool ise önbellektir, asla gerçeğin kaynağı
 * değildir: unutma scrub'ı onu pack ile aynı boğazda tamamen boşaltır.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './context-pack.mjs';

export const SPOOL_RELATIVE_DIR = path.join('.urdr', 'spool');
export const SPOOL_MAX_FILES = 32;
export const SPOOL_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_REPLY_TOKENS = 2000;
const REF_RE = /^spool:[0-9a-f]{16}$/;

/** Delta uygulanan araçlar: salt-okur ve deterministik olanlar. Yazan
 * araçlar (append/apply/forget/resume) ve geri-alma kanalı (fetch) asla
 * "unchanged" ile kısaltılmaz. */
export const DELTA_TOOLS = new Set([
  'urdr_search', 'urdr_context', 'urdr_map', 'urdr_read',
  'urdr_related', 'urdr_ask', 'urdr_path', 'urdr_report',
]);

/** Park (spool taşması) uygulanan araçlar: delta kümesi + durum bildiren
 * watch/delta. urdr_fetch bilinçli dışarıda — geri-alma kanalının kendisi
 * park edilirse sonsuz döngü doğar; dilim boyunu zaten çağıran sınırlar. */
export const PARKED_TOOLS = new Set([...DELTA_TOOLS, 'urdr_watch', 'urdr_delta']);

export function createSessionLedger() { return new Map(); }

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** force/maxReplyTokens taşıma bayraklarıdır; anahtar içeriği belirlemez. */
export function canonicalKey(name, args = {}) {
  const keys = Object.keys(args).filter((k) => k !== 'force' && k !== 'maxReplyTokens').sort();
  return name + '|' + JSON.stringify(keys.map((k) => [k, args[k]]));
}

function spoolDirFor(memoryDir) { return path.join(memoryDir, SPOOL_RELATIVE_DIR); }

/** İçerik-adresli, atomik, idempotent park. Dönen ref = hash'in kendisi. */
export function spoolWrite(memoryDir, text) {
  const hash = sha256(text).slice(0, 16);
  const dir = spoolDirFor(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${hash}.txt`);
  if (!fs.existsSync(target)) {
    const tmp = path.join(dir, `.tmp-${process.pid}-${hash}`);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);                       // atomik: yarım spool dosyası olamaz
  } else {
    const now = new Date();
    fs.utimesSync(target, now, now);                  // LRU tazeleme
  }
  spoolSweep(memoryDir, { keep: `${hash}.txt` });
  return `spool:${hash}`;
}

/** LRU süpürme: dosya sayısı/toplam bayt tavanı aşılırsa en eskiler gider. */
export function spoolSweep(memoryDir, { maxFiles = SPOOL_MAX_FILES, maxBytes = SPOOL_MAX_BYTES, keep } = {}) {
  const dir = spoolDirFor(memoryDir);
  let entries;
  try { entries = fs.readdirSync(dir).filter((e) => e.endsWith('.txt')); } catch { return 0; }
  const stats = entries.map((name) => {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    return { name, path: p, size: st.size, mtimeMs: st.mtimeMs };
  }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let total = stats.reduce((sum, s) => sum + s.size, 0);
  let removed = 0;
  for (const entry of stats) {
    if (stats.length - removed <= maxFiles && total <= maxBytes) break;
    if (entry.name === keep) continue;                // az önce yazılan asla süpürülmez
    fs.rmSync(entry.path, { force: true });
    total -= entry.size;
    removed++;
  }
  return removed;
}

/** Unutma boğazı: spool önbellektir, scrub hepsini siler — unutulan yaprağın
 * metni park edilmiş bir cevabın içinde hayatta kalamaz. */
export function spoolScrub(memoryDir) {
  const dir = spoolDirFor(memoryDir);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) { fs.rmSync(path.join(dir, entry), { force: true }); removed++; }
  return removed;
}

/** Park edilmiş cevaptan satır dilimi. Bütünlük: içerik hash'i ref'le
 * doğrulanır — kurcalanmış spool dosyası sessizce servis edilmez. */
export function spoolFetch(memoryDir, ref, { fromLine, toLine } = {}) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new Error('ref must look like spool:<16 hex chars> (returned by a parked or unchanged reply)');
  }
  const hash = ref.slice('spool:'.length);
  const target = path.join(spoolDirFor(memoryDir), `${hash}.txt`);
  let text;
  try { text = fs.readFileSync(target, 'utf8'); }
  catch { throw new Error(`spool entry not found: ${ref} (spool is a cache — the result may have been swept or scrubbed; re-run the original tool)`); }
  if (!sha256(text).startsWith(hash)) {
    fs.rmSync(target, { force: true });
    throw new Error(`spool integrity failure for ${ref}: content does not match its ref; entry removed — re-run the original tool`);
  }
  const lines = text.split('\n');
  const start = Math.max(1, fromLine ?? 1);
  const end = Math.min(lines.length, toLine ?? start + 199);
  if (start > lines.length) throw new Error(`fromLine ${start} is beyond the entry (${lines.length} lines)`);
  const slice = lines.slice(start - 1, end).join('\n');
  return { ref, totalLines: lines.length, fromLine: start, toLine: end,
           tokensApprox: estimateTokens(slice), text: slice };
}

function readForce(args) {
  if (args.force === undefined) return false;
  if (typeof args.force !== 'boolean') throw new Error('force must be a boolean');
  return args.force;
}

function readMaxReplyTokens(args) {
  if (args.maxReplyTokens === undefined) return DEFAULT_MAX_REPLY_TOKENS;
  if (!Number.isInteger(args.maxReplyTokens) || args.maxReplyTokens < 100 || args.maxReplyTokens > 8000) {
    throw new Error('maxReplyTokens must be an integer from 100 through 8000');
  }
  return args.maxReplyTokens;
}

/**
 * Vergi boğazı: salt-okur bir aracın tam cevabını alır; ya olduğu gibi,
 * ya "unchanged" kanıtı, ya da önizleme+ref olarak döndürür.
 * Damga, cevabın kalıcı içeriği üzerinden alınır (rebuilt gibi çağrıya
 * özgü bayraklar hariç) — ilk çağrının "yeniden derledim" notu ikinci
 * çağrının "değişmedi" tespitini bozmaz.
 */
export function applyContextTax(ledger, memoryDir, name, args, value) {
  if (!ledger || !PARKED_TOOLS.has(name)) return value;
  const deltaEligible = DELTA_TOOLS.has(name);
  const force = readForce(args);
  const maxReplyTokens = readMaxReplyTokens(args);
  const text = JSON.stringify(value, null, 2);
  const stampBasis = (value && typeof value === 'object' && !Array.isArray(value))
    ? JSON.stringify({ ...value, rebuilt: undefined }, null, 2)
    : text;
  const stamp = sha256(stampBasis).slice(0, 12);
  const key = canonicalKey(name, args);
  const previous = ledger.get(key);
  ledger.set(key, stamp);

  if (deltaEligible && !force && previous === stamp) {
    const ref = spoolWrite(memoryDir, text);
    return {
      unchanged: true, stamp, ref, tokensApproxFull: estimateTokens(text),
      hint: `identical to the earlier ${name} reply in this session; slices via urdr_fetch("${ref}"), full body via force:true`,
    };
  }
  if (estimateTokens(text) > maxReplyTokens) {
    const ref = spoolWrite(memoryDir, text);
    const lines = text.split('\n');
    const budgetChars = maxReplyTokens * 4 - 300;      // zarf alanları için pay
    const preview = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > budgetChars) break;
      preview.push(line);
      used += line.length + 1;
    }
    return {
      spooled: true, ref, stamp, tokensApproxFull: estimateTokens(text),
      totalLines: lines.length, previewLines: preview.length, preview: preview.join('\n'),
      hint: `reply exceeded maxReplyTokens=${maxReplyTokens}; full body parked — urdr_fetch ref="${ref}" with fromLine/toLine returns exact slices`,
    };
  }
  return value;
}
