#!/usr/bin/env node
/**
 * token-autopsy.mjs — Claude Code oturum dökümlerinden token harcama otopsisi.
 *
 *   node scripts/token-autopsy.mjs <transcript.jsonl | proje-dizini> [...]
 *
 * Bağlam vergisi katmanının ölçüm tezgâhı: neyin token yaktığını TAHMİN etmez,
 * ajanın kendi oturum dökümlerinden (JSONL) okur. İki veri sınıfı ayrılır:
 *
 *   1. GERÇEK kullanım — API'nin bildirdiği usage alanları (output, taze input,
 *      önbellek yazma/okuma). Bunlar kesindir.
 *   2. Araç çıktısı hacmi — bağlama giren tool_result karakterleri.
 *      Token ≈ karakter/4 yaklaşımıdır ve öyle etiketlenir.
 *
 * İsraf tanımları (kalite kaybı SIFIR olan kesim payı):
 *   - tekrar okuma: aynı dosyanın ikinci+ Read'i. Arada düzenleme yoksa
 *     tamamı israftır; varsa yalnız yeni yazılan karakterler düşülür.
 *   - cerrahi oran: okunup düzenlenen dosyalarda ilk okuma / dokunulan
 *     karakter — "bütün dosyayı okuyup 5 satır değiştirme" katsayısı.
 *
 * Anahtar bulgu (bu tezgâh yazılırken 6 oturum, 21.598 istek üzerinde):
 * bağlama giren her token, oturumun kalan HER isteğinde önbellekten yeniden
 * okunur — ölçülen örnekte 2,3M araç token'ı 10,7 MİLYAR önbellek okuma
 * token'ına dönüştü. Asıl vergi budur; katmanın hedefi bu çarpanı düşürmek.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const estimateTokens = (chars) => Math.round(chars / 4);
const fmt = (n) => n.toLocaleString('en-US');

/** tool_result içeriğinin bağlama giren metin uzunluğu (görseller sayılmaz). */
export function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') total += part.text.length;
    }
    return total;
  }
  return 0;
}

function fileState(map, filePath) {
  if (!map.has(filePath)) {
    map.set(filePath, {
      reads: 0, readChars: 0, firstReadChars: 0, everRead: false,
      edits: 0, editChars: 0, repeatWasteChars: 0,
      editedSinceRead: false, newCharsSinceRead: 0,
    });
  }
  return map.get(filePath);
}

