#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readCommittedState } from './lib/event-log.mjs';
import { importMarkdown } from './lib/transaction.mjs';
import {
  createUrdrMcpServer,
  MAX_LEAF_TEXT_LENGTH,
  MAX_QUERY_LENGTH,
} from './mcp-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const windowsNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmPrefix = process.platform === 'win32' ? [windowsNpmCli] : [];
let passed = 0;

async function test(name, body) {
  await body();
  passed++;
  console.log(`  ✓ ${name}`);
}

function temp(prefix = 'urdr-rock6d-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); }

function compilerFixture() {
  const deployment = Array.from({ length: 25 }, (_, i) => `- deployment pipeline-${i} release-${i} service-${i}`);
  const security = Array.from({ length: 25 }, (_, i) => `- security vault-${i} credential-${i} control-${i}`);
  return `# Root-2: Technical\n\n## Operations\n\n${[...deployment, ...security].join('\n')}\n\n## Notes\n\n_No entries yet._\n`;
}

function value(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text || 'tool returned an MCP error');
  return result.structuredContent || JSON.parse(result.content[0].text);
}

function errorMessage(result) {
  assert.equal(result.isError, true, 'expected MCP tool rejection');
  return result.structuredContent?.error || result.content?.[0]?.text || '';
}

async function openInMemory(serveRoot) {
  const server = createUrdrMcpServer({ serveRoot });
  const client = new Client({ name: 'urdr-rock6d-selftest', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

await test('real MCP client calls search, append, lint, compiler, and consequential forgetting actions', async () => {
  const serveRoot = temp();
  const memory = path.join(serveRoot, 'memory');
  write(path.join(memory, 'root-2-technical.md'), compilerFixture());
  importMarkdown(memory);
  const { server, client } = await openInMemory(serveRoot);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['append', 'compiler', 'forgetting', 'lint', 'search']);
    assert.match(listed.tools.find((tool) => tool.name === 'forgetting').description, /CONSEQUENTIAL USER-TRIGGERED ERASURE/);

    const leafText = '**17.07.2026 — MCP boundary — unique-rock6d-memory**';
    const appended = value(await client.callTool({ name: 'append', arguments: {
      memoryDir: 'memory', rootFile: 'root-2-technical.md', branch: 'Notes', leafText,
    } }));
    assert.match(appended.id, /^u_/);
    assert.ok(fs.readFileSync(path.join(memory, appended.file), 'utf8').includes(leafText));

    const searched = value(await client.callTool({ name: 'search', arguments: {
      memoryDir: 'memory', query: 'unique-rock6d-memory', hierarchyFiles: ['root-2-technical.md'],
    } }));
    assert.equal(searched.count, 1);
    assert.equal(searched.results[0].branch, 'Notes');
    assert.match(searched.results[0].text, /unique-rock6d-memory/);
    assert.equal(fs.existsSync(path.join(memory, '.urdr', 'search-telemetry.json')), false);

    const linted = value(await client.callTool({ name: 'lint', arguments: { memoryDir: 'memory', failOnWarn: true } }));
    assert.equal(linted.files, 1);
    assert.ok(linted.findings.some((finding) => finding.code === 'branch-leaves'));
    assert.equal(linted.failed, true);

    const plan = value(await client.callTool({ name: 'compiler', arguments: { memoryDir: 'memory', action: 'dry-run' } }));
    assert.ok(plan.actions.some((action) => action.type === 'branch.split' && action.applicable));
    value(await client.callTool({ name: 'append', arguments: {
      memoryDir: 'memory', rootFile: 'root-2-technical.md', branch: 'Notes',
      leafText: '**17.07.2026 — stale proof — changes committed tree hash**',
    } }));
    assert.match(errorMessage(await client.callTool({ name: 'compiler', arguments: {
      memoryDir: 'memory', action: 'apply', plan,
    } })), /stale compiler plan/);

    const freshPlan = value(await client.callTool({ name: 'compiler', arguments: { memoryDir: 'memory', action: 'dry-run' } }));
    const applied = value(await client.callTool({ name: 'compiler', arguments: {
      memoryDir: 'memory', action: 'apply', plan: freshPlan,
    } }));
    assert.equal(applied.status, 'applied');
    assert.ok(applied.actionsApplied.length > 0);
    assert.match(fs.readFileSync(path.join(memory, 'root-2-technical.md'), 'utf8'), /## Operations \/ Deployment/);

    const forgotten = value(await client.callTool({ name: 'forgetting', arguments: {
      memoryDir: 'memory', action: 'forget', leafId: appended.id, reason: 'explicit Rock 6D self-test erasure',
    } }));
    assert.equal(forgotten.id, appended.id);
    assert.equal(readCommittedState(memory).forgottenLeaves.has(appended.id), true);
    assert.ok(!fs.readFileSync(path.join(memory, 'root-2-technical.md'), 'utf8').includes('unique-rock6d-memory'));
    const resumed = value(await client.callTool({ name: 'forgetting', arguments: { memoryDir: 'memory', action: 'resume' } }));
    assert.deepEqual(resumed, { resumed: [] });
  } finally {
    await client.close();
    await server.close().catch(() => {});
    fs.rmSync(serveRoot, { recursive: true, force: true });
  }
});

await test('MCP boundary rejects traversal, symlink escape, and oversized query/leaf input clearly', async () => {
  const serveRoot = temp();
  const memory = path.join(serveRoot, 'memory');
  write(path.join(memory, 'root-2-technical.md'), '# Root-2\n\n## Notes\n\n_No entries yet._\n');
  const outside = temp('urdr-rock6d-outside-');
  write(path.join(outside, 'root-9-outside.md'), '# Outside\n\n## Secrets\n\n- must stay outside\n');
  fs.symlinkSync(outside, path.join(serveRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const { server, client } = await openInMemory(serveRoot);
  try {
    assert.match(errorMessage(await client.callTool({ name: 'search', arguments: {
      memoryDir: '../outside', query: 'x',
    } })), /path traversal/);
    assert.match(errorMessage(await client.callTool({ name: 'append', arguments: {
      memoryDir: 'memory', rootFile: '../outside.md', branch: 'Notes', leafText: '- x',
    } })), /path traversal/);
    assert.match(errorMessage(await client.callTool({ name: 'search', arguments: {
      memoryDir: 'escape', query: 'must stay outside',
    } })), /escapes memory directory/);
    assert.match(errorMessage(await client.callTool({ name: 'search', arguments: {
      memoryDir: 'memory', query: 'q'.repeat(MAX_QUERY_LENGTH + 1),
    } })), /exceeds maximum length/);
    assert.match(errorMessage(await client.callTool({ name: 'append', arguments: {
      memoryDir: 'memory', rootFile: 'root-2-technical.md', branch: 'Notes',
      leafText: 'x'.repeat(MAX_LEAF_TEXT_LENGTH + 1),
    } })), /exceeds maximum length/);
    assert.ok(!fs.readFileSync(path.join(outside, 'root-9-outside.md'), 'utf8').includes('- x'));
    assert.ok(!fs.readFileSync(path.join(memory, 'root-2-technical.md'), 'utf8').includes('x'.repeat(100)));
  } finally {
    await client.close();
    await server.close().catch(() => {});
    fs.rmSync(serveRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

await test('packed package clean-installs, starts over stdio, and answers a real tool call', async () => {
  const staging = temp('urdr-rock6d-pack-');
  const installDir = temp('urdr-rock6d-install-');
  const memory = temp('urdr-rock6d-clean-memory-');
  try {
    const packed = spawnSync(npmCommand, [...npmPrefix, 'pack', '--json', '--pack-destination', staging], {
      cwd: packageRoot, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const packInfo = JSON.parse(packed.stdout);
    const tarball = path.join(staging, packInfo[0].filename);
    console.log(`    clean-install pack: ${packInfo[0].filename} (${packInfo[0].size} bytes)`);

    const installed = spawnSync(npmCommand, [...npmPrefix, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: installDir, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    console.log(`    clean-install npm: ${installed.stdout.trim().replace(/\s+/g, ' ')}`);

    write(path.join(memory, 'root-1-topics.md'), '# Root-1\n\n## Projects\n\n- packed-server-proof\n');
    const serverScript = path.join(installDir, 'node_modules', 'urdr-mcp-server', 'scripts', 'mcp-server.mjs');
    assert.equal(fs.existsSync(serverScript), true);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [serverScript, '--root', memory], cwd: installDir, stderr: 'pipe',
    });
    const client = new Client({ name: 'urdr-clean-install-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const searched = value(await client.callTool({ name: 'search', arguments: { query: 'packed-server-proof' } }));
      assert.equal(searched.count, 1);
      assert.match(searched.results[0].text, /packed-server-proof/);
      console.log(`    clean-install MCP: search returned ${searched.count} matching leaf`);
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.rmSync(memory, { recursive: true, force: true });
  }
});

console.log(`\n  ${passed} Rock 6D tests passed`);
