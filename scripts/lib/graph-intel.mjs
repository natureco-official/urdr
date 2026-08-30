/**
 * graph-intel.mjs — bellek grafiği üzerinde deterministik topluluk tespiti
 * ve yapı analizi. Sıfır bağımlılık, sıfır rastgelelik: aynı paket her
 * makinede aynı toplulukları verir (düğümler sıralı gezilir, eşitlikler
 * sözlük sırasıyla kırılır).
 *
 * Louvain (modülerlik optimizasyonu) — graphify'ın Leiden/Louvain katmanının
 * Urðr'e uyan hâli. Girdi paketin kenarlarıdır; `member` kenarları kümelemeye
 * SOKULMAZ (her yaprağı kendi dalına yapıştırıp analizi totolojiye çevirirdi).
 * Böylece bulunan topluluklar dal sınırlarını AŞTIĞINDA gerçek bilgi taşır:
 * "bu üç dal aslında tek konu" sinyali göz kararı değil matematiktir.
 */

function neighborWeights(edges, allowedKinds) {
  const adjacency = new Map();
  const addWeight = (a, b, w) => {
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    const row = adjacency.get(a);
    row.set(b, (row.get(b) || 0) + w);
  };
  for (const edge of edges) {
    if (!allowedKinds.has(edge.kind)) continue;
    if (edge.source === edge.target) continue;
    addWeight(edge.source, edge.target, edge.weight);
    addWeight(edge.target, edge.source, edge.weight);
  }
  return adjacency;
}

/** Tek seviyeli Louvain geçişi: yerel modülerlik kazancıyla taşıma. */
function louvainPass(nodes, adjacency, totalWeight) {
  const community = new Map(nodes.map((node) => [node, node]));
  const communityWeight = new Map();   // topluluğa giren toplam kenar ağırlığı (2m payı)
  const nodeStrength = new Map();
  for (const node of nodes) {
    let strength = 0;
    for (const weight of (adjacency.get(node) || new Map()).values()) strength += weight;
    nodeStrength.set(node, strength);
    communityWeight.set(node, strength);
  }
  if (totalWeight === 0) return { community, moved: false };

  let movedAny = false;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (const node of nodes) {
      const current = community.get(node);
      const strength = nodeStrength.get(node);
      communityWeight.set(current, communityWeight.get(current) - strength);

      // komşu topluluklara bağlantı ağırlıkları
      const links = new Map();
      for (const [neighbor, weight] of adjacency.get(node) || []) {
        const target = community.get(neighbor);
        links.set(target, (links.get(target) || 0) + weight);
      }
      let bestCommunity = current;
      let bestGain = 0;
      const candidates = [...links.keys()].sort();  // determinizm
      for (const candidate of candidates) {
        const gain = links.get(candidate) - (communityWeight.get(candidate) * strength) / (2 * totalWeight);
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && candidate < bestCommunity)) {
          if (gain > 0) { bestGain = gain; bestCommunity = candidate; }
        }
      }
      communityWeight.set(bestCommunity, (communityWeight.get(bestCommunity) || 0) + strength);
      if (bestCommunity !== current) {
        community.set(node, bestCommunity);
        improved = true;
        movedAny = true;
      }
    }
  }
  return { community, moved: movedAny };
}

/**
 * Tam Louvain: geçiş + topluluk grafiğine katlama, hareket durana dek.
 * Dönen harita: düğüm → topluluk etiketi (deterministik, en küçük üye id'si).
 */
export function detectCommunities(pack, opts = {}) {
  const allowedKinds = new Set(opts.kinds || ['edge', 'bkz', 'sibling']);
  // bkz: kenarları dal düğümünde biter; member kenarları kümelemeye girmediği
  // için (her yaprağı dalına yapıştırıp analizi totolojiye çevirirdi) çapraz-kök
  // sinyal kopuk kalırdı. Dal hedefi burada dalın TEMSİLCİ yaprağına çözülür
  // (en yüksek derece, eşitlikte en küçük id) — görselleştirmeyle aynı kural.
  const temsilci = new Map();
  for (const leaf of pack.leaves) {
    const key = `branch:${leaf.file}::${leaf.branch}`;
    const current = temsilci.get(key);
    if (!current || leaf.degree > current.degree
        || (leaf.degree === current.degree && leaf.id < current.id)) temsilci.set(key, leaf);
  }
  const cozulmus = pack.edges.map((edge) => {
    const source = temsilci.get(edge.source)?.id ?? edge.source;
    const target = temsilci.get(edge.target)?.id ?? edge.target;
    return source === target ? null : { ...edge, source, target };
  }).filter(Boolean);
  let adjacency = neighborWeights(cozulmus, allowedKinds);
  let nodes = [...adjacency.keys()].sort();
  let assignment = new Map(nodes.map((node) => [node, node]));

  for (let level = 0; level < 10; level++) {
    let totalWeight = 0;
    for (const row of adjacency.values()) for (const weight of row.values()) totalWeight += weight;
    totalWeight /= 2;
    const { community, moved } = louvainPass(nodes, adjacency, totalWeight);
    if (!moved && level > 0) break;

    // düğüm → üst topluluk; assignment'ı katla
    for (const [node, parent] of assignment) assignment.set(node, community.get(parent) ?? parent);
    if (!moved) break;

    // topluluk grafiğine katla
    const folded = new Map();
    for (const [source, row] of adjacency) {
      const from = community.get(source);
      for (const [target, weight] of row) {
        const to = community.get(target);
        if (from === to) continue;
        if (!folded.has(from)) folded.set(from, new Map());
        const fromRow = folded.get(from);
        fromRow.set(to, (fromRow.get(to) || 0) + weight);
      }
    }
    adjacency = folded;
    nodes = [...adjacency.keys()].sort();
  }

  // etiketleri kararlılaştır: topluluk = en küçük üye id'si
  const members = new Map();
  for (const [node, label] of assignment) {
    if (!members.has(label)) members.set(label, []);
    members.get(label).push(node);
  }
  const canonical = new Map();
  for (const [label, list] of members) {
    list.sort();
    canonical.set(label, list[0]);
  }
  const result = new Map();
  for (const [node, label] of assignment) result.set(node, canonical.get(label));
  return result;
}

