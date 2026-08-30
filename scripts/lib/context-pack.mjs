/**
 * context-pack.mjs — Urðr Bağlam Paketi derleyicisi.
 *
 * Sorun: ajanlar her oturumda ham Markdown'dan yeniden yöneliyordu — olgun bir
 * ağaçta oturum başlangıcı ~35k token (4 dosyanın tam okunması), tek arama
 * "hiyerarşi önce" adına koca bir kök dosyası (~15k token) okutuyordu.
 *
 * Çözüm: kaynak gerçeğe DOKUNMADAN (Markdown + olay günlüğü aynen kalır)
 * deterministik, LLM'siz, bağımlılıksız bir derlenmiş görünüm üretmek:
 *
 *   .urdr/pack/stamp.json   girdi parmak izi — bayat paket imkânsız
 *   .urdr/pack/index.json   yaprak kataloğu (id, kök, dal, başlık, tarih, derece)
 *   .urdr/pack/graph.json   kenarlar: EXTRACTED (id'li edge: + bkz:) ve
 *                           INFERRED (aynı-dal komşuluğu; F3 eş-anma ekler)
 *   .urdr/pack/digest.md    ≤~350 token oturum brifingi — "4 dosya oku"
 *                           protokolünün yerini alan TEK okuma
 *
 * Paket türetilmiş bir önbellektir: silinmesi veri kaybı değildir, bir sonraki
 * loadPack yeniden üretir. Unutma (forgetting) yolunda scrub doğrulaması tüm
 * dosyaları gezdiği için paket scrub ÖNCESİ silinmelidir — invalidatePack
 * bunun için dışa açıktır; sildikten sonra unutulan yaprak bir daha paketin
 * hiçbir üretiminde görünmez (kaynaktan zaten silinmiştir).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listRootFiles, parseMarkdown } from './markdown-model.mjs';

export const PACK_RELATIVE_DIR = path.join('.urdr', 'pack');
export const DIGEST_CHAR_BUDGET = 1500;          // ~East 375 token; ölçülen değer bench'te
const HEADLINE_MAX = 96;
const RECENT_ENTRY_COUNT = 8;
const HOT_NODE_COUNT = 5;
const BRANCH_LEAF_WARNING = 50;
const ROOT_BRANCH_WARNING = 9;

/** transaction.mjs'teki kalıpla aynı; bağımsız tanım bilinçli (gevşek bağ). */
const BKZ_RE = /\bbkz:\s*((?:root|kök|kok)-?\d+)(?:\s*\/\s*([^\n();]+?))?(?=\s*(?:[();]|$))/giu;
const DATE_RE = /^\s*(?:[-+*]\s+)?\*\*(\d{2})\.(\d{2})\.(\d{4})\s+[—-]/;

