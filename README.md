# Urðr — Tree Memory for AI Agents

> **"The past is never dead. It's not even past."** — Faulkner

**Urðr** (pronounced *urth*) is an open-source **tree-structured memory architecture** designed for AI coding agents. Named after the Norse Norn of the past who dwells at the root of Yggdrasil, Urðr gives your AI agent a persistent, organized, and fast-retrieval memory system that survives across sessions.

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
git clone https://github.com/gencay/urdr.git
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
| **OpenClaw** | Symlink roots into your workspace: `ln -sf my-memory/root-1-topics.md MEMORY.md` |
| **NatureCo CLI** | Copy `integrations/natureco/plugin.yaml` into your NatureCo config |
| **Hermes** | Copy `integrations/hermes/skill.yaml` into your Hermes skills dir |
| **Other agent?** | Just point it to read the 4 `root-*.md` files at session start. See `AGENTS.md` |

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
│   ├── kók-0-indeks.md
│   ├── kók-1-konular.md
│   ├── kók-2-teknik.md
│   ├── kók-3-kararlar.md
│   └── agent-personality.md
│
├── protocols/              # Architecture & protocol docs
│   ├── architecture.md        # English
│   ├── mimari.md              # Türkçe
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
├── scripts/                # Utility scripts
│   ├── init.sh             # Initialize memory tree
│   ├── check-growth.sh     # Audit branch health
│   └── migrate.sh          # Restructure branches
│
└── examples/               # Practical use cases
    ├── basic-setup/
    ├── project-tracking/
    └── technical-reference/
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
| **Your agent?** | Just read the 4 `root-*.md` files → see `AGENTS.md` | 🛠 Any |

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
