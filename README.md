# Urðr — Tree Memory for AI Agents

[![CI](https://github.com/natureco-official/urdr/actions/workflows/ci.yml/badge.svg)](https://github.com/natureco-official/urdr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)]()
[![Tooling](https://img.shields.io/badge/tooling-LLM--free-brightgreen)]()

**Give your coding agent a memory that survives the session — and costs
~375 tokens to wake up, no matter how big it grows.**

Plain Markdown you can read and git-diff, backed by a crash-consistent,
hash-chained event log. No vector DB, no embeddings, no LLM calls, no
network. One MCP call (`urdr_context`) replaces reading root files at
session start: **measured 93–227× cheaper** than the file protocol it
replaces, flat at any tree size. Ask questions (`urdr_ask`), trace evidence
chains between concepts (`urdr_path`), and watch your whole brain rotate
in the browser (**Urðr Tree**) — all deterministic, all local.

```bash
npx -y urdr-mcp-server --root ~/my-memory     # any MCP client, one line
```

Claude Desktop users: grab the `.mcpb` from Releases and double-click it.

**Proof, not promises:**
- **202 automated tests**, cross-platform CI on Linux, macOS, and Windows — badge above is live.
- **0 known vulnerabilities** (`npm audit`).
- Every atomic write is **fault-injection tested** at each real crash point — `before-fsync`, `before-rename`, `after-rename`, `before-directory-fsync` — proving a crash mid-write never corrupts or half-writes a leaf.
- The benchmark **reports its own weak spots**: 89.7% one-call recall, dropping to 67% on collision/fuzzy keys — published, not hidden.
- [`ISSUES.md`](./ISSUES.md) keeps two independent AI code audits public and unedited — including everything that was wrong before it was fixed.

---

> 🤖 **Are you an AI agent reading this?** Stop. Go read **[AGENTS.md](./AGENTS.md)** first — it has your direct instructions. Come back here after you've onboarded yourself. (Yes, this repo is designed for you to self-configure.)

---

### Claude Desktop — one-click install (.mcpb)

Download `urdr-memory-<version>.mcpb` from Releases and **double-click it**.
Claude Desktop asks for your memory folder (pick an empty one to start
fresh — templates ship inside the bundle) and runs the server with its own
Node runtime. No npm, no terminal, no config file.

Build it yourself: `npm run mcpb` → `dist/urdr-memory-<version>.mcpb`
(validated and packed with the official `@anthropic-ai/mcpb` tooling;
the bundle is fully self-contained).

## Context Pack — 93–227× fewer tokens, measured

Agents used to re-orient from raw Markdown every session: the 4-file session
protocol costs ~35k tokens on a mature tree, and every "hierarchy-first"
lookup loads a whole root file. The Context Pack compiles the tree into
`.urdr/pack/` (catalog + graph + a ≤~375-token session brief) —
deterministically, with **zero LLM calls and zero dependencies**, stamped
against the root files and event log so a stale pack is impossible.

| tree size | session: old → new | factor | lookup: old → new | factor |
|---|---|---|---|---|
| 1,120 leaves | 34,737 → **375** | **93×** | 14,967 → 576 | 26× |
| 4,500 leaves | 53,216 → **375** | **142×** | 24,261 → 576 | 42× |
| 9,000 leaves | 85,236 → **375** | **227×** | 40,370 → 576 | 70× |

The brief is **O(1)**: the tree grew 8× and the session cost did not move.
Numbers are `chars/4` estimates from `node scripts/context-bench.mjs`
(seeded synthetic trees; the bench prints its own honesty notes — leaves are
~2 lines, so real long-leaf trees make the OLD side worse, not better).

New MCP tools: `urdr_context` (one-call session start), `urdr_map`
(~80-token skeleton), `urdr_read` (full text of specific leaf ids),
`urdr_related` (token-budgeted graph neighborhood; every result labeled
EXTRACTED — explicit `edge:`/`bkz:` — or INFERRED — same-branch adjacency).

## Context Tax — the session-long half of the savings

The Context Pack made session *start* cheap. The context-tax layer (v1.2)
attacks the rest: every token that enters an agent's context is re-read on
every later request of the session (measured with
`scripts/token-autopsy.mjs`: 2.3M tool tokens became 10.7 **billion**
cache-read tokens across six real sessions). Two mechanisms, both with
zero information loss:

- **Delta protocol** — a repeated identical read-only query returns a
  ~30-token `unchanged` proof (content-hash stamp + spool ref) instead of
  the full body. A changed tree always returns the full body; `force:true`
  always works; the ledger lives only in server memory, so a restart just
  means one full reply again.
- **Spool** — oversized replies are never truncated. The full body is
  parked in a content-addressed file under `.urdr/spool/`, the reply
  carries a preview plus `spool:<hash>`, and `urdr_fetch(ref, fromLine,
  toLine)` returns exact, integrity-checked slices. The spool is a cache:
  LRU-capped, and **emptied by the forgetting scrub in the same choke
  point as the pack** — a forgotten leaf cannot survive inside a parked
  reply.

Design and measured baseline: `docs/design/2026-08-30-context-tax.md`.

## Urðr Tree — see your whole brain locally

```
node scripts/tree.mjs ~/my-memory --serve     # → http://127.0.0.1:4177
```

A single-file, dependency-free visualization of the entire memory: your
leaves as an organic particle brain (deterministic layout, Louvain community
patches, EXTRACTED pathways arcing over the shell), plus a network view.
No CDN, no network calls — the brain never leaves your machine. Community
detection is dependency-free Louvain over the memory graph; communities that
cross branch boundaries are flagged ⚡ because they are the real signal that
two branches are secretly one topic.

---

## The name

> **"The past is never dead. It's not even past."** — Faulkner

**Urðr** (pronounced *urth*) is the Norse Norn of the past, who dwells at
the root of Yggdrasil and waters the world-tree from the well of what has
been. A fitting name for a memory: roots, branches, leaves — and nothing
truly forgotten unless you choose to forget it.

## Why Urðr?

Every AI agent today has the same fundamental limitation: **no persistent memory between sessions**. Most agents start fresh each time, losing context, decisions, and lessons learned. The ones that do remember use flat files that quickly become unmanageable junk drawers.

Urðr solves this with a **tree-memory** approach — inspired by how humans organize knowledge into categories, not flat lists.

### What Makes Urðr Different?

| Feature | Other Approaches | Urðr |
|---------|-----------------|------|
| **Structure** | Flat files, vector DBs, or SQL | 4-root tree with branches & leaves |
| **Retrieval** | Full-file scan or a vector DB/embedding pipeline | Hierarchy first, then a dependency-free hybrid fallback (exact/regex + trigram/typo/Turkish-suffix ranking) — no embeddings, no network call |
| **Source of truth** | The files on disk, full stop | An append-only, hash-chained event log; Markdown is a generated, still directly-editable view |
| **Consistency** | Often duplicated/copied across files | Single primary source + stable-ID-backed `bkz:` edges, not free-text |
| **Growth** | Unmanaged — becomes a junk drawer | Disciplined branch-splitting rules, plus a deterministic auto-split proposal when a branch outgrows them |
| **Cross-domain** | Handled ad-hoc | Formal cross-cutting protocol |
| **Auditability & deletion** | Usually neither, or a bare irreversible delete | Optional provenance metadata per leaf; forgetting removes a leaf from current and future state and every live managed artifact, with the historical ledger boundary explicitly documented |
| **Maintenance** | Manual cleanup, or none | A memory compiler proposes concrete fixes (splits, index diffs, reference repairs) as a dry-run plan, applied only after explicit approval |
| **Agent integration** | Platform-specific only | OpenCode, Claude Code, Codex CLI (MCP), NatureCo, Hermes, OpenClaw |

---

## Architecture at a Glance

```
🌳 Urðr Memory Tree
│
├── 🌱 ROOTS (4 core files)
│   ├── root-0  →  Index (routing, map of all roots)
│   ├── root-1  →  Topics (people, projects, broad subjects)
│   ├── root-2  →  Technical (systems, installs, technical refs)
│   └── root-3  →  Decisions (ADR, constraints, learned lessons)
│
├── 🌿 BRANCHES (## headings inside roots)
│   └── Each root usually has 5-9 branches (a practical routing heuristic)
│
└── 🍃 LEAVES (specific notes, dated events, facts)
    └── Branches hold 30-50 leaves before splitting
```

### The 4-Step Retrieval Protocol

```
1. Identify the subject
2. Select the root (which domain?)
3. Pick the branch (which ## heading?)
4. Read the leaf (specific note)

Target: <300 tokens per retrieval
```

---

## Quick Start

**3 steps, 2 minutes.** Pick your agent below.

### Step 1: Initialize the Memory Tree

```bash
git clone https://github.com/natureco-official/urdr.git
cd urdr

# Creates ~/my-memory with 4 root files + personality
./scripts/init.sh --path ~/my-memory --lang en
```

This creates:
```
~/my-memory/
├── root-0-index.md       # ← Routing map
├── root-1-topics.md      # ← People, projects, subjects
├── root-2-technical.md   # ← Systems, APIs, configs
├── root-3-decisions.md   # ← ADRs, constraints, lessons
└── agent-personality.md  # ← Who your agent is
```

### Step 2: Pick Your Agent → Follow These 3 Lines

| Agent | Just do this |
|-------|-------------|
| **OpenCode** | Copy `integrations/opencode/SKILL.md` to your `.opencode/skills/` dir |
| **Claude Code** | Hand it [`integrations/claude-code/CLAUDE.md`](integrations/claude-code/CLAUDE.md) and say "set this up" — that file walks it through installing the MCP server, building the tree, registering itself, and pointing Claude Code's own memory index at Urðr (the step that makes recall automatic) |
| **OpenClaw** | Use `integrations/openclaw/README.md` to expose the index as `MEMORY.md` and keep domain roots under `memory/` |
| **NatureCo CLI** | Copy `integrations/natureco/plugin.yaml` into your NatureCo config |
| **Hermes** | Copy `integrations/hermes/skill.yaml` into your Hermes skills dir |
| **Codex CLI** | `codex mcp add urdr -- npx -y urdr-mcp-server --root ~/my-memory` |
| **Other agent?** | Load `root-0-index.md` at session start, then read the routed domain root on demand. See `AGENTS.md` |

**Can't find your agent?** Doesn't matter. Urðr is just Markdown files. Any agent that can read files can use it — tell it to load `root-0-index.md` at session start and you're done.

### Step 3: Tell Your Agent to Remember Something

```markdown
# Inside root-1-topics.md → ## Projects

## Current Project: My App

**04.07.2026 — Decided to use SQLite for local storage.**
- Alternative considered: PostgreSQL (overkill for single-user)
- Rollback possible: swap connection string only
```

That's it. Your agent will find this next session, understand the context, and build on it. No more starting from zero.

---

## Directory Structure

```
urdr/
├── README.md               # This file
├── LICENSE                 # MIT
├── AGENTS.md               # Guide for AI agents using Urðr
├── package.json            # MCP server package (the only real npm dependency)
│
├── templates/              # Memory root templates (EN + TR)
│   ├── root-0-index.md
│   ├── root-1-topics.md
│   ├── root-2-technical.md
│   ├── root-3-decisions.md
│   ├── kök-0-indeks.md
│   ├── kök-1-konular.md
│   ├── kök-2-teknik.md
│   ├── kök-3-kararlar.md
│   └── agent-personality.md
│
├── protocols/              # Architecture & protocol docs
│   ├── architecture.md        # English
│   ├── cross-cutting.md       # Cross-domain protocol
│   ├── growth-rules.md        # When & how to grow
│   └── hard-error-protocol.md # Error recovery
│
├── integrations/           # Platform-specific adapters
│   ├── opencode/SKILL.md
│   ├── claude-code/CLAUDE.md
│   ├── openclaw/README.md
│   ├── natureco/plugin.yaml
│   └── hermes/skill.yaml
│
├── scripts/                # Utility scripts (cross-platform)
│   ├── init.sh             # Initialize memory tree (event log born from the start)
│   ├── migrate.mjs         # Transactional branch/root restructuring
│   ├── search.mjs          # Hybrid branch-aware search (Node, LLM-free)
│   ├── bench.mjs           # Retrieval/fidelity benchmark (Node, LLM-free)
│   ├── append.mjs          # Concurrency-safe, event-log-aware leaf writer
│   ├── lint.mjs            # Memory health audit (growth/refs/dup, CI guard)
│   ├── compiler.mjs        # Dry-run fix plans (splits, index diffs, ref repairs)
│   ├── forget.mjs          # Permanent leaf tombstone + artifact scrub
│   ├── mcp-server.mjs      # MCP tools over a confined memory-tree root
│   ├── lib/                # Event log, transactions, lock, parser, telemetry, auto-split
│   └── selftest.mjs        # Exercises every tool (CI, 3-OS matrix)
│
└── examples/               # Practical use cases
    └── basic-setup/
```

---

## Platform Integrations

| Platform | Integration File | Status |
|----------|-----------------|--------|
| **OpenCode** | `integrations/opencode/SKILL.md` | ✅ Ready |
| **Claude Code** | `integrations/claude-code/CLAUDE.md` | ✅ Ready |
| **OpenClaw** | `integrations/openclaw/README.md` | ✅ Ready |
| **NatureCo CLI** | `integrations/natureco/plugin.yaml` | ✅ Ready |
| **Hermes** | `integrations/hermes/skill.yaml` | ✅ Ready |
| **Codex CLI** | `scripts/mcp-server.mjs` (MCP, no skill-file convention needed) | ✅ Ready |
| **Your agent?** | Just read the 4 `root-*.md` files → see `AGENTS.md` | 🛠 Any |

---

## MCP Server

Run the published package directly with `npx`—no separate install step is needed. For a local
checkout, run `npm ci` first, then use the repository script. Configure the server with one fixed
filesystem root. Tool-call `memoryDir` values are relative to this root; absolute paths, parent
traversal, and symlinks that resolve outside it are rejected.

```bash
npx -y urdr-mcp-server --root ~/my-memory
# or, from a local checkout after npm ci:
node scripts/mcp-server.mjs --root ~/my-memory
```

The server exposes seven namespaced tools: `urdr_search`, `urdr_append`, `urdr_lint`,
`urdr_compile_plan`, `urdr_apply_plan`, `urdr_forget_leaf`, and `urdr_resume_forgetting`.
Compiler planning is read-only; apply keeps the committed tree-state staleness check and accepts
only actions reproduced by a fresh trusted dry run. Forgetting is marked and described as a
consequential user-triggered erasure action, while resume is an idempotent completion of an already
committed forget. The `urdr-mcp-server` package is published on npm; the local-checkout command
remains available for contributors and development.

---

## Protocols

Urðr defines three core protocols that make the memory system reliable:

### 1. Architecture Protocol (`protocols/architecture.md`)
The fundamental tree-memory structure: roots, branches, leaves, and the 4-step retrieval method.

### 2. Cross-Cutting Protocol (`protocols/cross-cutting.md`)
Handles information that naturally belongs to multiple roots. Uses the **"Single Primary, Multiple `bkz:`"** rule to prevent duplication drift.

### 3. Growth Rules (`protocols/growth-rules.md`)
Disciplined rules for when to add branches, split overgrown ones, or create new roots. Prevents the "junk drawer" problem.

---

## Retrieval Safety Net (`scripts/search.mjs`)

The 4-step hierarchy is the **primary** path — fast and cheap. But category-guessing has a failure mode: if the agent looks in the wrong root, information that *is* stored reads as "not found" — which, to a user, is indistinguishable from forgetting.

Urðr ships a **hybrid last-resort search** that closes this gap without touching the architecture's elegance:

```bash
# When the 4-step protocol comes up empty, scan everything (branch-aware):
node scripts/search.mjs "sqltie karar" ~/my-memory
# → root-2-technical.md › ## APIs › **04.07.2026 — chose SQLite for local storage**

# Override metacharacter auto-detection when the query syntax must be explicit:
node scripts/search.mjs "foo.bar" ~/my-memory --literal
node scripts/search.mjs "foo.*bar" ~/my-memory --regex
```

- **LLM-free, no embeddings, no network call** — exact/regex matching, then trigram-similarity fuzzy ranking over lightly stemmed tokens (with Turkish agglutinative-suffix stripping) catches typos and different inflections a literal scan would miss entirely.
- **ReDoS-safe** — a regex query runs in a separate, terminable subprocess with a hard deadline; a pathological pattern gets killed and reported as a timeout, never a hang.
- **Cross-platform** — pure Node.js. No `grep`/`rg`/`awk` dependency (those don't exist on stock Windows).
- **Branch-aware** — every hit reports `file › ## branch › leaf`, so the agent still gets structured context.
- **Telemetry is opt-in and aggregate-only** — disabled by default and a true no-op on disk when off; when enabled it records only hierarchy/fallback/miss/timeout counters, never a query, result, or leaf ID.
- **Composable** — exits `0` on hit / `1` on miss (grep convention), or `--json` for programmatic use.

This substantially reduces false "not remembered" results: hierarchy first, hybrid full-tree ranking as the net beneath it.

## Benchmark (`scripts/bench.mjs`)

"Unlimited memory" is a claim until you measure it. `bench.mjs` builds a synthetic tree with a controllable share of **wrong-root** leaves (filed under one root, but naturally queried as another) and a controllable share of **collision** leaves (near-duplicate content, queried with a typo or a different Turkish suffix) — the honest way to measure recall, since a benchmark where every key is globally unique makes 100% recall trivial regardless of how good the retrieval actually is:

```bash
node scripts/bench.mjs --leaves 300 --ambiguity 0.3
```

```
  🌳 Urðr Memory Benchmark
  ──────────────────────────────────────────────────────────────────
  leaves: 300 · wrong-root: 93 (31.0%) · collision: 94 (31.3%) · seed: 42

  Production-writer fidelity       : 100.0% (6/6 via appendLeaf + event log) ✓
  Stable-ID import/oracle fidelity : 100.0% (300/300) ✓

  recall@1, one-call hierarchy-aware : 89.7%
  recall@1, global-only              : 88.7%
  recall@1, two-call assisted        : 89.7%
  recall@1, unique exact keys        : 100.0% (206/206, one-call)
  recall@1, collision/fuzzy keys     : 67.0% (63/94, one-call)
  rescued by assisted second call    : 0 leaves (0.0%)

  avg one-call latency               : 28.069 ms/query (CPU, no LLM/network call)
  avg global-only latency             : 40.209 ms/query (CPU, no LLM/network call)
  avg two-call assisted latency        : 32.144 ms/query (conditional second call)
  avg one-call result size             : ~22 tokens

  → One-call recall is the production API/MCP behavior; assisted recall requires a conditional second call.
```

Write fidelity is measured through the real `appendLeaf()` production writer, not a raw file write, and retrieval correctness is scored against Rock 6A stable IDs, not text-matching. Identical results on macOS, Windows, and Linux (deterministic seed). Use it to prove the architecture works at volume — and to catch the growth bottleneck *before* production, not months later when users ask "why doesn't it remember?"

## Event Log & Transactions (`scripts/lib/event-log.mjs`, `scripts/lib/transaction.mjs`)

Markdown files are the human-readable surface; the actual source of truth is an **append-only, hash-chained event log** (`.urdr/events.jsonl`). Every leaf gets a stable ID (a round-trippable `<!-- urdr:id:... -->` comment), `bkz:` references resolve to ID-backed edges instead of free text, and multi-file changes commit atomically through one transaction. Direct edits to the Markdown files are still fully supported — a reconciliation step diffs them back against the log and flags a genuine conflict (never silently auto-merges) if the same leaf changed both ways.

- **Crash-safe.** Every write is fsync'd and atomically renamed; after a process is killed mid-publish, event-aware readers immediately see the correct logical generation instead of corrupt state or a lost leaf. The next mutation or an explicit reconcile/import repairs partially materialized root Markdown files; reads alone do not rewrite them.
- **Concurrency-safe.** A persistent lease-service process, reused across acquisitions for the caller's lifetime, renews each lock on its own timer, so a busy writer can't lose the lock to a false "stale" steal.
- **Provenance (optional).** Any leaf may carry `creator`, `timestamp`, `source`, `confidence`, `verification_state`, `verifier`, and `validity_interval` metadata — fully additive, no migration needed for existing leaves.
- **Forgetting.** `scripts/forget.mjs` tombstones a leaf, removes it from current and future state, and scrubs its bytes from every live managed generation snapshot, recovery copy, and registered export. It cannot redact the historical ledger in place without breaking the hash chain; this boundary is documented in `protocols/architecture.md`, not hidden.
- **Memory compiler (`scripts/compiler.mjs`).** Turns lint findings into a concrete dry-run plan — deterministic branch-split proposals (keyword/Jaccard clustering, no ML), index diffs, and unambiguous reference repairs — bound to the current event-log head hash. Apply rejects a stale plan and any action not reproduced by a fresh trusted dry run, then publishes the approved actions as one atomic transaction.

```bash
node scripts/compiler.mjs ~/my-memory --out plan.json   # dry-run, changes nothing
node scripts/compiler.mjs ~/my-memory --apply plan.json # apply an approved, still-fresh plan
node scripts/forget.mjs ~/my-memory --id <stable-id> --reason "..."
```

## Concurrency-Safe Writes (`scripts/append.mjs`)

The instant more than one writer touches the same memory, naive "read file → rewrite file" loses data: two writers read the same version, both append, the second write clobbers the first. This is a **real** scenario — a NatureCo gateway runs 8 messaging channels (WhatsApp, Telegram, Signal, IRC, Mattermost, iMessage, SMS + terminal) all writing to one shared tree.

`append.mjs` makes a leaf-append atomic and serialized:

```bash
node scripts/append.mjs ~/my-memory root-2-technical.md "APIs" "**04.07.2026 — chose SQLite — ok**"
```

- **Lease lock, not a bare advisory mkdir.** A persistent lease-service process, reused across acquisitions for the caller's lifetime, acquires and renews each lock on its own timer — a busy writer's blocked event loop can't cause a false "stale lock" steal, and a genuinely crashed writer's lock still gets reclaimed safely (token-checked, so a former owner can never delete a successor's lock).
- **Writes go through the event log**, not a bare file rewrite — a new leaf gets a stable ID and is immediately visible in committed state, no separate import step.
- **Append-only** — inserts under the right `## branch` (replacing `_No entries yet._`), never overwrites sibling leaves.
- **Atomic write** — fsync + temp file + durable rename (platform-specific: directory fsync on Linux/macOS, `MoveFileEx` with `MOVEFILE_WRITE_THROUGH` on Windows), so a half-written file is never observable and a crash mid-write always recovers cleanly.

Verified in CI on Linux, macOS, and Windows: 6 concurrent writers → 6 leaves, zero loss, file integrity intact. Concurrent writers to different root files now serialize through the one event log — an intentional consequence of a single authoritative hash chain, not a regression; correctness (no lost leaf) is what's guaranteed, not parallel execution.

## Health Lint (`scripts/lint.mjs`)

A cross-platform command audits the failure modes that erode retrieval as the tree grows and exits non-zero on errors (CI/pre-commit guard):

```bash
node scripts/lint.mjs ~/my-memory
```

1. **Growth** — root with 9+ branches, branch with 50+ leaves → split signals
2. **Index bloat** — flags a `root-0-index` that stores leaves instead of mapping (it's read on every retrieval)
3. **bkz: references** — broken refs (points to a missing root) + over-deep chains
4. **Duplication** — near-identical leaves across the tree — the "same fact in 5 slightly-different places" drift

## Design Philosophy

1. **Structure over content** — 100 well-organized notes beat 1000 messy ones
2. **Single source of truth** — Every fact lives in exactly one place; other locations only reference it
3. **Age-appropriate layering** — Raw notes mature into categorized knowledge over time
4. **Retrieval speed first** — Design decisions prioritize how fast you can FIND information, not how much you can STORE

---

## Who Is This For?

- **AI agent developers** who want persistent memory across sessions
- **Teams** using AI coding assistants who need shared context
- **Solo developers** who want their AI to remember decisions and context
- **Tool builders** creating agentic systems that need structured memory

---

## License

MIT — use it, fork it, adapt it. Credit is appreciated but not required.

---

## Etymology

**Urðr** (Old Norse: *Urðr*, English: *Wyrd*) is one of the three Norns in Norse mythology who dwell at the root of Yggdrasil, the world tree. Urðr weaves the **past** — making her the perfect namesake for a memory system that archives decisions, lessons, and context.

Her sisters:
- **Verðandi** — the present (what is becoming)
- **Skuld** — the future (what shall be)

Together they water Yggdrasil's roots from the Well of Urðr, keeping the tree alive. 🌳

---

---

## More from NatureCo

- [**Cupertino Terminal**](https://github.com/natureco-official/cupertino-terminal) — A macOS-grade terminal for Windows, macOS and Linux — Rust core, no Electron, with a built-in end-to-end encrypted P2P remote shell
- [**NatureCo CLI**](https://github.com/natureco-official/natureco-cli) — A terminal-native AI assistant: chat, a coding agent, automation, and bots on Telegram, Discord and Slack
- [**CodeDNA**](https://github.com/natureco-official/codedna) — How much of a commit was written by AI, and does its author actually understand it?
- [**NatureCo SDK**](https://github.com/natureco-official/natureco-sdk) — JavaScript SDK for the NatureCo API — build AI chatbots and ship them anywhere
- [**Skuld**](https://github.com/natureco-official/natureco-skuld) — An agentic coding workspace that will not claim success it cannot prove — every change goes through a verification gate before it is reported as done
- [**Verðandi**](https://github.com/natureco-official/verdandi) — Task-context compiler for AI coding agents — indexes with the TypeScript AST so the agent stops burning tokens hunting for the right file

<sub>Part of the **NatureCo** ecosystem — [natureco.me](https://natureco.me) · NatureCo ekosisteminin parçası</sub>
