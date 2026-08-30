#!/usr/bin/env node
/**
 * tree.mjs — Urðr Tree: belleğin tamamının etkileşimli haritası.
 *
 *   node scripts/tree.mjs [memoryDir]            .urdr/tree.html üret
 *   node scripts/tree.mjs [memoryDir] --serve    yerel bağlantıdan sun
 *                                                (http://127.0.0.1:PORT)
 *   node scripts/tree.mjs [memoryDir] --serve --port 4177
 *
 * Tek dosya HTML: CDN yok, ağ isteği yok, veri gömülü — beyin makineden
 * çıkmaz. Canvas kuvvet yerleşimi, topluluk paneli (Louvain), EXTRACTED/
 * INFERRED katman filtresi, arama, tıkla-incele. --serve modunda
 * /data.json her istekte paketi tazeler: yeni yaprak eklendiyse
 * tarayıcıda ↻ yeterlidir.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from './lib/context-pack.mjs';
import { detectCommunities, summarizeCommunities } from './lib/graph-intel.mjs';

/**
 * Birim küre yönünü insan beyni yüzeyine yansıtır (sagital profil tablosu +
 * elips enine kesit + boyuna yarık + korteks kırışıklığı). Hem veri düğümleri
 * hem doku parçacıkları aynı fonksiyondan geçer — form tek kaynaktan.
 */
const BEYIN_PROFIL = [
  [-180, 0.92], [-162, 0.96], [-146, 1.00], [-132, 0.94],
  [-118, 0.82], [-104, 0.68], [-92, 0.74], [-78, 0.88],
  [-62, 1.00], [-48, 1.02], [-34, 0.84], [-18, 0.74],
  [-6, 0.84], [0, 0.94], [14, 1.05], [34, 1.09],
  [56, 1.06], [76, 1.00], [92, 0.95], [112, 0.99],
  [132, 1.05], [152, 1.08], [166, 1.03], [180, 0.92],
];
export function beyinYuzeyi(x, y, z, i) {
  const alfa = Math.atan2(y, z) * 180 / Math.PI;
  let s1 = BEYIN_PROFIL[0][1];
  for (let k = 1; k < BEYIN_PROFIL.length; k++) {
    if (alfa <= BEYIN_PROFIL[k][0]) {
      const [a0, r0] = BEYIN_PROFIL[k - 1], [a1, r1] = BEYIN_PROFIL[k];
      s1 = r0 + (r1 - r0) * (alfa - a0) / (a1 - a0);
      break;
    }
  }
  if (alfa > -150 && alfa < -100) s1 += 0.14 * Math.exp(-((alfa + 126) ** 2) / 260);
  const c = Math.sqrt(Math.max(0.06, 1 - x * x));
  let nz = Math.cos(alfa * Math.PI / 180) * s1 * c;
  let ny = Math.sin(alfa * Math.PI / 180) * s1 * c;
  let nx = 0.62 * x;
  if (ny > 0.1) ny -= 0.055 * Math.exp(-(nx * nx) / 0.012);
  const h = Math.sin(i * 12.9898) * 43758.5453;
  const jitter = 1 + ((h - Math.floor(h)) - 0.5) * 0.08;
  return [nx * jitter, ny * jitter, nz * jitter];
}

