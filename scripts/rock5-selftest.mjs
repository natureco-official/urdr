#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendLeaf } from './append.mjs';
import { searchMemory } from './search.mjs';
import { TELEMETRY_FILE } from './lib/telemetry.mjs';

let passed = 0, failed = 0;
function ok(condition, message) {
  if (condition) { passed++; console.log('  ✓ ' + message); }
  else { failed++; console.log('  ✗ ' + message); }
}

function root(title, branch, leaf = '_No entries yet._') {
  return `# ${title}\n\n## ${branch}\n\n${leaf}\n`;
}

console.log('\n  🌳 Rock 5 self-test\n  ' + '─'.repeat(50));

// Regex execution must be externally interruptible; a synchronous same-thread timer cannot do this.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock5-redos-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root('Root-2', 'Safety', `- ${'a'.repeat(50000)}!`));
  const started = performance.now();
  const result = searchMemory(dir, '(a+)+$', { regexTimeoutMs: 100 });
  const elapsed = performance.now() - started;
  ok(result.timeout === true && result.count === 0, 'regex: pathological pattern returns a timeout result');
  ok(elapsed < 2000, `regex: hard deadline prevents a hang (${Math.round(elapsed)} ms)`);
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root('Root-2', 'Safety', '- literal [ bracket'));
  const recoveryStarted = performance.now();
  const recovered = searchMemory(dir, 'literal \\[ bracket', { mode: 'regex', regexTimeoutMs: 300 });
  const recoveryElapsed = performance.now() - recoveryStarted;
  ok(recovered.count === 1 && recoveryElapsed < 2000,
    `regex: timed-out worker is discarded and a normal query recovers promptly (${Math.round(recoveryElapsed)} ms)`);
  ok(searchMemory(dir, '[', { regexTimeoutMs: 300 }).count === 1, 'regex: invalid patterns preserve literal fallback behavior');
  ok(searchMemory(dir, '[', { mode: 'regex', regexTimeoutMs: 300 }).count === 1, 'regex: explicit mode preserves invalid-pattern literal fallback behavior');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Explicit literal mode must not reinterpret punctuation as regular-expression syntax.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock5-search-mode-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root('Root-2', 'Syntax', '- literal foo.bar\n- decoy fooXbar'));
  const literal = searchMemory(dir, 'foo.bar', { mode: 'literal' });
  ok(literal.count === 1 && literal.results[0].text.includes('foo.bar'), 'search mode: literal punctuation matches only literal text');
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./search.mjs', import.meta.url)), 'foo.bar', dir, '--literal', '--json'], {
    encoding: 'utf8', windowsHide: true,
  });
  const cliResult = JSON.parse(cli.stdout);
  ok(cli.status === 0 && cliResult.count === 1 && cliResult.results[0].text.includes('foo.bar'), 'search mode: --literal CLI flag reaches literal matching');
  const conflicting = spawnSync(process.execPath, [fileURLToPath(new URL('./search.mjs', import.meta.url)), 'foo.bar', dir, '--literal', '--regex'], {
    encoding: 'utf8', windowsHide: true,
  });
  ok(conflicting.status === 2 && /mutually exclusive/.test(conflicting.stderr), 'search mode: --literal and --regex CLI flags are mutually exclusive');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Hybrid ranking: typo, word order, partial matching, and lightweight Turkish suffix normalization.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock5-hybrid-'));
  fs.writeFileSync(path.join(dir, 'root-1-topics.md'), root('Root-1', 'Projects', '- unrelated calendar migration'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root('Root-2', 'Systems', '**01.07.2026 — SQLite kararları — local database storage policy**'));
  const typo = searchMemory(dir, 'sqltie karar', { maxResults: 1 });
  ok(typo.count === 1 && typo.results[0].file === 'root-2-technical.md' && typo.results[0].match === 'fuzzy', 'hybrid: typo + Turkish plural stem ranks the intended leaf first');
  const suffix = searchMemory(dir, "sqlite'ı", { maxResults: 1 });
  ok(suffix.count === 1 && suffix.results[0].file === 'root-2-technical.md', "hybrid: apostrophe case suffix relates sqlite and sqlite'ı");
  const structured = searchMemory(dir, 'sqlite storage', { hierarchyFiles: ['root-1-topics.md'], maxResults: 1 });
  ok(structured.results[0]?.route === 'fallback' && structured.results[0]?.file === 'root-2-technical.md', 'hybrid: hierarchy miss falls through to ranked full-tree retrieval');
  fs.rmSync(dir, { recursive: true, force: true });
}

