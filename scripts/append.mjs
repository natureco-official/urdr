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
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBranch, hasHeadingNodes, parseMarkdown } from './lib/markdown-model.mjs';
import { acquireLeaseLock, assertLeaseOwned, releaseLeaseLock } from './lib/lock.mjs';
import { eventLogPaths, hashContent, readCommittedState } from './lib/event-log.mjs';
import { assignStableIds, beginTransaction, importMarkdown, populateTransactionEdgesFromViews } from './lib/transaction.mjs';

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

const WINDOWS_MOVE_HELPER_SOURCE = `
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class UrdrMove {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="MoveFileExW")]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool MoveFileEx(string from, string to, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool CloseHandle(IntPtr handle);

  static string Move(string from, string to) {
    if (MoveFileEx(from, to, 0x1u | 0x8u)) return null;
    int error = Marshal.GetLastWin32Error();
    return new Win32Exception(error).Message + " (" + error + ")";
  }

  static bool ProcessExists(int processId) {
    IntPtr handle = OpenProcess(0x00100000u, false, processId);
    if (handle == IntPtr.Zero) return false;
    try { return WaitForSingleObject(handle, 0) == 0x00000102u; }
    finally { CloseHandle(handle); }
  }

  static bool IsSharingViolation(IOException error) {
    int code = error.HResult & 0xffff;
    return code == 32 || code == 33;
  }

  static T RetrySharingViolation<T>(Func<T> operation) {
    for (int attempt = 0; ; attempt++) {
      try { return operation(); }
      catch (IOException error) {
        if (!IsSharingViolation(error) || attempt >= 5) throw;
        Thread.Sleep(2 << attempt);
      }
    }
  }

  static void RetrySharingViolation(Action operation) {
    RetrySharingViolation<object>(() => { operation(); return null; });
  }

  static void RunServer(string directory, int parentPid) {
    Directory.CreateDirectory(directory);
    try {
      while (ProcessExists(parentPid) && !File.Exists(Path.Combine(directory, "stop"))) {
        foreach (string request in Directory.GetFiles(directory, "*.request")) {
          string response = Path.ChangeExtension(request, ".response");
          string result;
          try {
            byte[] payload = RetrySharingViolation(() => File.ReadAllBytes(request));
            int fromBytes = BitConverter.ToInt32(payload, 0);
            string from = Encoding.Unicode.GetString(payload, 4, fromBytes);
            string to = Encoding.Unicode.GetString(payload, 4 + fromBytes, payload.Length - 4 - fromBytes);
            string error = Move(from, to);
            result = error == null ? "ok" : "error\\n" + error;
          } catch (Exception error) {
            result = "error\\n" + error.Message;
          }
          string temporary = response + ".tmp";
          File.WriteAllText(temporary, result, new UTF8Encoding(false));
          RetrySharingViolation(() => File.Move(temporary, response));
          RetrySharingViolation(() => File.Delete(request));
        }
        Thread.Sleep(1);
      }
    } finally {
      for (int attempt = 0; attempt < 20; attempt++) {
        try {
          if (Directory.Exists(directory)) Directory.Delete(directory, true);
          break;
        } catch { Thread.Sleep(5); }
      }
    }
  }

  public static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "--server") {
      RunServer(args[1], Int32.Parse(args[2]));
      return 0;
    }
    if (args.Length != 2) {
      Console.Error.WriteLine("expected source and destination paths");
      return 2;
    }
    string moveError = Move(args[0], args[1]);
    if (moveError == null) return 0;
    Console.Error.WriteLine(moveError);
    return 1;
  }
}`;

let windowsMoveHelper;
let windowsMoveServer;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) {} }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function windowsMoveHelperPath() {
  if (windowsMoveHelper && fs.existsSync(windowsMoveHelper)) return windowsMoveHelper;

  const sourceHash = crypto.createHash('sha256').update(WINDOWS_MOVE_HELPER_SOURCE).digest('hex');
  const cacheDir = path.join(os.tmpdir(), 'urdr-durable-rename');
  const helper = path.join(cacheDir, `movefileex-${sourceHash}.exe`);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (fs.existsSync(helper)) {
    windowsMoveHelper = helper;
    return helper;
  }

  const temporary = path.join(cacheDir, `.movefileex-${sourceHash}-${process.pid}-${crypto.randomUUID()}.exe`);
  const command = `Add-Type -TypeDefinition @'\n${WINDOWS_MOVE_HELPER_SOURCE}\n'@ -Language CSharp -OutputAssembly $env:URDR_MOVE_HELPER -OutputType ConsoleApplication`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, URDR_MOVE_HELPER: temporary },
  });
  if (result.error || result.status !== 0 || !fs.existsSync(temporary)) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    const detail = result.error?.message || result.stderr || result.stdout || `PowerShell exited with status ${result.status}`;
    throw new Error(`durable rename helper compilation failed: ${detail.trim()}`);
  }

  try { fs.renameSync(temporary, helper); }
  catch (error) {
    // Concurrent first writers compile identical, content-addressed helpers. The winner
    // publishes atomically; losers discard their private completed executable.
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (!fs.existsSync(helper)) throw error;
  }
  windowsMoveHelper = helper;
  return helper;
}

