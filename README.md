# Urðr — Tree Memory for AI Agents

[![CI](https://github.com/natureco-official/urdr/actions/workflows/ci.yml/badge.svg)](https://github.com/natureco-official/urdr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)]()
[![Tooling](https://img.shields.io/badge/tooling-LLM--free-brightgreen)]()

> **"The past is never dead. It's not even past."** — Faulkner

**Urðr** (pronounced *urth*) is an open-source **tree-structured memory architecture** designed for AI coding agents. Named after the Norse Norn of the past who dwells at the root of Yggdrasil, Urðr gives your AI agent a persistent, organized, and fast-retrieval memory system that survives across sessions.

---

> 🤖 **Are you an AI agent reading this?** Stop. Go read **[AGENTS.md](./AGENTS.md)** first — it has your direct instructions. Come back here after you've onboarded yourself. (Yes, this repo is designed for you to self-configure.)

---

## Why Urðr?

Every AI agent today has the same fundamental limitation: **no persistent memory between sessions**. Most agents start fresh each time, losing context, decisions, and lessons learned. The ones that do remember use flat files that quickly become unmanageable junk drawers.

Urðr solves this with a **tree-memory** approach — inspired by how humans organize knowledge into categories, not flat lists.

### What Makes Urðr Different?

| Feature | Other Approaches | Urðr |
|---------|-----------------|------|
| **Structure** | Flat files, vector DBs, or SQL | 4-root tree with branches & leaves |
| **Retrieval** | Full-file scan or semantic search | 4-step protocol (<300 tokens) |
| **Consistency** | Often duplicated/copied across files | Single primary source + `bkz:` refs |
| **Growth** | Unmanaged — becomes a junk drawer | Disciplined branch-splitting rules |
| **Cross-domain** | Handled ad-hoc | Formal cross-cutting protocol |
| **Agent integration** | Platform-specific only | OpenCode, Claude Code, NatureCo, Hermes, OpenClaw |

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
│   └── Each root has 5-9 branches (Miller's Law limit)
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

# Creates memory/ directory with 4 root files + personality
./scripts/init.sh --path ./my-memory --lang en
```

This creates:
```
my-memory/
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
| **Claude Code** | `cp integrations/claude-code/CLAUDE.md ./my-project/CLAUDE.md` |
| **OpenClaw** | Use `integrations/openclaw/README.md` to expose the index as `MEMORY.md` and keep domain roots under `memory/` |
| **NatureCo CLI** | Copy `integrations/natureco/plugin.yaml` into your NatureCo config |
| **Hermes** | Copy `integrations/hermes/skill.yaml` into your Hermes skills dir |
| **Codex CLI** | `codex mcp add urdr -- node scripts/mcp-server.mjs --root ./my-memory` |
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
│   ├── init.sh             # Initialize memory tree
│   ├── migrate.mjs         # Transactional branch/root restructuring
│   ├── search.mjs          # Last-resort branch-aware search (Node, LLM-free)
│   ├── bench.mjs           # Retrieval/fidelity benchmark (Node, LLM-free)
│   ├── append.mjs          # Concurrency-safe leaf writer (lock + atomic)
│   ├── lint.mjs            # Memory health audit (growth/refs/dup, CI guard)
│   ├── mcp-server.mjs      # MCP tools over a confined memory-tree root
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

Install the locked official MCP SDK dependency with `npm ci`, then configure the server with one
fixed filesystem root. Tool-call `memoryDir` values are relative to this root; absolute paths,
parent traversal, and symlinks that resolve outside it are rejected.

```bash
node scripts/mcp-server.mjs --root ./my-memory
```

The server exposes exactly five tool families: `search`, `append`, `lint`, `compiler` (dry-run or
apply), and `forgetting` (explicit permanent forget or interrupted-scrub resume). Compiler apply
keeps the committed tree-state staleness check. Forgetting is marked and described as a
consequential user-triggered erasure action. The package is intentionally not published; use the
checkout directly or install a locally produced `npm pack` tarball.

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

Urðr ships a **last-resort search** that closes this gap without touching the architecture's elegance:

```bash
# When the 4-step protocol comes up empty, scan everything (branch-aware):
node scripts/search.mjs "sqlite" ./my-memory
# → root-2-technical.md › ## APIs › **04.07.2026 — chose SQLite for local storage**
```

- **LLM-free** — pure keyword/regex scan; zero token cost, ~0.2–0.6 ms/query.
- **Cross-platform** — pure Node.js. No `grep`/`rg`/`awk` dependency (those don't exist on stock Windows). `ripgrep` is used only as an optional accelerator on very large trees.
- **Branch-aware** — every hit reports `file › ## branch › leaf`, so the agent still gets structured context.
- **Composable** — exits `0` on hit / `1` on miss (grep convention), or `--json` for programmatic use.

This makes retrieval a *guarantee*, not a *guess*: hierarchy first, full scan as the net beneath it.

## Benchmark (`scripts/bench.mjs`)

"Unlimited memory" is a claim until you measure it. `bench.mjs` builds a synthetic tree with a controllable share of **ambiguous** leaves (filed under one root, but naturally queried as another — the exact case where category-guessing fails) and reports real numbers:

```bash
node scripts/bench.mjs --leaves 300 --ambiguity 0.3
```

```
  Write fidelity (stored == intended): 100.0%  ✓
  recall@1, hierarchy-only        : 73.3%   ← fails on wrong-root guesses
  recall@1, hierarchy + fallback  : 100.0%  ← safety net
  rescued by fallback             : 80 leaves (26.7%)
  avg retrieval latency           : 0.2 ms/query (CPU, no LLM call)
  → Fallback lifted recall from 73.3% to 100.0% with zero LLM cost.
```

Identical results on macOS, Windows, and Linux (deterministic seed). Use it to prove the architecture works at volume — and to catch the growth bottleneck *before* production, not months later when users ask "why doesn't it remember?"

## Concurrency-Safe Writes (`scripts/append.mjs`)

The instant more than one writer touches the same memory, naive "read file → rewrite file" loses data: two writers read the same version, both append, the second write clobbers the first. This is a **real** scenario — a NatureCo gateway runs 8 messaging channels (WhatsApp, Telegram, Signal, IRC, Mattermost, iMessage, SMS + terminal) all writing to one shared tree.

`append.mjs` makes a leaf-append atomic and serialized:

```bash
node scripts/append.mjs ./my-memory root-2-technical.md "APIs" "**04.07.2026 — chose SQLite — ok**"
```

- **Advisory lock** via atomic `mkdir` (the one primitive guaranteed atomic on every OS/filesystem); stale locks (crashed writer) are auto-stolen after 30 s.
- **Append-only** — inserts under the right `## branch` (replacing `_No entries yet._`), never overwrites sibling leaves.
- **Atomic write** — temp file + `rename`, so a half-written file is never observable.

Verified: 15 concurrent writers → 15 leaves, zero loss, file integrity intact (macOS + Windows).

## Health Lint (`scripts/lint.mjs`)

A cross-platform command audits the failure modes that erode retrieval as the tree grows and exits non-zero on errors (CI/pre-commit guard):

```bash
node scripts/lint.mjs ./my-memory
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

<sub>Part of the **NatureCo** ecosystem — [natureco.me](https://natureco.me) · NatureCo ekosisteminin parçası</sub>