export function buildTreeData(memoryDir) {
  const pack = loadPack(memoryDir);
  const assignment = detectCommunities(pack);
  const communities = summarizeCommunities(pack, assignment);
  const communityOf = new Map();
  communities.forEach((community, index) => {
    for (const id of community.memberIds) communityOf.set(id, index);
  });
  const nodes = pack.leaves.map((leaf) => ({
    id: leaf.id,
    label: leaf.headline || leaf.id,
    file: leaf.file,
    branch: leaf.branch,
    date: leaf.date,
    degree: leaf.degree,
    community: communityOf.has(leaf.id) ? communityOf.get(leaf.id) : -1,
  }));
  const known = new Set(nodes.map((node) => node.id));
  // bkz: kenarları dal düğümüne gider; görselleştirmede dalın temsilcisine
  // (en yüksek dereceli üye yaprağa) yönlendirilir ki beyin kabuğunda
  // çapraz-kök referanslar gerçek çizgi olarak görünsün.
  const temsilci = new Map();
  for (const leaf of pack.leaves) {
    const key = `branch:${leaf.file}::${leaf.branch}`;
    const current = temsilci.get(key);
    if (!current || leaf.degree > current.degree) temsilci.set(key, leaf);
  }
  const hedefCoz = (id) => known.has(id) ? id : (temsilci.get(id)?.id ?? null);
  const seenLink = new Set();
  const links = [];
  for (const edge of pack.edges) {
    if (edge.kind === 'member') continue;
    const source = hedefCoz(edge.source), target = hedefCoz(edge.target);
    if (!source || !target || source === target) continue;
    const key = source < target ? `${source}|${target}|${edge.kind}` : `${target}|${source}|${edge.kind}`;
    if (seenLink.has(key)) continue;
    seenLink.add(key);
    links.push({ source, target, tier: edge.tier, kind: edge.kind, weight: edge.weight });
  }
  layoutGraph(nodes, links);
  // Doku parçacıkları: görsel yoğunluk veri sayısından bağımsızdır. Referans
  // estetik (Dala) binlerce parçacıkla yüzeyi dokuya çevirir; yapraklar az
  // olsa bile kabuk dolu görünür. Deterministik (sabit tohum), tıklanamaz.
  const dokular = [];
  let tohum = 42;
  const rnd = () => { tohum = (tohum * 1664525 + 1013904223) >>> 0; return tohum / 0xffffffff; };
  const dokuSayisi = Math.min(14000, Math.max(6500, nodes.length * 10));
  const kabukNokta = (t, u) => {
    // nodes ile aynı beyin projeksiyonu: sagital profil + elips kesit
    const phi = Math.acos(1 - 2 * t);
    const theta = u * 2 * Math.PI;
    return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
  };
  for (let d = 0; d < dokuSayisi; d++) {
    const [x0, y0, z0] = kabukNokta(rnd(), rnd());
    const derinKatman = rnd();                    // 0=iç, 1=kabuk üstü serpinti
    const radyal = 0.86 + derinKatman * 0.22 + (rnd() - 0.5) * 0.08;
    const donusmus = beyinYuzeyi(x0, y0, z0, d);
    dokular.push({
      sx: Math.round(donusmus[0] * radyal * 1000) / 1000,
      sy: Math.round(donusmus[1] * radyal * 1000) / 1000,
      sz: Math.round(donusmus[2] * radyal * 1000) / 1000,
      boy: Math.round((1.2 + rnd() * 3.4) * 10) / 10,
      renk: Math.round(rnd() * 100) / 100,
      don: Math.round(rnd() * 6.28 * 100) / 100,
    });
  }
  // Yerellik koruyan sarmal: ardışık indeksler kürede KOMŞUDUR. Böylece
  // topluluklar bitişik şerit-yamalar oluşturur (Dala'daki renk bölgeleri),
  // aynı-dal kardeş kenarları kısa yüzey lifleri olur — korteks kıvrımı etkisi.
  // (Altın açı bunun tersiydi: ardışık indeksler 137° zıplıyordu, lifler
  // kabuğu boydan boya kat eden karmaşaya dönüyordu.)
  const sirali = [...nodes].sort((a, b) => a.community - b.community
    || a.file.localeCompare(b.file) || (a.branch || '').localeCompare(b.branch || '')
    || a.id.localeCompare(b.id));
  const tur = Math.max(6, Math.round(Math.sqrt(sirali.length) * 0.9));
  sirali.forEach((node, i) => {
    const t = (i + 0.5) / sirali.length;
    const phi = Math.acos(1 - 2 * t);
    const theta = t * tur * 2 * Math.PI;
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = Math.sin(phi) * Math.sin(theta);
    const [nx, ny, nz] = beyinYuzeyi(x, y, z, i);
    node.sx = Math.round(nx * 1000) / 1000;
    node.sy = Math.round(ny * 1000) / 1000;
    node.sz = Math.round(nz * 1000) / 1000;
  });
  return {
    generatedAt: pack.generatedAt,
    stamp: pack.stamp,
    language: pack.language,
    stats: { leaves: pack.leaves.length, edges: pack.edges.length, roots: pack.roots.length },
    communities: communities.map((community, index) => ({
      index, name: community.name, size: community.size, crossBranch: community.crossBranch,
    })),
    nodes,
    links,
    dokular,
  };
}

