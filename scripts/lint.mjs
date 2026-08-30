#!/usr/bin/env node
/** Urðr memory health audit (cross-platform, LLM-free). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCommittedState } from './lib/event-log.mjs';
import { listRootFiles, parseMarkdown } from './lib/markdown-model.mjs';

export const MAX_BRANCHES = 9;
export const WARN_LEAVES = 30;
export const MAX_LEAVES = 50;
const DUP_THRESHOLD = 0.85;
const INDEX_LEAF_WARN = 15;

function parseFile(file) {
  const name = path.basename(file);
  const model = parseMarkdown(fs.readFileSync(file, 'utf8'));
  return {
    file: name,
    isIndex: /-0-|^0[-_]|index|indeks/i.test(name),
    branches: model.branches.map((branch) => ({
      name: branch.name,
      leaves: branch.leaves.map((leaf) => ({
        id: leaf.id, text: leaf.text, line: leaf.startLine,
        referenceOnly: /\bbkz:/iu.test(leaf.text),
      })),
    })),
  };
}

const STOP = new Set(['the', 've', 'and', 'for', 'with', 'chose', 'alt', 'none', 'ok', 'to', 'bir', 'ile', 'için', 'of', 'in', 'on', 'is', 'bkz']);
function tokens(text) {
  return new Set(String(text).toLocaleLowerCase()
    .replace(/\*\*|__|`|\|/g, ' ')
    .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ')
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((word) => word.length > 2 && !STOP.has(word)));
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function addReferenceFindings(dir, findings) {
  const logFile = path.join(dir, '.urdr', 'events.jsonl');
  if (!fs.existsSync(logFile)) return;
  const state = readCommittedState(dir);
  const leafLocation = (id) => {
    const leaf = state.leaves.get(id);
    return leaf ? `${leaf.file} › ## ${leaf.branch || '(no branch)'}` : id;
  };
  const outgoing = new Map();
  for (const edge of state.edges.values()) {
    if (edge.status !== 'resolved' || !edge.targetId || !state.leaves.has(edge.sourceId) || !state.leaves.has(edge.targetId)) {
      findings.push({
        level: 'error', code: 'broken-ref',
        msg: `${leafLocation(edge.sourceId)}: unresolved stable-ID reference ${edge.id} (${edge.status})`,
        details: {
          edge: { ...edge },
          source: state.leaves.get(edge.sourceId) || null,
          target: state.leaves.get(edge.targetId) || null,
        },
      });
      continue;
    }
    const targets = outgoing.get(edge.sourceId) || new Set();
    targets.add(edge.targetId);
    outgoing.set(edge.sourceId, targets);
  }
  const reported = new Set();
  for (const [source, middleIds] of outgoing) {
    for (const middle of middleIds) {
      for (const target of outgoing.get(middle) || []) {
        const key = `${source}\0${middle}\0${target}`;
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({ level: 'warn', code: 'reference-chain', msg: `${leafLocation(source)} → ${leafLocation(middle)} → ${leafLocation(target)}: bkz: chain exceeds one hop` });
      }
    }
  }
}

function addDuplicateFindings(parsed, findings) {
  const leaves = parsed.flatMap((root) => root.branches.flatMap((branch) => branch.leaves
    .filter((leaf) => !leaf.referenceOnly)
    .map((leaf) => ({ ...leaf, file: root.file, branch: branch.name, tokenSet: tokens(leaf.text) }))));
  const index = new Map();
  const candidates = new Set();
  for (let i = 0; i < leaves.length; i++) {
    for (const token of leaves[i].tokenSet) {
      for (const prior of index.get(token) || []) candidates.add(`${prior}:${i}`);
      const ids = index.get(token) || [];
      ids.push(i);
      index.set(token, ids);
    }
  }
  for (const pair of candidates) {
    const [i, j] = pair.split(':').map(Number);
    const similarity = jaccard(leaves[i].tokenSet, leaves[j].tokenSet);
    if (similarity < DUP_THRESHOLD) continue;
    findings.push({ level: 'warn', code: 'duplication', msg: `near-duplicate (${(similarity * 100).toFixed(0)}%) — ${leaves[i].file} › ## ${leaves[i].branch} L${leaves[i].line} ≈ ${leaves[j].file} › ## ${leaves[j].branch} L${leaves[j].line}. Keep one primary + bkz:.` });
  }
}

export function validateTargetBranch(dir, targetFile, targetBranch) {
  const resolvedDir = fs.realpathSync(dir);
  const resolvedFile = fs.realpathSync(path.resolve(resolvedDir, targetFile));
  if (path.dirname(resolvedFile) !== resolvedDir) throw new Error(`target root escapes memory directory: ${targetFile}`);
  const model = parseMarkdown(fs.readFileSync(resolvedFile, 'utf8'));
  const wanted = String(targetBranch).replace(/^##\s*/, '').trim().toLocaleLowerCase();
  const branch = model.branches.find((item) => item.name.trim().toLocaleLowerCase() === wanted);
  if (!branch) throw new Error(`target branch does not exist: ${path.basename(resolvedFile)} / ${targetBranch}`);
  return branch;
}

