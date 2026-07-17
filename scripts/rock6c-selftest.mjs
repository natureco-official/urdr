#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCompilerPlan, compileDryRun } from './compiler.mjs';
import { EVENT_SCHEMA_VERSION, readCommittedState, readEventLog } from './lib/event-log.mjs';
import { forgetMemoryLeaf, resumeForgottenArtifactScrubs, scrubForgottenArtifacts } from './lib/forgetting.mjs';
import { proposeBranchSplit } from './lib/auto-split.mjs';
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