/**
 * Deterministik kuvvet yerleşimi (Fruchterman-Reingold + soğutma), Node
 * tarafında koşar. Tarayıcı hazır koordinat alır: ilk kare bitmiş haritadır,
 * requestAnimationFrame'e ve sekme görünürlüğüne bağımlılık yoktur ve aynı
 * ağaç her makinede aynı haritayı verir (test edilebilir).
 */
export function layoutGraph(nodes, links, { iterations = 260, area = 1200 } = {}) {
  const n = nodes.length;
  if (n === 0) return;
  const k = Math.sqrt((area * area) / n);          // ideal mesafe
  // altın açı sarmalı — deterministik başlangıç, bindirmesiz
  nodes.forEach((node, i) => {
    const r = 8 * Math.sqrt(i + 1);
    node.x = Math.cos(i * 2.39996) * r;
    node.y = Math.sin(i * 2.39996) * r;
  });
  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  const pairs = links
    .map((link) => [idx.get(link.source), idx.get(link.target), link.weight || 1])
    .filter(([a2, b2]) => a2 !== undefined && b2 !== undefined && a2 !== b2);

  const dispX = new Float64Array(n), dispY = new Float64Array(n);
  for (let iter = 0; iter < iterations; iter++) {
    const sicaklik = area * 0.09 * (1 - iter / iterations) + 1;
    dispX.fill(0); dispY.fill(0);
    // itme — ızgara yaklaşımı
    const hucre = k * 2.2, izgara = new Map();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(nodes[i].x / hucre)}:${Math.floor(nodes[i].y / hucre)}`;
      if (!izgara.has(key)) izgara.set(key, []);
      izgara.get(key).push(i);
    }
    for (const [key, list] of izgara) {
      const [gx, gy] = key.split(':').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const near = izgara.get(`${gx + dx}:${gy + dy}`);
        if (!near) continue;
        for (const i of list) for (const j of near) {
          if (j <= i) continue;
          let ddx = nodes[i].x - nodes[j].x, ddy = nodes[i].y - nodes[j].y;
          let d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < 0.01) { ddx = ((i * 37 + j) % 13) - 6; ddy = ((i * 17 + j) % 11) - 5; d = Math.sqrt(ddx*ddx+ddy*ddy) || 1; }
          if (d > hucre) continue;
          const f = (k * k) / d / d;
          dispX[i] += (ddx / d) * f * k * 0.08; dispY[i] += (ddy / d) * f * k * 0.08;
          dispX[j] -= (ddx / d) * f * k * 0.08; dispY[j] -= (ddy / d) * f * k * 0.08;
        }
      }
    }
    // çekme — kenarlar
    for (const [a2, b2, w] of pairs) {
      const dx = nodes[b2].x - nodes[a2].x, dy = nodes[b2].y - nodes[a2].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d * d) / k * 0.0016 * Math.min(3, w);
      dispX[a2] += (dx / d) * f; dispY[a2] += (dy / d) * f;
      dispX[b2] -= (dx / d) * f; dispY[b2] -= (dy / d) * f;
    }
    // hafif merkez çekimi + sıcaklıkla sınırlı adım
    for (let i = 0; i < n; i++) {
      dispX[i] -= nodes[i].x * 0.004; dispY[i] -= nodes[i].y * 0.004;
      const d = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 1;
      const step = Math.min(d, sicaklik);
      nodes[i].x += (dispX[i] / d) * step;
      nodes[i].y += (dispY[i] / d) * step;
    }
  }
  // koordinatları yuvarla — data.json küçülür, determinizm gözle doğrulanır
  for (const node of nodes) { node.x = Math.round(node.x * 10) / 10; node.y = Math.round(node.y * 10) / 10; }
}

const HTML_TEMPLATE = /* html */ `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Urðr Tree</title>
<style>
  /* Dala tasarım dili: saf siyah boşluk, tek mor vurgu, amber kıvılcım.
     Panel yok, kart yok — siyah üstünde yüzen yazı; hiyerarşi ağırlıkla
     değil ölçekle kurulur. */
  :root {
    --void:#000000; --bone:#ffffff; --ash:#9a9a9a; --mist:#bdbdbd;
    --iris:#8052ff; --saffron:#ffb829; --verdant:#15846e;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--void); color:var(--bone);
         font:400 15px/1.5 Inter, system-ui, sans-serif; overflow:hidden; }
  #sahne { position:fixed; inset:0; }
  #yan { position:fixed; top:0; right:0; bottom:0; width:316px; padding:36px 30px;
         overflow-y:auto; background:linear-gradient(270deg, rgba(0,0,0,.92) 70%, transparent); }
  h1 { font-size:42px; font-weight:400; letter-spacing:-1.68px; line-height:1.1; }
  h1 b { color:var(--iris); font-weight:400; }
  .alt { color:var(--ash); font-size:14px; margin:6px 0 24px; }
  #ara { width:100%; padding:10px 0; border:0; border-bottom:1px solid #222;
         background:transparent; color:var(--bone); font:200 18px/1.4 Inter, system-ui, sans-serif; }
  #ara::placeholder { color:#555; }
  #ara:focus { outline:none; border-bottom-color:var(--iris); }
  .bolum { font-size:12px; font-weight:600; letter-spacing:.35px; text-transform:uppercase;
           color:var(--ash); margin:30px 0 12px; }
  .mod { display:flex; gap:6px; margin-top:24px; }
  .mod button { flex:1; padding:8px 0; border-radius:9999px; border:1px solid #222;
                background:transparent; color:var(--ash); font:600 13px Inter, system-ui, sans-serif;
                letter-spacing:.3px; cursor:pointer; }
  .mod button.aktif { background:var(--iris); border-color:var(--iris); color:var(--bone); }
  label.katman { display:flex; gap:10px; align-items:center; font-size:14px;
                 color:var(--mist); padding:4px 0; cursor:pointer; font-weight:200; }
  label.katman input { accent-color: var(--iris); }
  .top { display:flex; align-items:center; gap:10px; padding:5px 0; cursor:pointer;
         font-size:14px; font-weight:200; color:var(--mist); }
  .top:hover { color:var(--bone); }
  .top.kapali { opacity:.3; }
  .nokta { width:8px; height:8px; border-radius:50%; flex:none; }
  .top .say { margin-left:auto; color:var(--ash); font-variant-numeric:tabular-nums; font-size:13px; }
  #detay { margin-top:30px; display:none; }
  #detay .baslik { font-size:18px; font-weight:400; line-height:1.3; margin-bottom:8px; }
  #detay .meta { color:var(--ash); font-size:13px; font-weight:200; }
  #detay code { display:block; margin-top:12px; color:var(--saffron); font-size:11px;
                word-break:break-all; cursor:copy; font-family:ui-monospace, monospace; }
  #durum { position:fixed; left:30px; bottom:24px; color:#555; font-size:12px; }
  #yenile { position:fixed; left:30px; top:30px; padding:8px 20px; border-radius:9999px;
            border:1px solid #222; background:transparent; color:var(--ash);
            font:600 13px Inter, system-ui, sans-serif; letter-spacing:.3px; cursor:pointer; }
  #yenile:hover { color:var(--bone); border-color:var(--iris); }