export function lintTree(dir) {
  const files = listRootFiles(dir);
  const findings = [];
  const add = (level, code, msg) => findings.push({ level, code, msg });
  if (files.length === 0) { add('error', 'no-roots', `no root files in ${dir}`); return { findings, files: 0 }; }
  const parsed = files.map(parseFile);
  const rootNames = new Set(parsed.map((root) => root.file.toLocaleLowerCase()));
  for (const root of parsed) {
    if (root.branches.length >= MAX_BRANCHES) add('warn', 'root-branches', `${root.file}: ${root.branches.length} branches (>= ${MAX_BRANCHES}) — consider splitting into a new root`);
    for (const branch of root.branches) {
      if (branch.leaves.length >= MAX_LEAVES) findings.push({ level: 'error', code: 'branch-leaves', msg: `${root.file} › ## ${branch.name}: ${branch.leaves.length} leaves (>= ${MAX_LEAVES}) — split into sub-branches`, details: { file: root.file, branch: branch.name, count: branch.leaves.length, threshold: MAX_LEAVES } });
      else if (branch.leaves.length >= WARN_LEAVES) findings.push({ level: 'warn', code: 'branch-leaves', msg: `${root.file} › ## ${branch.name}: ${branch.leaves.length} leaves (>= ${WARN_LEAVES}) — approaching split limit`, details: { file: root.file, branch: branch.name, count: branch.leaves.length, threshold: WARN_LEAVES } });
    }
    if (root.isIndex) {
      const count = root.branches.reduce((sum, branch) => sum + branch.leaves.length, 0);
      if (count >= INDEX_LEAF_WARN) findings.push({ level: 'warn', code: 'index-bloat', msg: `${root.file}: index holds ${count} content leaves — it should map, not store leaves`, details: { file: root.file, count, threshold: INDEX_LEAF_WARN } });
    }
    // Legacy trees have no event graph yet. Preserve broken-root diagnostics during
    // migration, but deliberately do not infer graph depth from this prose.
    if (!fs.existsSync(path.join(dir, '.urdr', 'events.jsonl'))) {
      for (const branch of root.branches) for (const leaf of branch.leaves) {
        if (!leaf.referenceOnly) continue;
        const refs = leaf.text.match(/(?:root|kök|kok)-\d+[\p{L}\p{N}-]*(?:\.md)?/giu) || [];
        for (const ref of refs) {
          const stem = ref.replace(/\.md$/i, '').toLocaleLowerCase();
          if (![...rootNames].some((name) => name.startsWith(stem))) add('error', 'broken-ref', `${root.file} › ## ${branch.name} (line ${leaf.line}): bkz: points to missing "${ref}"`);
        }
      }
    }
  }
  addReferenceFindings(dir, findings);
  addDuplicateFindings(parsed, findings);
  return { findings, files: files.length };
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg) => arg.startsWith('--') && !['--json', '--verbose', '--fail-on-warn', '--root'].includes(arg));
  if (unknown.length) { console.error(`unknown option: ${unknown[0]}`); process.exit(2); }
  // `--root <dir>` is an alias for the positional directory, so one flag works everywhere:
  // here, in search.mjs, and in the MCP server.
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && !argv[rootIndex + 1]) { console.error('--root requires a directory'); process.exit(2); }
  const rootValueIndex = rootIndex >= 0 ? rootIndex + 1 : -1;
  const dir = (rootIndex >= 0 ? argv[rootValueIndex] : undefined)
    || argv.find((arg, index) => !arg.startsWith('--') && index !== rootValueIndex)
    || process.cwd();
  const json = argv.includes('--json');
  const failOnWarn = argv.includes('--fail-on-warn');
  const { findings, files } = lintTree(dir);
  const errors = findings.filter((finding) => finding.level === 'error');
  const warnings = findings.filter((finding) => finding.level === 'warn');
  if (json) console.log(JSON.stringify({ dir, files, errors: errors.length, warnings: warnings.length, findings }, null, 2));
  else {
    console.log(`\n  Urðr Memory Lint — ${files} root file(s)\n  ${'─'.repeat(56)}`);
    if (!findings.length) console.log('  ✓ Healthy — no growth, reference, or duplication issues.');
    for (const finding of [...errors, ...warnings]) console.log(`  ${finding.level === 'error' ? '✗' : '⚠'} [${finding.code}] ${finding.msg}`);
    if (findings.length) console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s).`);
    console.log('');
  }
  process.exit(errors.length || (failOnWarn && warnings.length) ? 1 : 0);
}
