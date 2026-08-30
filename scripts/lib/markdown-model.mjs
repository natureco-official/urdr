import fs from 'node:fs';
import path from 'node:path';

/**
 * Çok haneli kök numarası desteklenir (root-10-….md). Eski kalıp `\d[-_]`
 * tek haneyle sınırlıydı: root-10 ve sonrası arama/lint/derleyici için
 * görünmezdi — dosya durur, kimse okumazdı. 10 kök × 9 dal × 50 yaprakta
 * (~4.500 yaprak) sessiz bir tavana dönüşüyordu (bkz: feat/context-pack).
 */
export const ROOT_FILE_RE = /^(?:(?:root|kök|kok)-)?\d+[-_].*\.md$/i;
export const EMPTY_PLACEHOLDER_RE = /^_(?:no entries yet|henüz kayıt yok)\._$/i;

const ATX_HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const LIST_RE = /^( {0,3})(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const DATED_ENTRY_RE = /^\s*(?:[-+*]\s+)?\*\*\d{2}\.\d{2}\.\d{4}\s+[—-]/;

export function listRootFiles(memoryDir) {
  let entries;
  try { entries = fs.readdirSync(memoryDir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && ROOT_FILE_RE.test(entry.name))
    .map((entry) => path.join(memoryDir, entry.name))
    .sort();
}

export function isEmptyPlaceholder(text) {
  return EMPTY_PLACEHOLDER_RE.test(String(text).trim());
}

function headingFromLine(line, lineNumber) {
  const match = line.match(ATX_HEADING_RE);
  if (!match) return null;
  let text = match[3] || '';
  text = text.replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { type: 'heading', depth: match[2].length, text, startLine: lineNumber, endLine: lineNumber };
}

function maskComments(lines, newline) {
  const visible = [];
  const metadata = [];
  let comment = null;
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const source = lines[i];
    if (fence) {
      visible.push(source);
      const close = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`);
      if (close.test(source)) fence = null;
      continue;
    }
    if (!comment) {
      const opener = source.match(FENCE_RE);
      if (opener) {
        fence = { marker: opener[2][0], length: opener[2].length };
        visible.push(source);
        continue;
      }
    }
    let rest = source;
    let shown = '';

    while (rest.length > 0) {
      if (comment) {
        const close = rest.indexOf('-->');
        if (close < 0) {
          comment.parts.push(rest);
          rest = '';
          continue;
        }
        comment.parts.push(rest.slice(0, close + 3));
        if (comment.metadata) {
          const raw = comment.parts.join(newline);
          const inner = raw.slice(4, -3).trim();
          metadata.push({
            type: 'metadata',
            prefix: 'urdr',
            value: inner.replace(/^urdr\s*:/i, ''),
            raw,
            startLine: comment.startLine,
            endLine: i + 1,
          });
        }
        comment = null;
        rest = rest.slice(close + 3);
        continue;
      }

      const open = rest.indexOf('<!--');
      if (open < 0) {
        shown += rest;
        rest = '';
        continue;
      }
      shown += rest.slice(0, open);
      const afterOpen = rest.slice(open + 4);
      comment = {
        metadata: /^\s*urdr\s*:/i.test(afterOpen),
        parts: ['<!--'],
        startLine: i + 1,
      };
      rest = afterOpen;
    }
    visible.push(shown);
  }

  return { visible, metadata };
}

function fenceEnd(lines, start) {
  const opener = lines[start].match(FENCE_RE);
  if (!opener) return start;
  const marker = opener[2][0];
  const length = opener[2].length;
  const close = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${length},}[ \\t]*$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (close.test(lines[i])) return i;
  }
  return lines.length - 1;
}

function leaf(lines, start, end, kind) {
  while (end > start && !lines[end].trim()) end--;
  const raw = lines.slice(start, end + 1).join('\n');
  return { type: 'leaf', kind, raw, text: raw.trim(), startLine: start + 1, endLine: end + 1 };
}

function isTableStart(lines, index) {
  return index + 1 < lines.length && lines[index].includes('|') && TABLE_DIVIDER_RE.test(lines[index + 1]);
}

function paragraphEnd(lines, start) {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || DATED_ENTRY_RE.test(line) || headingFromLine(line, i + 1) || FENCE_RE.test(line) || LIST_RE.test(line) || /^ {0,3}>/.test(line) || THEMATIC_BREAK_RE.test(line)) break;
    if (isTableStart(lines, i)) break;
    end = i;
  }
  return end;
}

function datedEntryEnd(lines, start) {
  let end = start;
  let fence = null;
  let sawBlank = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      end = i;
      const close = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`);
      if (close.test(line)) fence = null;
      continue;
    }
    if (!line.trim()) { sawBlank = true; end = i; continue; }
    if (sawBlank && !/^(?: {2,}|\t)/.test(line)) break;
    sawBlank = false;
    const opener = line.match(FENCE_RE);
    if (opener) {
      fence = { marker: opener[2][0], length: opener[2].length };
      end = i;
      continue;
    }
    if (DATED_ENTRY_RE.test(line) || headingFromLine(line, i + 1) || isEmptyPlaceholder(line) || THEMATIC_BREAK_RE.test(line)) break;
    end = i;
  }
  return end;
}

