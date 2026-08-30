/**
 * memory-query.mjs — tek çağrılık soru cevaplama ve kavram-yolu bulma.
 *
 * graphify'ın `query` ve `path` komutlarının Urðr karşılığı; fark, cevabın
 * denetlenebilir olması: her satır yaprak id'si ve kanıt katmanı taşır,
 * hiçbir adımda LLM yoktur. Cevap ham dosya değil, bütçeyle kırpılmış
 * altgrafiktir — token ekonomisinin sorgu tarafı.
 */
import { loadPack, readLeavesById, relatedLeaves, estimateTokens } from './context-pack.mjs';
import { searchMemory } from '../search.mjs';

/**
 * Soru → tohum yapraklar (arama) → komşuluk genişletmesi → bütçeli cevap.
 * Dönen yapı hem makine-okur (leaves/related) hem insan-okur (markdown) verir.
 */
export function askMemory(memoryDir, question, opts = {}) {
  const budgetTokens = Number.isFinite(opts.budgetTokens) ? Math.max(100, opts.budgetTokens) : 700;
  const pack = loadPack(memoryDir);
  // Kademeli gevşetme: arama katmanı bilinçli olarak BÜTÜN kelimeleri ister
  // (yanlış pozitif önleme); sorularsa fazladan kelime taşır ("ne durumda",
  // "kampanyası"). Tam soru boş dönerse en uzun iki kelimeyle, o da boşsa
  // en uzun tek kelimeyle yeniden denenir — deterministik merdiven.
  const kelimeler = [...question.matchAll(/[\p{L}\p{N}]{3,}/gu)].map((m) => m[0])
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const denemeler = [question];
  if (kelimeler.length >= 2) denemeler.push(`${kelimeler[0]} ${kelimeler[1]}`);
  if (kelimeler.length >= 1) denemeler.push(kelimeler[0]);
  let found = { count: 0, results: [] };
  let usedQuery = question;
  for (const deneme of denemeler) {
    found = searchMemory(memoryDir, deneme, { maxResults: 8 });
    if (!found.error && found.count > 0) { usedQuery = deneme; break; }
  }
  if (found.error || found.count === 0) {
    return { question, budgetTokens, seeds: [], leaves: [], related: [],
      markdown: found.error ? `⚠️ ${found.error}` : 'Eşleşme yok — bu bilgi henüz kaydedilmemiş olabilir.' };
  }
  // arama sonuçlarını paketteki yapraklara bağla (id varsa id, yoksa dosya+satır)
  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  const byPos = new Map(pack.leaves.map((leaf) => [`${leaf.file}#${leaf.line}`, leaf]));
  const seeds = [];
  for (const result of found.results) {
    const leaf = (result.id && byId.get(result.id)) || byPos.get(`${result.file}#${result.line}`);
    if (leaf && !seeds.includes(leaf)) seeds.push(leaf);
    if (seeds.length >= 4) break;
  }
  if (seeds.length === 0) {
    return { question, budgetTokens, seeds: [], leaves: [], related: [],
      markdown: 'Eşleşme yok — bu bilgi henüz kaydedilmemiş olabilir.' };
  }

  // Bütçe bölüşümü: ~%60 tohum tam metinleri, ~%40 komşuluk başlıkları.
  const readBudgetChars = budgetTokens * 4 * 0.6;
  const chosen = [];
  let used = 0;
  for (const seed of seeds) {
    if (used + seed.chars > readBudgetChars && chosen.length > 0) break;
    chosen.push(seed);
    used += seed.chars;
  }
  const fullLeaves = readLeavesById(memoryDir, chosen.map((leaf) => leaf.id));

  const relatedBudget = Math.max(80, Math.floor(budgetTokens * 0.4));
  const seen = new Set(chosen.map((leaf) => leaf.id));
  const related = [];
  for (const seed of chosen) {
    const neighborhood = relatedLeaves(pack, seed.id, {
      budgetTokens: Math.floor(relatedBudget / chosen.length), depth: 2,
    });
    for (const entry of neighborhood.related || []) {
      if (entry.headline && !seen.has(entry.id)) { seen.add(entry.id); related.push(entry); }
    }
  }

  const tr = pack.language === 'tr';
  const lines = [tr ? `# Soru: ${question}` : `# Question: ${question}`];
  if (usedQuery !== question) lines.push(tr ? `_eşleşen sorgu: "${usedQuery}"_` : `_matched query: "${usedQuery}"_`);
  lines.push('');
  for (const leaf of fullLeaves) {
    if (leaf.error) continue;
    lines.push(`## ${leaf.file} › ${leaf.branch}${leaf.date ? ` · ${leaf.date}` : ''}`);
    lines.push(leaf.text, '', `\`${leaf.id}\``, '');
  }
  if (related.length) {
    lines.push(tr ? '## Bağlantılı (başlıklar)' : '## Related (headlines)');
    for (const entry of related.slice(0, 10)) {
      lines.push(`- ${entry.headline} — ${entry.tier}/${entry.via} \`${entry.id}\``);
    }
  }
  let markdown = lines.join('\n');
  if (estimateTokens(markdown) > budgetTokens) markdown = markdown.slice(0, budgetTokens * 4 - 2) + '…';
  return {
    question, budgetTokens,
    seeds: chosen.map((leaf) => leaf.id),
    leaves: fullLeaves,
    related: related.slice(0, 10),
    tokensApprox: estimateTokens(markdown),
    markdown,
  };
}