/** Topluluk özetleri: ad (en yüksek dereceli yaprağın başlığı), üye sayısı, dal yayılımı. */
export function summarizeCommunities(pack, assignment) {
  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  const groups = new Map();
  for (const [node, label] of assignment) {
    const leaf = byId.get(node);
    if (!leaf) continue;                       // dal/kök düğümleri özetlenmez
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(leaf);
  }
  const summaries = [];
  for (const [label, leaves] of groups) {
    if (leaves.length < 2) continue;
    leaves.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
    const branches = [...new Set(leaves.map((leaf) => `${leaf.file} › ${leaf.branch}`))];
    summaries.push({
      label,
      name: leaves[0].headline,
      size: leaves.length,
      branches,
      crossBranch: branches.length > 1,
      memberIds: leaves.map((leaf) => leaf.id),
    });
  }
  summaries.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
  return summaries;
}

/** Çapraz-kök EXTRACTED kenarlar: en değerli "şaşırtıcı bağlantı" adayları. */
export function surprisingConnections(pack, limit = 10) {
  const byId = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
  const scored = [];
  for (const edge of pack.edges) {
    if (edge.tier !== 'EXTRACTED' || edge.kind === 'member') continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const sourceFile = source?.file || String(edge.source).replace(/^branch:/, '').split('::')[0];
    const targetFile = target?.file || String(edge.target).replace(/^branch:/, '').split('::')[0];
    if (sourceFile === targetFile) continue;
    scored.push({
      weight: edge.weight,
      kind: edge.kind,
      from: source ? { id: source.id, headline: source.headline, file: source.file } : { id: edge.source },
      to: target ? { id: target.id, headline: target.headline, file: target.file } : { id: edge.target },
    });
  }
  scored.sort((a, b) => b.weight - a.weight
    || String(a.from.id).localeCompare(String(b.from.id))
    || String(a.to.id).localeCompare(String(b.to.id)));
  return scored.slice(0, limit);
}

/** İnsan-okur rapor: Yggdrasil'in röntgeni. */
export function buildReport(pack, assignment) {
  const tr = pack.language === 'tr';
  const summaries = summarizeCommunities(pack, assignment);
  const cross = summaries.filter((community) => community.crossBranch);
  const god = [...pack.leaves].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, 8).filter((leaf) => leaf.degree > 0);
  const surprises = surprisingConnections(pack, 8);

  const lines = [
    tr ? '# URDR RAPORU' : '# URDR REPORT', '',
    tr ? `_${pack.leaves.length} yaprak · ${pack.edges.length} kenar · damga \`${pack.stamp.slice(0, 12)}\`_`
       : `_${pack.leaves.length} leaves · ${pack.edges.length} edges · stamp \`${pack.stamp.slice(0, 12)}\`_`, '',
    tr ? '## Tanrı düğümleri (her şey buradan geçiyor)' : '## God nodes (everything routes through these)',
  ];
  if (god.length === 0) lines.push(tr ? '- yok' : '- none');
  for (const leaf of god) lines.push(`- ${leaf.headline} — ${leaf.degree}° · ${leaf.file} › ${leaf.branch} \`${leaf.id}\``);

  lines.push('', tr ? '## Dal sınırını aşan topluluklar' : '## Communities crossing branch boundaries');
  if (cross.length === 0) lines.push(tr ? '- yok — dallar konularıyla örtüşüyor' : '- none — branches match their topics');
  for (const community of cross.slice(0, 6)) {
    lines.push(`- **${community.name}** — ${community.size} ${tr ? 'yaprak' : 'leaves'}: ${community.branches.join(' + ')}`);
  }

  lines.push('', tr ? '## Şaşırtıcı bağlantılar (çapraz kök, açık referans)' : '## Surprising connections (cross-root, explicit)');
  if (surprises.length === 0) lines.push(tr ? '- yok' : '- none');
  for (const edge of surprises) {
    lines.push(`- ${edge.from.headline || edge.from.id} → ${edge.to.headline || edge.to.id} _(${edge.kind})_`);
  }

  lines.push('', tr
    ? '_Bu rapor deterministiktir: LLM yok, rastgelelik yok; aynı ağaç aynı raporu üretir._'
    : '_This report is deterministic: no LLM, no randomness; the same tree yields the same report._');
  return lines.join('\n');
}
