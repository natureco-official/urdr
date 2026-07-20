#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventLogPaths, hashContent, readCommittedState as readState } from './lib/event-log.mjs';
import { acquireLeaseLock, releaseLeaseLock } from './lib/lock.mjs';
import { findBranch, listRootFiles, parseMarkdown, ROOT_FILE_RE } from './lib/markdown-model.mjs';
import { beginTransaction, importMarkdown, readPublishedGeneration } from './lib/transaction.mjs';

function fail(message) { throw new Error(message); }
function cleanBranch(value) { return String(value).trim().replace(/^##\s+/, '').trim(); }
function stableId() { return `u_${crypto.randomUUID()}`; }
function metadata(id) { return `<!-- urdr:id:${id} -->`; }
function slug(value) {
  const result = String(value).trim().toLocaleLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  if (!result) fail('root name must contain a letter or number');
  return result;
}

function rootContext(fileArg) {
  const absolute = path.resolve(fileArg);
  let canonical;
  try { canonical = fs.realpathSync(absolute); }
  catch (error) { if (error.code === 'ENOENT') fail(`root file not found: ${fileArg}`); throw error; }
  if (!fs.statSync(canonical).isFile()) fail(`not a file: ${fileArg}`);
  const file = path.basename(canonical);
  if (!ROOT_FILE_RE.test(file)) fail(`invalid root filename: ${file}`);
  return { memoryDir: path.dirname(canonical), file, absolute: canonical };
}

function sameTree(first, secondArg) {
  const second = rootContext(secondArg);
  if (fs.realpathSync(first.memoryDir) !== fs.realpathSync(second.memoryDir)) {
    fail('source and target roots must belong to the same memory tree');
  }
  return second;
}

function branchRange(content, branchName, file) {
  const model = parseMarkdown(content);
  const branch = findBranch(model, cleanBranch(branchName));
  if (!branch) fail(`branch not found in ${file}: ${cleanBranch(branchName)}`);
  return { model, branch, start: branch.heading.startLine - 1, end: branch.endLine };
}

function joinLines(lines, newline, hadFinalNewline) {
  let result = lines.join(newline);
  if (hadFinalNewline && !result.endsWith(newline)) result += newline;
  return result;
}

function insertAtBranchEnd(content, branchName, blocks, file) {
  let located = branchRange(content, branchName, file);
  if (located.branch.placeholders.length > 0) {
    const stripped = [...located.model.lines];
    for (const placeholder of [...located.branch.placeholders].sort((a, b) => b.startLine - a.startLine)) {
      stripped.splice(placeholder.startLine - 1, placeholder.endLine - placeholder.startLine + 1);
    }
    content = joinLines(stripped, located.model.newline, content.endsWith(located.model.newline));
    located = branchRange(content, branchName, file);
  }
  const { model, branch } = located;
  const lines = [...model.lines];
  let insert = branch.endLine;
  while (insert > branch.heading.startLine && !lines[insert - 1]?.trim()) insert--;
  const addition = [];
  if (insert > 0 && lines[insert - 1]?.trim()) addition.push('');
  for (const block of blocks) {
    addition.push(...block);
    if (addition.at(-1) !== '') addition.push('');
  }
  lines.splice(insert, 0, ...addition);
  return joinLines(lines, model.newline, content.endsWith(model.newline));
}

function removeLeafBlocks(content, selectedIds) {
  const model = parseMarkdown(content);
  const lines = [...model.lines];
  for (const leaf of model.leaves.filter((item) => selectedIds.has(item.id)).sort((a, b) => b.startLine - a.startLine)) {
    let start = Math.min(leaf.startLine, ...(leaf.metadata || []).map((item) => item.startLine)) - 1;
    let end = leaf.endLine;
    while (end < lines.length && !lines[end].trim()) end++;
    lines.splice(start, end - start);
  }
  return joinLines(lines, model.newline, content.endsWith(model.newline));
}

function leafBlock(model, leaf) {
  const start = Math.min(leaf.startLine, ...(leaf.metadata || []).map((item) => item.startLine)) - 1;
  return model.lines.slice(start, leaf.endLine);
}

function addStateDiff(tx, beforeState, contents) {
  const after = new Map();
  for (const [file, content] of contents) {
    for (const [index, leaf] of parseMarkdown(content).leaves.entries()) {
      if (!leaf.id) fail(`migration produced a leaf without a stable ID in ${file}:${leaf.startLine}`);
      if (after.has(leaf.id)) fail(`migration produced duplicate stable ID: ${leaf.id}`);
      after.set(leaf.id, { id: leaf.id, file, branch: leaf.branch, kind: leaf.kind, index, text: leaf.text, contentHash: hashContent(leaf.text) });
    }
  }
  for (const id of beforeState.leaves.keys()) if (!after.has(id)) tx.deleteLeaf(id);
  for (const leaf of after.values()) {
    const previous = beforeState.leaves.get(leaf.id);
    if (!previous || ['file', 'branch', 'kind', 'index', 'text', 'contentHash'].some((key) => previous[key] !== leaf[key])) tx.upsertLeaf({ ...(previous || {}), ...leaf });
  }
}

function prepare(memoryDir, lock) {
  importMarkdown(memoryDir, { lock });
  return readPublishedGeneration(memoryDir).files;
}

function withMigrationLock(memoryDir, opts, operation) {
  const paths = eventLogPaths(memoryDir);
  fs.mkdirSync(paths.urdrDir, { recursive: true });
  const lock = acquireLeaseLock(paths.lockDir, opts.lockOptions);
  try { return operation(lock); }
  finally { releaseLeaseLock(lock); }
}

export function splitBranch(fileArg, branchArg, subBranches, opts = {}) {
  const root = rootContext(fileArg);
  const names = [...new Set(subBranches.map(cleanBranch).filter(Boolean))];
  if (names.length === 0) fail('split requires at least one sub-branch');
  const initial = fs.readFileSync(root.absolute, 'utf8');
  const initialParent = branchRange(initial, branchArg, root.file).branch.name;
  const initialBranches = new Set(parseMarkdown(initial).branches.map((item) => item.name.toLocaleLowerCase()));
  for (const name of names) {
    const heading = `${initialParent} / ${name}`;
    if (initialBranches.has(heading.toLocaleLowerCase())) fail(`branch already exists in ${root.file}: ${heading}`);
  }
  return withMigrationLock(root.memoryDir, opts, (lock) => {
    const raw = fs.readFileSync(root.absolute, 'utf8');
    const parent = branchRange(raw, branchArg, root.file).branch.name;
    const existing = new Set(parseMarkdown(raw).branches.map((item) => item.name.toLocaleLowerCase()));
    const headings = names.map((name) => `${parent} / ${name}`);
    for (const heading of headings) if (existing.has(heading.toLocaleLowerCase())) fail(`branch already exists in ${root.file}: ${heading}`);
    const contents = prepare(root.memoryDir, lock);
    opts.afterPrepare?.();
    const original = contents.get(root.file);
    const updated = insertAtBranchEnd(original, parent, headings.map((heading) => [`## ${heading}`, '', '_No entries yet._']), root.file);
    contents.set(root.file, updated);
    const tx = beginTransaction(root.memoryDir, { lock }).addOperation({ type: 'migration.split', file: root.file, branch: parent, subBranches: headings });
    // The migration lock keeps this complete snapshot current through commit.
    addStateDiff(tx, readState(root.memoryDir), contents);
    tx.publishRoot(root.file, updated).commit();
    return { file: root.file, branch: parent, subBranches: headings };
  });
}

export function moveEntries(sourceArg, targetArg, targetBranchArg, selectors, opts = {}) {
  const source = rootContext(sourceArg);
  const target = sameTree(source, targetArg);
  if (selectors.length === 0) fail('move requires at least one entry selector');
  const rawSourceModel = parseMarkdown(fs.readFileSync(source.absolute, 'utf8'));
  branchRange(fs.readFileSync(target.absolute, 'utf8'), targetBranchArg, target.file);
  for (const selector of selectors) {
    const hits = rawSourceModel.leaves.filter((leaf) => leaf.id === selector || leaf.text.includes(selector));
    if (hits.length === 0) fail(`entry not found in ${source.file}: ${selector}`);
    if (hits.length > 1) fail(`entry selector is ambiguous in ${source.file}: ${selector}`);
  }
  return withMigrationLock(source.memoryDir, opts, (lock) => {
  const contents = prepare(source.memoryDir, lock);
  opts.afterPrepare?.();
  const sourceContent = contents.get(source.file);
  const targetContent = contents.get(target.file);
  branchRange(targetContent, targetBranchArg, target.file);
  const sourceModel = parseMarkdown(sourceContent);
  const selected = [];
  for (const selector of selectors) {
    const hits = sourceModel.leaves.filter((leaf) => leaf.id === selector || leaf.text.includes(selector));
    if (hits.length === 0) fail(`entry not found in ${source.file}: ${selector}`);
    if (hits.length > 1) fail(`entry selector is ambiguous in ${source.file}: ${selector}`);
    if (!selected.includes(hits[0])) selected.push(hits[0]);
  }
  const ids = new Set(selected.map((leaf) => leaf.id));
  const blocks = selected.map((leaf) => leafBlock(sourceModel, leaf));
  let nextSource = removeLeafBlocks(sourceContent, ids);
  let nextTarget;
  if (source.file === target.file) {
    nextTarget = insertAtBranchEnd(nextSource, targetBranchArg, blocks, target.file);
    nextSource = nextTarget;
  } else {
    nextTarget = insertAtBranchEnd(targetContent, targetBranchArg, blocks, target.file);
  }
  contents.set(source.file, nextSource);
  contents.set(target.file, nextTarget);
  const tx = beginTransaction(source.memoryDir, { lock }).addOperation({ type: 'migration.move', source: source.file, target: target.file, targetBranch: cleanBranch(targetBranchArg), leafIds: [...ids] });
  addStateDiff(tx, readState(source.memoryDir), contents);
  tx.publishRoot(source.file, nextSource);
  if (target.file !== source.file) tx.publishRoot(target.file, nextTarget);
  tx.commit();
  return { moved: ids.size, source: source.file, target: target.file, targetBranch: cleanBranch(targetBranchArg) };
  });
}

function naming(file) {
  if (/^root-/i.test(file)) return { prefix: 'root', title: 'Root', index: /^root-0-/i };
  if (/^kök-/i.test(file)) return { prefix: 'kök', title: 'Kök', index: /^kök-0-/i };
  if (/^kok-/i.test(file)) return { prefix: 'kok', title: 'Kök', index: /^kok-0-/i };
  fail(`cannot determine naming language from ${file}`);
}

export function createRoot(nameArg, sourceArg, branchArgs, opts = {}) {
  const source = rootContext(sourceArg);
  const requested = [...new Set(branchArgs.flatMap((value) => String(value).split(',')).map(cleanBranch).filter(Boolean))];
  if (requested.length === 0) fail('new-root requires at least one branch');
  const initialFiles = listRootFiles(source.memoryDir).map((file) => path.basename(file));
  const initialStyle = naming(source.file);
  if (initialFiles.some((file) => naming(file).prefix !== initialStyle.prefix)) fail('memory tree mixes naming languages');
  const initialModel = parseMarkdown(fs.readFileSync(source.absolute, 'utf8'));
  for (const name of requested) if (!findBranch(initialModel, name)) fail(`branch not found in ${source.file}: ${name}`);
  return withMigrationLock(source.memoryDir, opts, (lock) => {
  const allFiles = listRootFiles(source.memoryDir).map((file) => path.basename(file));
  const style = naming(source.file);
  if (allFiles.some((file) => naming(file).prefix !== style.prefix)) fail('memory tree mixes naming languages');
  const numbers = allFiles.map((file) => Number(file.match(/(?:^|-)(\d+)(?:[-_]|$)/)?.[1])).filter(Number.isFinite);
  const number = Math.max(-1, ...numbers) + 1;
  const newFile = `${style.prefix}-${number}-${slug(nameArg)}.md`;
  if (!ROOT_FILE_RE.test(newFile)) fail(`generated invalid root filename: ${newFile}`);
  const rawModel = parseMarkdown(fs.readFileSync(source.absolute, 'utf8'));
  for (const name of requested) if (!findBranch(rawModel, name)) fail(`branch not found in ${source.file}: ${name}`);
  const contents = prepare(source.memoryDir, lock);
  opts.afterPrepare?.();
  const original = contents.get(source.file);
  const model = parseMarkdown(original);
  const branches = requested.map((name) => {
    const branch = findBranch(model, name);
    if (!branch) fail(`branch not found in ${source.file}: ${name}`);
    return branch;
  }).sort((a, b) => a.heading.startLine - b.heading.startLine);
  const newLines = [`# ${style.title}-${number}: ${String(nameArg).trim()}`, '', metadata(stableId()), `> **Created:** migrated from ${source.file}`, '', '---', ''];
  for (const branch of branches) newLines.push(...model.lines.slice(branch.heading.startLine - 1, branch.endLine), '');
  let nextSourceLines = [...model.lines];
  for (const branch of [...branches].sort((a, b) => b.heading.startLine - a.heading.startLine)) {
    nextSourceLines.splice(branch.heading.startLine - 1, branch.endLine - branch.heading.startLine + 1);
  }
  const nextSource = joinLines(nextSourceLines, model.newline, original.endsWith(model.newline));
  const newContent = joinLines(newLines, model.newline, true);
  contents.set(source.file, nextSource);
  contents.set(newFile, newContent);
  const indexFile = allFiles.find((file) => style.index.test(file));
  if (indexFile) {
    const index = contents.get(indexFile);
    const nl = parseMarkdown(index).newline;
    const addition = `${index.endsWith(nl) ? '' : nl}${nl}${metadata(stableId())}${nl}- **${style.title}-${number}** — \`${newFile}\`${nl}`;
    contents.set(indexFile, index + addition);
  }
  const tx = beginTransaction(source.memoryDir, { lock }).addOperation({ type: 'migration.new-root', source: source.file, target: newFile, branches: branches.map((item) => item.name) });
  addStateDiff(tx, readState(source.memoryDir), contents);
  tx.publishRoot(source.file, nextSource).publishRoot(newFile, newContent);
  if (indexFile) tx.publishRoot(indexFile, contents.get(indexFile));
  tx.commit();
  return { file: newFile, number, branches: branches.map((item) => item.name) };
  });
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1]) fail(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function splitPlan(args) {
  const planFile = option(args, '--plan-file');
  const inline = option(args, '--sub-branches');
  if (planFile && inline) fail('use either --plan-file or --sub-branches, not both');
  if (planFile) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(planFile), 'utf8'));
    const values = Array.isArray(parsed) ? parsed : parsed.subBranches;
    if (!Array.isArray(values)) fail('split plan must be a JSON array or contain subBranches[]');
    return values;
  }
  if (inline) return inline.split(',');
  if (args.length > 2) return args.slice(2);
  fail('split is non-interactive; pass --sub-branches or --plan-file');
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage:\n  node scripts/migrate.mjs split <root-file> <branch> --sub-branches <a,b>\n  node scripts/migrate.mjs split <root-file> <branch> --plan-file <plan.json>\n  node scripts/migrate.mjs move <source-file> <target-file> <target-branch> <entry>...\n  node scripts/migrate.mjs new-root <name> <source-root> <branch>...');
    return;
  }
  let result;
  if (command === 'split') {
    if (args.length < 2) fail('usage: split <root-file> <branch> --sub-branches <a,b>');
    result = splitBranch(args[0], args[1], splitPlan(args));
  } else if (command === 'move') {
    if (args.length < 4) fail('usage: move <source-file> <target-file> <target-branch> <entry>...');
    result = moveEntries(args[0], args[1], args[2], args.slice(3));
  } else if (command === 'new-root') {
    if (args.length < 3) fail('usage: new-root <name> <source-root> <branch>...');
    result = createRoot(args[0], args[1], args.slice(2));
  } else fail(`unknown command: ${command}`);
  console.log(JSON.stringify(result));
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}
if (isMain()) {
  try { main(); }
  catch (error) { console.error(`migrate: ${error.message}`); process.exitCode = 1; }
}