</style>
</head>
<body>
<canvas id="sahne"></canvas>
<button id="yenile" title="Paketi tazele">↻ YENİLE</button>
<aside id="yan">
  <h1>Urðr <b>Tree</b></h1>
  <div class="alt" id="ozet"></div>
  <input id="ara" placeholder="Yaprak ara…" spellcheck="false">
  <div class="mod">
    <button id="modBeyin" class="aktif">BEYİN</button>
    <button id="modAg">AĞ</button>
  </div>
  <div class="bolum">Katmanlar</div>
  <label class="katman"><input type="checkbox" id="kx" checked> <span style="color:var(--verdant)">EXTRACTED</span>&nbsp;— açık referans</label>
  <label class="katman"><input type="checkbox" id="ki" checked> <span>INFERRED</span>&nbsp;— komşuluk</label>
  <div class="bolum">Topluluklar</div>
  <div id="toplar"></div>
  <div id="detay"></div>
</aside>
<div id="durum"></div>
<script>
const VERI = __DATA__;
/* Dala paleti çevresinde topluluk renkleri: iris, saffron, verdant + türevler */
const RENKLER = ['#8052ff','#ffb829','#15846e','#b18cff','#ff8329','#3fb9a0',
                 '#5c7cfa','#ffd166','#7ee787','#d2a8ff','#76e3ea','#f778ba'];