export function estimateTokens(text) {
  // Belgelenmiş yaklaşıklık: ~4 karakter ≈ 1 token. Bench gerçek örnekle doğrular.
  return Math.ceil(String(text).length / 4);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function packDir(memoryDir) {
  return path.join(memoryDir, PACK_RELATIVE_DIR);
}

/** Girdi parmak izi: kök dosyaların içerik özeti + olay günlüğü başı. */
export function computeStamp(memoryDir) {
  const parts = [];
  for (const file of listRootFiles(memoryDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    parts.push(`${path.basename(file)}:${sha256(content)}`);
  }
  for (const relative of [path.join('.urdr', 'event-head.json')]) {
    try { parts.push(`${relative}:${sha256(fs.readFileSync(path.join(memoryDir, relative), 'utf8'))}`); }
    catch { /* günlüksüz ağaç da geçerli */ }
  }
  return sha256(parts.join('\n'));
}

function stripMarkdown(line) {
  return line
    .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function leafDate(text) {
  const match = String(text).match(DATE_RE);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`; // ISO sıralanabilir
}

function leafHeadline(text) {
  const first = String(text).split(/\r?\n/).find((line) => line.trim()) || '';
  let headline = stripMarkdown(first);
  headline = headline.replace(/^(\d{2})\.(\d{2})\.(\d{4})\s+[—-]\s*/, '');
  if (headline.length > HEADLINE_MAX) headline = `${headline.slice(0, HEADLINE_MAX - 1)}…`;
  return headline;
}

function syntheticId(fileBase, startLine) {
  return `${fileBase}#L${startLine}`;
}

function normalizeRootRef(raw) {
  const digits = String(raw).match(/\d+/);
  return digits ? Number(digits[0]) : null;
}

/**
 * Paketi bellek ağacından derler. Tamamen deterministik: aynı girdi aynı
 * paket. LLM yok, ağ yok, rastgelelik yok.
 */
export function buildPack(memoryDir) {
  const files = listRootFiles(memoryDir);
  const language = files.some((file) => /kök|kok/i.test(path.basename(file))) ? 'tr' : 'en';
  const leaves = [];
  const branches = [];       // { key, file, name, leafCount }
  const roots = [];          // { file, rootNumber, branchCount, leafCount }
  const idToIndex = new Map();
  const branchKey = (fileBase, branch) => `${fileBase}::${branch || '(root)'}`;
  const rootNumberByFile = new Map();

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fileBase = path.basename(file);
    const model = parseMarkdown(content);
    const rootNumber = normalizeRootRef(fileBase);
    rootNumberByFile.set(fileBase, rootNumber);
    const rootRecord = { file: fileBase, rootNumber, branchCount: model.branches.length, leafCount: 0 };
    roots.push(rootRecord);

    for (const branch of model.branches) {
      branches.push({
        key: branchKey(fileBase, branch.name),
        file: fileBase,
        name: branch.name,
        leafCount: branch.leaves.length,
      });
    }
    for (const leaf of model.leaves) {
      const id = leaf.id || syntheticId(fileBase, leaf.startLine);
      const record = {
        id,
        stable: Boolean(leaf.id),
        file: fileBase,
        branch: leaf.branch || '(root)',
        kind: leaf.kind,
        line: leaf.startLine,
        chars: leaf.text.length,
        date: leafDate(leaf.text),
        headline: leafHeadline(leaf.text),
        edgeTargetIds: leaf.edgeTargetIds || [],
        bkzRootRefs: [...leaf.text.matchAll(BKZ_RE)].map((match) => ({
          root: normalizeRootRef(match[1]),
          branch: match[2] ? match[2].trim() : null,
        })),
      };
      idToIndex.set(id, leaves.length);
      leaves.push(record);
      rootRecord.leafCount += 1;
    }
  }

  // ── Kenarlar ──────────────────────────────────────────────────────────────
  const edges = [];
  const pushEdge = (source, target, tier, kind, weight) => {
    if (source === target) return;
    edges.push({ source, target, tier, kind, weight });
  };
  const branchLeafIds = new Map();
  for (const leaf of leaves) {
    const key = branchKey(leaf.file, leaf.branch);
    if (!branchLeafIds.has(key)) branchLeafIds.set(key, []);
    branchLeafIds.get(key).push(leaf.id);
  }
  const fileByRootNumber = new Map();
  for (const [file, number] of rootNumberByFile) {
    if (number !== null && !fileByRootNumber.has(number)) fileByRootNumber.set(number, file);
  }

  for (const leaf of leaves) {
    // EXTRACTED: kararlı id → id kenarları (edge: metadata)
    for (const targetId of leaf.edgeTargetIds) {
      if (idToIndex.has(targetId)) pushEdge(leaf.id, targetId, 'EXTRACTED', 'edge', 3);
    }
    // EXTRACTED: metindeki bkz: kök[/dal] referansı → dal düğümü
    for (const ref of leaf.bkzRootRefs) {
      const targetFile = fileByRootNumber.get(ref.root);
      if (!targetFile) continue;
      const target = ref.branch
        ? `branch:${branchKey(targetFile, ref.branch)}`
        : `root:${targetFile}`;
      pushEdge(leaf.id, target, 'EXTRACTED', 'bkz', 2);
    }
  }
  // INFERRED: aynı dalda ardışık yapraklar (zincir — O(n), yıldız patlaması yok)
  for (const ids of branchLeafIds.values()) {
    for (let i = 1; i < ids.length; i++) pushEdge(ids[i - 1], ids[i], 'INFERRED', 'sibling', 1);
  }
  // Yapısal: dal düğümü → üye yaprakları. bkz: ile dala gelen gezinme buradan
  // içeriğe akar (related 2. seviyede gerçek yaprak başlıkları döner).
  for (const [key, ids] of branchLeafIds) {
    for (const id of ids) pushEdge(`branch:${key}`, id, 'EXTRACTED', 'member', 1);
  }

  // Derece (yalnız yaprak düğümleri; member kenarı sayılmaz — her yaprağa
  // eşit +1 eklerdi, sıralamayı değiştirmeyip gürültü üretirdi)
  const degree = new Map();
  for (const edge of edges) {
    if (edge.kind === 'member') continue;
    for (const end of [edge.source, edge.target]) {
      degree.set(end, (degree.get(end) || 0) + (edge.tier === 'EXTRACTED' ? 2 : 1));
    }
  }
  for (const leaf of leaves) leaf.degree = degree.get(leaf.id) || 0;

  const stamp = computeStamp(memoryDir);
  const pack = {
    version: 1,
    stamp,
    generatedAt: new Date().toISOString(),
    language,
    roots,
    branches,
    leaves,
    edges,
  };
  pack.digest = buildDigest(pack);
  return pack;
}

const LABELS = {
  tr: {
    title: '# Urðr Oturum Brifingi',
    map: '## Ağaç haritası',
    recent: '## Son kayıtlar',
    hot: '## En bağlantılı düğümler',
    warn: '## Büyüme uyarıları',
    leavesWord: 'yaprak',
    branchesWord: 'dal',
    branchWarn: (b) => `"${b.name}" dalı ${b.leafCount} yaprak — bölme önerin (≥${BRANCH_LEAF_WARNING})`,
    rootWarn: (r) => `${r.file} ${r.branchCount} dal — yeni kök düşün (≥${ROOT_BRANCH_WARNING})`,
    none: 'yok',
    howto: '_Derin okuma: urdr_search → urdr_read (yaprak id). Tam dosya okuma gerekmez._',
  },
  en: {
    title: '# Urðr Session Brief',
    map: '## Tree map',
    recent: '## Recent entries',
    hot: '## Most connected nodes',
    warn: '## Growth warnings',
    leavesWord: 'leaves',
    branchesWord: 'branches',
    branchWarn: (b) => `branch "${b.name}" holds ${b.leafCount} leaves — consider a split (≥${BRANCH_LEAF_WARNING})`,
    rootWarn: (r) => `${r.file} has ${r.branchCount} branches — consider a new root (≥${ROOT_BRANCH_WARNING})`,
    none: 'none',
    howto: '_Deep reads: urdr_search → urdr_read (leaf ids). Never load whole root files._',
  },
};

/** ≤ DIGEST_CHAR_BUDGET karakterlik deterministik oturum brifingi. */
export function buildDigest(pack) {
  const t = LABELS[pack.language] || LABELS.en;
  const lines = [t.title, ''];

  lines.push(t.map);
  for (const root of pack.roots) {
    const rootBranches = pack.branches.filter((branch) => branch.file === root.file);
    const shown = rootBranches.slice(0, 9).map((branch) => `${branch.name} (${branch.leafCount})`).join(' · ');
    const extra = rootBranches.length > 9 ? ` +${rootBranches.length - 9}` : '';
    lines.push(`- **${root.file}** — ${root.leafCount} ${t.leavesWord}: ${shown}${extra}`);
  }
  lines.push('');

  const dated = pack.leaves.filter((leaf) => leaf.date)
    .sort((a, b) => b.date.localeCompare(a.date) || b.line - a.line)
    .slice(0, RECENT_ENTRY_COUNT);
  lines.push(t.recent);
  if (dated.length === 0) lines.push(`- ${t.none}`);
  for (const leaf of dated) lines.push(`- ${leaf.date} · ${leaf.headline} \`${leaf.id}\``);
  lines.push('');

  const hot = [...pack.leaves].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, HOT_NODE_COUNT).filter((leaf) => leaf.degree > 0);
  lines.push(t.hot);
  if (hot.length === 0) lines.push(`- ${t.none}`);
  for (const leaf of hot) lines.push(`- ${leaf.headline} — ${leaf.degree}° \`${leaf.id}\``);
  lines.push('');

  const branchWarnings = pack.branches.filter((branch) => branch.leafCount >= BRANCH_LEAF_WARNING);
  const rootWarnings = pack.roots.filter((root) => root.branchCount >= ROOT_BRANCH_WARNING);
  lines.push(t.warn);
  if (branchWarnings.length === 0 && rootWarnings.length === 0) lines.push(`- ${t.none}`);
  for (const branch of branchWarnings.slice(0, 4)) lines.push(`- ${t.branchWarn(branch)}`);
  for (const root of rootWarnings.slice(0, 4)) lines.push(`- ${t.rootWarn(root)}`);
  lines.push('', t.howto);

  let digest = lines.join('\n');
  if (digest.length > DIGEST_CHAR_BUDGET) {
    // Bütçe aşımında en genç bölümden kırp: sıcak düğümler → son kayıtlar.
    digest = `${digest.slice(0, DIGEST_CHAR_BUDGET - 2)}…`;
  }
  return digest;
}

export function writePack(memoryDir, pack) {
  const directory = packDir(memoryDir);
  fs.mkdirSync(directory, { recursive: true });
  const writeAtomic = (name, content) => {
    const target = path.join(directory, name);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, target);
  };
  const { digest, ...rest } = pack;
  writeAtomic('index.json', JSON.stringify({
    version: pack.version, stamp: pack.stamp, generatedAt: pack.generatedAt,
    language: pack.language, roots: pack.roots, branches: pack.branches, leaves: pack.leaves,
  }));
  writeAtomic('graph.json', JSON.stringify({
    version: pack.version, stamp: pack.stamp, edges: pack.edges,
  }));
  writeAtomic('digest.md', digest);
  writeAtomic('stamp.json', JSON.stringify({ version: pack.version, stamp: pack.stamp, generatedAt: pack.generatedAt }));
  return directory;
}