function windowsMoveServerHandle() {
  if (windowsMoveServer && processExists(windowsMoveServer.child.pid)) return windowsMoveServer;

  const directory = path.join(os.tmpdir(), `urdr-durable-rename-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory);
  const child = spawn(windowsMoveHelperPath(), ['--server', directory, String(process.pid)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();

  const cleanup = () => {
    try { fs.writeFileSync(path.join(directory, 'stop'), ''); } catch {}
    const deadline = Date.now() + 1000;
    while (processExists(child.pid) && Date.now() < deadline) sleepSync(5);
    if (processExists(child.pid)) try { child.kill(); } catch {}
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  };
  process.once('exit', cleanup);
  windowsMoveServer = { child, directory };
  return windowsMoveServer;
}

function windowsDurableRename(from, to) {
  // atomicReplaceFile blocks the event loop by contract, so publish a complete request
  // and synchronously poll for the independently running helper's atomic response.
  const server = windowsMoveServerHandle();
  const token = crypto.randomUUID();
  const request = path.join(server.directory, `${token}.request`);
  const response = path.join(server.directory, `${token}.response`);
  const temporary = `${request}.tmp`;
  const fromBytes = Buffer.from(from, 'utf16le');
  const toBytes = Buffer.from(to, 'utf16le');
  const payload = Buffer.allocUnsafe(4 + fromBytes.length + toBytes.length);
  payload.writeUInt32LE(fromBytes.length, 0);
  fromBytes.copy(payload, 4);
  toBytes.copy(payload, 4 + fromBytes.length);
  fs.writeFileSync(temporary, payload, { flag: 'wx' });
  fs.renameSync(temporary, request);

  const deadline = Date.now() + 30000;
  while (!fs.existsSync(response)) {
    if (!processExists(server.child.pid)) throw new Error('durable rename failed: helper process stopped');
    if (Date.now() >= deadline) throw new Error('durable rename failed: helper response timeout');
    sleepSync(1);
  }
  const result = fs.readFileSync(response, 'utf8');
  try { fs.rmSync(response, { force: true }); } catch {}
  if (result !== 'ok') {
    const detail = result.startsWith('error\n') ? result.slice(6) : result;
    throw new Error(`durable rename failed: ${detail.trim()}`);
  }
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
    let committedState = readCommittedState(memory);
    if (committedState.checkpoints.size === 0) {
      importMarkdown(memory, { lock });
      committedState = readCommittedState(memory);
    }

    const content = fs.readFileSync(target, 'utf8');
    const existingIds = new Set(parseMarkdown(content).leaves.map((leaf) => leaf.id).filter(Boolean));
    let next = assignStableIds(insertLeaf(content, branch, leafText));
    const model = parseMarkdown(next);
    const appended = model.leaves
      .map((leaf, index) => ({ leaf, index }))
      .filter(({ leaf }) => leaf.id && !existingIds.has(leaf.id));
    if (appended.length !== 1) throw new Error(`append must create exactly one stable leaf; created ${appended.length}`);

    const { leaf, index } = appended[0];
    const existing = committedState.leaves.get(leaf.id);
    if (existing) {
      throw new Error(`stable leaf id already exists in committed tree: ${leaf.id} (${existing.file})`);
    }
    const proposedLeaf = {
      id: leaf.id,
      file: rootFile,
      branch: leaf.branch,
      kind: leaf.kind,
      index,
      text: leaf.text,
      contentHash: hashContent(leaf.text),
    };
    const transaction = beginTransaction(memory, { lock }).upsertLeaf(proposedLeaf);
    const proposed = new Map([[rootFile, next]]);
    populateTransactionEdgesFromViews(transaction, committedState, proposed, {
      baseLeaves: committedState.leaves,
      sourceIds: [leaf.id],
      embedResolved: true,
    });
    next = proposed.get(rootFile);
    const result = transaction.publishRoot(rootFile, next).commit(opts);
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