const canvas = document.getElementById('sahne');
const ctx = canvas.getContext('2d');
let W, H, DPR = Math.min(devicePixelRatio || 1, 2);
function boyutla(){ W=innerWidth; H=innerHeight; canvas.width=W*DPR; canvas.height=H*DPR;
  canvas.style.width=W+'px'; canvas.style.height=H+'px'; ctx.setTransform(DPR,0,0,DPR,0,0); }
addEventListener('resize', boyutla); boyutla();

const N = VERI.nodes;
const idx = new Map(N.map((n,i)=>[n.id,i]));
const L = VERI.links.map(l=>({ ...l, a:idx.get(l.source), b:idx.get(l.target) }));
const acikTop = new Set(VERI.communities.map(c=>c.index)); acikTop.add(-1);
let gorX=true, gorI=true, arama='', secili=null, mod='beyin';
let salinim=0; let aci=1.5708, egim=-0.06, elleAci=false, zoom=1, panX=0, panY=0;

function gorunur(n){
  if (!acikTop.has(n.community)) return false;
  if (arama && !((n.label||'').toLowerCase().includes(arama) || (n.branch||'').toLowerCase().includes(arama))) return false;
  return true;
}
function bagGorunur(l){
  if (l.tier==='EXTRACTED' && !gorX) return false;
  if (l.tier==='INFERRED' && !gorI) return false;
  return gorunur(N[l.a]) && gorunur(N[l.b]);
}

/* ── BEYİN: doku parçacıklı, ışıklı kabuk (Dala estetiği) ──
   Katmanlar: (1) arka plan serpintisi, (2) ekleme-karışımlı doku üçgenleri
   — içi boş konturlar, ışık yönlü parlaklık, (3) sinir yolları, (4) veri
   düğümleri (tıklanabilir, dolu). Işık sağ-üst-önden gelir; sol-alt karanlığa
   gömülür — hacim hissinin kaynağı budur. */
const P = new Array(N.length);
const DOKU = VERI.dokular || [];
const SERPINTI = [];
{ let t=7; const r=()=>{ t=(t*1664525+1013904223)>>>0; return t/0xffffffff; };
  for (let i=0;i<220;i++) SERPINTI.push({x:r(), y:r(), b:0.6+r()*2.6, a:0.04+r()*0.10, d:r()*6.28}); }
