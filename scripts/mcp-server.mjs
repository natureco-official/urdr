#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendLeaf, resolveConfinedTarget } from './append.mjs';
import { applyCompilerPlan, compileDryRun } from './compiler.mjs';
import { forgetMemoryLeaf, resumeForgottenArtifactScrubs } from './lib/forgetting.mjs';
import { lintTree } from './lint.mjs';
import { searchMemory } from './search.mjs';
import { estimateTokens, loadPack, readLeavesById, relatedLeaves, treeMap } from './lib/context-pack.mjs';
import { askMemory, pathBetween } from './lib/memory-query.mjs';
import { buildReport, detectCommunities } from './lib/graph-intel.mjs';
import { applyContextTax, createSessionLedger, spoolFetch } from './lib/context-tax.mjs';
import { createWatchRegistry, deltaPaths, watchPaths, MAX_WATCH_PATHS_PER_CALL, MAX_WATCH_FILES } from './lib/file-watch.mjs';

export const MAX_QUERY_LENGTH = 4096;
export const MAX_LEAF_TEXT_LENGTH = 64 * 1024;
export const MAX_COMPILER_PLAN_BYTES = 2 * 1024 * 1024;

const stringSchema = (description, maxLength) => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });
const memoryDirSchema = stringSchema('Relative memory-tree directory beneath the server configured root. Defaults to ".".', 1024);
// Bağlam vergisi bayrakları: delta uygulanan salt-okur araçlar taşır (lib/context-tax.mjs).
const taxProps = {
  force: { type: 'boolean', description: 'Return the full body even when it is identical to an earlier reply in this session (the delta protocol otherwise answers "unchanged" with a spool ref).' },
  maxReplyTokens: { type: 'integer', minimum: 100, maximum: 8000, description: 'Replies above this approximate token budget are parked in the spool; a preview plus a spool:<hash> ref is returned. Default 2000.' },
};

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'urdr_search',
    description: 'Search a confined Urdr memory tree without writing search telemetry.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        memoryDir: memoryDirSchema,
        ...taxProps,
        query: stringSchema('Search query interpreted according to mode.', MAX_QUERY_LENGTH),
        mode: { type: 'string', enum: ['auto', 'literal', 'regex'], default: 'auto' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'integer', minimum: 0, maximum: 1000 },
        regexTimeoutMs: { type: 'integer', minimum: 10, maximum: 10000 },
        hierarchyFiles: { type: 'array', maxItems: 64, items: stringSchema('Relative root filename inside memoryDir.', 255) },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_context',
    description: 'ONE-CALL SESSION START. Compiled ~350-token brief of the whole tree: map, recent dated entries with leaf ids, hottest nodes, growth warnings. Replaces reading root files at session start.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { memoryDir: memoryDirSchema, ...taxProps },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_map',
    description: 'Tree skeleton only: roots, branches, leaf counts (~80 tokens). Use to route before searching; never read whole root files for orientation.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { memoryDir: memoryDirSchema, ...taxProps },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_read',
    description: 'Full text of specific leaves by stable id (from urdr_search / urdr_context / urdr_related). Surgical read — only the requested leaves are returned, never whole files.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['ids'],
      properties: {
        memoryDir: memoryDirSchema,
        ...taxProps,
        ids: { type: 'array', minItems: 1, maxItems: 32, items: stringSchema('Stable leaf id.', 512) },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_related',
    description: 'Token-budgeted neighborhood of one leaf over the memory graph. EXTRACTED edges (explicit edge:/bkz:) rank before INFERRED (same-branch adjacency); every result carries its provenance tier.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['leafId'],
      properties: {
        memoryDir: memoryDirSchema,
        ...taxProps,
        leafId: stringSchema('Origin leaf id.', 512),
        budgetTokens: { type: 'integer', minimum: 50, maximum: 4000 },
        depth: { type: 'integer', minimum: 1, maximum: 3 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_ask',
    description: 'ONE-CALL question answering: search seeds the memory graph, the neighborhood expands it, and a token-budgeted markdown answer comes back with full leaf texts, related headlines, and provenance tiers on every line. No LLM, fully deterministic.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['question'],
      properties: {
        memoryDir: memoryDirSchema,
        ...taxProps,
        question: stringSchema('Natural-language question or keywords.', MAX_QUERY_LENGTH),
        budgetTokens: { type: 'integer', minimum: 100, maximum: 4000 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_path',
    description: 'Cheapest evidence chain between two concepts (Dijkstra; explicit EXTRACTED references cost less than INFERRED adjacency). Accepts leaf ids or search queries; every hop carries its via/tier.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: {
        memoryDir: memoryDirSchema,
        ...taxProps,
        from: stringSchema('Start: leaf id or search query.', MAX_QUERY_LENGTH),
        to: stringSchema('End: leaf id or search query.', MAX_QUERY_LENGTH),
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_report',
    description: 'Deterministic whole-tree structure report: god nodes, communities crossing branch boundaries (Louvain), surprising cross-root connections. Same tree yields the same report.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { memoryDir: memoryDirSchema, ...taxProps },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_append',
    description: 'Append one dated leaf to an existing branch in a confined Urdr root file using the durable event-log transaction writer.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootFile', 'branch', 'leafText'],
      properties: {
        memoryDir: memoryDirSchema,
        rootFile: stringSchema('Relative root filename inside memoryDir.', 255),
        branch: stringSchema('Existing ## branch name.', 512),
        leafText: stringSchema('Leaf Markdown. Actual headings are rejected.', MAX_LEAF_TEXT_LENGTH),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'urdr_lint',
    description: 'Audit a confined Urdr tree for growth, reference, index, and duplication findings.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { memoryDir: memoryDirSchema, failOnWarn: { type: 'boolean', default: false } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_compile_plan',
    description: 'Generate an inert Urdr compiler dry-run plan for the current committed tree state.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { memoryDir: memoryDirSchema },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'urdr_apply_plan',
    description: 'Apply an explicitly supplied compiler plan after validating its size, confinement, freshness, and exact correspondence to a newly regenerated trusted dry run.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['plan'],
      properties: {
        memoryDir: memoryDirSchema,
        plan: { type: 'object', description: 'Exact compiler dry-run plan to approve and apply.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'urdr_forget_leaf',
    description: 'CONSEQUENTIAL USER-TRIGGERED ERASURE. Forget one stable leaf, remove it from current and future state and every live managed artifact, and retain only the documented append-only ledger record.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['leafId'],
      properties: {
        memoryDir: memoryDirSchema,
        leafId: stringSchema('Stable leaf ID to forget.', 512),
        reason: stringSchema('User-provided reason recorded with the forgetting operation.', 4096),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'urdr_watch',
    description: 'Register file stamps for change tracking (the coding-loop counterpart of the memory stamps). Paths are relative to the fixed watch root configured at server startup (--watch-root, defaults to the memory root); re-watching a path rebases its baseline. Registry is session-lived: a server restart forgets baselines, so no staleness class exists.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['paths'],
      properties: {
        memoryDir: memoryDirSchema,
        paths: { type: 'array', minItems: 1, maxItems: 64, items: stringSchema('Relative path beneath the watch root.', 1024) },
        maxReplyTokens: taxProps.maxReplyTokens,
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_delta',
    description: 'What changed since the last look? Unchanged watched files cost one line each; changed files return only their changed line ranges as verbatim hunks (never summaries — an over-budget diff region is returned whole and flagged coarse:true). Baselines rebase after reporting, so consecutive deltas are incremental. Oversized replies park in the spool.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        memoryDir: memoryDirSchema,
        paths: { type: 'array', minItems: 1, maxItems: 256, items: stringSchema('Watched relative path (subset filter; omit for all).', 1024) },
        maxReplyTokens: taxProps.maxReplyTokens,
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_fetch',
    description: 'Retrieve exact line slices of a parked reply from the spool. Refs (spool:<hash>) come from "unchanged" or "spooled" replies; the ref is the content hash, so every slice is provably part of the reply it came from. The spool is a cache: swept by LRU and emptied by the forgetting scrub.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['ref'],
      properties: {
        memoryDir: memoryDirSchema,
        ref: stringSchema('Spool reference, e.g. spool:0f3a9c2b71d4e685.', 64),
        fromLine: { type: 'integer', minimum: 1, maximum: 1000000 },
        toLine: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'urdr_resume_forgetting',
    description: 'Idempotently finish managed-artifact scrubs for forgetting operations that were already committed but interrupted.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { memoryDir: memoryDirSchema },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
]);

function objectArguments(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be an object');
  return value;
}

function requiredString(args, key, maxLength) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${key} exceeds maximum length of ${maxLength} characters`);
  return value;
}

function optionalBoolean(args, key) {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  return args[key];
}

function optionalInteger(args, key, min, max) {
  if (args[key] === undefined) return undefined;
  if (!Number.isInteger(args[key]) || args[key] < min || args[key] > max) {
    throw new Error(`${key} must be an integer from ${min} through ${max}`);
  }
  return args[key];
}

function optionalEnum(args, key, values, fallback) {
  if (args[key] === undefined) return fallback;
  if (typeof args[key] !== 'string' || !values.includes(args[key])) {
    throw new Error(`${key} must be one of: ${values.join(', ')}`);
  }
  return args[key];
}

function rejectTraversal(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error(`${label} must be a non-empty relative path`);
  if (relativePath.length > 1024) throw new Error(`${label} exceeds maximum length of 1024 characters`);
  if (path.isAbsolute(relativePath)) throw new Error(`${label} must be relative to the configured server root`);
  if (relativePath.split(/[\\/]+/).includes('..')) throw new Error(`${label} path traversal is not allowed`);
}

/** Resolve a client memoryDir beneath one fixed, trusted startup root. */
export function resolveServedMemoryDir(serveRoot, memoryDir = '.') {
  rejectTraversal(memoryDir, 'memoryDir');
  const root = fs.realpathSync(path.resolve(serveRoot));
  const memory = memoryDir === '.' ? root : resolveConfinedTarget(root, memoryDir).target;
  if (!fs.statSync(memory).isDirectory()) throw new Error('memoryDir must resolve to a directory');
  return memory;
}

function validateRootFile(memory, rootFile, label = 'rootFile') {
  rejectTraversal(rootFile, label);
  return resolveConfinedTarget(memory, rootFile).target;
}

function validateCompilerPlan(memory, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan is required for urdr_apply_plan');
  const bytes = Buffer.byteLength(JSON.stringify(plan));
  if (bytes > MAX_COMPILER_PLAN_BYTES) throw new Error(`plan exceeds maximum size of ${MAX_COMPILER_PLAN_BYTES} bytes`);
  if (path.resolve(String(plan.memoryDir || '')) !== memory) throw new Error('compiler plan belongs to a different memory tree');
  if (!Array.isArray(plan.actions)) throw new Error('compiler plan actions must be an array');
  for (const action of plan.actions) {
    if (!action || typeof action !== 'object' || !['branch.split', 'edge.repair', 'index.diff'].includes(action.type)) {
      throw new Error(`unsupported compiler plan action: ${action?.type}`);
    }
    if (typeof action.file === 'string') validateRootFile(memory, action.file, 'compiler action file');
  }
}

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: message } };
}

export function executeTool(serveRoot, name, rawArguments, ledger = null, watch = null) {
  const args = objectArguments(rawArguments);
  const memory = resolveServedMemoryDir(serveRoot, args.memoryDir ?? '.');
  const value = dispatchTool(memory, name, args, watch);
  return applyContextTax(ledger, memory, name, args, value);
}

function dispatchTool(memory, name, args, watch) {

  if (name === 'urdr_search') {
    const query = requiredString(args, 'query', MAX_QUERY_LENGTH);
    const hierarchyFiles = args.hierarchyFiles;
    if (hierarchyFiles !== undefined) {
      if (!Array.isArray(hierarchyFiles) || hierarchyFiles.length > 64) throw new Error('hierarchyFiles must contain at most 64 root filenames');
      for (const file of hierarchyFiles) validateRootFile(memory, requiredString({ file }, 'file', 255), 'hierarchy file');
    }
    return searchMemory(memory, query, {
      mode: optionalEnum(args, 'mode', ['auto', 'literal', 'regex'], 'auto'),
      caseSensitive: optionalBoolean(args, 'caseSensitive'),
      maxResults: optionalInteger(args, 'maxResults', 0, 1000),
      regexTimeoutMs: optionalInteger(args, 'regexTimeoutMs', 10, 10000),
      hierarchyFiles,
    });
  }

  if (name === 'urdr_context') {
    const pack = loadPack(memory);
    return { digest: pack.digest, tokensApprox: estimateTokens(pack.digest), stamp: pack.stamp, rebuilt: pack.rebuilt };
  }

  if (name === 'urdr_map') {
    const pack = loadPack(memory);
    return { map: treeMap(pack), stamp: pack.stamp };
  }

  if (name === 'urdr_read') {
    const ids = args.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 32) throw new Error('ids must contain 1..32 leaf ids');
    for (const id of ids) requiredString({ id }, 'id', 512);
    return { leaves: readLeavesById(memory, ids) };
  }

  if (name === 'urdr_related') {
    const leafId = requiredString(args, 'leafId', 512);
    const pack = loadPack(memory);
    return relatedLeaves(pack, leafId, {
      budgetTokens: optionalInteger(args, 'budgetTokens', 50, 4000),
      depth: optionalInteger(args, 'depth', 1, 3),
    });
  }

  if (name === 'urdr_ask') {
    const question = requiredString(args, 'question', MAX_QUERY_LENGTH);
    return askMemory(memory, question, { budgetTokens: optionalInteger(args, 'budgetTokens', 100, 4000) });
  }

  if (name === 'urdr_path') {
    return pathBetween(memory, requiredString(args, 'from', MAX_QUERY_LENGTH), requiredString(args, 'to', MAX_QUERY_LENGTH));
  }

  if (name === 'urdr_report') {
    const pack = loadPack(memory);
    const assignment = detectCommunities(pack);
    return { report: buildReport(pack, assignment), stamp: pack.stamp };
  }

  if (name === 'urdr_append') {
    const rootFile = requiredString(args, 'rootFile', 255);
    validateRootFile(memory, rootFile);
    return appendLeaf(memory, rootFile, requiredString(args, 'branch', 512),
      requiredString(args, 'leafText', MAX_LEAF_TEXT_LENGTH));
  }

  if (name === 'urdr_lint') {
    const failOnWarn = optionalBoolean(args, 'failOnWarn') ?? false;
    const lint = lintTree(memory);
    const errors = lint.findings.filter((finding) => finding.level === 'error').length;
    const warnings = lint.findings.filter((finding) => finding.level === 'warn').length;
    return { ...lint, errors, warnings, failed: errors > 0 || (failOnWarn && warnings > 0) };
  }

  if (name === 'urdr_compile_plan') return compileDryRun(memory);

  if (name === 'urdr_apply_plan') {
    validateCompilerPlan(memory, args.plan);
    return applyCompilerPlan(memory, args.plan);
  }

  if (name === 'urdr_forget_leaf') {
    const leafId = requiredString(args, 'leafId', 512);
    const reason = args.reason === undefined ? undefined : requiredString(args, 'reason', 4096);
    return forgetMemoryLeaf(memory, leafId, { reason });
  }

  if (name === 'urdr_resume_forgetting') return resumeForgottenArtifactScrubs(memory);

  if (name === 'urdr_watch' || name === 'urdr_delta') {
    if (!watch) throw new Error(`${name} requires a watch registry (available over the MCP server; not in bare CLI calls)`);
    const paths = args.paths;
    if (paths !== undefined) {
      if (!Array.isArray(paths)) throw new Error('paths must be an array of relative paths');
      for (const entry of paths) requiredString({ entry }, 'entry', 1024);
    }
    if (name === 'urdr_watch') return watchPaths(watch.registry, watch.root, paths);
    return deltaPaths(watch.registry, watch.root, paths);
  }

  if (name === 'urdr_fetch') {
    return spoolFetch(memory, requiredString(args, 'ref', 64), {
      fromLine: optionalInteger(args, 'fromLine', 1, 1000000),
      toLine: optionalInteger(args, 'toLine', 1, 1000000),
    });
  }

  throw new Error(`unknown tool: ${name}`);
}

export function createUrdrMcpServer({ serveRoot, watchRoot }) {
  const confinedRoot = fs.realpathSync(path.resolve(serveRoot));
  if (!fs.statSync(confinedRoot).isDirectory()) throw new Error('configured server root must be a directory');
  const ledger = createSessionLedger();   // oturum-ömürlü delta defteri
  const watchRootResolved = fs.realpathSync(path.resolve(watchRoot ?? confinedRoot));
  if (!fs.statSync(watchRootResolved).isDirectory()) throw new Error('watch root must be a directory');
  const watch = { registry: createWatchRegistry(), root: watchRootResolved };
  const server = new Server({ name: 'urdr-mcp-server', version: '1.3.0' }, {
    capabilities: { tools: {} },
    instructions: `All memoryDir values are relative to the fixed configured root: ${confinedRoot}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try { return result(executeTool(confinedRoot, request.params.name, request.params.arguments, ledger, watch)); }
    catch (error) { return errorResult(error); }
  });
  return server;
}

function parseCli(argv) {
  if (argv.includes('--help')) return { help: true };
  const flags = ['--root', '--watch-root'];
  const unknown = argv.filter((arg, index) => !flags.includes(arg) && !flags.includes(argv[index - 1]));
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    if (!argv[index + 1]) throw new Error(`${flag} requires a directory`);
    return argv[index + 1];
  };
  return { serveRoot: valueOf('--root') ?? process.cwd(), watchRoot: valueOf('--watch-root') };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write('Usage: urdr-mcp [--root <confined-memory-root>] [--watch-root <confined-watch-root>]\n');
    return;
  }
  const server = createUrdrMcpServer(options);
  await server.connect(new StdioServerTransport());
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) main().catch((error) => { console.error(error.message); process.exit(1); });
