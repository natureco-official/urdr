#!/usr/bin/env node
/**
 * append.mjs — Urðr safe concurrent leaf writer (cross-platform, LLM-free)
 *
 * A separate lease-keeper process renews the lock while this synchronous writer works.
 * Writes use fsync + atomic replacement. Linux/macOS also fsync the parent directory;
 * Windows uses MoveFileExW WRITE_THROUGH because Windows rejects directory fsync.
 *
 * Replacement metadata is platform-specific: Linux/macOS copy POSIX permission bits but
 * not ownership, ACLs, xattrs, security labels, or resource forks. Windows replacements
 * inherit directory ACLs; the prior file ACL and DOS attributes are not preserved.
 *
 * Usage:
 *   node append.mjs <memory-dir> <root-file> "<branch>" "<leaf text>"
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBranch, hasHeadingNodes, parseMarkdown } from './lib/markdown-model.mjs';
import { acquireLeaseLock, assertLeaseOwned, releaseLeaseLock } from './lib/lock.mjs';
import { eventLogPaths, hashContent, readCommittedState } from './lib/event-log.mjs';
import { assignStableIds, beginTransaction, importMarkdown } from './lib/transaction.mjs';

export const FILE_METADATA_GUARANTEES = Object.freeze({
  linux: 'POSIX permission bits are copied; ownership, ACLs, xattrs, and security labels are not preserved.',
  darwin: 'POSIX permission bits are copied; ownership, ACLs, extended attributes, and resource forks are not preserved.',
  win32: 'The replacement inherits ACLs from the directory; the prior file ACL and DOS attributes are not preserved.',
});

export function injectFault(opts, stage) {
  if (opts.faultAt === stage) throw new Error(`fault injection: ${stage}`);
  if (opts.faultInjector) opts.faultInjector(stage);
}

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function resolveConfinedTarget(memoryDir, rootFile) {
  if (!rootFile || path.isAbsolute(rootFile)) throw new Error('root file must be a relative path beneath memory directory');
  if (String(rootFile).split(/[\\/]+/).includes('..')) throw new Error('root file path traversal is not allowed');

  const memory = fs.realpathSync(path.resolve(memoryDir));
  const candidate = path.resolve(memory, rootFile);
  const parent = fs.realpathSync(path.dirname(candidate));
  const target = fs.realpathSync(candidate);
  if (!isWithin(memory, parent) && parent !== memory) throw new Error('root file parent escapes memory directory');
  if (!isWithin(memory, target)) throw new Error('root file escapes memory directory');
  return { memory, parent, target };
}

function windowsDurableRename(from, to) {
  const source = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class UrdrMove {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool MoveFileEx(string from, string to, uint flags);
  public static void Run(string from, string to) {
    if (!MoveFileEx(from, to, 0x1 | 0x8)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}`;
  const command = `Add-Type -TypeDefinition @'\n${source}\n'@; [UrdrMove]::Run($env:URDR_MOVE_FROM, $env:URDR_MOVE_TO)`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, URDR_MOVE_FROM: from, URDR_MOVE_TO: to },
  });
  if (result.status !== 0) throw new Error(`durable rename failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function durableRename(from, to) {
  if (process.platform === 'win32') windowsDurableRename(from, to);
  else fs.renameSync(from, to);
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function atomicReplaceFile(target, content, lock, opts = {}) {
  let stat = null;
  try { stat = fs.statSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let fd;
  let renamed = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, stat?.mode ?? 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    if (process.platform !== 'win32' && stat) fs.fchmodSync(fd, stat.mode & 0o7777);
    injectFault(opts, 'before-fsync');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    assertLeaseOwned(lock);
    injectFault(opts, 'before-rename');
    durableRename(tmp, target);
    renamed = true;
    injectFault(opts, 'after-rename');
    assertLeaseOwned(lock);
    injectFault(opts, 'before-directory-fsync');
    fsyncDirectory(path.dirname(target));
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (!renamed) try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

/** Return new content with one leaf inserted under the named canonical `##` branch. */
export function insertLeaf(content, branchName, leafText) {
  if (!leafText || !String(leafText).trim()) throw new Error('empty leaf text');
  if (hasHeadingNodes(leafText)) throw new Error('leaf text contains a Markdown heading');

  const model = parseMarkdown(content);
  const branch = findBranch(model, branchName);
  if (!branch) throw new Error(`branch not found: "## ${branchName}"`);
  const lines = [...model.lines];
  const leafLines = String(leafText).split(/\r?\n/);

  if (branch.placeholders.length > 0) {
    lines.splice(branch.placeholders[0].startLine - 1, 1, ...leafLines);
    return lines.join(model.newline);
  }

  if (branch.leaves.length > 0) {
    const last = branch.leaves[branch.leaves.length - 1];
    lines.splice(last.endLine, 0, '', ...leafLines);
  } else {
    lines.splice(branch.heading.endLine, 0, '', ...leafLines);
  }
  return lines.join(model.newline);
}

/** Concurrency-safe append of one leaf. Returns { file, branch, bytes, id, transactionId }. */
export function appendLeaf(memoryDir, rootFile, branch, leafText, opts = {}) {
  if (!leafText || !String(leafText).trim()) throw new Error('empty leaf text');
  if (hasHeadingNodes(leafText)) throw new Error('leaf text contains a Markdown heading');
  const { memory, target } = resolveConfinedTarget(memoryDir, rootFile);
  const paths = eventLogPaths(memory);
  fs.mkdirSync(paths.urdrDir, { recursive: true });
  const lock = acquireLeaseLock(paths.lockDir, opts.lockOptions || opts);
  try {
    assertLeaseOwned(lock);

    // A legacy tree must become authoritative before its first append. Reusing the
    // tree lock keeps concurrent first writers from racing through bootstrap.
    if (readCommittedState(memory).checkpoints.size === 0) importMarkdown(memory, { lock });

    const content = fs.readFileSync(target, 'utf8');
    const existingIds = new Set(parseMarkdown(content).leaves.map((leaf) => leaf.id).filter(Boolean));
    const next = assignStableIds(insertLeaf(content, branch, leafText));
    const model = parseMarkdown(next);
    const appended = model.leaves
      .map((leaf, index) => ({ leaf, index }))
      .filter(({ leaf }) => leaf.id && !existingIds.has(leaf.id));
    if (appended.length !== 1) throw new Error(`append must create exactly one stable leaf; created ${appended.length}`);

    const { leaf, index } = appended[0];
    const result = beginTransaction(memory, { lock })
      .upsertLeaf({
        id: leaf.id,
        file: rootFile,
        branch: leaf.branch,
        kind: leaf.kind,
        index,
        text: leaf.text,
        contentHash: hashContent(leaf.text),
      })
      .publishRoot(rootFile, next)
      .commit(opts);
    return {
      file: rootFile,
      branch,
      bytes: Buffer.byteLength(next),
      id: leaf.id,
      transactionId: result.transactionId,
    };
  } finally {
    releaseLeaseLock(lock);
  }
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain()) {
  const [memoryDir, rootFile, branch, ...rest] = process.argv.slice(2);
  const leafText = rest.join(' ');
  if (!memoryDir || !rootFile || !branch || !leafText) {
    console.error('Usage: node append.mjs <memory-dir> <root-file> "<branch>" "<leaf text>"');
    process.exit(2);
  }
  try {
    const result = appendLeaf(memoryDir, rootFile, branch, leafText);
    console.log(`✓ appended to ${result.file} › ## ${result.branch} (${result.bytes} bytes)`);
  } catch (error) {
    console.error('✗ ' + error.message);
    process.exit(1);
  }
}
