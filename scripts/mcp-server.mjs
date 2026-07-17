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

export const MAX_QUERY_LENGTH = 4096;
export const MAX_LEAF_TEXT_LENGTH = 64 * 1024;
export const MAX_COMPILER_PLAN_BYTES = 2 * 1024 * 1024;

const stringSchema = (description, maxLength) => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });
const memoryDirSchema = stringSchema('Relative memory-tree directory beneath the server configured root. Defaults to ".".', 1024);

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'urdr_search',
    description: 'Search a confined Urdr memory tree. Search telemetry is opt-in and remains disabled unless telemetry=true.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        memoryDir: memoryDirSchema,
        query: stringSchema('Search query interpreted according to mode.', MAX_QUERY_LENGTH),
        mode: { type: 'string', enum: ['auto', 'literal', 'regex'], default: 'auto' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'integer', minimum: 0, maximum: 1000 },
        regexTimeoutMs: { type: 'integer', minimum: 10, maximum: 10000 },
        telemetry: { type: 'boolean', default: false },
        hierarchyFiles: { type: 'array', maxItems: 64, items: stringSchema('Relative root filename inside memoryDir.', 255) },
      },
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

function executeTool(serveRoot, name, rawArguments) {
  const args = objectArguments(rawArguments);
  const memory = resolveServedMemoryDir(serveRoot, args.memoryDir ?? '.');

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
      telemetry: optionalBoolean(args, 'telemetry') ?? false,
      hierarchyFiles,
    });
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

  throw new Error(`unknown tool: ${name}`);
}

export function createUrdrMcpServer({ serveRoot }) {
  const confinedRoot = fs.realpathSync(path.resolve(serveRoot));
  if (!fs.statSync(confinedRoot).isDirectory()) throw new Error('configured server root must be a directory');
  const server = new Server({ name: 'urdr-mcp-server', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: `All memoryDir values are relative to the fixed configured root: ${confinedRoot}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try { return result(executeTool(confinedRoot, request.params.name, request.params.arguments)); }
    catch (error) { return errorResult(error); }
  });
  return server;
}

function parseCli(argv) {
  if (argv.includes('--help')) return { help: true };
  const unknown = argv.filter((arg, index) => arg !== '--root' && argv[index - 1] !== '--root');
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && !argv[rootIndex + 1]) throw new Error('--root requires a directory');
  return { serveRoot: rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd() };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write('Usage: urdr-mcp [--root <confined-memory-root>]\n');
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