const DOKU_RENK = (v) => v<0.42 ? '128,82,255' : v<0.68 ? '255,184,41' : v<0.80 ? '255,255,255' : v<0.92 ? '189,189,189' : '21,132,110';
function ucgen(x, y, r, don){
  ctx.beginPath();
  ctx.moveTo(x+Math.cos(don)*r, y+Math.sin(don)*r);
  ctx.lineTo(x+Math.cos(don+2.09)*r, y+Math.sin(don+2.09)*r);
  ctx.lineTo(x+Math.cos(don+4.19)*r, y+Math.sin(don+4.19)*r);
  ctx.closePath();
}
function beyinCiz(){
  const cx=(W-316)*0.47, cy=H*0.52, R=Math.min((W-316)*0.40, H*0.44)*zoom;
  const cosA=Math.cos(aci), sinA=Math.sin(aci), cosE=Math.cos(egim), sinE=Math.sin(egim);
  const F=3.4;
  const don3 = (n) => {
    const X=n.sx*cosA + n.sz*sinA, Z=-n.sx*sinA + n.sz*cosA, Y=n.sy;
    const Y2=Y*cosE - Z*sinE, Z2=Y*sinE + Z*cosE;
    const olcek=F/(F-Z2);
    return { x:cx+panX+X*R*olcek, y:cy+panY+Y2*R*olcek, z:Z2, olcek };
  };
  // ışık yönü (ekran uzayı, sağ-üst-ön) — parçacık normali ≈ konum yönü
  const isik = (n, q) => {
    const L=Math.sqrt(n.sx*n.sx+n.sy*n.sy+n.sz*n.sz)||1;
    const X=(n.sx*cosA+n.sz*sinA)/L, Y=n.sy/L;
    const Y2=Y*cosE - (q?0:0);
    return Math.max(0.10, 0.52 + 0.48*(X*0.55 - Y2*0.62 + q*0.45));
  };
  // 1) arka plan serpintisi
  for (const sp of SERPINTI){
    ctx.globalAlpha = sp.a;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 0.8;
    ucgen(sp.x*W, sp.y*H, sp.b*2.2, sp.d); ctx.stroke();
  }
  // 2) doku katmanı — ekleme karışımı: üst üste binen konturlar kendiliğinden parlar
  ctx.globalCompositeOperation='lighter';
  for (const d of DOKU){
    const q=don3(d);
    const derinlik = (q.z+1.3)/2.3;
    // ekran-uzayı ışık düşüşü: sağ-üst parlak, sol-alt karanlığa gömülür
    const ekranIsik = Math.max(0.06, Math.min(1, ((q.x-cx)/R*0.45 - (q.y-cy)/R*0.65 + 0.72)/1.35));
    const parlak = isik(d, q.z) * (0.24 + 0.76*derinlik) * (0.35 + 0.85*ekranIsik);
    const boyut = d.boy * q.olcek * (0.75 + 0.5*derinlik);
    ctx.globalAlpha = Math.min(0.85, 0.10 + 0.55*parlak);
    ctx.strokeStyle = 'rgba(' + DOKU_RENK(d.renk) + ',' + (0.35 + 0.5*parlak).toFixed(2) + ')';
    ctx.lineWidth = 0.9;
    ucgen(q.x, q.y, boyut, d.don + aci*0.35);
    ctx.stroke();
  }
  // 3) sinir yolları
  ctx.globalCompositeOperation='source-over';
  ctx.globalAlpha = 1;
  for (const l of L){
    if (!bagGorunur(l)) continue;
    const na=N[l.a], nb=N[l.b];
    const a=P[l.a]=don3(na), b=P[l.b]=don3(nb);
    const derin=Math.min(a.z,b.z);
    if (derin < -0.35) continue;
    let mx3=(na.sx+nb.sx)/2, my3=(na.sy+nb.sy)/2, mz3=(na.sz+nb.sz)/2;
    const ml=Math.sqrt(mx3*mx3+my3*my3+mz3*mz3)||1;
    const kiris=Math.sqrt((na.sx-nb.sx)**2+(na.sy-nb.sy)**2+(na.sz-nb.sz)**2);
    const it=(1 + 0.30*Math.min(1.4, kiris))/ml;
    const M=don3({sx:mx3*it, sy:my3*it, sz:mz3*it});
    const gorluk=(0.3 + 0.7*(derin+1)/2);
    if (l.tier==='EXTRACTED'){ ctx.strokeStyle='rgba(128,82,255,'+(0.55*gorluk)+')'; ctx.lineWidth=1.3; }
    else { ctx.strokeStyle='rgba(255,184,41,'+(0.13*gorluk)+')'; ctx.lineWidth=.7; }
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.quadraticCurveTo(M.x,M.y,b.x,b.y); ctx.stroke();
  }
  // 4) veri düğümleri — dolu, tıklanabilir, üstte
  for (let i=0;i<N.length;i++){
    const n=N[i];
    if (!gorunur(n)) { P[i]=P[i]||don3(n); continue; }
    const q=P[i]=don3(n);
    const arka=q.z<0;
    const alfa= arka? .25+.25*(q.z+1) : .75+.25*q.z;
    const r=(2.2+Math.min(6, Math.sqrt(n.degree||0)*1.7))*q.olcek*(arka?.85:1);
    ctx.globalAlpha=Math.max(.08, Math.min(1, alfa));
    ctx.fillStyle = n.community>=0 ? RENKLER[n.community%RENKLER.length] : '#8a8a8a';
    ucgen(q.x, q.y, r, (i%7)*0.9); ctx.fill();
    if (n===secili){ ctx.globalAlpha=1; ctx.strokeStyle='#fff'; ctx.lineWidth=1.4; ctx.stroke(); }
  }
  ctx.globalAlpha=1;
  if (secili){
    const q=P[idx.get(secili.id)];
    if (q && q.z>-0.2){
      ctx.fillStyle='#fff'; ctx.font='200 14px Inter, system-ui, sans-serif';
      ctx.fillText(secili.label.slice(0,64), Math.min(q.x+12, W-640), q.y-10);
    }
  }
}

