#!/usr/bin/env node
/**
 * selftest.mjs — Urðr tooling self-test (cross-platform, LLM-free, zero-dependency)
 *
 * Exercises every tool against a temporary fixture and exits non-zero on any failure.
 * Runs identically on macOS, Windows, and Linux — used by CI (3-OS matrix) and locally.
 *
 * Usage:  node scripts/selftest.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { searchMemory } from './search.mjs';
import { appendLeaf, atomicReplaceFile, insertLeaf, resolveConfinedTarget } from './append.mjs';
import { lintTree } from './lint.mjs';
import { parseMarkdown } from './lib/markdown-model.mjs';
import { acquireLeaseLock, assertLeaseOwned, releaseLeaseLock } from './lib/lock.mjs';
import { canonicalJson, hashContent, hashEvent, readCommittedState, readEventLog } from './lib/event-log.mjs';
import {
  beginTransaction,
  DirtyViewError,
  exportMarkdown,
  importMarkdown,
  readPublishedGeneration,
  readPublishedRoot,
  reconcileMarkdown,
} from './lib/transaction.mjs';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runChild(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code));
  });
}

const root2 = '# Root-2: Technical\n\n---\n\n## APIs\n\n_No entries yet._\n\n---\n\n## Fixes\n\n_No entries yet._\n\n---\n';

function tmpTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root2);
  return dir;
}

console.log('\n  🌳 Urðr self-test\n  ' + '─'.repeat(50));

// ── markdown-model.mjs ─────────────────────────────────────────────
{
  const fixture = [
    '# Root',
    '<!-- ordinary prose',
    '## Not a branch',
    'secret comment text',
    '-->',
    '## English',
    '_No entries yet._',
    '## Turkish',
    '_Henüz kayıt yok._',
    '## Rich',
    '<!-- urdr:id:abc123 -->',
    '**01.01.2026 — Entry — outcome**',
    'continuation line',
    '  - nested detail',
    '',
    '- top-level item',
    '  continuation',
    '  - nested item',
    '',
    '| Key | Value |',
    '| --- | --- |',
    '| a | b |',
    '',
    '> quoted line',
    '> continuation',
    '',
    '```md',
    '## Not a branch either',
    '<!-- code, not a comment -->',
    '```',
    '',
  ].join('\r\n');
  const model = parseMarkdown(fixture);
  ok(model.newline === '\r\n', 'parser: preserves CRLF style');
  ok(model.branches.map((b) => b.name).join('|') === 'English|Turkish|Rich', 'parser: headings in comments/fences are not branches');
  ok(model.metadata.length === 1 && model.metadata[0].value === 'id:abc123', 'parser: Urðr metadata comments parsed and preserved');
  ok(!model.leaves.some((leaf) => /secret comment text/.test(leaf.text)), 'parser: full multiline prose comments ignored');
  ok(model.branches[0].leaves.length === 0 && model.branches[1].leaves.length === 0, 'parser: English and Turkish placeholders are empty branches');
  const rich = model.branches[2].leaves;
  ok(rich.length === 5, 'parser: real entry/list/table/blockquote/fence boundaries');
  ok(rich[0].kind === 'entry' && /nested detail/.test(rich[0].text), 'parser: multiline entry keeps continuation and nested content');
  ok(rich[1].kind === 'list-item' && /nested item/.test(rich[1].text), 'parser: nested list stays in its parent leaf');
  ok(rich[2].kind === 'table' && rich[3].kind === 'blockquote' && rich[4].kind === 'code-fence', 'parser: table, blockquote, and fenced code are leaf units');
  ok(/<!-- code, not a comment -->/.test(rich[4].text), 'parser: fenced code content is preserved');
}

// ── append.mjs ──────────────────────────────────────────────────────
{
  const dir = tmpTree();
  const appended = appendLeaf(dir, 'root-2-technical.md', 'APIs', '**01.01.2026 — sqlite — chose SQLite**');
  let c = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(c.includes('SQLite'), 'append: leaf written');
  const committedLeaf = readCommittedState(dir).leaves.get(appended.id);
  ok(Boolean(appended.id && appended.transactionId && committedLeaf?.text.includes('SQLite')),
    'append: stable leaf ID is immediately visible in committed state');
  ok(!/## APIs[\s\S]*?_No entries yet\._/.test(c.split('## Fixes')[0]), 'append: placeholder replaced in APIs');
  appendLeaf(dir, 'root-2-technical.md', 'APIs', '**02.02.2026 — redis — chose Redis**');
  c = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(c.includes('SQLite') && c.includes('Redis'), 'append: append-only (keeps siblings)');
  ok((c.match(/^## APIs/gm) || []).length === 1, 'append: file structure intact');
  // wrong branch → throws
  let threw = false;
  try { appendLeaf(dir, 'root-2-technical.md', 'NoSuchBranch', 'x'); } catch { threw = true; }
  ok(threw, 'append: unknown branch rejected');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmpTree();
  const appendScript = fileURLToPath(new URL('./append.mjs', import.meta.url));
  // One authoritative hash chain requires tree-wide serialization. This test asserts
  // correctness/no-loss only; appenders are not expected to execute in parallel.
  const writers = Array.from({ length: 6 }, (_, index) => runChild(process.execPath, [appendScript, dir,
    'root-2-technical.md', 'APIs', `**01.01.2026 — concurrent-${index} — retained**`]));
  const statuses = await Promise.all(writers);
  const content = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(statuses.every((status) => status === 0) && writers.every((_, index) => content.includes(`concurrent-${index}`)),
    'append: concurrent processes retain every leaf');
  ok(readCommittedState(dir).leaves.size === 6,
    'append CLI: fresh legacy tree bootstraps all concurrent leaves into committed state');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── insertLeaf (pure) ───────────────────────────────────────────────
{
  const out = insertLeaf(root2, 'Fixes', '**03.03.2026 — bugfix — patched**');
  ok(out.includes('patched') && out.split('## Fixes')[1].includes('patched'), 'insertLeaf: places under correct branch');
}

// ── append validation and durability ────────────────────────────────
{
  const prose = insertLeaf(root2, 'APIs', '**01.01.2026 — note — prose may contain ## literally**');
  ok(prose.includes('## literally'), 'append: legitimate ## prose is accepted');
  const fenced = insertLeaf(root2, 'APIs', '```md\n## code heading\n```');
  ok(fenced.includes('## code heading'), 'append: heading syntax inside a fence is accepted');
  let headingRejected = false;
  try { insertLeaf(root2, 'APIs', '## Injected branch\ntext'); } catch { headingRejected = true; }
  ok(headingRejected, 'append: actual Markdown heading injection rejected');

  const dir = tmpTree();
  let traversalRejected = false;
  try { resolveConfinedTarget(dir, '../root-2-technical.md'); } catch { traversalRejected = true; }
  ok(traversalRejected, 'append: parent path traversal rejected');
  let absoluteRejected = false;
  try { resolveConfinedTarget(dir, path.join(dir, 'root-2-technical.md')); } catch { absoluteRejected = true; }
  ok(absoluteRejected, 'append: absolute root path rejected');

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-outside-'));
  fs.writeFileSync(path.join(outside, 'escaped.md'), root2);
  let symlinkRejected = false;
  let symlinkSupported = true;
  try {
    fs.symlinkSync(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    try { resolveConfinedTarget(dir, path.join('escape', 'escaped.md')); } catch { symlinkRejected = true; }
  } catch { symlinkSupported = false; }
  ok(!symlinkSupported || symlinkRejected, 'append: realpath confinement rejects symlink/junction escape');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

{
  for (const stage of ['before-fsync', 'before-rename', 'after-rename', 'before-directory-fsync']) {
    const dir = tmpTree();
    const target = path.join(dir, 'root-2-technical.md');
    const next = insertLeaf(fs.readFileSync(target, 'utf8'), 'APIs', `**01.01.2026 — ${stage} — test**`);
    const lock = acquireLeaseLock(`${target}.lock`);
    let injected = false;
    try { atomicReplaceFile(target, next, lock, { faultAt: stage }); }
    catch (error) { injected = error.message === `fault injection: ${stage}`; }
    finally { releaseLeaseLock(lock); }
    const content = fs.readFileSync(target, 'utf8');
    const changed = content.includes(stage);
    ok(injected, `atomic write: ${stage} fault hook fires`);
    ok(stage === 'before-fsync' || stage === 'before-rename' ? !changed : changed, `atomic write: ${stage} has the expected commit boundary`);
    ok(!fs.readdirSync(dir).some((name) => name.includes('.tmp-')), `atomic write: ${stage} cleans temporary files`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── event log + stable IDs ───────────────────────────────────
{
  ok(canonicalJson({ z: 1, a: { y: 2, b: 3 } }) === '{"a":{"b":3,"y":2},"z":1}',
    'event log: canonical JSON recursively sorts keys');

  const future = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-schema-'));
  fs.mkdirSync(path.join(future, '.urdr'));
  const futureRecord = { schemaVersion: 2, kind: 'future', prevHash: null, sequence: 1 };
  futureRecord.hash = hashEvent(futureRecord);
  fs.writeFileSync(path.join(future, '.urdr', 'events.jsonl'), `${canonicalJson(futureRecord)}\n`);
  const futureRead = readEventLog(future);
  ok(futureRead.integrity && futureRead.records.length === 1
    && futureRead.warnings.some((warning) => warning.code === 'unsupported-schema-version'),
  'event log: newer schema records are preserved and reported without crashing');
  fs.rmSync(future, { recursive: true, force: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-stable-'));
  fs.writeFileSync(path.join(dir, 'root-1-topics.md'), [
    '# Root-1', '', '## Items', '',
    '**01.01.2026 - duplicate - same text**', '',
    '**01.01.2026 - duplicate - same text**', '',
  ].join('\n'));
  const firstImport = importMarkdown(dir);
  let model = parseMarkdown(fs.readFileSync(path.join(dir, 'root-1-topics.md'), 'utf8'));
  const originalIds = model.leaves.map((leaf) => leaf.id);
  ok(firstImport.status === 'imported' && new Set(originalIds).size === 2 && originalIds.every(Boolean),
    'stable IDs: duplicate leaves receive distinct embedded IDs');

  const reordered = [
    '# Root-1', '', '## Renamed Items', '',
    `<!-- urdr:id:${originalIds[1]} -->`, model.leaves[1].raw, '',
    `<!-- urdr:id:${originalIds[0]} -->`, model.leaves[0].raw.replace('same text', 'edited text'), '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'root-1-topics.md'), reordered);
  const reconciled = reconcileMarkdown(dir);
  model = parseMarkdown(fs.readFileSync(path.join(dir, 'root-1-topics.md'), 'utf8'));
  ok(reconciled.status === 'reconciled' && new Set(model.leaves.map((leaf) => leaf.id)).size === 2
    && originalIds.every((id) => model.leaves.some((leaf) => leaf.id === id)),
  'stable IDs: IDs survive branch rename, reorder, and leaf edit');

  const exported = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-export-'));
  exportMarkdown(dir, exported);
  importMarkdown(exported);
  const exportedIds = parseMarkdown(fs.readFileSync(path.join(exported, 'root-1-topics.md'), 'utf8')).leaves.map((leaf) => leaf.id);
  const eventCount = readEventLog(exported).records.length;
  const repeated = importMarkdown(exported);
  ok(originalIds.every((id) => exportedIds.includes(id)) && repeated.status === 'unchanged'
    && readEventLog(exported).records.length === eventCount,
  'stable IDs: export/re-import round-trip is idempotent');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(exported, { recursive: true, force: true });
}

// ── structured bkz edges ─────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-edges-'));
  fs.writeFileSync(path.join(dir, 'root-1-topics.md'), [
    '# Root-1', '', '## Projects', '',
    '- linked project (bkz: Root-2 / APIs)', '',
    '- ambiguous project (bkz: Root-2 / Systems)', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), [
    '# Root-2', '', '## APIs', '', '- canonical API leaf', '',
    '## Systems', '', '- first system', '', '- second system', '',
  ].join('\n'));
  importMarkdown(dir);
  const state = readCommittedState(dir);
  const markdown = fs.readFileSync(path.join(dir, 'root-1-topics.md'), 'utf8');
  ok([...state.edges.values()].some((edge) => edge.status === 'resolved' && edge.targetId)
    && /<!-- urdr:edge:\d+:u_/.test(markdown),
  'bkz edges: unambiguous legacy reference migrates to an ID-backed edge');
  ok([...state.edges.values()].some((edge) => edge.status === 'legacy-unresolved' && edge.targetId === null),
    'bkz edges: ambiguous legacy reference is explicitly flagged unresolved');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── transaction atomicity ────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-tx-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), '# Root-2\n\n## APIs\n\n- initial\n');
  importMarkdown(dir);
  const before = readCommittedState(dir).operations.length;
  const aborted = beginTransaction(dir);
  aborted.addOperation({ type: 'test.aborted', value: 1 });
  aborted.abort();
  ok(readCommittedState(dir).operations.length === before, 'transaction: abort has zero visible effect');

  const interrupted = beginTransaction(dir);
  interrupted.addOperation({ type: 'test.interrupted', value: 1 });
  let interruptedFault = false;
  try { interrupted.commit({ faultAt: 'before-fsync' }); }
  catch (error) { interruptedFault = /fault injection/.test(error.message); }
  ok(interruptedFault && readCommittedState(dir).operations.length === before,
    'transaction: interrupted uncommitted operations have zero visible effect');
  fs.rmSync(dir, { recursive: true, force: true });

  const recovery = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-tx-recovery-'));
  const recoveryFile = path.join(recovery, 'root-2-technical.md');
  fs.writeFileSync(recoveryFile, '# Root-2\n\n## APIs\n\n- original\n');
  importMarkdown(recovery);
  const recoveryBefore = fs.readFileSync(recoveryFile, 'utf8');
  const recoveryLeaf = readCommittedState(recovery).leaves.get(parseMarkdown(recoveryBefore).leaves[0].id);
  const recoveryNext = recoveryBefore.replace('- original', '- committed before crash');
  let recoveryFault = false;
  try {
    beginTransaction(recovery)
      .upsertLeaf({ ...recoveryLeaf, text: '- committed before crash', contentHash: hashContent('- committed before crash') })
      .publishRoot('root-2-technical.md', recoveryNext)
      .commit({ faultAt: 'before-published-view-materialization' });
  } catch (error) { recoveryFault = /fault injection/.test(error.message); }
  const committedRecords = readEventLog(recovery).records.length;
  ok(recoveryFault && fs.readFileSync(recoveryFile, 'utf8') === recoveryBefore
    && [...readCommittedState(recovery).leaves.values()].some((leaf) => leaf.text === '- committed before crash'),
  'transaction recovery: committed event survives a crash before live-file materialization');
  const recovered = reconcileMarkdown(recovery);
  ok(recovered.status === 'clean' && fs.readFileSync(recoveryFile, 'utf8') === recoveryNext
    && readEventLog(recovery).records.length === committedRecords
    && [...readCommittedState(recovery).leaves.values()].some((leaf) => leaf.text === '- committed before crash'),
  'transaction recovery: reconcile repairs the live file without logging a spurious deletion');
  fs.rmSync(recovery, { recursive: true, force: true });

  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-tx-partial-'));
  const partialTechnical = path.join(partial, 'root-2-technical.md');
  const partialDecisions = path.join(partial, 'root-3-decisions.md');
  fs.writeFileSync(partialTechnical, '# Root-2\n\n## APIs\n\n- old API\n');
  fs.writeFileSync(partialDecisions, '# Root-3\n\n## Rules\n\n- old rule\n');
  importMarkdown(partial);
  const technicalBefore = fs.readFileSync(partialTechnical, 'utf8');
  const decisionsBefore = fs.readFileSync(partialDecisions, 'utf8');
  const partialState = readCommittedState(partial);
  const technicalLeaf = partialState.leaves.get(parseMarkdown(technicalBefore).leaves[0].id);
  const decisionsLeaf = partialState.leaves.get(parseMarkdown(decisionsBefore).leaves[0].id);
  const technicalAfter = technicalBefore.replace('- old API', '- new API');
  const decisionsAfter = decisionsBefore.replace('- old rule', '- new rule');
  let materializedFiles = 0;
  let partialFault = false;
  try {
    beginTransaction(partial)
      .upsertLeaf({ ...technicalLeaf, text: '- new API', contentHash: hashContent('- new API') })
      .upsertLeaf({ ...decisionsLeaf, text: '- new rule', contentHash: hashContent('- new rule') })
      .publishRoot('root-2-technical.md', technicalAfter)
      .publishRoot('root-3-decisions.md', decisionsAfter)
      .commit({ faultInjector(stage) {
        if (stage === 'after-published-view-materialization-file' && ++materializedFiles === 1) {
          throw new Error(`fault injection: ${stage}`);
        }
      } });
  } catch (error) { partialFault = /fault injection/.test(error.message); }
  const partialRecords = readEventLog(partial).records.length;
  ok(partialFault && fs.readFileSync(partialTechnical, 'utf8') === technicalAfter
    && fs.readFileSync(partialDecisions, 'utf8') === decisionsBefore,
  'transaction recovery: multi-file crash leaves an observable partial materialization');
  const partialRecovered = importMarkdown(partial);
  const partialRecoveredState = readCommittedState(partial);
  ok(partialRecovered.status === 'unchanged'
    && fs.readFileSync(partialTechnical, 'utf8') === technicalAfter
    && fs.readFileSync(partialDecisions, 'utf8') === decisionsAfter
    && readEventLog(partial).records.length === partialRecords
    && partialRecoveredState.leaves.get(technicalLeaf.id)?.text === '- new API'
    && partialRecoveredState.leaves.get(decisionsLeaf.id)?.text === '- new rule',
  'transaction recovery: import resumes all files without silently losing the unwritten view');
  fs.rmSync(partial, { recursive: true, force: true });
}

// ── reconciliation and dirty-view gate ───────────────────────
{
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-new-root-'));
  const newRootFile = path.join(newRoot, 'root-4-new.md');
  const newLeaf = {
    id: 'new-root-leaf',
    file: 'root-4-new.md',
    branch: 'Fresh',
    kind: 'list-item',
    index: 0,
    text: '- first leaf',
    contentHash: hashContent('- first leaf'),
  };
  const newRootContent = '# Root-4: New\n\n## Fresh\n\n<!-- urdr:id:new-root-leaf -->\n- first leaf\n';
  let newRootError = null;
  try {
    beginTransaction(newRoot).upsertLeaf(newLeaf).publishRoot('root-4-new.md', newRootContent).commit();
  } catch (error) { newRootError = error; }
  ok(newRootError === null
    && fs.existsSync(newRootFile)
    && fs.readFileSync(newRootFile, 'utf8') === newRootContent
    && readCommittedState(newRoot).leaves.get(newLeaf.id)?.text === newLeaf.text,
  'dirty-view gate: transaction can publish a brand-new root file');
  fs.rmSync(newRoot, { recursive: true, force: true });

  const deletedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-deleted-root-'));
  const deletedFile = path.join(deletedRoot, 'root-2-technical.md');
  const differentFile = path.join(deletedRoot, 'root-3-decisions.md');
  fs.writeFileSync(deletedFile, '# Root-2\n\n## APIs\n\n- original\n');
  fs.writeFileSync(differentFile, '# Root-3\n\n## Rules\n\n- original rule\n');
  importMarkdown(deletedRoot);
  const deletedLeafId = parseMarkdown(fs.readFileSync(deletedFile, 'utf8')).leaves[0].id;
  const differentContent = fs.readFileSync(differentFile, 'utf8');
  const differentNext = differentContent.replace('- original rule', '- changed rule');
  const differentLeaf = readCommittedState(deletedRoot).leaves.get(parseMarkdown(differentContent).leaves[0].id);
  fs.rmSync(deletedFile);
  beginTransaction(deletedRoot)
    .upsertLeaf({ ...differentLeaf, text: '- changed rule', contentHash: hashContent('- changed rule') })
    .publishRoot('root-3-decisions.md', differentNext)
    .commit();
  const deletedResult = reconcileMarkdown(deletedRoot);
  ok(deletedResult.status === 'reconciled'
    && deletedResult.changedLeaves === 1
    && !fs.existsSync(deletedFile)
    && !readCommittedState(deletedRoot).leaves.has(deletedLeafId),
  'reconciliation: out-of-band root deletion survives an unrelated publication and is committed');
  fs.rmSync(deletedRoot, { recursive: true, force: true });

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-reconcile-clean-'));
  fs.writeFileSync(path.join(clean, 'root-2-technical.md'), '# Root-2\n\n## APIs\n\n- original\n');
  importMarkdown(clean);
  const cleanFile = path.join(clean, 'root-2-technical.md');
  fs.writeFileSync(cleanFile, fs.readFileSync(cleanFile, 'utf8').replace('- original', '- direct edit'));
  const cleanResult = reconcileMarkdown(clean);
  ok(cleanResult.status === 'reconciled' && [...readCommittedState(clean).leaves.values()].some((leaf) => /direct edit/.test(leaf.text)),
    'reconciliation: clean direct edit becomes a committed event');
  fs.rmSync(clean, { recursive: true, force: true });

  const conflict = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-reconcile-conflict-'));
  fs.writeFileSync(path.join(conflict, 'root-2-technical.md'), '# Root-2\n\n## APIs\n\n- original\n');
  importMarkdown(conflict);
  const conflictFile = path.join(conflict, 'root-2-technical.md');
  const parsed = parseMarkdown(fs.readFileSync(conflictFile, 'utf8'));
  const leaf = readCommittedState(conflict).leaves.get(parsed.leaves[0].id);
  beginTransaction(conflict).upsertLeaf({ ...leaf, text: '- event-log edit', contentHash: 'event-log-edit' }).commit();
  fs.writeFileSync(conflictFile, fs.readFileSync(conflictFile, 'utf8').replace('- original', '- direct edit'));
  const conflictResult = reconcileMarkdown(conflict);
  ok(conflictResult.status === 'conflict' && conflictResult.conflicts[0].id === leaf.id,
    'reconciliation: same leaf changed directly and through event log is a conflict');

  const proposed = fs.readFileSync(conflictFile, 'utf8').replace('- direct edit', '- proposed publish');
  const gated = beginTransaction(conflict).addOperation({ type: 'test.publish' }).publishRoot('root-2-technical.md', proposed);
  let dirtyError = null;
  try { gated.commit(); } catch (error) { dirtyError = error; }
  ok(dirtyError instanceof DirtyViewError && dirtyError.recoveryCopies.every((file) => fs.existsSync(file)),
    'dirty-view gate: dirty publication is refused and recovery copy retained');
  fs.rmSync(conflict, { recursive: true, force: true });

  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-gate-clean-'));
  fs.writeFileSync(path.join(allowed, 'root-2-technical.md'), '# Root-2\n\n## APIs\n\n- original\n');
  fs.writeFileSync(path.join(allowed, 'root-3-decisions.md'), '# Root-3\n\n## Rules\n\n- original rule\n');
  importMarkdown(allowed);
  const allowedContent = fs.readFileSync(path.join(allowed, 'root-2-technical.md'), 'utf8');
  const allowedDecision = fs.readFileSync(path.join(allowed, 'root-3-decisions.md'), 'utf8');
  const technicalNext = allowedContent.replace('- original', '- generation two');
  const decisionNext = allowedDecision.replace('- original rule', '- generation two rule');
  const allowedState = readCommittedState(allowed);
  const technicalLeaf = allowedState.leaves.get(parseMarkdown(allowedContent).leaves[0].id);
  const decisionLeaf = allowedState.leaves.get(parseMarkdown(allowedDecision).leaves[0].id);
  const allowedTx = beginTransaction(allowed)
    .upsertLeaf({ ...technicalLeaf, text: '- generation two', contentHash: hashContent('- generation two') })
    .upsertLeaf({ ...decisionLeaf, text: '- generation two rule', contentHash: hashContent('- generation two rule') })
    .publishRoot('root-2-technical.md', technicalNext)
    .publishRoot('root-3-decisions.md', decisionNext);
  const allowedResult = allowedTx.commit();
  ok(Boolean(allowedResult.commit), 'dirty-view gate: clean publication is allowed');
  const publishedGeneration = readPublishedGeneration(allowed);
  ok(/generation two/.test(publishedGeneration.files.get('root-2-technical.md'))
    && /generation two rule/.test(publishedGeneration.files.get('root-3-decisions.md'))
    && readPublishedRoot(allowed, 'root-2-technical.md') === publishedGeneration.files.get('root-2-technical.md'),
  'publish: event-aware reader sees one complete multi-file generation');
  fs.rmSync(allowed, { recursive: true, force: true });
}

// ── hash-chain corruption and truncation ─────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-chain-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), '# Root-2\n\n## APIs\n\n- initial\n');
  importMarkdown(dir);
  const logFile = path.join(dir, '.urdr', 'events.jsonl');
  const healthy = readEventLog(dir);
  ok(healthy.records.every((record) => record.schemaVersion === 1)
    && healthy.records.some((record) => record.kind === 'commit')
    && healthy.records.every((record, index) => record.prevHash === (healthy.records[index - 1]?.hash || null)),
  'event log: records are schema-versioned, committed, and hash-chained');
  const original = fs.readFileSync(logFile, 'utf8');
  const lines = original.trimEnd().split('\n');
  const changed = JSON.parse(lines[0]);
  changed.timestamp = 'tampered';
  lines[0] = JSON.stringify(changed);
  fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
  ok(readEventLog(dir).errors.some((error) => error.code === 'hash-chain-corruption'),
    'event log: hash-chain corruption is detected');

  fs.writeFileSync(logFile, original.slice(0, -7));
  const truncated = readEventLog(dir);
  ok(truncated.tailIssue != null && truncated.errors.some((error) => error.code === 'log-truncated'),
    'event log: incomplete final line is reported without crashing');

  fs.writeFileSync(logFile, `${original}{"incomplete"`);
  const recoverable = readEventLog(dir);
  ok(recoverable.warnings.some((warning) => warning.code === 'truncated-tail') && recoverable.integrity,
    'event log: unanchored incomplete tail is recognized as recoverable');
  beginTransaction(dir).addOperation({ type: 'test.after-recovery' }).commit();
  ok(readEventLog(dir).integrity, 'event log: next append recovers an incomplete unanchored tail');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── independent lease keeper ────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-lock-'));
  const lockDir = path.join(dir, 'writer.lock');
  const first = acquireLeaseLock(lockDir, { timeoutMs: 2000, staleMs: 180, updateMs: 40 });
  sleepSync(360);
  ok(assertLeaseOwned(first), 'lock: subprocess renews while writer event loop is blocked');
  let contended = false;
  try { acquireLeaseLock(lockDir, { timeoutMs: 120, staleMs: 180, updateMs: 40 }); }
  catch (error) { contended = /lock timeout/.test(error.message); }
  ok(contended, 'lock: active owner cannot be stolen');
  releaseLeaseLock(first);

  const abandoned = acquireLeaseLock(lockDir, { timeoutMs: 2000, staleMs: 120, updateMs: 30 });
  process.kill(abandoned.pid);
  sleepSync(220);
  let renewalFailureDetected = false;
  try { assertLeaseOwned(abandoned); } catch (error) { renewalFailureDetected = /keeper stopped|renewal failed/.test(error.message); }
  ok(renewalFailureDetected, 'lock: writer detects lease-keeper renewal failure');
  const successor = acquireLeaseLock(lockDir, { timeoutMs: 2000, staleMs: 120, updateMs: 30 });
  ok(assertLeaseOwned(successor), 'lock: stale lease is recovered after renewal failure');
  releaseLeaseLock(abandoned);
  ok(assertLeaseOwned(successor), 'lock: former owner cannot release successor lease');
  releaseLeaseLock(successor);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── search.mjs ──────────────────────────────────────────────────────
{
  const dir = tmpTree();
  appendLeaf(dir, 'root-2-technical.md', 'APIs', '**01.01.2026 — sqlite — chose SQLite for storage**');
  appendLeaf(dir, 'root-2-technical.md', 'Fixes', '**02.02.2026 — oauth — fixed refresh loop**');
  const hit = searchMemory(dir, 'oauth');
  ok(hit.count === 1, 'search: finds the leaf');
  ok(hit.results[0].branch === 'Fixes', 'search: branch-aware result');
  ok(searchMemory(dir, 'kubernetes').count === 0, 'search: miss returns empty');
  ok(searchMemory(dir, '').error != null, 'search: empty query guarded');
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root2.replace('_No entries yet._',
    '<!-- hidden\ncomment-only-key\n-->\n\n```md\n## fake\ncode-only-key\n```'));
  ok(searchMemory(dir, 'comment-only-key').count === 0, 'search: ordinary multiline comments are ignored');
  const codeHit = searchMemory(dir, 'code-only-key');
  ok(codeHit.count === 1 && codeHit.results[0].branch === 'APIs', 'search: fenced code is searchable without creating a fake branch');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── lint.mjs ────────────────────────────────────────────────────────
{
  const clean = tmpTree();
  appendLeaf(clean, 'root-2-technical.md', 'APIs', '**01.01.2026 — note — a unique fact about storage**');
  const lc = lintTree(clean);
  ok(lc.findings.filter((f) => f.level === 'error').length === 0, 'lint: clean tree has no errors');
  fs.rmSync(clean, { recursive: true, force: true });

  const turkish = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-tr-'));
  fs.writeFileSync(path.join(turkish, 'kök-2-teknik.md'), '# Kök-2\n\n## Sistemler\n\n_Henüz kayıt yok._\n');
  ok(lintTree(turkish).findings.length === 0, 'lint: Turkish placeholder creates no false leaf warnings');
  fs.rmSync(turkish, { recursive: true, force: true });

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-selftest-bad-'));
  // broken bkz + near-duplicate
  fs.writeFileSync(path.join(bad, 'root-3-decisions.md'),
    '# Root-3: Decisions\n\n## Rules\n\n**01.01.2026 — rule — see also bkz: root-9-ghost (Missing)**\n' +
    '**02.02.2026 — never store plaintext secrets in the repo ever**\n' +
    '**03.03.2026 — never store plaintext secrets in the repo ever**\n');
  const lb = lintTree(bad);
  ok(lb.findings.some((f) => f.code === 'broken-ref'), 'lint: catches broken bkz: ref');
  ok(lb.findings.some((f) => f.code === 'duplication'), 'lint: catches near-duplicate');
  fs.rmSync(bad, { recursive: true, force: true });
}

// ── write fidelity (bench core) ─────────────────────────────────────
{
  const dir = tmpTree();
  const leaf = '**04.07.2026 — çğıöşü-fidelity — unicode + **bold** | pipe · dash**';
  appendLeaf(dir, 'root-2-technical.md', 'APIs', leaf);
  const c = fs.readFileSync(path.join(dir, 'root-2-technical.md'), 'utf8');
  ok(c.includes(leaf), 'fidelity: stored == intended (unicode + markdown-hostile chars)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Rock-focused suites stay isolated so their CLI/process fixtures cannot leak state into
// the long-running concurrency suite, but they are still part of this canonical proof run.
for (const [file, label] of [['rock2-selftest.mjs', 'Rock 2'], ['rock3-selftest.mjs', 'Rock 3']]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./${file}`, import.meta.url))], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const count = Number(result.stdout?.match(/(\d+) Rock \d+ tests passed/)?.[1] || 0);
  if (result.status === 0 && count > 0) passed += count;
  else {
    failed++;
    console.log(`  ✗ ${label} focused suite failed (exit ${result.status ?? 'unknown'})`);
  }
}

console.log('\n  ' + '─'.repeat(50));
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