function listEnd(lines, start) {
  const baseIndent = lines[start].match(LIST_RE)[1].length;
  let end = start;
  let sawBlank = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { sawBlank = true; end = i; continue; }
    const marker = line.match(LIST_RE);
    if (marker && marker[1].length <= baseIndent) break;
    if (headingFromLine(line, i + 1) && line.match(/^ */)[0].length <= baseIndent) break;
    if (sawBlank && line.match(/^ */)[0].length <= baseIndent && !/^ {0,3}>/.test(line)) break;
    sawBlank = false;
    end = i;
  }
  return end;
}

function quoteEnd(lines, start) {
  let end = start;
  let sawBlank = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) { sawBlank = true; end = i; continue; }
    if (sawBlank && !/^ {0,3}>/.test(lines[i])) break;
    if (headingFromLine(lines[i], i + 1) && !/^ {0,3}>/.test(lines[i])) break;
    sawBlank = false;
    end = i;
  }
  return end;
}

function tableEnd(lines, start) {
  let end = start + 1;
  for (let i = start + 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) end = i;
  return end;
}

function indentedCodeEnd(lines, start) {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim() || /^(?: {4}|\t)/.test(lines[i])) end = i;
    else break;
  }
  return end;
}

export function parseMarkdown(content) {
  const source = String(content);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const originalLines = source.split(/\r?\n/);
  const { visible: lines, metadata } = maskComments(originalLines, newline);
  const headings = [];
  const branches = [];
  const leaves = [];
  const placeholders = [];
  const nodes = [...metadata];
  let currentBranch = null;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const end = fenceEnd(lines, i);
      const node = leaf(lines, i, end, 'code-fence');
      node.branch = currentBranch?.name || null;
      leaves.push(node); nodes.push(node);
      if (currentBranch) currentBranch.leaves.push(node);
      i = end + 1;
      continue;
    }

    const atx = headingFromLine(line, i + 1);
    if (atx) {
      headings.push(atx); nodes.push(atx);
      if (atx.depth === 2) {
        if (currentBranch) currentBranch.endLine = i;
        currentBranch = { type: 'branch', name: atx.text, heading: atx, startLine: i + 1, endLine: lines.length, leaves: [], placeholders: [] };
        branches.push(currentBranch);
      }
      i++;
      continue;
    }

    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1]) && line.trim()) {
      const depth = lines[i + 1].trim().startsWith('=') ? 1 : 2;
      const node = { type: 'heading', depth, text: line.trim(), startLine: i + 1, endLine: i + 2, style: 'setext' };
      headings.push(node); nodes.push(node);
      i += 2;
      continue;
    }

    if (isEmptyPlaceholder(line)) {
      const node = { type: 'placeholder', text: line.trim(), startLine: i + 1, endLine: i + 1, branch: currentBranch?.name || null };
      placeholders.push(node); nodes.push(node);
      if (currentBranch) currentBranch.placeholders.push(node);
      i++;
      continue;
    }
    if (THEMATIC_BREAK_RE.test(line)) { i++; continue; }

    let end = i;
    let kind = 'paragraph';
    if (DATED_ENTRY_RE.test(line)) { end = datedEntryEnd(lines, i); kind = 'entry'; }
    else if (LIST_RE.test(line)) { end = listEnd(lines, i); kind = 'list-item'; }
    else if (/^ {0,3}>/.test(line)) { end = quoteEnd(lines, i); kind = 'blockquote'; }
    else if (isTableStart(lines, i)) { end = tableEnd(lines, i); kind = 'table'; }
    else if (/^(?: {4}|\t)/.test(line)) { end = indentedCodeEnd(lines, i); kind = 'indented-code'; }
    else { end = paragraphEnd(lines, i); }

    const node = leaf(lines, i, end, kind);
    node.branch = currentBranch?.name || null;
    leaves.push(node); nodes.push(node);
    if (currentBranch) currentBranch.leaves.push(node);
    i = end + 1;
  }

  if (currentBranch) currentBranch.endLine = lines.length;
  nodes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  for (const item of metadata) {
    const next = leaves.find((candidate) => candidate.startLine > item.endLine
      && originalLines.slice(item.endLine, candidate.startLine - 1).every((line) => !line.trim() || /^\s*<!--\s*urdr\s*:/i.test(line)));
    if (!next) continue;
    item.leaf = next;
    next.metadata ||= [];
    next.metadata.push(item);
  }
  for (const item of leaves) {
    const values = (item.metadata || []).map((entry) => entry.value);
    const ids = values.filter((value) => /^id:/i.test(value)).map((value) => value.slice(value.indexOf(':') + 1).trim());
    item.id = ids.length === 1 ? ids[0] : null;
    item.edgeTargets = values.filter((value) => /^edge:/i.test(value)).map((value) => {
      const encoded = value.slice(value.indexOf(':') + 1).trim();
      const indexed = encoded.match(/^(\d+):(.+)$/);
      return indexed ? { index: Number(indexed[1]), targetId: indexed[2].trim() } : { index: null, targetId: encoded };
    }).filter((edge) => edge.targetId);
    item.edgeTargetIds = item.edgeTargets.map((edge) => edge.targetId);
  }
  return { source, newline, lines: originalLines, headings, branches, leaves, placeholders, metadata, nodes };
}

export function hasHeadingNodes(content) {
  return parseMarkdown(content).headings.length > 0;
}

export function findBranch(model, name) {
  const wanted = String(name).trim().toLocaleLowerCase();
  return model.branches.find((branch) => branch.name.trim().toLocaleLowerCase() === wanted) || null;
}