// A weak hierarchy fuzzy match must not mask an exact match elsewhere in the tree.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock5-masked-exact-'));
  fs.writeFileSync(path.join(dir, 'root-1-topics.md'), root('Root-1', 'Projects', '- sqlite storag policy draft'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root('Root-2', 'Systems', '- canonical sqlite storage policy'));
  const result = searchMemory(dir, 'sqlite storage policy', {
    hierarchyFiles: ['root-1-topics.md'], maxResults: 1,
  });
  ok(result.results[0]?.file === 'root-2-technical.md' && result.results[0]?.match === 'exact' && result.results[0]?.route === 'fallback',
    'hybrid: full-tree exact match outranks a weak hierarchy fuzzy match');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Telemetry is trace-free by default and aggregate-only when explicitly enabled.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdr-rock5-telemetry-'));
  fs.writeFileSync(path.join(dir, 'root-2-technical.md'), root('Root-2', 'Systems', '- secret-query-canary sqlite storage'));
  searchMemory(dir, 'secret-query-canary');
  ok(!fs.existsSync(path.join(dir, TELEMETRY_FILE)), 'telemetry: disabled search leaves no trace on disk');
  searchMemory(dir, 'secret-query-canary', { telemetry: true });
  searchMemory(dir, 'secret-query-canary', { telemetry: true, hierarchyFiles: ['root-2-technical.md'] });
  searchMemory(dir, 'definitely-absent-zqxj', { telemetry: true });
  const file = path.join(dir, TELEMETRY_FILE);
  const telemetry = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(telemetry.queries.hierarchy === 1 && telemetry.queries.fallback === 1 && telemetry.queries.miss === 1, 'telemetry: enabled mode records aggregate route counters');
  ok(!fs.readFileSync(file, 'utf8').includes('secret-query-canary'), 'telemetry: query-derived values are never stored');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Production writer and stable-ID benchmark methodology are exercised through the CLI.
{
  // Windows durability uses a fresh PowerShell process for each write-through atomic
  // replacement. Import + production appends can therefore exceed 60s on slower hosts
  // even though the benchmark's search work completes in milliseconds.
  const benchTimeoutMs = process.platform === 'win32' ? 120000 : 60000;
  const bench = spawnSync(process.execPath, [fileURLToPath(new URL('./bench.mjs', import.meta.url)), '--leaves', '3', '--ambiguity', '0.34', '--collision', '0.34'], {
    encoding: 'utf8', windowsHide: true, timeout: benchTimeoutMs,
  });
  ok(bench.status === 0 && /Production-writer fidelity\s+: 100\.0%/.test(bench.stdout), 'benchmark: write fidelity uses the production append/event-log path');
  ok(/Stable-ID import\/oracle fidelity\s+: 100\.0%/.test(bench.stdout), 'benchmark: ground truth is established through stable IDs');
  ok(/recall@1, one-call/.test(bench.stdout) && /recall@1, global-only/.test(bench.stdout) && /recall@1, two-call assisted/.test(bench.stdout),
    'benchmark: one-call, global-only, and two-call assisted recall are reported separately');
  ok(/recall@1, unique exact keys/.test(bench.stdout) && /recall@1, collision\/fuzzy keys/.test(bench.stdout), 'benchmark: unique and collision recall are reported separately');
}

console.log('\n  ' + '─'.repeat(50));
if (failed === 0) console.log(`  ${passed} Rock 5 tests passed\n`);
else console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