/* ── AĞ: Node tarafında hesaplanan deterministik yerleşim ── */
let agFit=null;
function agCiz(){
  if (!agFit){
    const gs=N.filter(gorunur);
    const xs=gs.map(n=>n.x), ys=gs.map(n=>n.y);
    const x1=Math.min(...xs), x2=Math.max(...xs), y1=Math.min(...ys), y2=Math.max(...ys);
    const k=70, gw=(W-316)-k*2, gh=H-k*2;
    const z=Math.min(gw/Math.max(60,x2-x1), gh/Math.max(60,y2-y1));
    agFit={ z, ox:k+(gw-(x2-x1)*z)/2 - x1*z, oy:k+(gh-(y2-y1)*z)/2 - y1*z };
  }
  const T=(n)=>[ n.x*agFit.z*zoom + agFit.ox + panX, n.y*agFit.z*zoom + agFit.oy + panY ];
  ctx.lineWidth=.7;
  for (const l of L){
    if (!bagGorunur(l)) continue;
    const [ax,ay]=T(N[l.a]), [bx,by]=T(N[l.b]);
    ctx.strokeStyle = l.tier==='EXTRACTED' ? 'rgba(21,132,110,.4)' : 'rgba(154,154,154,.10)';
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke();
  }
  for (const n of N){
    if (!gorunur(n)) continue;
    const [x,y]=T(n);
    const r=2.5+Math.min(7, Math.sqrt(n.degree||0)*1.8);
    ctx.fillStyle = n.community>=0 ? RENKLER[n.community%RENKLER.length] : '#666';
    ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill();
    if (n===secili){ ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke(); }
  }
  if (secili){
    const [x,y]=T(secili);
    ctx.fillStyle='#fff'; ctx.font='200 14px Inter, system-ui, sans-serif';
    ctx.fillText(secili.label.slice(0,64), x+12, y-8);
  }
}

function kare(){
  ctx.clearRect(0,0,W,H);
  if (mod==='beyin'){
    if(!elleAci){ salinim+=0.006; aci = 1.5708 + Math.sin(salinim)*0.44; }
    beyinCiz();
  }
  else agCiz();
  requestAnimationFrame(kare);
}
requestAnimationFrame(kare);

/* etkileşim */
let bas=null;
canvas.addEventListener('pointerdown',(e)=>{
  // önce düğüm vuruşu
  let vurulan=null;
  if (mod==='beyin'){
    let enIyi=1e9;
    for (let i=0;i<N.length;i++){
      const q=P[i]; if(!q || q.z<0 || !gorunur(N[i])) continue;
      const d=(q.x-e.clientX)**2+(q.y-e.clientY)**2;
      if (d<120 && d<enIyi){ enIyi=d; vurulan=N[i]; }
    }
  } else {
    for (const n of N){
      if (!gorunur(n)) continue;
      const x=n.x*agFit.z*zoom+agFit.ox+panX, y=n.y*agFit.z*zoom+agFit.oy+panY;
      if ((x-e.clientX)**2+(y-e.clientY)**2 < 100){ vurulan=n; }
    }
  }
  if (vurulan){ sec(vurulan); return; }
  bas={x:e.clientX, y:e.clientY, aci, egim, panX, panY};
});
addEventListener('pointermove',(e)=>{
  if (!bas) return;
  if (mod==='beyin'){
    elleAci=true;
    aci = bas.aci + (e.clientX-bas.x)*0.005;
    egim = Math.max(-1.2, Math.min(1.2, bas.egim + (e.clientY-bas.y)*0.005));
  } else {
    panX = bas.panX + (e.clientX-bas.x); panY = bas.panY + (e.clientY-bas.y);
  }
});
addEventListener('pointerup',()=>{ bas=null; });
canvas.addEventListener('wheel',(e)=>{ e.preventDefault();
  zoom=Math.min(4, Math.max(.3, zoom*(e.deltaY<0?1.1:0.9))); },{passive:false});

