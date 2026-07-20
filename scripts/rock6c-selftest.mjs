#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLeaf } from './append.mjs';
import { applyCompilerPlan, compileDryRun } from './compiler.mjs';
import { EVENT_SCHEMA_VERSION, readCommittedState, readEventLog } from './lib/event-log.mjs';
import { forgetMemoryLeaf, resumeForgottenArtifactScrubs, scrubForgottenArtifacts } from './lib/forgetting.mjs';
import { proposeBranchSplit } from './lib/auto-split.mjs';
import { parseMarkdown } from './lib/markdown-model.mjs';
import { beginTransaction, exportMarkdown, importMarkdown, reconcileMarkdown } from './lib/transaction.mjs';
import { recordSearchOutcome } from './lib/telemetry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, body) { body(); passed++; console.log(`  ✓ ${name}`); }
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock6c-')); }
function write(dir, file, body) { fs.writeFileSync(path.join(dir, file), body, 'utf8'); }
function treeWith(body, file = 'root-2-technical.md') {
  const dir = temp();
  write(dir, file, body);
  importMarkdown(dir);
  return dir;
}

test('provenance is optional and additive without an event schema bump', () => {
  const dir = treeWith('# Root-2\n\n## Systems\n\n- provenance subject\n');
  const leaf = [...readCommittedState(dir).leaves.values()][0];
  assert.equal(EVENT_SCHEMA_VERSION, 1);
  assert.equal(leaf.creator, undefined);
  const tx = beginTransaction(dir);
  tx.updateLeafProvenance(leaf.id, {
    creator: 'rock6c-test', timestamp: '2026-07-17T00:00:00.000Z', source: 'fixture',
    confidence: 0.9, verification_state: 'verified', verifier: 'selftest',
    validity_interval: { from: '2026-01-01', to: '2027-01-01' },
  });
  tx.commit();
  const updated = readCommittedState(dir).leaves.get(leaf.id);
  assert.equal(updated.text, leaf.text);
  assert.equal(updated.creator, 'rock6c-test');
  assert.deepEqual(updated.validity_interval, { from: '2026-01-01', to: '2027-01-01' });
  const viewFile = path.join(dir, leaf.file);
  const checkpoint = beginTransaction(dir);
  checkpoint.publishRoot(leaf.file, fs.readFileSync(viewFile, 'utf8'));
  checkpoint.commit();
  write(dir, leaf.file, fs.readFileSync(viewFile, 'utf8').replace('provenance subject', 'provenance subject edited'));
  assert.equal(reconcileMarkdown(dir).status, 'reconciled');
  assert.equal(readCommittedState(dir).leaves.get(leaf.id).creator, 'rock6c-test');
  assert.throws(() => beginTransaction(dir).updateLeafProvenance(leaf.id, { text: 'forbidden' }), /unknown provenance field/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('leaf.upsert accepts provenance while legacy callers remain unchanged', () => {
  const dir = temp();
  const tx = beginTransaction(dir);
  tx.upsertLeaf({ id: 'p1', file: 'root-2-technical.md', branch: 'B', kind: 'list-item', index: 0, text: '- fact', contentHash: 'x', creator: 'agent', confidence: 0.75 });
  tx.upsertLeaf({ id: 'legacy', file: 'root-2-technical.md', branch: 'B', kind: 'list-item', index: 1, text: '- old', contentHash: 'y' });
  tx.commit();
  const state = readCommittedState(dir);
  assert.equal(state.leaves.get('p1').creator, 'agent');
  assert.equal(state.leaves.get('legacy').creator, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forget tombstone scrubs managed artifacts but retains ledger history', () => {
  const secret = '- FORGET-ME-physical-bytes-unique\n  continuation-sensitive';
  const dir = treeWith(`# Root-2\n\n## Secrets\n\n${secret}\n\n- safe fact\n`.replace(/\n/g, '\r\n'));
  const leaf = [...readCommittedState(dir).leaves.values()].find((item) => item.text === secret);
  const recovery = path.join(dir, '.urdr', 'recovery', 'old');
  fs.mkdirSync(recovery, { recursive: true });
  write(recovery, 'root-2-technical.md', `${secret.replace(/\n/g, '\r\n')}\r\n`);
  write(dir, 'orphan.tmp', `${secret.replace(/\n/g, '\r\n')}\r\n`);
  const exported = temp();
  exportMarkdown(dir, exported);
  recordSearchOutcome(dir, true, 'fallback');
  const result = forgetMemoryLeaf(dir, leaf.id, { reason: 'selftest erasure request', retention: { maxGenerations: 1, recoveryMaxAgeDays: 0 } });
  assert.equal(readCommittedState(dir).leaves.has(leaf.id), false);
  assert.ok(readCommittedState(dir).forgottenLeaves.has(leaf.id));
  const resurrection = beginTransaction(dir);
  resurrection.upsertLeaf(leaf);
  assert.throws(() => resurrection.commit(), /permanently forgotten leaf/);
  assert.equal(result.scrubbed.ledgerRetained, true);
  assert.ok(fs.readFileSync(path.join(dir, '.urdr', 'events.jsonl'), 'utf8').includes(JSON.stringify(secret).slice(1, -1)));
  assert.ok(!fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8').includes('FORGET-ME-physical-bytes-unique'));
  assert.ok(!fs.existsSync(path.join(dir, 'orphan.tmp')));
  assert.equal(fs.readdirSync(path.join(dir, '.urdr', 'generations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, '.urdr', 'recovery')));
  assert.ok(!fs.existsSync(path.join(exported, 'root-2-technical.md')) || !fs.readFileSync(path.join(exported, 'root-2-technical.md'), 'utf8').includes(secret));
  const telemetry = fs.readFileSync(path.join(dir, '.urdr', 'search-telemetry.json'), 'utf8');
  assert.ok(!telemetry.includes(secret));
  assert.deepEqual(JSON.parse(telemetry).queries, { hierarchy: 0, fallback: 1, miss: 0, timeout: 0 });
  fs.rmSync(exported, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forgetting matches Markdown artifacts by stable ID and preserves a colliding live leaf', () => {
  const shared = '- identical retained text';
  const dir = treeWith(`# Root-2\n\n## Notes\n\n${shared}\n\n${shared}\n`);
  const initial = readCommittedState(dir);
  const twins = [...initial.leaves.values()].filter((leaf) => leaf.text === shared);
  assert.equal(twins.length, 2);
  const [forgotten, retained] = twins;
  const oldGeneration = JSON.parse(fs.readFileSync(path.join(dir, '.urdr', 'current-generation.json'), 'utf8')).generationId;
  const recovery = path.join(dir, '.urdr', 'recovery', 'collision');
  fs.mkdirSync(recovery, { recursive: true });
  write(recovery, 'root-2-technical.md', fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8'));
  const exported = temp();
  exportMarkdown(dir, exported);

  assert.doesNotThrow(() => forgetMemoryLeaf(dir, forgotten.id));
  const committed = readCommittedState(dir);
  assert.equal(committed.leaves.has(forgotten.id), false);
  assert.equal(committed.leaves.get(retained.id).text, shared);
  for (const file of [
    path.join(dir, 'root-2-technical.md'),
    path.join(recovery, 'root-2-technical.md'),
    path.join(exported, 'root-2-technical.md'),
  ]) {
    const leaves = parseMarkdown(fs.readFileSync(file, 'utf8')).leaves;
    assert.equal(leaves.some((leaf) => leaf.id === forgotten.id), false);
    assert.equal(leaves.some((leaf) => leaf.id === retained.id && leaf.text === shared), true);
  }
  assert.equal(fs.existsSync(path.join(dir, '.urdr', 'generations', oldGeneration)), false);
  fs.rmSync(exported, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forgetting preserves unrelated tmp-pattern files', () => {
  const secret = '- tmp deletion target';
  const dir = treeWith(`# Root-2\n\n## Notes\n\n${secret}\n`);
  const leaf = [...readCommittedState(dir).leaves.values()].find((item) => item.text === secret);
  write(dir, 'something.tmp', 'unrelated temporary work\n');
  forgetMemoryLeaf(dir, leaf.id);
  assert.equal(fs.readFileSync(path.join(dir, 'something.tmp'), 'utf8'), 'unrelated temporary work\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('append rejects a stable ID already committed in another root', () => {
  const dir = temp();
  write(dir, 'root-1-topics.md', '# Root-1\n\n## Notes\n\n- original owner\n');
  write(dir, 'root-2-technical.md', '# Root-2\n\n## Systems\n\n- existing system\n');
  importMarkdown(dir);
  const before = readCommittedState(dir);
  const original = [...before.leaves.values()].find((leaf) => leaf.text === '- original owner');
  const target = path.join(dir, 'root-2-technical.md');
  const targetBefore = fs.readFileSync(target, 'utf8');
  assert.throws(
    () => appendLeaf(dir, 'root-2-technical.md', 'Systems', `<!-- urdr:id:${original.id} -->\n- attempted owner theft`),
    new RegExp(`stable leaf id already exists in committed tree: ${original.id} \\(root-1-topics\\.md\\)`),
  );
  const after = readCommittedState(dir);
  assert.equal(after.leaves.get(original.id).file, 'root-1-topics.md');
  assert.equal(after.leaves.get(original.id).text, '- original owner');
  assert.equal(fs.readFileSync(target, 'utf8'), targetBefore);
  assert.equal([...after.leaves.values()].some((leaf) => leaf.text.includes('attempted owner theft')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('interrupted forgetting scrub resumes idempotently from committed identity', () => {
  const secret = '- FORGET-ME-after-commit-crash-window';
  const dir = treeWith(`# Root-2\n\n## Secrets\n\n${secret}\n\n- safe fact\n`);
  const leaf = [...readCommittedState(dir).leaves.values()].find((item) => item.text === secret);
  const recovery = path.join(dir, '.urdr', 'recovery', 'interrupted');
  fs.mkdirSync(recovery, { recursive: true });
  write(recovery, 'root-2-technical.md', `${secret}\n`);

  assert.throws(() => forgetMemoryLeaf(dir, leaf.id, {
    faultAt: 'after-forget-commit', reason: 'selftest interrupted scrub',
  }), /fault injection: after-forget-commit/);
  const interrupted = readCommittedState(dir);
  assert.equal(interrupted.leaves.has(leaf.id), false);
  assert.ok(interrupted.forgottenLeaves.has(leaf.id));
  assert.ok(fs.readFileSync(path.join(recovery, 'root-2-technical.md'), 'utf8').includes(secret));
  const forgetRecord = readEventLog(dir).records.find((record) => record.operation?.type === 'leaf.forget' && record.operation.id === leaf.id);
  assert.equal(forgetRecord.operation.text, secret);
  assert.equal(forgetRecord.operation.file, leaf.file);

  const resumed = resumeForgottenArtifactScrubs(dir);
  assert.deepEqual(resumed.resumed.map((item) => item.id), [leaf.id]);
  assert.equal(fs.existsSync(recovery), false);
  assert.doesNotThrow(() => scrubForgottenArtifacts(dir, leaf.id, leaf.text));
  assert.deepEqual(resumeForgottenArtifactScrubs(dir), { resumed: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auto-split output exactly matches the deterministic golden fixture', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'auto-split-golden.json'), 'utf8'));
  assert.deepEqual(proposeBranchSplit(golden.input), golden.expected);
});

function overgrownTree() {
  const deployment = Array.from({ length: 25 }, (_, i) => `- deployment pipeline-${i} release-${i} service-${i}`);
  const security = Array.from({ length: 25 }, (_, i) => `- security vault-${i} credential-${i} control-${i}`);
  return treeWith(`# Root-2\n\n## Operations\n\n${[...deployment, ...security].join('\n')}\n`);
}

function multiRootOvergrownTree({ withEdge = false } = {}) {
  const dir = temp();
  const deployment = Array.from({ length: 25 }, (_, i) => `- deployment pipeline-${i} release-${i} service-${i}`);
  const security = Array.from({ length: 25 }, (_, i) => `- security vault-${i} credential-${i} control-${i}`);
  write(dir, 'root-1-topics.md', `# Root-1\n\n## Notes\n\n- untouched root-b leaf\n${withEdge ? '\n- stable bridge (bkz: Root-3 / Canonical)\n' : ''}`);
  write(dir, 'root-2-technical.md', `# Root-2\n\n## Operations\n\n${[...deployment, ...security].join('\n')}\n`);
  if (withEdge) write(dir, 'root-3-decisions.md', '# Root-3\n\n## Canonical\n\n- stable edge target\n');
  importMarkdown(dir);
  return dir;
}

function operationRecordsSince(dir, index, type) {
  return readEventLog(dir).records.slice(index).filter((record) => record.operation?.type === type);
}

test('compiler dry-run is inert and apply publishes an approved split in one transaction', () => {
  const dir = overgrownTree();
  const beforeLog = readEventLog(dir).records.length;
  const beforeView = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  const plan = compileDryRun(dir);
  assert.equal(readEventLog(dir).records.length, beforeLog);
  assert.equal(fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8'), beforeView);
  const split = plan.actions.find((action) => action.type === 'branch.split' && action.applicable);
  assert.ok(split && split.clusters.length === 2);
  const leaf = [...readCommittedState(dir).leaves.values()][0];
  const metadata = beginTransaction(dir);
  metadata.updateLeafProvenance(leaf.id, { verification_state: 'reviewed' });
  metadata.commit();
  assert.throws(() => applyCompilerPlan(dir, plan), /stale compiler plan/);
  const freshPlan = compileDryRun(dir);
  const beforeApplyLog = readEventLog(dir).records.length;
  const result = applyCompilerPlan(dir, freshPlan);
  assert.equal(result.status, 'applied');
  const view = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  assert.match(view, /## Operations \/ Deployment/);
  assert.match(view, /## Operations \/ Security/);
  const newRecords = readEventLog(dir).records.slice(beforeApplyLog);
  assert.ok(newRecords.length > 1);
  assert.equal(new Set(newRecords.map((record) => record.transactionId)).size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compiler leaves untouched roots leafChanges sequences unchanged', () => {
  const dir = multiRootOvergrownTree();
  const before = readCommittedState(dir);
  const rootB = [...before.leaves.values()].find((leaf) => leaf.text === '- untouched root-b leaf');
  const sequence = before.leafChanges.get(rootB.id);
  applyCompilerPlan(dir, compileDryRun(dir));
  assert.equal(readCommittedState(dir).leafChanges.get(rootB.id), sequence);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forgetting leaves untouched roots leafChanges sequences unchanged', () => {
  const dir = multiRootOvergrownTree();
  const before = readCommittedState(dir);
  const rootA = [...before.leaves.values()].find((leaf) => leaf.text.includes('deployment pipeline-0'));
  const rootB = [...before.leaves.values()].find((leaf) => leaf.text === '- untouched root-b leaf');
  const sequence = before.leafChanges.get(rootB.id);
  forgetMemoryLeaf(dir, rootA.id);
  assert.equal(readCommittedState(dir).leafChanges.get(rootB.id), sequence);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compiler rejects an unreconciled edit in an otherwise untouched root', () => {
  const dir = multiRootOvergrownTree();
  const rootB = [...readCommittedState(dir).leaves.values()].find((leaf) => leaf.text === '- untouched root-b leaf');
  const rootBFile = path.join(dir, 'root-1-topics.md');
  write(dir, 'root-1-topics.md', fs.readFileSync(rootBFile, 'utf8').replace('untouched root-b leaf', 'unreconciled root-b edit'));
  const plan = compileDryRun(dir);
  const beforeLog = readEventLog(dir).records.length;
  assert.throws(() => applyCompilerPlan(dir, plan), (error) => {
    assert.equal(error.code, 'URDR_DIRTY_VIEW');
    assert.deepEqual(error.files, ['root-1-topics.md']);
    assert.match(error.message, /reconciliation before retrying/);
    return true;
  });
  assert.equal(readEventLog(dir).records.length, beforeLog);
  assert.match(fs.readFileSync(rootBFile, 'utf8'), /unreconciled root-b edit/);
  assert.equal(readCommittedState(dir).leaves.get(rootB.id).text, '- untouched root-b leaf');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a direct edit after an unrelated compiler run reconciles without a false conflict', () => {
  const dir = multiRootOvergrownTree();
  applyCompilerPlan(dir, compileDryRun(dir));
  const rootBFile = path.join(dir, 'root-1-topics.md');
  write(dir, 'root-1-topics.md', fs.readFileSync(rootBFile, 'utf8').replace('untouched root-b leaf', 'later reviewed root-b edit'));
  const result = reconcileMarkdown(dir);
  assert.equal(result.status, 'reconciled');
  assert.deepEqual(result.conflicts, []);
  assert.ok([...readCommittedState(dir).leaves.values()].some((leaf) => leaf.text === '- later reviewed root-b edit'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reconciling one changed leaf emits exactly one leaf upsert', () => {
  const dir = temp();
  write(dir, 'root-1-topics.md', '# Root-1\n\n## Notes\n\n- changed leaf\n\n- stable sibling\n');
  write(dir, 'root-2-technical.md', '# Root-2\n\n## Systems\n\n- stable other-root leaf\n');
  importMarkdown(dir);
  const file = path.join(dir, 'root-1-topics.md');
  write(dir, 'root-1-topics.md', fs.readFileSync(file, 'utf8').replace('- changed leaf', '- changed leaf reviewed'));
  const beforeLog = readEventLog(dir).records.length;
  assert.equal(reconcileMarkdown(dir).status, 'reconciled');
  assert.equal(operationRecordsSince(dir, beforeLog, 'leaf.upsert').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compiler split upserts exactly the leaves whose canonical placement changed', () => {
  const dir = multiRootOvergrownTree();
  const before = readCommittedState(dir);
  const beforeLog = readEventLog(dir).records.length;
  applyCompilerPlan(dir, compileDryRun(dir));
  const after = readCommittedState(dir);
  const fields = ['contentHash', 'file', 'branch', 'index', 'kind'];
  const expected = [...after.leaves.values()].filter((leaf) => {
    const previous = before.leaves.get(leaf.id);
    return !previous || fields.some((field) => previous[field] !== leaf[field]);
  }).length;
  const upserts = operationRecordsSince(dir, beforeLog, 'leaf.upsert');
  assert.equal(upserts.length, expected);
  assert.ok(upserts.length < before.leaves.size);
  assert.ok(upserts.every((record) => record.operation.leaf.file === 'root-2-technical.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unchanged edges are not re-upserted by compiler or forgetting transactions', () => {
  const dir = multiRootOvergrownTree({ withEdge: true });
  assert.equal(readCommittedState(dir).edges.size, 1);
  let beforeLog = readEventLog(dir).records.length;
  applyCompilerPlan(dir, compileDryRun(dir));
  assert.equal(operationRecordsSince(dir, beforeLog, 'edge.upsert').length, 0);
  const forgotten = [...readCommittedState(dir).leaves.values()].find((leaf) => leaf.file === 'root-2-technical.md');
  beforeLog = readEventLog(dir).records.length;
  forgetMemoryLeaf(dir, forgotten.id);
  assert.equal(operationRecordsSince(dir, beforeLog, 'edge.upsert').length, 0);
  assert.equal(readCommittedState(dir).edges.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compiler rejects a fresh-hash plan whose action content was hand-tampered', () => {
  const dir = overgrownTree();
  const plan = compileDryRun(dir);
  const split = plan.actions.find((action) => action.type === 'branch.split' && action.applicable);
  split.clusters[0].name = 'Operations / Fabricated';
  assert.throws(() => applyCompilerPlan(dir, plan), /not produced by the current trusted dry run/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8'), /Fabricated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compiler emits a concrete non-destructive index diff', () => {
  const leaves = Array.from({ length: 15 }, (_, i) => `- index content ${i}`).join('\n');
  const dir = treeWith(`# Root-0\n\n## Map\n\n${leaves}\n`, 'root-0-index.md');
  const action = compileDryRun(dir).actions.find((item) => item.type === 'index.diff');
  assert.equal(action.applicable, false);
  assert.equal(action.removals.length, 15);
  assert.match(action.unified, /^- L/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compiler repairs an unambiguous stable-ID path mismatch', () => {
  const dir = temp();
  write(dir, 'root-1-topics.md', '# Root-1\n\n## Bridges\n\n- bridge (bkz: Root-2 / APIs)\n');
  write(dir, 'root-2-technical.md', '# Root-2\n\n## APIs\n\n- canonical target\n');
  importMarkdown(dir);
  const targetFile = path.join(dir, 'root-2-technical.md');
  write(dir, 'root-2-technical.md', fs.readFileSync(targetFile, 'utf8').replace('## APIs', '## Interfaces'));
  assert.equal(reconcileMarkdown(dir).status, 'reconciled');
  const plan = compileDryRun(dir);
  const repair = plan.actions.find((action) => action.type === 'edge.repair' && action.applicable);
  assert.equal(repair.newHuman, 'bkz: Root-2 / Interfaces');
  applyCompilerPlan(dir, plan);
  assert.match(fs.readFileSync(path.join(dir, 'root-1-topics.md'), 'utf8'), /bkz: Root-2 \/ Interfaces/);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n  ${passed} Rock 6C tests passed`);