/** Tek bir oturum dökümünü satır satır işler (dev dosyalar belleğe sığmaz). */
export async function analyzeSession(file) {
  const toolById = new Map();
  const perTool = new Map();
  const files = new Map();
  const usage = { out: 0, freshIn: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  let toolResultChars = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }   // bozuk satır otopsiyi durdurmaz
    const message = entry.message;
    if (entry.type === 'assistant' && message) {
      if (message.usage) {
        usage.out += message.usage.output_tokens || 0;
        usage.freshIn += message.usage.input_tokens || 0;
        usage.cacheRead += message.usage.cache_read_input_tokens || 0;
        usage.cacheWrite += message.usage.cache_creation_input_tokens || 0;
        usage.requests++;
      }
      for (const item of (Array.isArray(message.content) ? message.content : [])) {
        if (item.type !== 'tool_use') continue;
        toolById.set(item.id, { name: item.name, input: item.input });
        const input = item.input || {};
        if (item.name === 'Edit' && input.file_path) {
          const st = fileState(files, input.file_path);
          st.edits++;
          st.editChars += (input.old_string || '').length + (input.new_string || '').length;
          st.editedSinceRead = true;
          st.newCharsSinceRead += (input.new_string || '').length;
        } else if (item.name === 'Write' && input.file_path) {
          const st = fileState(files, input.file_path);
          st.edits++;
          st.editChars += (input.content || '').length;
          st.editedSinceRead = true;
          st.newCharsSinceRead += (input.content || '').length;
        }
      }
    } else if (entry.type === 'user' && message) {
      for (const item of (Array.isArray(message.content) ? message.content : [])) {
        if (item.type !== 'tool_result') continue;
        const meta = toolById.get(item.tool_use_id);
        const chars = contentChars(item.content);
        toolResultChars += chars;
        const name = meta ? meta.name : '(bilinmeyen)';
        const tally = perTool.get(name) || { calls: 0, chars: 0 };
        tally.calls++;
        tally.chars += chars;
        perTool.set(name, tally);
        if (name === 'Read' && meta?.input?.file_path) {
          const st = fileState(files, meta.input.file_path);
          if (st.everRead) {
            st.repeatWasteChars += st.editedSinceRead
              ? Math.max(0, chars - st.newCharsSinceRead)
              : chars;
          } else {
            st.everRead = true;
            st.firstReadChars = chars;
          }
          st.reads++;
          st.readChars += chars;
          st.editedSinceRead = false;
          st.newCharsSinceRead = 0;
        }
      }
    }
  }

  let repeatWaste = 0, readTotal = 0, readCalls = 0;
  let surgicalRead = 0, surgicalTouch = 0, editedFileCount = 0;
  for (const st of files.values()) {
    repeatWaste += st.repeatWasteChars;
    readTotal += st.readChars;
    readCalls += st.reads;
    if (st.everRead && st.edits > 0) {
      surgicalRead += st.firstReadChars;
      surgicalTouch += st.editChars;
      editedFileCount++;
    }
  }
  let exploreChars = 0;
  for (const [name, tally] of perTool) {
    if (name === 'Grep' || name === 'Glob' || name === 'Bash') exploreChars += tally.chars;
  }
  return {
    file, usage, toolResultChars, perTool, repeatWaste, readTotal, readCalls,
    surgicalRead, surgicalTouch, editedFileCount, exploreChars, fileCount: files.size,
  };
}

