#!/usr/bin/env node
/**
 * build-mcpb.mjs — Claude Desktop tek-tık kurulum paketi (.mcpb) üretir.
 *
 *   node scripts/build-mcpb.mjs        → dist/urdr-memory-<sürüm>.mcpb
 *
 * .mcpb, manifest + sunucu dosyaları + gömülü node_modules içeren bir ZIP'tir;
 * kullanıcı çift tıklar, Claude Desktop bellek klasörünü SORAR (user_config
 * "directory" alanı) ve sunucuyu kendi Node çalışma zamanıyla başlatır.
 * Kullanıcı makinesinde npm/node kurulumu gerekmez.
 *
 * Doğrulama ve paketleme resmi araçla yapılır: npx @anthropic-ai/mcpb.
 */
import { execFileSync } from 'node:child_process';

// Windows'ta npm/npx birer .cmd betiğidir: execFileSync düz adla ENOENT verir,
// .cmd uzantısı da ancak shell ile çalışır. Tek boğaz — her platformda aynı çağrı.
const WIN = process.platform === 'win32';
const runTool = (command, args, options = {}) =>
  execFileSync(WIN ? `${command}.cmd` : command, args, { ...options, shell: WIN });
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'mcpb-staging');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ── 1. sahne dizini ──────────────────────────────────────────────────────────
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'server', 'scripts', 'lib'), { recursive: true });

const SERVER_FILES = [
  'scripts/mcp-server.mjs', 'scripts/append.mjs', 'scripts/search.mjs',
  'scripts/lint.mjs', 'scripts/compiler.mjs', 'scripts/pack.mjs', 'scripts/tree.mjs',
];
for (const file of SERVER_FILES) {
  fs.copyFileSync(path.join(ROOT, file), path.join(STAGE, 'server', file));
}
for (const entry of fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))) {
  if (entry.endsWith('.mjs')) {
    fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', entry), path.join(STAGE, 'server', 'scripts', 'lib', entry));
  }
}
// Boş ağaç ilk kurulumda kullanılabilsin diye şablonlar da pakete girer.
fs.mkdirSync(path.join(STAGE, 'server', 'templates'), { recursive: true });
for (const entry of fs.readdirSync(path.join(ROOT, 'templates'))) {
  fs.copyFileSync(path.join(ROOT, 'templates', entry), path.join(STAGE, 'server', 'templates', entry));
}

// ── 2. üretim bağımlılığı sahneye gömülür ───────────────────────────────────
fs.writeFileSync(path.join(STAGE, 'server', 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, type: 'module', private: true,
  dependencies: pkg.dependencies,
}, null, 2));
// --ignore-scripts: sahne kurulumunda yaşam-döngüsü betiği çalışmaz — SDK saf
// JS'tir, gerek yok; kullanıcı .npmrc'sindeki allow-scripts politikaları da
// (saha raporu: OpenClaw) kurulumu kesemez. Tedarik zinciri hijyeni bonus.
runTool('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: path.join(STAGE, 'server'), stdio: 'inherit',
});

// ── 3. manifest ──────────────────────────────────────────────────────────────
const manifest = {
  manifest_version: '0.2',
  name: 'urdr-memory',
  display_name: 'Urðr Memory',
  version: pkg.version,
  description: 'Tree-structured, git-diffable memory for Claude. Plain Markdown as the source of truth, crash-consistent event log, zero LLM calls — with one-call session briefs (urdr_context), graph-backed answers (urdr_ask) and the Urðr Tree brain visualization.',
  long_description: 'Urðr gives Claude a persistent, auditable memory: 4-root Markdown tree backed by a hash-chained event log. The Context Pack compiles the whole tree into a ~375-token session brief (measured 93–227× cheaper than reading root files). 18 tools: search, ask, path, related, read, map, context, report, fetch, watch, delta, write_context, append, lint, compiler plans, forgetting with verified scrubs. The context-tax layer answers repeated identical queries with a ~30-token "unchanged" proof and parks oversized replies in a content-addressed spool. Everything is deterministic and local — no vector DB, no embeddings, no network calls.',
  author: { name: 'NatureCo', url: 'https://github.com/natureco-official/urdr' },
  repository: { type: 'git', url: 'https://github.com/natureco-official/urdr' },
  homepage: 'https://github.com/natureco-official/urdr',
  license: 'MIT',
  keywords: ['memory', 'agent-memory', 'knowledge-management', 'markdown', 'event-sourcing'],
  server: {
    type: 'node',
    entry_point: 'server/scripts/mcp-server.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/scripts/mcp-server.mjs', '--root', '${user_config.memory_dir}'],
    },
  },
  user_config: {
    memory_dir: {
      type: 'directory',
      title: 'Memory tree folder',
      description: 'Folder holding your root-*.md files. Pick an empty folder to start fresh — copy the templates from the bundle (server/templates) or run init.sh from the repo.',
      required: true,
      default: '${HOME}/urdr-memory',
    },
  },
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=22' },
  },
  tools: [
    { name: 'urdr_context', description: 'One-call session brief (~375 tokens) for the whole tree' },
    { name: 'urdr_ask', description: 'Question → token-budgeted answer from the memory graph, provenance on every line' },
    { name: 'urdr_search', description: 'Hybrid literal/regex/trigram search with Turkish suffix awareness' },
    { name: 'urdr_read', description: 'Full text of specific leaves by stable id' },
    { name: 'urdr_related', description: 'Token-budgeted graph neighborhood of one leaf' },
    { name: 'urdr_path', description: 'Cheapest evidence chain between two concepts' },
    { name: 'urdr_map', description: 'Tree skeleton: roots, branches, counts' },
    { name: 'urdr_report', description: 'God nodes, cross-branch communities, surprising connections' },
    { name: 'urdr_fetch', description: 'Exact line slices of parked (spooled) replies; refs are content hashes' },
    { name: 'urdr_watch', description: 'Baseline file stamps under the watch root for change tracking' },
    { name: 'urdr_delta', description: 'Changed line ranges since the last look — verbatim hunks, cost proportional to the change' },
    { name: 'urdr_write_context', description: 'Pre-write brief: verbatim branch inventory, near-duplicate warnings, format hints, advisory ranking' },
    { name: 'urdr_append', description: 'Durable, event-logged leaf append' },
    { name: 'urdr_lint', description: 'Growth, reference and duplication audit' },
    { name: 'urdr_compile_plan', description: 'Dry-run maintenance plan (splits, repairs)' },
    { name: 'urdr_apply_plan', description: 'Apply an approved maintenance plan' },
    { name: 'urdr_forget_leaf', description: 'User-triggered erasure with verified artifact scrub' },
    { name: 'urdr_resume_forgetting', description: 'Finish interrupted scrubs idempotently' },
  ],
};
fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ── 4. doğrula + paketle ─────────────────────────────────────────────────────
runTool('npx', ['-y', '@anthropic-ai/mcpb', 'validate', path.join(STAGE, 'manifest.json')], { stdio: 'inherit' });
const out = path.join(DIST, `urdr-memory-${pkg.version}.mcpb`);
fs.rmSync(out, { force: true });
runTool('npx', ['-y', '@anthropic-ai/mcpb', 'pack', STAGE, out], { stdio: 'inherit' });
const size = fs.statSync(out).size;
console.log(`\n✓ ${path.relative(ROOT, out)}  (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log('  Kurulum: dosyayı çift tıkla → Claude Desktop bellek klasörünü sorar → hazır.');