/** Türetilmiş önbelleği tamamen kaldırır (unutma yolu scrub'dan önce çağırır). */
export function invalidatePack(memoryDir) {
  fs.rmSync(packDir(memoryDir), { recursive: true, force: true });
}

/**
 * Paketi yükler; girdi parmak izi tutmuyorsa yeniden derleyip yazar.
 * Dönen nesne her zaman taze ve diskle tutarlıdır.
 */
export function loadPack(memoryDir, opts = {}) {
  const directory = packDir(memoryDir);
  const currentStamp = computeStamp(memoryDir);
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'stamp.json'), 'utf8'));
    if (stored.stamp === currentStamp && stored.version === 1) {
      const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
      const graph = JSON.parse(fs.readFileSync(path.join(directory, 'graph.json'), 'utf8'));
      const digest = fs.readFileSync(path.join(directory, 'digest.md'), 'utf8');
      if (index.stamp === currentStamp && graph.stamp === currentStamp) {
        return { ...index, edges: graph.edges, digest, rebuilt: false };
      }
    }
  } catch { /* eksik ya da bozuk paket → yeniden derle */ }
  if (opts.rebuild === false) return null;
  const pack = buildPack(memoryDir);
  writePack(memoryDir, pack);
  return { ...pack, rebuilt: true };
}

