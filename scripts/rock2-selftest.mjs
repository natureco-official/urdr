#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEventLog } from './lib/event-log.mjs';
import { ROOT_FILE_RE, parseMarkdown } from './lib/markdown-model.mjs';
import { importMarkdown, reconcileMarkdown } from './lib/transaction.mjs';
import { createRoot, main, moveEntries, splitBranch } from './migrate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack || error}`); process.exitCode = 1; }
}
function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `urdr-${name}-`)); }
function writeTree(dir, prefix = 'root') {
  const names = prefix === 'root'
    ? ['root-0-index.md', 'root-1-topics.md', 'root-2-technical.md', 'root-3-decisions.md']
    : ['kök-0-indeks.md', 'kök-1-konular.md', 'kök-2-teknik.md', 'kök-3-kararlar.md'];
  const contents = [
    '# Root-0\n\n## Map\n\n- Existing roots\n',
    '# Root-1\n\n## Projects\n\n- Alpha project\n\n## People\n\n- Ada\n',
    '# Root-2\n\n## Systems\n\n_No entries yet._\n\n## APIs\n\n- HTTP\n',
    '# Root-3\n\n## Rules\n\n- Keep one truth\n',
  ];
  names.forEach((file, index) => fs.writeFileSync(path.join(dir, file), contents[index]));
  return names;
}
function operationTypes(dir) {
  return readEventLog(dir).records.filter((record) => record.kind === 'operation').map((record) => record.operation.type);
}

test('split uses a plan file, creates correct headings, and commits a migration event', () => {
  const dir = temp('split');
  const files = writeTree(dir);
  const plan = path.join(dir, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ subBranches: ['Web', 'Mobile'] }));
  main(['split', path.join(dir, files[1]), '## Projects', '--plan-file', plan]);
  const content = fs.readFileSync(path.join(dir, files[1]), 'utf8');
  assert.match(content, /^## Projects \/ Web$/m);
  assert.match(content, /^## Projects \/ Mobile$/m);
  assert.doesNotMatch(content, /^## ##/m);
  assert(operationTypes(dir).includes('migration.split'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('move inserts in the named target branch, removes its placeholder, and preserves stable ID', () => {
  const dir = temp('move');
  const files = writeTree(dir);
  splitBranch(path.join(dir, files[1]), 'Projects', ['Web']);
  const before = parseMarkdown(fs.readFileSync(path.join(dir, files[1]), 'utf8'));
  const alpha = before.leaves.find((leaf) => /Alpha project/.test(leaf.text));
  moveEntries(path.join(dir, files[1]), path.join(dir, files[2]), 'Systems', ['Alpha project']);
  const source = fs.readFileSync(path.join(dir, files[1]), 'utf8');
  const target = fs.readFileSync(path.join(dir, files[2]), 'utf8');
  assert(!source.includes('Alpha project'));
  assert(!target.includes('_No entries yet._'));
  const moved = parseMarkdown(target).leaves.find((leaf) => /Alpha project/.test(leaf.text));
  assert.equal(moved.id, alpha.id);
  assert.equal(moved.branch, 'Systems');
  assert(operationTypes(dir).includes('migration.move'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('move rejects a missing target branch before mutating the tree', () => {
  const dir = temp('missing-branch');
  const files = writeTree(dir);
  const snapshots = files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.throws(() => moveEntries(path.join(dir, files[1]), path.join(dir, files[2]), 'Missing', ['Alpha']), /branch not found/);
  assert.equal(fs.existsSync(path.join(dir, '.urdr')), false);
  files.forEach((file, index) => assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), snapshots[index]));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new-root uses the next dynamic number, valid naming language, moves branches, and updates index transactionally', () => {
  const dir = temp('new-root');
  const files = writeTree(dir);
  const result = createRoot('Design Notes', path.join(dir, files[2]), ['Systems']);
  assert.equal(result.file, 'root-4-design-notes.md');
  assert(ROOT_FILE_RE.test(result.file));
  assert(!parseMarkdown(fs.readFileSync(path.join(dir, files[2]), 'utf8')).branches.some((branch) => branch.name === 'Systems'));
  assert(parseMarkdown(fs.readFileSync(path.join(dir, result.file), 'utf8')).branches.some((branch) => branch.name === 'Systems'));
  assert(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes(result.file));
  assert(operationTypes(dir).includes('migration.new-root'));
  fs.rmSync(dir, { recursive: true, force: true });
});

function init(args, cwd) {
  return spawnSync('bash', [path.join(here, 'init.sh'), ...args], { cwd, encoding: 'utf8' });
}

test('init rejects invalid and removed both language modes without creating a target', () => {
  const dir = temp('init-lang');
  for (const lang of ['both', 'xx']) {
    const target = path.join(dir, lang);
    const result = init(['--path', target, '--lang', lang, '--agent-name', 'A', '--user-name', 'U'], dir);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(target), false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init safely substitutes special characters and refuses overwrite', () => {
  const dir = temp('init-special');
  const target = path.join(dir, 'memory');
  const agent = 'A&B / \\ $ [agent]';
  const user = 'U&ser / \\ $1';
  const result = init(['--path', target, '--lang', 'en', '--agent-name', agent, '--user-name', user], dir);
  assert.equal(result.status, 0, result.stderr);
  const logFile = path.join(target, '.urdr', 'events.jsonl');
  assert(fs.statSync(logFile).size > 0);
  assert.equal(importMarkdown(target).status, 'unchanged');
  assert.equal(reconcileMarkdown(target).status, 'clean');
  const personality = fs.readFileSync(path.join(target, 'agent-personality.md'), 'utf8');
  assert(personality.includes(agent));
  assert(personality.includes(user));
  const marker = path.join(target, 'keep.txt');
  fs.writeFileSync(marker, 'keep');
  const second = init(['--path', target, '--lang', 'en', '--agent-name', 'X', '--user-name', 'Y'], dir);
  assert.notEqual(second.status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init detects an enclosing git repository before writing', () => {
  const dir = temp('init-nested');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const target = path.join(repo, 'memory');
  const result = init(['--path', target, '--lang', 'tr', '--agent-name', 'A', '--user-name', 'U'], repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nested git repository/);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n  ${passed} Rock 2 tests passed`);
if (process.exitCode) process.exit(process.exitCode);
