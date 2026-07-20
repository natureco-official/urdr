import fs from 'node:fs';
import path from 'node:path';
import { atomicReplaceFile, injectFault } from '../append.mjs';
import { parseMarkdown } from './markdown-model.mjs';
import { canonicalJson, eventLogPaths, hashContent, readCommittedState, readEventLog } from './event-log.mjs';
import { acquireLeaseLock, assertLeaseOwned, releaseLeaseLock } from './lock.mjs';
import { beginTransaction, loadRootContents, populateTransactionFromViews } from './transaction.mjs';

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

export function removeLeafFromMarkdown(content, id) {
  const model = parseMarkdown(content);
  const leaf = model.leaves.find((item) => item.id === id);
  if (!leaf) return content;
  const start = Math.min(leaf.startLine, ...(leaf.metadata || []).map((item) => item.startLine));
  const lines = [...model.lines];
  lines.splice(start - 1, leaf.endLine - start + 1);
  while (lines[start - 1] === '' && lines[start - 2] === '') lines.splice(start - 1, 1);
  return lines.join(model.newline);
}

function fileContains(file, needles) {
  try {
    const body = fs.readFileSync(file);
    return needles.some((needle) => needle.length && body.includes(Buffer.from(needle, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

function markdownArtifact(file, id, needles) {
  const before = fs.readFileSync(file, 'utf8');
  const after = removeLeafFromMarkdown(before, id);
  if (after !== before) return { after, before, matchedBy: 'id' };

  // Managed Markdown carries stable IDs. Text fallback is reserved for legacy
  // copies whose matching leaf cannot be identified, preserving old scrub coverage
  // without confusing an ID-bearing live leaf with the forgotten one.
  const model = parseMarkdown(before);
  const legacyMatch = model.leaves.some((leaf) => !leaf.id
    && needles.some((needle) => needle.length && leaf.text.includes(needle)));
  return { after: before, before, matchedBy: legacyMatch ? 'legacy-text' : null };
}

function artifactMatch(file, id, needles) {
  if (/\.md$/i.test(file)) return markdownArtifact(file, id, needles);
  return { after: null, before: null, matchedBy: fileContains(file, needles) ? 'text' : null };
}

function walkFiles(directory, visit) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(target, visit);
    else if (entry.isFile()) visit(target);
  }
}

function readExportDirectories(memoryDir) {
  const file = path.join(memoryDir, '.urdr', 'exports.jsonl');
  try {
    return [...new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line).directory]; } catch { return []; }
    }).filter(Boolean).map((item) => path.resolve(item)))];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function enforceArtifactRetention(memoryDir, opts = {}) {
  const memory = path.resolve(memoryDir);
  const pointerFile = path.join(memory, '.urdr', 'current-generation.json');
  let current = null;
  try { current = JSON.parse(fs.readFileSync(pointerFile, 'utf8')).generationId; } catch { /* no generation */ }
  const generationsDir = path.join(memory, '.urdr', 'generations');
  const generations = fs.existsSync(generationsDir)
    ? fs.readdirSync(generationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(generationsDir, entry.name), time: fs.statSync(path.join(generationsDir, entry.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name))
    : [];
  const limit = Number.isInteger(opts.maxGenerations) ? Math.max(1, opts.maxGenerations) : Infinity;
  const keep = new Set([current, ...generations.filter((item) => item.name !== current).slice(0, Math.max(0, limit - 1)).map((item) => item.name)]);
  const removed = [];
  for (const generation of generations) if (!keep.has(generation.name)) {
    fs.rmSync(generation.path, { recursive: true, force: true });
    removed.push(generation.path);
  }
  if (Number.isFinite(opts.recoveryMaxAgeDays)) {
    const cutoff = Date.now() - Math.max(0, opts.recoveryMaxAgeDays) * 86400000;
    const recovery = path.join(memory, '.urdr', 'recovery');
    walkFiles(recovery, (file) => { if (fs.statSync(file).mtimeMs < cutoff) { fs.rmSync(file, { force: true }); removed.push(file); } });
    removeEmptyDirectories(recovery);
  }
  return removed;
}

export function scrubForgottenArtifacts(memoryDir, id, text, opts = {}) {
  const memory = path.resolve(memoryDir);
  const normalizedText = String(text);
  const needles = [...new Set([normalizedText, normalizedText.replace(/\r?\n/g, '\r\n')])];
  const removed = [];
  let pointer = null;
  try { pointer = JSON.parse(fs.readFileSync(path.join(memory, '.urdr', 'current-generation.json'), 'utf8')); } catch { /* absent */ }

  const generationsDir = path.join(memory, '.urdr', 'generations');
  if (fs.existsSync(generationsDir)) for (const entry of fs.readdirSync(generationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === pointer?.generationId) continue;
    const directory = path.join(generationsDir, entry.name);
    let contains = false;
    walkFiles(directory, (file) => { if (artifactMatch(file, id, needles).matchedBy) contains = true; });
    if (contains) { fs.rmSync(directory, { recursive: true, force: true }); removed.push(directory); }
  }

  const recovery = path.join(memory, '.urdr', 'recovery');
  walkFiles(recovery, (file) => {
    const match = artifactMatch(file, id, needles);
    if (!match.matchedBy) return;
    if (match.matchedBy === 'id') fs.writeFileSync(file, match.after, 'utf8');
    else fs.rmSync(file, { force: true });
    removed.push(file);
  });
  removeEmptyDirectories(recovery);

  for (const directory of readExportDirectories(memory)) {
    if (!fs.existsSync(directory)) continue;
    walkFiles(directory, (file) => {
      const match = artifactMatch(file, id, needles);
      if (!match.matchedBy) return;
      if (match.matchedBy === 'id') fs.writeFileSync(file, match.after, 'utf8');
      else fs.rmSync(file, { force: true });
      removed.push(file);
    });
  }

  walkFiles(memory, (file) => {
    if (!/(?:^|[.])tmp(?:[.-]|$)/i.test(path.basename(file))) return;
    if (!fileContains(file, needles)) return;
    fs.rmSync(file, { force: true });
    removed.push(file);
  });
  removed.push(...enforceArtifactRetention(memory, opts));

  const ledger = path.join(memory, '.urdr', 'events.jsonl');
  const survivors = [];
  walkFiles(memory, (file) => {
    if (path.resolve(file) === path.resolve(ledger)) return;
    if (artifactMatch(file, id, needles).matchedBy) survivors.push(file);
  });
  if (survivors.length) throw new Error(`forget scrub incomplete; content remains in: ${survivors.join(', ')}`);
  const ledgerEncoding = JSON.stringify(normalizedText).slice(1, -1);
  return { removed: [...new Set(removed)], ledgerRetained: fs.existsSync(ledger) && fs.readFileSync(ledger, 'utf8').includes(ledgerEncoding) };
}

function scrubMarkerFile(memoryDir, id) {
  return path.join(memoryDir, '.urdr', 'forgotten', `${hashContent(id)}.json`);
}

function readScrubMarker(memoryDir, operationRecord) {
  try {
    const marker = JSON.parse(fs.readFileSync(scrubMarkerFile(memoryDir, operationRecord.operation.id), 'utf8'));
    return marker.id === operationRecord.operation.id
      && marker.forgetSequence === operationRecord.sequence
      && marker.transactionId === operationRecord.transactionId;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

function writeScrubMarker(memoryDir, operationRecord, lock) {
  assertLeaseOwned(lock);
  const directory = path.join(memoryDir, '.urdr', 'forgotten');
  fs.mkdirSync(directory, { recursive: true });
  atomicReplaceFile(scrubMarkerFile(memoryDir, operationRecord.operation.id), `${canonicalJson({
    file: operationRecord.operation.file,
    forgetSequence: operationRecord.sequence,
    id: operationRecord.operation.id,
    transactionId: operationRecord.transactionId,
  })}\n`, lock);
}

function committedForgetOperations(memoryDir, state) {
  const log = readEventLog(memoryDir);
  if (!log.integrity) throw new Error(`event log integrity failure: ${log.errors.map((item) => item.code).join(', ')}`);
  const operations = new Map();
  for (const record of log.records) {
    if (record.kind !== 'operation' || record.operation?.type !== 'leaf.forget') continue;
    if (!state.committedTransactions.has(record.transactionId) || !state.forgottenLeaves.has(record.operation.id)) continue;
    operations.set(record.operation.id, record);
  }
  return operations;
}

export function resumeForgottenArtifactScrubs(memoryDir, opts = {}) {
  const memory = path.resolve(memoryDir);
  const paths = eventLogPaths(memory);
  const lock = acquireLeaseLock(paths.lockDir, opts.lockOptions);
  try {
    const state = readCommittedState(memory);
    if (!state.integrity) throw new Error(`event log integrity failure: ${state.errors.map((item) => item.code).join(', ')}`);
    const forgetOperations = committedForgetOperations(memory, state);
    const resumed = [];
    for (const id of state.forgottenLeaves) {
      const record = forgetOperations.get(id);
      if (!record) throw new Error(`committed leaf.forget operation not found: ${id}`);
      if (readScrubMarker(memory, record)) continue;
      if (typeof record.operation.text !== 'string' || typeof record.operation.file !== 'string') {
        throw new Error(`leaf.forget operation lacks resumable scrub identity: ${id}`);
      }
      const scrubbed = scrubForgottenArtifacts(memory, id, record.operation.text, opts.retention || {});
      writeScrubMarker(memory, record, lock);
      resumed.push({ id, scrubbed });
    }
    return { resumed };
  } finally {
    releaseLeaseLock(lock);
  }
}

export function forgetMemoryLeaf(memoryDir, id, opts = {}) {
  const memory = path.resolve(memoryDir);
  const paths = eventLogPaths(memory);
  const lock = acquireLeaseLock(paths.lockDir, opts.lockOptions);
  try {
    const state = readCommittedState(memory);
    if (!state.integrity) throw new Error(`event log integrity failure: ${state.errors.map((item) => item.code).join(', ')}`);
    const leaf = state.leaves.get(id);
    if (!leaf) throw new Error(`leaf not found: ${id}`);
    const contents = loadRootContents(memory);
    const source = contents.get(leaf.file);
    if (source === undefined) throw new Error(`leaf root view not found: ${leaf.file}`);
    const updated = removeLeafFromMarkdown(source, id);
    if (updated === source) throw new Error(`leaf id not found in current Markdown view: ${id}`);
    contents.set(leaf.file, updated);

    const transaction = beginTransaction(memory, { lock });
    populateTransactionFromViews(transaction, state, contents, {
      forgottenIds: [id],
      forgottenLeafIdentities: new Map([[id, { file: leaf.file, text: leaf.text }]]),
      publishFiles: [leaf.file],
      reason: opts.reason,
    });
    const committed = transaction.commit();
    injectFault(opts, 'after-forget-commit');
    const scrubbed = scrubForgottenArtifacts(memory, id, leaf.text, opts.retention || {});
    const record = committed.records.find((item) => item.operation?.type === 'leaf.forget' && item.operation.id === id);
    if (!record) throw new Error(`committed leaf.forget operation not found: ${id}`);
    writeScrubMarker(memory, record, lock);
    return { id, transactionId: committed.transactionId, scrubbed };
  } finally {
    releaseLeaseLock(lock);
  }
}