/** Argümanları dosya listesine açar: .jsonl doğrudan, dizinse içindeki .jsonl'ler. */
export function collectTranscripts(args, { minBytes = 0 } = {}) {
  const targets = [];
  for (const arg of args) {
    const stat = fs.statSync(arg);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(arg)) {
        if (!entry.endsWith('.jsonl')) continue;
        const p = path.join(arg, entry);
        const size = fs.statSync(p).size;
        if (size >= minBytes) targets.push({ path: p, size });
      }
    } else if (arg.endsWith('.jsonl')) {
      targets.push({ path: arg, size: stat.size });
    }
  }
  targets.sort((a, b) => b.size - a.size);
  return targets;
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: token-autopsy.mjs <transcript.jsonl | dizin> [...]');
    process.exit(2);
  }
  const targets = collectTranscripts(args, { minBytes: 200 * 1024 });
  if (targets.length === 0) {
    console.error('hiç .jsonl dökümü bulunamadı (200KB altı oturumlar atlanır)');
    process.exit(2);
  }

  const agg = { out: 0, freshIn: 0, cacheRead: 0, cacheWrite: 0, requests: 0,
                toolChars: 0, repeatWaste: 0, readTotal: 0, readCalls: 0,
                surgicalRead: 0, surgicalTouch: 0, exploreChars: 0, sessions: 0 };
  const perToolAgg = new Map();
  const rows = [];
  for (const { path: p, size } of targets) {
    const r = await analyzeSession(p);
    if (r.usage.requests === 0) continue;
    agg.sessions++;
    agg.out += r.usage.out; agg.freshIn += r.usage.freshIn;
    agg.cacheRead += r.usage.cacheRead; agg.cacheWrite += r.usage.cacheWrite;
    agg.requests += r.usage.requests;
    agg.toolChars += r.toolResultChars; agg.repeatWaste += r.repeatWaste;
    agg.readTotal += r.readTotal; agg.readCalls += r.readCalls;
    agg.surgicalRead += r.surgicalRead; agg.surgicalTouch += r.surgicalTouch;
    agg.exploreChars += r.exploreChars;
    for (const [name, tally] of r.perTool) {
      const a = perToolAgg.get(name) || { calls: 0, chars: 0 };
      a.calls += tally.calls; a.chars += tally.chars;
      perToolAgg.set(name, a);
    }
    rows.push({
      id: path.basename(p, '.jsonl').slice(0, 8),
      mb: (size / 1e6).toFixed(0),
      reqs: r.usage.requests,
      toolTok: estimateTokens(r.toolResultChars),
      readTok: estimateTokens(r.readTotal),
      repeatTok: estimateTokens(r.repeatWaste),
      repeatPct: r.readTotal ? Math.round(100 * r.repeatWaste / r.readTotal) : 0,
      surgical: r.surgicalTouch ? (r.surgicalRead / r.surgicalTouch).toFixed(1) : '—',
      avgCtx: Math.round((r.usage.freshIn + r.usage.cacheRead + r.usage.cacheWrite) / r.usage.requests),
    });
  }

  console.log('OTURUM DÖKÜMÜ (araç token ≈ karakter/4)');
  console.log('oturum      MB   istek   araçTok    okumaTok  tekrarTok tekrar% cerrahi  ort.bağlam');
  for (const r of rows.slice(0, 20)) {
    console.log(r.id.padEnd(9) + String(r.mb).padStart(4) + String(r.reqs).padStart(8)
      + fmt(r.toolTok).padStart(10) + fmt(r.readTok).padStart(12) + fmt(r.repeatTok).padStart(11)
      + (r.repeatPct + '%').padStart(8) + String(r.surgical).padStart(8) + fmt(r.avgCtx).padStart(12));
  }

  console.log('\nARAÇ BAZINDA (bağlama giren çıktı)');
  for (const [name, tally] of [...perToolAgg].sort((a, b) => b[1].chars - a[1].chars).slice(0, 12)) {
    console.log('  ' + name.padEnd(30) + String(tally.calls).padStart(6) + ' çağrı'
      + fmt(estimateTokens(tally.chars)).padStart(12) + ' tok');
  }

  console.log('\nGERÇEK KULLANIM (API usage alanları)');
  console.log('  oturum: ' + agg.sessions + ' | istek: ' + fmt(agg.requests));
  console.log('  output: ' + fmt(agg.out) + ' | taze input: ' + fmt(agg.freshIn)
    + ' | önbellek yazma: ' + fmt(agg.cacheWrite) + ' | önbellek okuma: ' + fmt(agg.cacheRead));
  console.log('  istek başına ort. bağlam: '
    + fmt(Math.round((agg.freshIn + agg.cacheRead + agg.cacheWrite) / Math.max(1, agg.requests))) + ' tok');

  console.log('\nİSRAF (sıfır kalite kaybıyla kesilebilir pay)');
  console.log('  Read toplam: ' + fmt(estimateTokens(agg.readTotal)) + ' tok (' + fmt(agg.readCalls) + ' okuma)');
  console.log('  tekrar okuma israfı: ' + fmt(estimateTokens(agg.repeatWaste)) + ' tok ('
    + Math.round(100 * agg.repeatWaste / Math.max(1, agg.readTotal)) + '%)');
  console.log('  cerrahi oran: '
    + (agg.surgicalTouch ? (agg.surgicalRead / agg.surgicalTouch).toFixed(1) + '×' : '—'));
  console.log('  keşif çıktısı (Grep+Glob+Bash): ' + fmt(estimateTokens(agg.exploreChars)) + ' tok');
  console.log('\nNot: bağlama giren her token, oturumun kalan her isteğinde önbellekten');
  console.log('yeniden okunur — asıl vergi tekil boy değil, boy × kalan istek sayısıdır.');
}
