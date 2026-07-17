#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySplitProposal, proposeBranchSplit } from './lib/auto-split.mjs';
import { canonicalJson, eventLogPaths, hashContent, readCommittedState } from './lib/event-log.mjs';
import { acquireLeaseLock, releaseLeaseLock } from './lib/lock.mjs';
import { parseMarkdown } from './lib/markdown-model.mjs';
import { beginTransaction, loadRootContents, populateTransactionFromViews } from './lib/transaction.mjs';
import { lintTree, MAX_LEAVES } from './lint.mjs';

export const COMPILER_PLAN_VERSION = 1;

function committedTreeHash(state) {
  const commits = [...state.committedTransactions.values()].sort((a, b) => a.sequence - b.sequence);
  const head = commits.at(-1) || null;
  return hashContent(canonicalJson({ hash: head?.hash || null, sequence: head?.sequence || 0 }));
}

function actionId(action) {
  const value = { ...action };
  delete value.id;
  return `fix_${hashContent(canonicalJson(value)).slice(0, 20)}`;
}

function rootNumber(file) { return path.basename(file).match(/(?:^|-)(\d+)(?:[-_]|$)/)?.[1] || null; }
function humanReference(leaf) { return `bkz: Root-${rootNumber(leaf.file)} / ${leaf.branch}`; }

function indexDiff(file, content) {
  const model = parseMarkdown(content);
  const leaves = model.branches.flatMap((branch) => branch.leaves
    .filter((leaf) => !/\bbkz:/iu.test(leaf.text))
    .map((leaf) => ({ branch: branch.name, id: leaf.id, line: leaf.startLine, text: leaf.text })));
  return {
    file,
    removals: leaves.map((leaf) => ({ ...leaf, preview: leaf.text.replace(/\s+/g, ' ').slice(0, 100) })),
    unified: leaves.map((leaf) => `- L${leaf.line} [${leaf.branch}] ${leaf.text.replace(/\s+/g, ' ')}`).join('\n'),
  };
}

function replaceLeafReference(content, action) {
  const model = parseMarkdown(content);
  const leaf = model.leaves.find((item) => item.id === action.sourceId);
  if (!leaf) throw new Error(`reference source leaf no longer exists: ${action.sourceId}`);
  const changed = leaf.text.replace(action.oldHuman, action.newHuman);
  if (changed === leaf.text) throw new Error(`reference text no longer matches: ${action.oldHuman}`);
  const lines = [...model.lines];
  lines.splice(leaf.startLine - 1, leaf.endLine - leaf.startLine + 1, ...changed.split(model.newline));
  return lines.join(model.newline);
}

function addAction(actions, action) {
  const complete = { ...action, id: actionId(action) };
  if (!actions.some((item) => item.id === complete.id)) actions.push(complete);
  return complete;
}

function buildPlanUnlocked(memoryDir) {
  const memory = path.resolve(memoryDir);
  const state = readCommittedState(memory);
  if (!state.integrity) throw new Error(`event log integrity failure: ${state.errors.map((item) => item.code).join(', ')}`);
  const lint = lintTree(memory);
  const contents = loadRootContents(memory);
  const actions = [];
  const splitTargetBranches = new Map();

  for (const finding of lint.findings.filter((item) => item.code === 'branch-leaves' && item.details?.threshold === MAX_LEAVES)) {
    const content = contents.get(finding.details.file);
    const branch = content && parseMarkdown(content).branches.find((item) => item.name === finding.details.branch);
    const proposal = branch && proposeBranchSplit({
      file: finding.details.file,
      branch: finding.details.branch,
      leaves: branch.leaves.map((leaf, index) => ({ id: leaf.id, index, line: leaf.startLine, text: leaf.text })),
    });
    if (!proposal) {
      addAction(actions, { type: 'branch.split', applicable: false, file: finding.details.file, branch: finding.details.branch, reason: 'insufficient repeated keyword evidence for a coherent split' });
      continue;
    }
    const existingBranches = new Set(parseMarkdown(content).branches.filter((item) => item.name !== proposal.branch).map((item) => item.name.toLocaleLowerCase()));
    const missingIds = proposal.clusters.some((cluster) => cluster.leafIds.some((id) => !state.leaves.has(id)));
    const collision = proposal.clusters.find((cluster) => existingBranches.has(cluster.name.toLocaleLowerCase()));
    const applicable = !missingIds && !collision;
    const reason = missingIds ? 'tree must be imported so every leaf has a committed stable ID'
      : collision ? `proposed branch already exists: ${collision.name}` : null;
    const action = addAction(actions, { ...proposal, applicable, ...(reason ? { reason } : {}) });
    if (applicable) for (const cluster of action.clusters) for (const id of cluster.leafIds) splitTargetBranches.set(id, cluster.name);
  }

  for (const finding of lint.findings.filter((item) => item.code === 'index-bloat')) {
    addAction(actions, {
      type: 'index.diff', applicable: false,
      reason: 'moving index content requires a human-selected domain destination; compiler refuses data loss',
      ...indexDiff(finding.details.file, contents.get(finding.details.file)),
    });
  }

  for (const finding of lint.findings.filter((item) => item.code === 'broken-ref')) {
    const { edge, source, target } = finding.details || {};
    if (edge?.targetId && source && target && edge.status === 'resolved-path-mismatch') {
      addAction(actions, { type: 'edge.repair', applicable: true, edgeId: edge.id, sourceId: source.id, file: source.file, oldHuman: edge.human, newHuman: humanReference(target), evidence: { targetId: target.id, targetFile: target.file, targetBranch: target.branch } });
    } else addAction(actions, { type: 'edge.repair', applicable: false, edgeId: edge?.id || null, reason: 'no unique live stable-ID target exists', evidence: finding.details || null });
  }

  for (const edge of state.edges.values()) {
    const branch = splitTargetBranches.get(edge.targetId);
    const source = state.leaves.get(edge.sourceId);
    const target = state.leaves.get(edge.targetId);
    if (!branch || !source || !target) continue;
    addAction(actions, {
      type: 'edge.repair', applicable: true, edgeId: edge.id, sourceId: source.id, file: source.file,
      oldHuman: edge.human, newHuman: humanReference({ ...target, branch }),
      evidence: { targetId: target.id, targetFile: target.file, targetBranch: branch, causedBySplit: true },
    });
  }

  return {
    planVersion: COMPILER_PLAN_VERSION,
    mode: 'dry-run',
    memoryDir: memory,
    treeStateHash: committedTreeHash(state),
    generatedAt: new Date().toISOString(),
    lint: { files: lint.files, findings: lint.findings },
    actions,
    applicableActions: actions.filter((action) => action.applicable).length,
  };
}