/** Kök→dal→sayaç iskeleti — kök dosyası okumanın ~80 tokenlik yerine geçer. */
export function treeMap(pack) {
  return pack.roots.map((root) => ({
    file: root.file,
    leaves: root.leafCount,
    branches: pack.branches
      .filter((branch) => branch.file === root.file)
      .map((branch) => ({ name: branch.name, leaves: branch.leafCount })),
  }));
}

/**
 * Kimliği verilen yaprakların TAM metnini döndürür — yalnız ilgili dosyalar
 * açılır, yalnız istenen satır aralıkları döner. "Dosyayı komple oku"nun yerine.
 */
export function readLeavesById(memoryDir, ids) {
  const pack = loadPack(memoryDir);
  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  const wanted = ids.map((id) => ({ id, record: byId.get(id) }));
  const byFile = new Map();
  for (const item of wanted) {
    if (!item.record) continue;
    if (!byFile.has(item.record.file)) byFile.set(item.record.file, []);
    byFile.get(item.record.file).push(item);
  }
  const results = new Map();
  for (const [file, items] of byFile) {
    let content;
    try { content = fs.readFileSync(path.join(memoryDir, file), 'utf8'); } catch { continue; }
    const model = parseMarkdown(content);
    for (const item of items) {
      const leaf = model.leaves.find((candidate) =>
        (candidate.id && candidate.id === item.id) || syntheticId(file, candidate.startLine) === item.id);
      if (leaf) {
        results.set(item.id, {
          id: item.id, file, branch: item.record.branch, line: item.record.line,
          date: item.record.date, text: leaf.text,
        });
      }
    }
  }
  return ids.map((id) => results.get(id) || { id, error: 'leaf not found (id may be stale — rebuild happens automatically on next call)' });
}

