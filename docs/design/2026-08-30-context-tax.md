# Context Tax Layer — Design

**Status:** shipped — v1.2.0 (delta protocol + spool + urdr_fetch, Rock 9) and v1.3.0 (urdr_watch/urdr_delta, Rock 10)
**Bench:** `node scripts/token-autopsy.mjs <transcript-dirs>` (proven by Rock 8)

## The problem, measured

Urðr already made *session start* cheap (~375 tokens, any tree size). This
layer attacks the rest of the session. The autopsy bench, run over 6 real
Claude Code sessions (21,598 API requests), found:

| Metric | Value |
|---|---|
| Tool output entering context | ~2.3M tokens (est.) |
| **Cache-read tokens** | **10.69 billion** |
| Average context per request | ~500,000 tokens |
| Repeat-read waste (unchanged bytes re-served) | 33% of all Read volume |
| Largest tool source | Bash: 58% of tool output |

The headline: every token that enters context is re-read on **every
subsequent request** of the session. A 1,000-token tool result early in a
long session becomes millions of cache-read tokens. The real cost of a tool
result is not its size — it is **size × remaining requests**. Cache reads
dominate the bill (~75–80% at 10% cache pricing).

Therefore: the layer's goal is not "read less once", it is **"keep less
resident"** — with zero information loss. We only ever evict what is
deterministically recoverable from disk.

## Principles (inherited from the Context Pack)

1. **Zero information loss.** Nothing is summarized away by an LLM. Every
   compressed reply carries a stable reference that recovers the full bytes.
2. **Provable freshness.** Every "unchanged" claim is backed by a content
   hash (the stamp mechanism that already guards the pack).
3. **Budgets at the source.** Tools never emit more than the caller's token
   budget; overflow goes to disk, not to context.
4. **Deterministic, local, LLM-free.** Same inputs, same bytes, no network.
5. **Measure before and after.** `token-autopsy.mjs` is the referee; each
   phase reruns it and publishes the delta.

## Components

### 1. Session delta protocol (all 14 tools) — v1.2

The MCP server keeps an in-memory, per-session ledger:
`(tool, canonical-args) → sha256(result)`.

- On a repeat call whose result hash is unchanged:
  reply `unchanged since <stamp8>` (~10 tokens) instead of the full body.
- Any call may pass `force: true` to get the full body regardless.
- `urdr_context` becomes incremental: the second call in a session returns
  only leaves appended/changed since the first brief — typically
  `no changes since brief <stamp8>` for the common case.
- The ledger is session-scoped and lives only in server memory: a restart
  simply forgets it and serves full bodies again. No new files, no new
  staleness class.

Expected effect: kills the measured 33% repeat-read waste *within Urðr's
domain*, and makes mid-session re-orientation (`context`, `map`, `digest`)
nearly free.

### 2. Spool — result parking for oversized replies — v1.2

When a result exceeds the caller's budget, today we truncate with `…`.
Instead:

- Write the full result to `.urdr/spool/<sha256-prefix>.md` (deterministic
  name = content hash; idempotent).
- Reply with: headline + first budget-worth of lines + `spool:<hash>` ref.
- New tool `urdr_fetch(ref, fromLine?, toLine?)` returns exact slices of a
  spooled result.

Guarantees:
- The ref *is* the hash — a fetched slice provably belongs to the reply it
  came from.
- **Forgetting integration:** `scrubForgottenArtifacts` walks `.urdr/spool/`
  in the same choke point that already scrubs the pack. A forgotten leaf's
  text cannot survive in a spool file.
- GC: spool capped (default 32 files / 4 MB, LRU by mtime); `pack build`
  sweeps expired entries. Spool files are cache, never source of truth.

### 3. File stamps beyond the tree — `urdr_delta` — v1.3

Generalizes the stamp mechanism from memory files to *any* watched files
(the bridge toward code-aware context, without an AST):

- `urdr_watch(paths[])` records `path → {sha256, size, mtime}` in the
  session ledger and returns one stamp line per file.
- `urdr_delta()` re-hashes watched files and returns, per changed file, the
  changed line ranges (plain `diff`-style hunks, verbatim — never
  summarized), budget-capped with spool overflow. Unchanged files cost one
  line: `~ path unchanged`.

This gives an agent the cheap loop it actually needs while coding:
*"what changed since I last looked?"* for tokens proportional to the change,
not to the codebase.

### 4. Protocol guidance (docs, not code) — v1.2

AGENTS.md gains a "context tax" section for agents using Urðr:

- Route large command outputs to files; bring only the tail plus a path
  into context.
- Prefer `urdr_ask` over re-exploring the repo for decisions that were
  recorded as leaves — recording decisions *is* token compression.
- Re-orient with `urdr_context` (delta form) instead of re-reading roots.

## Phasing and proof

| Phase | Ships | Proof |
|---|---|---|
| v1.2.0 | delta protocol, spool + `urdr_fetch`, AGENTS.md guidance | Rock 9 suite: hash-stability, `force` override, spool scrub-on-forget, GC caps; autopsy re-run published in README |
| v1.3.0 | `urdr_watch` / `urdr_delta` | Rock 10: hunk correctness vs `git diff`, budget caps, rename/delete handling |

## Honest limits

- Cache pricing is ~10% of input pricing; savings are large but not linear
  in cache-read tokens. The bench reports raw tokens and lets the reader
  apply their own prices.
- The layer cannot shrink what the model genuinely needs to reason about
  (the code being edited, the conversation itself). It removes redundancy
  only. Measured ceiling from the baseline: roughly 30–50% of tool-derived
  context, compounding through the cache-read multiplier.
- `token-autopsy.mjs` reads Claude Code's JSONL transcript format; other
  clients need an adapter (the analyzer is format-tolerant: unknown lines
  are skipped, never fatal).
