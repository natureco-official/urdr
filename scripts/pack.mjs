#!/usr/bin/env node
/**
 * pack.mjs — Bağlam Paketi CLI'si.
 *
 *   node scripts/pack.mjs build   [memoryDir]   paketi (yeniden) derle
 *   node scripts/pack.mjs status  [memoryDir]   damga taze mi, boyutlar ne
 *   node scripts/pack.mjs digest  [memoryDir]   oturum brifingini yazdır
 *   node scripts/pack.mjs map     [memoryDir]   kök→dal→sayaç iskeleti (JSON)
 *   node scripts/pack.mjs read    <id...> --root <dir>     yaprak tam metni
 *   node scripts/pack.mjs related <id> --root <dir> [--budget N] [--depth N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPack, computeStamp, estimateTokens, loadPack, PACK_RELATIVE_DIR,
  readLeavesById, relatedLeaves, treeMap, writePack,
} from './lib/context-pack.mjs';

function fail(message) { console.error(message); process.exit(2); }

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const flagValues = new Set([valueAfter('--root'), valueAfter('--budget'), valueAfter('--depth')].filter(Boolean));
  const positional = argv.slice(1).filter((arg) => !arg.startsWith('--') && !flagValues.has(arg));
  const memoryDir = valueAfter('--root') || (command === 'read' || command === 'related' ? process.cwd() : positional[0] || process.cwd());

  if (command === 'build') {
    const pack = buildPack(memoryDir);
    const directory = writePack(memoryDir, pack);
    console.log(`pack: ${pack.leaves.length} yaprak, ${pack.edges.length} kenar → ${directory}`);
    console.log(`digest: ${pack.digest.length} karakter ≈ ${estimateTokens(pack.digest)} token`);
  } else if (command === 'status') {
    const current = computeStamp(memoryDir);
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(path.join(memoryDir, PACK_RELATIVE_DIR, 'stamp.json'), 'utf8')); } catch {}
    console.log(JSON.stringify({
      packExists: Boolean(stored),
      fresh: stored?.stamp === current,
      storedStamp: stored?.stamp || null,
      currentStamp: current,
      generatedAt: stored?.generatedAt || null,
    }, null, 2));
  } else if (command === 'digest') {
    console.log(loadPack(memoryDir).digest);
  } else if (command === 'map') {
    console.log(JSON.stringify(treeMap(loadPack(memoryDir)), null, 2));
  } else if (command === 'read') {
    if (positional.length === 0) fail('usage: pack.mjs read <leafId...> --root <dir>');
    console.log(JSON.stringify(readLeavesById(memoryDir, positional), null, 2));
  } else if (command === 'related') {
    if (positional.length !== 1) fail('usage: pack.mjs related <leafId> --root <dir> [--budget N] [--depth N]');
    const pack = loadPack(memoryDir);
    console.log(JSON.stringify(relatedLeaves(pack, positional[0], {
      budgetTokens: parseInt(valueAfter('--budget'), 10) || undefined,
      depth: parseInt(valueAfter('--depth'), 10) || undefined,
    }), null, 2));
  } else {
    fail('usage: pack.mjs <build|status|digest|map|read|related> [args]');
  }
}