/**
 * Bütçeli komşuluk: EXTRACTED kenarlar önce, sonra INFERRED; derinlik ≤ depth.
 * Cevap ham dosya değil altgrafiktir — graphify'ın query fikri, denetlenebilir
 * kenar katmanlarıyla.
 */
export function relatedLeaves(pack, leafId, opts = {}) {
  const budgetTokens = Number.isFinite(opts.budgetTokens) ? Math.max(50, opts.budgetTokens) : 400;
  const depth = Number.isFinite(opts.depth) ? Math.min(3, Math.max(1, opts.depth)) : 2;
  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  if (!byId.has(leafId)) return { origin: leafId, error: 'unknown leaf id', related: [] };

  const adjacency = new Map();
  const addAdjacent = (from, to, edge) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ to, edge });
  };
  for (const edge of pack.edges) {
    addAdjacent(edge.source, edge.target, edge);
    addAdjacent(edge.target, edge.source, edge);
  }

  const seen = new Set([leafId]);
  const related = [];
  let frontier = [leafId];
  let charBudget = budgetTokens * 4;
  for (let level = 1; level <= depth && frontier.length && charBudget > 0; level++) {
    const nextFrontier = [];
    const candidates = [];
    for (const nodeId of frontier) {
      for (const { to, edge } of adjacency.get(nodeId) || []) {
        if (seen.has(to)) continue;
        candidates.push({ to, edge, level });
      }
    }
    // EXTRACTED önce, sonra ağırlık, sonra kararlı sıra — deterministik.
    candidates.sort((a, b) =>
      (a.edge.tier === 'EXTRACTED' ? 0 : 1) - (b.edge.tier === 'EXTRACTED' ? 0 : 1)
      || b.edge.weight - a.edge.weight
      || String(a.to).localeCompare(String(b.to)));
    for (const candidate of candidates) {
      if (seen.has(candidate.to)) continue;
      seen.add(candidate.to);
      const leaf = byId.get(candidate.to);
      const entry = leaf
        ? { id: leaf.id, headline: leaf.headline, file: leaf.file, branch: leaf.branch, date: leaf.date, tier: candidate.edge.tier, via: candidate.edge.kind, level }
        : { id: candidate.to, headline: null, tier: candidate.edge.tier, via: candidate.edge.kind, level };
      const cost = JSON.stringify(entry).length;
      if (charBudget - cost < 0) { charBudget = 0; break; }
      charBudget -= cost;
      related.push(entry);
      nextFrontier.push(candidate.to);
    }
    frontier = nextFrontier;
  }
  return { origin: leafId, budgetTokens, depth, related };
}