export function compileDryRun(memoryDir) {
  const memory = path.resolve(memoryDir);
  const paths = eventLogPaths(memory);
  const lock = acquireLeaseLock(paths.lockDir);
  try { return buildPlanUnlocked(memory); }
  finally { releaseLeaseLock(lock); }
}

export function applyCompilerPlan(memoryDir, plan) {
  const memory = path.resolve(memoryDir);
  if (plan?.planVersion !== COMPILER_PLAN_VERSION) throw new Error(`unsupported compiler plan version: ${plan?.planVersion}`);
  if (path.resolve(plan.memoryDir) !== memory) throw new Error('compiler plan belongs to a different memory tree');
  if (!Array.isArray(plan.actions)) throw new Error('compiler plan actions must be an array');
  const paths = eventLogPaths(memory);
  const lock = acquireLeaseLock(paths.lockDir);
  try {
    const state = readCommittedState(memory);
    const actualHash = committedTreeHash(state);
    if (actualHash !== plan.treeStateHash) throw new Error(`stale compiler plan: expected tree state ${plan.treeStateHash}, current state is ${actualHash}`);
    const freshPlan = buildPlanUnlocked(memory);
    const freshActions = new Map(freshPlan.actions.map((action) => [action.id, action]));
    const submittedIds = new Set();
    for (const action of plan.actions) {
      if (!action || typeof action !== 'object' || typeof action.id !== 'string'
        || action.id !== actionId(action) || !freshActions.has(action.id) || submittedIds.has(action.id)) {
        throw new Error(`compiler plan action was not produced by the current trusted dry run: ${action?.id || '(missing id)'}`);
      }
      submittedIds.add(action.id);
    }
    const selected = plan.actions.map((action) => freshActions.get(action.id)).filter((action) => action.applicable);
    if (!selected.length) throw new Error('compiler plan has no applicable approved actions');
    const contents = loadRootContents(memory);
    const changed = new Set();
    for (const action of selected.filter((item) => item.type === 'branch.split')) {
      contents.set(action.file, applySplitProposal(contents.get(action.file), action));
      changed.add(action.file);
    }
    for (const action of selected.filter((item) => item.type === 'edge.repair')) {
      contents.set(action.file, replaceLeafReference(contents.get(action.file), action));
      changed.add(action.file);
    }
    const transaction = beginTransaction(memory, { lock });
    populateTransactionFromViews(transaction, state, contents, { publishFiles: changed });
    const result = transaction.commit();
    return { status: 'applied', treeStateHash: actualHash, transactionId: result.transactionId, actionsApplied: selected.map((action) => action.id) };
  } finally {
    releaseLeaseLock(lock);
  }
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const applyIndex = args.indexOf('--apply');
  try {
    if (applyIndex >= 0) {
      const file = args[applyIndex + 1];
      const memoryDir = args.find((arg, index) => !arg.startsWith('--') && index !== applyIndex + 1);
      if (!file || !memoryDir) throw new Error('Usage: node scripts/compiler.mjs <memory-dir> --apply <plan.json>');
      console.log(JSON.stringify(applyCompilerPlan(memoryDir, JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
    } else {
      const memoryDir = args.find((arg) => !arg.startsWith('--')) || process.cwd();
      const plan = compileDryRun(memoryDir);
      const outIndex = args.indexOf('--out');
      if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify(plan, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
