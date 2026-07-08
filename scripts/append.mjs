#!/usr/bin/env node
/**
 * append.mjs — Urðr safe concurrent leaf writer (cross-platform, LLM-free)
 *
 * Urðr stores memory as Markdown, and agents are expected to write leaves into it. But
 * the moment more than one writer exists — e.g. NatureCo runs 8 messaging channels
 * (WhatsApp, Telegram, Signal, IRC, Mattermost, iMessage, SMS + terminal) all writing to
 * the SAME shared memory — naive "read file, rewrite file" loses data: two writers read
 * the same version, both append, the second `writeFile` clobbers the first. That's silent
 * memory loss.
 *
 * This tool makes a leaf-append atomic and serialized:
 *   1. Acquire an advisory lock (atomic `mkdir` — the one cross-platform primitive that
 *      is guaranteed atomic on every OS + filesystem).
 *   2. Read the CURRENT file (never a stale copy held across the write).
 *   3. Insert the leaf under its `## branch` (replacing the "_No entries yet._" placeholder,
 *      otherwise after the last existing leaf) — append-only, never overwrites siblings.
 *   4. Write via temp-file + atomic rename (a partially written file is never observable).
 *   5. Release the lock.
 *
 * Usage:
 *   node append.mjs <memory-dir> <root-file> "<branch>" "<leaf text>"
 *   node append.mjs ./mem root-2-technical.md "APIs" "**04.07.2026 — chose SQLite — ok**"
 *
 * As a module:  import { appendLeaf } from './append.mjs';
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Acquire an advisory lock via atomic mkdir. Retries with backoff up to timeoutMs.
 * Steals a lock older than staleMs (a crashed writer shouldn't wedge the tree forever).
 */
function acquireLock(lockDir, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir); // atomic: throws EEXIST if held
      try { fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid)); } catch {}
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // steal if stale
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > staleMs) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} continue; }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error('lock timeout: ' + lockDir);
      // tiny synchronous backoff (busy-wait a few ms; appends are sub-ms so this is rare)
      const until = Date.now() + 15;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseLock(lockDir) {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
}

/**
 * Pure insert: return new file content with `leafText` added under `## branch`.
 * Replaces a "_No entries yet._" placeholder if present; otherwise inserts after the
 * last leaf in that branch, before the branch-ending `---`/next `##`. Never touches
 * other branches. Throws if the branch heading is missing.
 */
export function insertLeaf(content, branch, leafText) {
  const lines = content.split(/\r?\n/);
  const bre = new RegExp('^##\\s+' + escapeRegex(branch) + '\\s*$', 'i');
  const bi = lines.findIndex((l) => bre.test(l));
  if (bi < 0) throw new Error(`branch not found: "## ${branch}"`);

  // branch region = (bi, end) where end is the next "## " or EOF
  let end = lines.length;
  for (let i = bi + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  // placeholder? replace it in place
  for (let i = bi + 1; i < end; i++) {
    if (/^_no entries yet\._$/i.test(lines[i].trim())) {
      lines[i] = leafText;
      return lines.join('\n');
    }
  }

  // otherwise insert after the last real content line in the region (skip blanks/---/comments)
  let insertAt = bi + 1;
  for (let i = bi + 1; i < end; i++) {
    const t = lines[i].trim();
    if (t && t !== '---' && !t.startsWith('<!--')) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, leafText);
  return lines.join('\n');
}

/**
 * Concurrency-safe append of one leaf. Serialized by an advisory lock, written atomically.
 * Returns { file, branch, bytes }.
 */
export function appendLeaf(memoryDir, rootFile, branch, leafText, opts = {}) {
  if (!leafText || !leafText.trim()) throw new Error('empty leaf text');
  const target = path.join(memoryDir, rootFile);
  const lockDir = target + '.lock';
  acquireLock(lockDir, opts);
  try {
    const content = fs.readFileSync(target, 'utf8'); // CURRENT content, inside the lock
    const next = insertLeaf(content, branch, leafText);
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, target); // atomic replace
    return { file: rootFile, branch, bytes: Buffer.byteLength(next) };
  } finally {
    releaseLock(lockDir);
  }
}

// ── CLI ────────────────────────────────────────────────────────────
// realpathSync resolves symlinks — essential because macOS /tmp → /private/tmp, so
// import.meta.url and argv[1] can differ by symlink alone and a plain string compare
// (even with fileURLToPath) silently fails to detect "run as CLI".
function isMain() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.');
  } catch { return false; }
}

if (isMain()) {
  const [memoryDir, rootFile, branch, ...rest] = process.argv.slice(2);
  const leafText = rest.join(' ');
  if (!memoryDir || !rootFile || !branch || !leafText) {
    console.error('Usage: node append.mjs <memory-dir> <root-file> "<branch>" "<leaf text>"');
    process.exit(2);
  }
  try {
    const r = appendLeaf(memoryDir, rootFile, branch, leafText);
    console.log(`✓ appended to ${r.file} › ## ${r.branch} (${r.bytes} bytes)`);
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}
