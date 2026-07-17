#!/usr/bin/env node
/**
 * Reproducible, dependency-free retrieval benchmark.
 *
 * `--ambiguity` controls wrong-root filing; `--collision` controls queries with
 * near-duplicate competitors (default: the ambiguity share). Ground truth comes from
 * readCommittedState() stable IDs. Write fidelity uses appendLeaf(), the production
 * concurrency-safe/event-log-aware writer.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { appendLeaf } from './append.mjs';
import { readCommittedState } from './lib/event-log.mjs';
import { importMarkdown } from './lib/transaction.mjs';
import { searchMemory } from './search.mjs';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOTS = [
  { file: 'root-1-topics.md', title: 'Root-1: Topics', branches: ['People', 'Projects', 'Organizations', 'Events'] },
  { file: 'root-2-technical.md', title: 'Root-2: Technical', branches: ['APIs', 'Configs', 'Systems', 'Fixes'] },
  { file: 'root-3-decisions.md', title: 'Root-3: Decisions', branches: ['ADRs', 'Rules', 'Lessons', 'Constraints'] },
];
const SUBJECTS = ['sqlite', 'postgres', 'redis', 'oauth', 'webhook', 'ratelimit', 'caching', 'migration',
  'telegram', 'discord', 'gateway', 'baileys', 'cronjob', 'backup', 'encryption', 'tokenbudget',
  'retrypolicy', 'idempotency', 'pagination', 'sharding', 'indexing', 'vectordb', 'embedding', 'prompt'];
const QUALIFIERS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'gamma', 'hotel'];

function emptyTree(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const root of ROOTS) {
    const parts = [`# ${root.title}`, '', '> Auto-generated benchmark fixture.', '', '---', ''];
    for (const branch of root.branches) parts.push(`## ${branch}`, '', '_No entries yet._', '', '---', '');
    fs.writeFileSync(path.join(dir, root.file), parts.join('\n'));
  }
}

function typo(value) {
  if (value.length < 4) return value;
  return value.slice(0, 2) + value[3] + value[2] + value.slice(4);
}

function generateTree(dir, nLeaves, ambiguity, collisionShare, rand) {
  fs.mkdirSync(dir, { recursive: true });
  const buckets = new Map(ROOTS.map((root) => [root.file, new Map(root.branches.map((branch) => [branch, []]))]));
  const leaves = [];

  for (let i = 0; i < nLeaves; i++) {
    const subject = SUBJECTS[Math.floor(rand() * SUBJECTS.length)];
    const impliedIdx = Math.floor(rand() * ROOTS.length);
    const isAmbiguous = rand() < ambiguity;
    const assignedIdx = isAmbiguous
      ? (impliedIdx + 1 + Math.floor(rand() * (ROOTS.length - 1))) % ROOTS.length
      : impliedIdx;
    const assigned = ROOTS[assignedIdx];
    const branch = assigned.branches[Math.floor(rand() * assigned.branches.length)];
    const isCollision = rand() < collisionShare;
    const qualifier = QUALIFIERS[i % QUALIFIERS.length];
    const group = Math.floor(i / QUALIFIERS.length) % Math.max(2, Math.ceil(nLeaves / 32));
    const keyword = isCollision ? `${subject} kararlar ${qualifier} grup${group}` : `${subject}-u${String(i).padStart(6, '0')}-z`;
    const query = isCollision
      ? `${typo(qualifier)} grup${group} ${i % 2 ? subject + "'ı" : subject} karar`
      : keyword;
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
    const marker = `bench-record-${i}`;
    const text = `**${day}.07.2026 — ${keyword} — ${marker} chose ${subject} (alt: none) · cost≈$0.5 | ok**`;
    buckets.get(assigned.file).get(branch).push(text);
    leaves.push({ assignedRoot: assigned.file, impliedRoot: ROOTS[impliedIdx].file, branch, text, marker, query, isAmbiguous, isCollision });
  }

  for (const root of ROOTS) {
    const parts = [`# ${root.title}`, '', '> Auto-generated benchmark fixture.', '', '---', ''];
    for (const branch of root.branches) {
      const lines = buckets.get(root.file).get(branch);
      parts.push(`## ${branch}`, '', ...(lines.length ? lines : ['_No entries yet._']), '', '---', '');
    }
    fs.writeFileSync(path.join(dir, root.file), parts.join('\n'));
  }

  importMarkdown(dir);
  const state = readCommittedState(dir);
  for (const leaf of leaves) {
    const matches = [...state.leaves.values()].filter((candidate) => candidate.text === leaf.text);
    if (matches.length !== 1) throw new Error(`stable-ID oracle could not resolve ${leaf.marker}`);
    // Keep assignedRoot/branch as the original generation intent (not the committed
    // state) so the fidelity check below verifies import against independent ground
    // truth instead of comparing state.leaves against a value just copied from it.
    leaf.id = matches[0].id;
  }
  return { leaves, state };
}

function measureWriterFidelity(dir, count) {
  emptyTree(dir);
  let passed = 0;
  for (let i = 0; i < count; i++) {
    const root = ROOTS[i % ROOTS.length];
    const branch = root.branches[i % root.branches.length];
    const text = `**${String(i + 1).padStart(2, '0')}.07.2026 — writer-fidelity-${i} — çğıöşü + **bold** | pipe · dash**`;
    const written = appendLeaf(dir, root.file, branch, text);
    const authoritative = readCommittedState(dir).leaves.get(written.id);
    if (authoritative?.text === text && authoritative.file === root.file && authoritative.branch === branch) passed++;
  }
  return { passed, count };
}

function run() {
  const argv = process.argv.slice(2);
  const num = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : fallback; };
  const nLeaves = num('--leaves', 300);
  const ambiguity = num('--ambiguity', 0.3);
  const collisionShare = num('--collision', ambiguity);
  const seed = num('--seed', 42);
  const keep = argv.includes('--keep');
  if (!Number.isInteger(nLeaves) || nLeaves < 1 || ambiguity < 0 || ambiguity > 1 || collisionShare < 0 || collisionShare > 1) {
    console.error('Usage: node bench.mjs [--leaves N>0] [--ambiguity 0..1] [--collision 0..1] [--seed N] [--keep]');
    process.exit(2);
  }

  const rand = mulberry32(seed);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-bench-'));
  const writerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-bench-writer-'));
  let exitCode = 0;
  try {
    const { leaves, state } = generateTree(dir, nLeaves, ambiguity, collisionShare, rand);
    const writer = measureWriterFidelity(writerDir, Math.min(6, nLeaves));
    const stableIdFidelity = leaves.filter((leaf) => {
      const truth = state.leaves.get(leaf.id);
      return truth?.file === leaf.assignedRoot && truth?.branch === leaf.branch;
    }).length;

    let oneCallHits = 0, globalHits = 0, assistedHits = 0, assistedRescued = 0;
    let uniqueTotal = 0, uniqueHits = 0, collisionTotal = 0, collisionHits = 0;
    let oneCallMs = 0, globalMs = 0, assistedMs = 0, totalResultChars = 0;
    for (const leaf of leaves) {
      const t0 = performance.now();
      const oneCall = searchMemory(dir, leaf.query, {
        hierarchyFiles: [leaf.impliedRoot], maxResults: 1, forceNode: true,
      });
      const t1 = performance.now();
      const globalOnly = searchMemory(dir, leaf.query, { maxResults: 1, forceNode: true });
      const t2 = performance.now();
      const oneCallHit = oneCall.results[0]?.id === leaf.id;
      const globalHit = globalOnly.results[0]?.id === leaf.id;
      const assistedHit = oneCallHit || globalHit;
      if (oneCallHit) oneCallHits++;
      if (globalHit) globalHits++;
      if (assistedHit) {
        assistedHits++;
        if (!oneCallHit) assistedRescued++;
      }
      if (oneCallHit) totalResultChars += oneCall.results[0].text.length;
      if (leaf.isCollision) { collisionTotal++; if (oneCallHit) collisionHits++; }
      else { uniqueTotal++; if (oneCallHit) uniqueHits++; }
      oneCallMs += t1 - t0;
      globalMs += t2 - t1;
      assistedMs += (t1 - t0) + (oneCallHit ? 0 : t2 - t1);
    }

    const pct = (value, total = nLeaves) => total ? ((value / total) * 100).toFixed(1) : 'n/a';
    const ambiguousCount = leaves.filter((leaf) => leaf.isAmbiguous).length;
    const collisionCount = leaves.filter((leaf) => leaf.isCollision).length;

    console.log('');
    console.log('  🌳 Urðr Memory Benchmark');
    console.log('  ' + '─'.repeat(66));
    console.log(`  leaves: ${nLeaves} · wrong-root: ${ambiguousCount} (${pct(ambiguousCount)}%) · collision: ${collisionCount} (${pct(collisionCount)}%) · seed: ${seed}`);
    console.log('');
    console.log(`  Production-writer fidelity       : ${pct(writer.passed, writer.count)}% (${writer.passed}/${writer.count} via appendLeaf + event log) ${writer.passed === writer.count ? '✓' : '✗ DATA LOSS'}`);
    console.log(`  Stable-ID import/oracle fidelity : ${pct(stableIdFidelity)}% (${stableIdFidelity}/${nLeaves}) ${stableIdFidelity === nLeaves ? '✓' : '✗'}`);
    console.log('');
    console.log(`  recall@1, one-call hierarchy-aware : ${pct(oneCallHits)}%`);
    console.log(`  recall@1, global-only              : ${pct(globalHits)}%`);
    console.log(`  recall@1, two-call assisted        : ${pct(assistedHits)}%`);
    console.log(`  recall@1, unique exact keys        : ${pct(uniqueHits, uniqueTotal)}% (${uniqueHits}/${uniqueTotal}, one-call)`);
    console.log(`  recall@1, collision/fuzzy keys     : ${pct(collisionHits, collisionTotal)}% (${collisionHits}/${collisionTotal}, one-call)`);
    console.log(`  rescued by assisted second call    : ${assistedRescued} leaves (${pct(assistedRescued)}%)`);
    console.log('');
    console.log(`  avg one-call latency               : ${(oneCallMs / nLeaves).toFixed(3)} ms/query (CPU, no LLM/network call)`);
    console.log(`  avg global-only latency             : ${(globalMs / nLeaves).toFixed(3)} ms/query (CPU, no LLM/network call)`);
    console.log(`  avg two-call assisted latency        : ${(assistedMs / nLeaves).toFixed(3)} ms/query (conditional second call)`);
    console.log(`  avg one-call result size             : ~${Math.round((totalResultChars / nLeaves) / 4)} tokens`);
    console.log('');
    console.log('  → One-call recall is the production API/MCP behavior; assisted recall requires a conditional second call.');
    console.log('');
    exitCode = writer.passed === writer.count && stableIdFidelity === nLeaves ? 0 : 1;
    if (keep) console.log(`  (fixtures kept at ${dir} and ${writerDir})`);
  } finally {
    if (!keep) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(writerDir, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

run();