function sec(n){
  secili=n;
  const detay=document.getElementById('detay');
  detay.style.display='block';
  detay.innerHTML='<div class="baslik">'+ (n.label||'').replace(/</g,'&lt;') +'</div>'
    +'<div class="meta">'+n.file+' › '+n.branch+(n.date? ' · '+n.date:'')+' · '+n.degree+'°</div>'
    +'<code title="kopyala">'+n.id+'</code>';
  detay.querySelector('code').onclick=(e)=>{ navigator.clipboard?.writeText(n.id);
    e.target.textContent='kopyalandı ✓'; setTimeout(()=>e.target.textContent=n.id,900); };
}

function paneliKur(){
  document.getElementById('ozet').textContent =
    VERI.stats.leaves+' yaprak · '+VERI.stats.edges+' kenar · '+VERI.communities.length+' topluluk';
  const kutu=document.getElementById('toplar'); kutu.innerHTML='';
  for (const c of VERI.communities.slice(0,24)){
    const satir=document.createElement('div');
    satir.className='top';
    satir.innerHTML='<span class="nokta" style="background:'+RENKLER[c.index%RENKLER.length]+'"></span>'
      +'<span>'+c.name.slice(0,24).replace(/</g,'&lt;')+(c.crossBranch?' ⚡':'')+'</span>'
      +'<span class="say">'+c.size+'</span>';
    satir.onclick=()=>{ acikTop.has(c.index)? acikTop.delete(c.index) : acikTop.add(c.index);
      satir.classList.toggle('kapali'); agFit=null; };
    kutu.appendChild(satir);
  }
  document.getElementById('durum').textContent='damga '+VERI.stamp.slice(0,12)+' · '+VERI.generatedAt;
}
paneliKur();
document.getElementById('ara').addEventListener('input',(e)=>{ arama=e.target.value.trim().toLowerCase(); agFit=null; });
document.getElementById('kx').addEventListener('change',(e)=>{ gorX=e.target.checked; });
document.getElementById('ki').addEventListener('change',(e)=>{ gorI=e.target.checked; });
const mB=document.getElementById('modBeyin'), mA=document.getElementById('modAg');
mB.onclick=()=>{ mod='beyin'; mB.classList.add('aktif'); mA.classList.remove('aktif'); zoom=1; panX=panY=0; };
mA.onclick=()=>{ mod='ag'; mA.classList.add('aktif'); mB.classList.remove('aktif'); zoom=1; panX=panY=0; agFit=null; };
document.getElementById('yenile').addEventListener('click',()=>location.reload());
</script>
</body>
</html>`;

export function renderTreeHtml(data) {
  return HTML_TEMPLATE.replace('__DATA__', JSON.stringify(data));
}

export function writeTreeHtml(memoryDir) {
  const data = buildTreeData(memoryDir);
  const target = path.join(memoryDir, '.urdr', 'tree.html');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderTreeHtml(data));
  return { target, data };
}

export function serveTree(memoryDir, port = 4177) {
  const server = http.createServer((request, response) => {
    try {
      if (request.url === '/data.json') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(buildTreeData(memoryDir)));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderTreeHtml(buildTreeData(memoryDir)));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error?.message || error));
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--port' && argv[i - 1] !== '--root');
  const memoryDir = valueAfter('--root') || positional[0] || process.cwd();
  if (argv.includes('--serve')) {
    const port = parseInt(valueAfter('--port'), 10) || 4177;
    serveTree(memoryDir, port);
    console.log(`Urðr Tree → http://127.0.0.1:${port}  (yalnız bu makine; veri dışarı çıkmaz)`);
    console.log('Yeni yaprak eklendiyse tarayıcıda ↻ Yenile yeterli. Durdurmak: Ctrl+C');
  } else {
    const { target, data } = writeTreeHtml(memoryDir);
    console.log(`Urðr Tree yazıldı: ${target}`);
    console.log(`${data.stats.leaves} yaprak · ${data.stats.edges} kenar · ${data.communities.length} topluluk`);
  }
}