/** Sorguyu tek yaprağa çözer: aramanın en iyi, pakette bulunan sonucu. */
function resolveLeaf(memoryDir, pack, query) {
  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  const byPos = new Map(pack.leaves.map((leaf) => [`${leaf.file}#${leaf.line}`, leaf]));
  if (byId.has(query)) return byId.get(query);          // doğrudan id verilebilir
  const found = searchMemory(memoryDir, query, { maxResults: 5 });
  for (const result of found.results || []) {
    const leaf = (result.id && byId.get(result.id)) || byPos.get(`${result.file}#${result.line}`);
    if (leaf) return leaf;
  }
  return null;
}

/**
 * İki kavram arasındaki en ucuz yol (Dijkstra). Kenar maliyeti kanıt gücüne
 * göre: EXTRACTED=1 (açık referans), member=2 (yapısal), INFERRED=3
 * (komşuluk) — yol tercihen açık referanslardan geçer ve her adım nedenini
 * (via/tier) taşır.
 */
export function pathBetween(memoryDir, fromQuery, toQuery) {
  const pack = loadPack(memoryDir);
  const from = resolveLeaf(memoryDir, pack, fromQuery);
  const to = resolveLeaf(memoryDir, pack, toQuery);
  if (!from || !to) {
    return { error: !from ? `başlangıç bulunamadı: ${fromQuery}` : `hedef bulunamadı: ${toQuery}`, path: [] };
  }
  if (from.id === to.id) return { from: from.id, to: to.id, path: [{ id: from.id, headline: from.headline }] };

  const cost = { EXTRACTED: 1, INFERRED: 3 };
  const adjacency = new Map();
  const addAdjacent = (a, b, edge) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push({ to: b, edge, w: edge.kind === 'member' ? 2 : (cost[edge.tier] ?? 3) });
  };
  for (const edge of pack.edges) { addAdjacent(edge.source, edge.target, edge); addAdjacent(edge.target, edge.source, edge); }

  const dist = new Map([[from.id, 0]]);
  const prev = new Map();
  const queue = [[0, from.id]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])));  // determinizm
    const [d, node] = queue.shift();
    if (node === to.id) break;
    if (d > (dist.get(node) ?? Infinity)) continue;
    for (const { to: next, edge, w } of adjacency.get(node) || []) {
      const nd = d + w;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd); prev.set(next, { node, edge });
        queue.push([nd, next]);
      }
    }
  }
  if (!prev.has(to.id)) return { from: from.id, to: to.id, path: [], error: 'yol yok — iki yaprak arasında hiçbir kenar zinciri bulunamadı' };

  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  const chain = [];
  let cursor = to.id;
  while (cursor) {
    const leaf = byId.get(cursor);
    const step = prev.get(cursor);
    chain.push({
      id: cursor,
      headline: leaf ? leaf.headline : cursor.replace(/^branch:/, '↳ dal: ').replace('::', ' › '),
      via: step ? step.edge.kind : null,
      tier: step ? step.edge.tier : null,
    });
    cursor = step ? step.node : null;
  }
  chain.reverse();
  return { from: from.id, to: to.id, cost: dist.get(to.id), hops: chain.length - 1, path: chain };
}
