/**
 * Event-log-aware readers get cross-file generation atomicity through the current-generation
 * pointer. Legacy readers that open root-*.md directly get only per-file atomic replacement.
 * A direct edit landing during the publish window is intentionally unsupported; edits made
 * before publication are protected by the dirty-view gate and must be reconciled first.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicReplaceFile, injectFault } from '../append.mjs';
import { listRootFiles, parseMarkdown, ROOT_FILE_RE } from './markdown-model.mjs';
import { acquireLeaseLock, assertLeaseOwned, releaseLeaseLock } from './lock.mjs';
import {
  appendTransaction,
  canonicalJson,
  eventLogPaths,
  hashContent,
  readCommittedState,
} from './event-log.mjs';

const BKZ_RE = /\bbkz:\s*((?:root|kök|kok)-?\d+)(?:\s*\/\s*([^\n();]+?))?(?=\s*(?:[();]|$))/giu;

export class DirtyViewError extends Error {
  constructor(files, recoveryCopies) {
    super(`dirty Markdown view${files.length === 1 ? '' : 's'}: ${files.join(', ')}; run reconciliation before publishing`);
    this.name = 'DirtyViewError';
    this.code = 'URDR_DIRTY_VIEW';
    this.files = files;
    this.recoveryCopies = recoveryCopies;
  }
}

function stableId() {
  return `u_${crypto.randomUUID()}`;
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/[\s_-]+/g, '-');
}

function rootNumber(file) {
  return path.basename(file).match(/(?:^|-)(\d+)(?:[-_]|$)/)?.[1] || null;
}

function insertMetadata(content, additions) {
  if (additions.size === 0) return content;
  const model = parseMarkdown(content);
  const lines = [...model.lines];
  for (const [line, comments] of [...additions.entries()].sort((a, b) => b[0] - a[0])) {
    lines.splice(line - 1, 0, ...comments);
  }
  return lines.join(model.newline);
}

function assignStableIds(content) {
  const model = parseMarkdown(content);
  const seen = new Set();
  const additions = new Map();
  for (const leaf of model.leaves) {
    const idMetadata = (leaf.metadata || []).filter((item) => /^id:/i.test(item.value));
    if (idMetadata.length > 1) throw new Error(`leaf has multiple Urðr ids at line ${leaf.startLine}`);
    if (leaf.id && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(leaf.id)) throw new Error(`invalid Urðr leaf id: ${leaf.id}`);
    if (leaf.id && seen.has(leaf.id)) throw new Error(`duplicate Urðr leaf id: ${leaf.id}`);
    if (leaf.id) seen.add(leaf.id);
    else additions.set(leaf.startLine, [`<!-- urdr:id:${stableId()} -->`]);
  }
  return insertMetadata(content, additions);
}

function leafSnapshot(file, content) {
  const model = parseMarkdown(content);
  const leaves = new Map();
  for (const [index, leaf] of model.leaves.entries()) {
    if (!leaf.id) throw new Error(`leaf without Urðr id in ${file}:${leaf.startLine}`);
    if (leaves.has(leaf.id)) throw new Error(`duplicate Urðr leaf id: ${leaf.id}`);
    leaves.set(leaf.id, {
      id: leaf.id,
      file,
      branch: leaf.branch,
      kind: leaf.kind,
      index,
      text: leaf.text,
      contentHash: hashContent(leaf.text),
    });
  }
  return { model, leaves };
}

function edgeId(sourceId, targetId, status, human) {
  return `e_${hashContent(canonicalJson({ human, sourceId, status, targetId })).slice(0, 24)}`;
}

function deriveEdges(contents, embedResolved) {
  const snapshots = new Map();
  const branches = new Map();
  for (const [file, content] of contents) {
    const snapshot = leafSnapshot(file, content);
    snapshots.set(file, snapshot);
    const number = rootNumber(file);
    for (const branch of snapshot.model.branches) {
      branches.set(`${number}/${normalize(branch.name)}`, branch.leaves.map((leaf) => leaf.id).filter(Boolean));
    }
  }

  const edges = new Map();
  const additionsByFile = new Map();
  for (const [file, snapshot] of snapshots) {
    const additions = new Map();
    for (const leaf of snapshot.model.leaves) {
      const matches = [...leaf.text.matchAll(BKZ_RE)];
      const explicit = leaf.edgeTargets || [];
      const used = new Set();
      for (const [matchIndex, match] of matches.entries()) {
        const number = match[1].match(/\d+/)?.[0];
        const branchName = String(match[2] || '').trim().replace(/[*_`.,:]+$/g, '').trim();
        const candidates = branches.get(`${number}/${normalize(branchName)}`) || [];
        let metadataIndex = explicit.findIndex((item, index) => !used.has(index) && item.index === matchIndex);
        if (metadataIndex < 0) metadataIndex = explicit.findIndex((item, index) => !used.has(index) && item.index === null);
        const explicitTarget = metadataIndex >= 0 ? explicit[metadataIndex].targetId : null;
        if (metadataIndex >= 0) used.add(metadataIndex);
        const targetId = explicitTarget || (candidates.length === 1 ? candidates[0] : null);
        const targetExists = targetId && [...snapshots.values()].some((item) => item.leaves.has(targetId));
        const status = !targetId ? 'legacy-unresolved'
          : !targetExists ? 'unresolved'
            : candidates.includes(targetId) ? 'resolved' : 'resolved-path-mismatch';
        const edge = { id: edgeId(leaf.id, targetId, status, match[0]), sourceId: leaf.id, targetId, status, human: match[0] };
        edges.set(edge.id, edge);
        if (embedResolved && targetId && !explicitTarget) {
          const comments = additions.get(leaf.startLine) || [];
          comments.push(`<!-- urdr:edge:${matchIndex}:${targetId} -->`);
          additions.set(leaf.startLine, comments);
        }
      }
      for (const [index, item] of explicit.entries()) {
        if (used.has(index)) continue;
        const targetExists = [...snapshots.values()].some((snapshot) => snapshot.leaves.has(item.targetId));
        const status = targetExists ? 'resolved-path-mismatch' : 'unresolved';
        const human = matches[item.index]?.[0] || 'bkz:';
        const edge = { id: edgeId(leaf.id, item.targetId, status, human), sourceId: leaf.id, targetId: item.targetId, status, human };
        edges.set(edge.id, edge);
      }
    }
    if (additions.size > 0) additionsByFile.set(file, additions);
  }

  if (embedResolved) {
    for (const [file, additions] of additionsByFile) contents.set(file, insertMetadata(contents.get(file), additions));
  }
  return edges;
}

function checkpointOperation(file, content) {
  const snapshot = leafSnapshot(file, content);
  return {
    type: 'view.checkpoint',
    file,
    contentHash: hashContent(content),
    leafHashes: Object.fromEntries([...snapshot.leaves].map(([id, leaf]) => [id, leaf.contentHash]).sort()),
    leaves: Object.fromEntries([...snapshot.leaves].map(([id, leaf]) => [id, {
      branch: leaf.branch,
      contentHash: leaf.contentHash,
      file: leaf.file,
      index: leaf.index,
      kind: leaf.kind,
    }]).sort()),
  };
}

function writeFileFsync(file, content) {
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function readPointer(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function readGeneration(memoryDir, generationId, transactionId) {
  const directory = path.join(memoryDir, '.urdr', 'generations', generationId);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.generationId !== generationId || manifest.transactionId !== transactionId) {
    throw new Error('published generation manifest mismatch');
  }
  const files = new Map();
  for (const [file, expectedHash] of Object.entries(manifest.hashes)) {
    assertRootFile(file);
    const content = fs.readFileSync(path.join(directory, file), 'utf8');
    if (hashContent(content) !== expectedHash) throw new Error(`published generation hash mismatch: ${file}`);
    files.set(file, content);
  }
  return { directory, files, generationId, manifest, transactionId };
}

function materializationMarker(generation) {
  return path.join(generation.directory, 'materialized.json');
}

function isMaterialized(generation) {
  try {
    const marker = JSON.parse(fs.readFileSync(materializationMarker(generation), 'utf8'));
    return marker.generationId === generation.generationId && marker.transactionId === generation.transactionId;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function repairPublishedViews(memoryDir, lock = null, opts = {}) {
  const memory = path.resolve(memoryDir);
  const paths = eventLogPaths(memory);
  fs.mkdirSync(paths.urdrDir, { recursive: true });
  const ownedLock = lock || acquireLeaseLock(paths.lockDir, opts.lockOptions);
  const release = !lock;
  try {
    assertLeaseOwned(ownedLock);
    const pointer = readPointer(path.join(paths.urdrDir, 'current-generation.json'));
    if (!pointer) return { status: 'absent', repairedFiles: [] };

    const state = readCommittedState(memory);
    if (!state.integrity) throw new Error(`event log integrity failure: ${state.errors.map((item) => item.code).join(', ')}`);
    if (!state.committedTransactions.has(pointer.transactionId)) {
      return { status: 'uncommitted', repairedFiles: [] };
    }

    const generation = readGeneration(memory, pointer.generationId, pointer.transactionId);
    if (isMaterialized(generation)) return { status: 'complete', repairedFiles: [] };

    const mismatched = [];
    for (const [file, content] of generation.files) {
      let currentHash = null;
      try { currentHash = hashContent(fs.readFileSync(path.join(memory, file), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (currentHash !== generation.manifest.hashes[file]) mismatched.push([file, content]);
    }

    if (mismatched.length > 0) injectFault(opts, 'before-published-view-materialization');
    const repairedFiles = [];
    for (const [file, content] of mismatched) {
      atomicReplaceFile(path.join(memory, file), content, ownedLock, opts);
      repairedFiles.push(file);
      injectFault(opts, 'after-published-view-materialization-file');
    }
    atomicReplaceFile(materializationMarker(generation), `${canonicalJson({
      generationId: generation.generationId,
      transactionId: generation.transactionId,
    })}\n`, ownedLock, opts);
    return { status: repairedFiles.length > 0 ? 'repaired' : 'complete', repairedFiles };
  } finally {
    if (release) releaseLeaseLock(ownedLock);
  }
}

function saveRecoveryCopies(memoryDir, transactionId, dirty) {
  const recovery = [];
  const directory = path.join(memoryDir, '.urdr', 'recovery', transactionId);
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, content] of dirty) {
    let target = path.join(directory, file);
    if (fs.existsSync(target)) target = path.join(directory, `${Date.now()}-${file}`);
    writeFileFsync(target, content);
    recovery.push(target);
  }
  return recovery;
}

function stageGeneration(memoryDir, transactionId, views) {
  const urdrDir = path.join(memoryDir, '.urdr');
  const generationId = `${Date.now()}-${transactionId}`;
  const directory = path.join(urdrDir, 'generations', generationId);
  fs.mkdirSync(directory, { recursive: true });
  const all = new Map(listRootFiles(memoryDir).map((file) => [path.basename(file), fs.readFileSync(file, 'utf8')]));
  for (const entry of views) all.set(entry[0], entry[1]);
  const hashes = {};
  for (const [file, content] of all) {
    writeFileFsync(path.join(directory, file), content);
    hashes[file] = hashContent(content);
  }
  writeFileFsync(path.join(directory, 'manifest.json'), `${canonicalJson({ generationId, hashes, transactionId })}\n`);
  return { generationId, directory, hashes };
}

function assertRootFile(file) {
  if (path.basename(file) !== file || !ROOT_FILE_RE.test(file)) throw new Error(`invalid root file: ${file}`);
}

export class Transaction {
  constructor(memoryDir, opts = {}) {
    this.memoryDir = path.resolve(memoryDir);
    this.id = opts.id || crypto.randomUUID();
    this.operations = [];
    this.views = new Map();
    this.expectedDirtyHashes = new Map(opts.expectedDirtyHashes || []);
    this.closed = false;
  }

  addOperation(operation) {
    if (this.closed) throw new Error('transaction is closed');
    this.operations.push(structuredClone(operation));
    return this;
  }

  upsertLeaf(leaf) {
    const { sequence, ...value } = leaf;
    return this.addOperation({ type: 'leaf.upsert', leaf: value });
  }
  deleteLeaf(id) { return this.addOperation({ type: 'leaf.delete', id }); }
  upsertEdge(edge) {
    const { sequence, ...value } = edge;
    return this.addOperation({ type: 'edge.upsert', edge: value });
  }
  deleteEdge(id) { return this.addOperation({ type: 'edge.delete', id }); }

  publishRoot(file, content) {
    if (this.closed) throw new Error('transaction is closed');
    assertRootFile(file);
    this.views.set(file, String(content));
    return this;
  }

  commit(opts = {}) {
    if (this.closed) throw new Error('transaction is closed');
    const paths = eventLogPaths(this.memoryDir);
    fs.mkdirSync(paths.urdrDir, { recursive: true });
    const lock = acquireLeaseLock(paths.lockDir, opts.lockOptions);
    try {
      assertLeaseOwned(lock);
      const state = readCommittedState(this.memoryDir);
      if (!state.integrity) throw new Error(`event log integrity failure: ${state.errors.map((item) => item.code).join(', ')}`);

      const dirty = new Map();
      for (const [file] of this.views) {
        const target = path.join(this.memoryDir, file);
        let current = null;
        try { current = fs.readFileSync(target, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const checkpoint = state.checkpoints.get(file);
        const currentHash = current === null ? null : hashContent(current);
        if (checkpoint && currentHash !== checkpoint.contentHash
          && this.expectedDirtyHashes.get(file) !== currentHash) dirty.set(file, current);
      }
      if (dirty.size > 0) {
        const recoverable = new Map([...dirty].filter(([, content]) => content !== null));
        throw new DirtyViewError([...dirty.keys()], saveRecoveryCopies(this.memoryDir, this.id, recoverable));
      }

      const operations = [...this.operations];
      for (const [file, content] of this.views) operations.push(checkpointOperation(file, content));
      if (operations.length === 0) throw new Error('transaction has no operations');

      const staged = this.views.size > 0 ? stageGeneration(this.memoryDir, this.id, this.views) : null;
      const pointerFile = path.join(paths.urdrDir, 'current-generation.json');
      const previousPointer = staged ? readPointer(pointerFile) : null;
      const previousIsCommitted = previousPointer && state.committedTransactions.has(previousPointer.transactionId);
      const previousGenerationId = previousIsCommitted ? previousPointer.generationId : previousPointer?.previousGenerationId || null;
      const previousTransactionId = previousIsCommitted ? previousPointer.transactionId : previousPointer?.previousTransactionId || null;
      const result = appendTransaction(this.memoryDir, this.id, operations, {
        ...opts,
        lock,
        beforeCommit: staged ? () => {
          const pointer = {
            generationId: staged.generationId,
            previousGenerationId,
            previousTransactionId,
            transactionId: this.id,
          };
          atomicReplaceFile(pointerFile, `${canonicalJson(pointer)}\n`, lock, opts);
        } : undefined,
      });
      this.closed = true;
      if (staged) repairPublishedViews(this.memoryDir, lock, opts);
      return { transactionId: this.id, generationId: staged?.generationId || null, ...result };
    } finally {
      releaseLeaseLock(lock);
    }
  }

  abort() {
    if (this.closed) return false;
    this.operations.length = 0;
    this.views.clear();
    this.closed = true;
    return true;
  }
}

export function beginTransaction(memoryDir, opts) {
  return new Transaction(memoryDir, opts);
}

function loadRootContents(memoryDir) {
  return new Map(listRootFiles(memoryDir).map((file) => [path.basename(file), fs.readFileSync(file, 'utf8')]));
}

export function importMarkdown(memoryDir) {
  const memory = path.resolve(memoryDir);
  repairPublishedViews(memory);
  const current = loadRootContents(memory);
  const state = readCommittedState(memory);
  const isUnchanged = current.size > 0 && [...current].every(([file, content]) => {
    const checkpoint = state.checkpoints.get(file);
    return checkpoint?.contentHash === hashContent(content) && parseMarkdown(content).leaves.every((leaf) => leaf.id);
  });
  if (isUnchanged) return { status: 'unchanged', transactionId: null, importedLeaves: 0, edges: state.edges.size };
  if (state.checkpoints.size > 0) return reconcileMarkdown(memory);

  const prepared = new Map([...current].map(([file, content]) => [file, assignStableIds(content)]));
  deriveEdges(prepared, true);
  const edges = deriveEdges(prepared, false);
  const transaction = beginTransaction(memory);
  let importedLeaves = 0;
  const seenIds = new Set();
  for (const [file, content] of prepared) {
    const snapshot = leafSnapshot(file, content);
    for (const leaf of snapshot.leaves.values()) {
      if (seenIds.has(leaf.id)) throw new Error(`duplicate Urðr leaf id: ${leaf.id}`);
      seenIds.add(leaf.id);
      transaction.upsertLeaf(leaf);
      importedLeaves++;
    }
    transaction.publishRoot(file, content);
  }
  for (const edge of edges.values()) transaction.upsertEdge(edge);
  const result = transaction.commit();
  return { status: 'imported', transactionId: result.transactionId, importedLeaves, edges: edges.size };
}

export function reconcileMarkdown(memoryDir) {
  const memory = path.resolve(memoryDir);
  repairPublishedViews(memory);
  const state = readCommittedState(memory);
  const raw = loadRootContents(memory);
  const prepared = new Map([...raw].map(([file, content]) => [file, assignStableIds(content)]));
  deriveEdges(prepared, true);
  const edges = deriveEdges(prepared, false);
  const baseLeaves = new Map();
  for (const [file, checkpoint] of state.checkpoints) {
    const entries = checkpoint.leaves || Object.fromEntries(Object.entries(checkpoint.leafHashes || {})
      .map(([id, contentHash]) => [id, { contentHash, file }]));
    for (const [id, leaf] of Object.entries(entries)) baseLeaves.set(id, { ...leaf, file: leaf.file || file });
  }
  const currentLeaves = new Map();
  for (const [file, content] of prepared) {
    for (const [id, leaf] of leafSnapshot(file, content).leaves) {
      if (currentLeaves.has(id)) throw new Error(`duplicate Urðr leaf id: ${id}`);
      currentLeaves.set(id, leaf);
    }
  }
  const directChanges = new Map();
  const deleted = new Map();
  for (const [id, leaf] of currentLeaves) {
    const base = baseLeaves.get(id);
    if (!base || ['contentHash', 'file', 'branch', 'index', 'kind'].some((key) => base[key] !== leaf[key])) directChanges.set(id, leaf);
  }
  for (const [id, leaf] of baseLeaves) if (!currentLeaves.has(id)) deleted.set(id, leaf.file);

  const conflicts = [];
  for (const id of new Set([...directChanges.keys(), ...deleted.keys()])) {
    const file = directChanges.get(id)?.file || deleted.get(id);
    const checkpoint = state.checkpoints.get(baseLeaves.get(id)?.file || file);
    const logLeaf = state.leaves.get(id);
    if (checkpoint && (state.leafChanges.get(id) || 0) > checkpoint.sequence) {
      conflicts.push({ id, file, logLeaf: logLeaf || null, markdownLeaf: directChanges.get(id) || null });
    }
  }
  if (conflicts.length > 0) return { status: 'conflict', conflicts };

  const dirtyFiles = [...raw].filter(([file, content]) => state.checkpoints.get(file)?.contentHash !== hashContent(content));
  if (directChanges.size === 0 && deleted.size === 0 && dirtyFiles.length === 0) return { status: 'clean', conflicts: [] };

  const transaction = beginTransaction(memory, { expectedDirtyHashes: [...raw].map(([file, content]) => [file, hashContent(content)]) });
  for (const leaf of directChanges.values()) transaction.upsertLeaf(leaf);
  for (const id of deleted.keys()) transaction.deleteLeaf(id);
  for (const edge of edges.values()) transaction.upsertEdge(edge);
  const managedIds = new Set([...currentLeaves.keys(), ...deleted.keys()]);
  for (const [id, edge] of state.edges) {
    if (managedIds.has(edge.sourceId) && !edges.has(id)) transaction.deleteEdge(id);
  }
  for (const [file, content] of prepared) transaction.publishRoot(file, content);
  const result = transaction.commit();
  return { status: 'reconciled', conflicts: [], changedLeaves: directChanges.size + deleted.size, transactionId: result.transactionId };
}

export function readPublishedRoot(memoryDir, file) {
  assertRootFile(file);
  const generation = readPublishedGeneration(memoryDir);
  const content = generation.files.get(file);
  if (content === undefined) throw new Error(`root file not found in published generation: ${file}`);
  return content;
}

export function readPublishedGeneration(memoryDir) {
  const memory = path.resolve(memoryDir);
  const pointer = readPointer(path.join(memory, '.urdr', 'current-generation.json'));
  if (!pointer) {
    return {
      generationId: null,
      transactionId: null,
      files: loadRootContents(memory),
    };
  }
  const state = readCommittedState(memory);
  let generationId = pointer.generationId;
  let transactionId = pointer.transactionId;
  if (!state.committedTransactions.has(transactionId)) {
    generationId = pointer.previousGenerationId;
    transactionId = pointer.previousTransactionId;
  }
  if (!generationId || !state.committedTransactions.has(transactionId)) {
    return { generationId: null, transactionId: null, files: loadRootContents(memory) };
  }
  const generation = readGeneration(memory, generationId, transactionId);
  return { generationId, transactionId, files: generation.files };
}

export function exportMarkdown(memoryDir, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const generation = readPublishedGeneration(memoryDir);
  for (const [file, content] of generation.files) fs.writeFileSync(path.join(outputDir, file), content, 'utf8');
  return { files: [...generation.files.keys()], generationId: generation.generationId };
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const [command, memoryDir] = process.argv.slice(2);
  try {
    if (command === 'import' && memoryDir) console.log(JSON.stringify(importMarkdown(memoryDir), null, 2));
    else if (command === 'reconcile' && memoryDir) {
      const result = reconcileMarkdown(memoryDir);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'conflict') process.exitCode = 3;
    } else {
      console.error('Usage: node scripts/lib/transaction.mjs <import|reconcile> <memory-dir>');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
