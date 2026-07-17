# Urðr Memory Architecture

> **Purpose:** This document defines the tree-structured memory architecture that makes Urðr unique. It covers philosophy, layers, branch types, insertion/retrieval/maintenance protocols, and constraints.
>
> **Scope:** Any AI agent or human using Urðr should read this to understand how the memory system works.

---

## 0. Context & Rationale

A memory system is not "information storage." It is **"fast information retrieval."** The value of an AI agent's memory is not how much it remembers — it's how quickly and accurately it can find the right information when needed.

Flat files / single-document lists degrade into **junk drawers** over time. A tree structure provides bounded hierarchical routing that usually reduces how much memory must be read: choose root → branch → leaf, then use the full-tree hybrid fallback scan when that routing guess is wrong.

**Why this document exists:** A consistent memory architecture ensures cross-session continuity, persistent personalization, and fast recall. Without architecture, an agent becomes "a being that starts from zero every session, forgetting context."

---

## 1. Architectural Philosophy — 3 Core Principles

1. **Structure over content.** 100 well-organized notes are more valuable than 1000 messy ones. Organization is the prerequisite for recall.
2. **Single primary source.** The same information does not live in two places. One location holds the truth; others carry only references. This ensures update consistency.
3. **Age-appropriate layering.** Raw session notes → distilled into roots → categorized into branches. Information "matures" over time, settling into its proper place.

---

## 2. Tree Structure — 3 Layers

```
🌳 Urðr Memory Tree (Entire System)
│
├── 🌱 ROOTS — fixed, stable core files (4 files)
│   ├── root-0  →  Index (routing, minimal text)
│   ├── root-1  →  Domain A — Topics (broad scope)
│   ├── root-2  →  Domain B — Technical (medium scope)
│   └── root-3  →  Domain C — Decisions (narrow/relational scope)
│
├── 🌿 BRANCHES — `##` categories within each root
│   ├── root-1 → branch A1, branch A2, branch A3, ...
│   ├── root-2 → branch B1, branch B2, branch B3, branch B4, ...
│   └── root-3 → branch C1, branch C2, branch C3, ...
│
└── 🍃 LEAVES — concrete information items under branches
    ├── branch A1 → leaf-1, leaf-2, leaf-3, ...
    └── branch B2 → leaf-1, leaf-2, ...
```

**Roots:** Core files. Typically **4** (1 index + 3 domain roots). Stable skeleton.

**Branches:** `##` Markdown headings inside roots. Topic-separated. Frequently forked, rarely deleted.

**Leaves:** Specific information under branches — dated events, names, notes, decisions, rules.

---

## 3. Why 4 Roots? (The Decomposition Model)

**3-roots + 1 index = 4 roots** is an empirically balanced structure:

- **Root-0 (index):** Routing only. Answers "which root handles this topic?" Minimal text, maximal links.
- **Root-1 (topics):** Frequently used, often updated, broad-scope information. People, projects, organizations.
- **Root-2 (technical):** Technical/system/operational information. Installs, services, processes, APIs.
- **Root-3 (decisions):** Decisions, constraints, relational notes, patterns, lessons learned.

**Root growth rule:** When a root accumulates **9+ branches**, create a new root file. Keeping branches per file in the **5-9 range** is a practical routing heuristic inspired by working-memory research such as Miller's Law, not a strict scientific limit.

**Practical root limit:** 4-6 roots. More than 6 makes cross-root coordination difficult — "which root do I check?" becomes a real question.

---

## 4. Branch Types — Generic Patterns

Each root is organized into `##` Markdown headings (branches). **Generic types** from which all branches are derived:

| Branch Type | Opening Signal | Content Property |
|-------------|----------------|------------------|
| **Operational process** | Recurring or scheduled work | Periodic, cron-like |
| **Setup reference** | One-time configuration | Static, long-lived |
| **Technical reference** | Reusable technical notes | API, commands, patterns |
| **Constraint & rule** | Non-negotiable decisions | Short, absolute |
| **Behavior/communication pattern** | Recurring interpersonal patterns | Learned social/cue notes |
| **Project-specific** | Persistent project info | Project scope, doesn't cross boundaries |
| **Learned lesson** | Reusable error/success pattern | Cause + fix + learning |
| **Decision record** | Justified choices | Date + alternative + rationale |
| **Dated event** | Historical information with reference value | Past, non-deletable |

**Branch creation decision tree:**

```
New information arrives
  ↓
1) Fits an existing branch?           → Yes → add to that branch
  ↓ No
2) Fits but branch is overgrown?      → Yes → add sub-heading or split
  ↓ No
3) Doesn't fit anywhere?              → Yes → create new branch (correct root)
  ↓
4) Root has 9+ branches now?          → Yes → create new root
```

---

## 5. Information Placement Rules

### 5.1 Single Primary Rule

Every piece of information lives in **one primary** location. If it appears elsewhere, it's only a reference:

```
> See also: <root> / <branch>
```

**Purpose:** When information is updated, it changes at **one point** and the entire system reflects it. Drift is prevented.

### 5.2 Dating Rule

- Dates are written as **inline markers**, not headings.
- Event format: `**DD.MM.YYYY — Event — Outcome**`
- Old information is normally retained. A user-triggered forgetting request is the explicit
  exception described under "Forgetting boundary" below.

### 5.3 Insertion Rule

- New information goes **under the relevant branch**, not at the bottom of the file.
- This prevents the bottom of each file from becoming a junk zone.
- If a new branch is needed, add it with `##` in the correct root.

### 5.4 Sensitive Information

- Credentials, API keys, tokens → **never** written to memory in plain text. Use a vault.
- Personal data → isolated scope, separated from main system.
- Learned personal patterns → stored only with explicit permission.

---

## 6. Fast Retrieval Protocol (4 Steps)

When a new question arrives:

```
1. IDENTIFY THE SUBJECT
   ↓ (extract keywords)
2. SELECT THE ROOT
   ↓ (which domain covers this?)
3. PICK THE BRANCH
   ↓ (scan ## headings in root)
4. READ THE LEAF
   ↓ (specific note / detail)
```

**Performance target:** These 4 steps should consume **less than 300 tokens** to reach an answer. The goal is to produce answers without reading the entire memory from scratch.

**Search tools:**
- **Direct read** (`read <path>`) — when root+branch path is known
- **Fallback search** (`node scripts/search.mjs "<keyword>" <memory-dir>`) — when the hierarchy comes up empty
- **Semantic search** — fuzzy match by topic (if available)

**Principle:** Locate with 1-2 tool calls before reading. Don't guess — verify.

---

## 7. Memory Maintenance

### 7.1 When to Update

- New persistent decision made (hard-to-rollback choices)
- New permanent rule established (non-negotiable quality)
- Repeated error finally root-caused
- New project / system / client opened
- Important lesson extracted (post root-cause analysis)

### 7.2 When NOT to Update

- One-off session details (session context only)
- Unconfirmed hypotheses
- Very short-lived states (hourly, temporary URLs, transient flags)

### 7.3 Growth Signals

| Signal | Action |
|--------|--------|
| A root reaches 9+ branches | **Create new root** or add virtual sub-grouping |
| A branch reaches 50+ leaves | **Split into sub-groups** (e.g., branch-A → branch-A.1, branch-A.2) |
| Same info found in 3+ places | **Cross-ref rule broken** — fix urgently |

---

## 8. Limitations & Pitfalls

- **Memory is not a brain.** It's just an indexer. Active searching and reading are still required — the file is a passive store, the agent is the active retriever.
- **Branches must stay logical.** A "Misc" or "Other" branch → scope creep signal. Split or delete immediately.
- **Cross-reference discipline must not relax.** One primary only. Otherwise the system degrades into inconsistency.
- **"Save everything" trap.** Only save information that will be **needed again**. Most session events aren't worth recording.
- **Stale data problem.** Very old information loses relevance. Periodic summarization is needed (weekly audit).

### Event-log and publication boundaries

- **Legacy-reader publication atomicity.** Event-log-aware readers follow the generation pointer
  and observe a multi-root transaction atomically. Readers that open `root-*.md` directly receive
  only per-file atomic replacement; they can briefly observe a mixed generation while multiple
  files are materialized. A direct edit arriving during that publish window is unsupported.
- **Forgetting boundary.** `scripts/forget.mjs` writes a `leaf.forget` tombstone, removes the leaf
  from current and all future committed state/views, and scrubs its bytes from obsolete managed
  generations, recovery files, temporary files, and exports registered by `exportMarkdown()`.
  Artifact retention limits can additionally remove old generations and expired recovery copies.
  Search telemetry needs no content redaction: it stores aggregate outcome counters only and its
  API does not accept query text, result text, or leaf IDs.
- **The append-only ledger is not physically redacted.** The original creation event remains in
  `.urdr/events.jsonl`. Each record's `prevHash` commits to the exact preceding record, so changing
  an old event in place would invalidate every later hash. Supporting redactable history would
  require a different ledger design (for example, independently redactable Merkle leaves) and is
  outside this architecture. True erasure of historical log bytes is therefore a manual,
  out-of-band raw-file operation that necessarily abandons or rebuilds the existing audit chain.
  Forgetting guarantees erasure from live materialized artifacts, current state, and all future
  state—not from historical ledger records.
- **Export scope.** Exports made through `exportMarkdown()` are registered and scrubbed. Copies
  made by unrelated tools or moved beyond their registered path cannot be discovered reliably and
  must be erased by the operator.

### Optional provenance and compiler approval

Leaves may carry optional `creator`, `timestamp`, `source`, `confidence`, `verification_state`,
`verifier`, and `validity_interval` fields. Existing leaves require no migration. These fields are
additive keys on the version-1 `leaf.upsert` payload, and `leaf.provenance` is a narrow metadata-only
operation, so `EVENT_SCHEMA_VERSION` remains 1; older readers already ignore operation types and
keys they do not understand. The canonical serialization and hash-chain algorithm are unchanged.

The memory compiler defaults to dry-run. It emits deterministic branch-split evidence, index
diffs, and unambiguous stable-ID reference repairs. Each plan is bound to the committed event-log
head; `--apply` rejects the plan if any transaction committed after it was generated or if any
submitted action is not reproduced by a fresh trusted dry run. Applicable actions are published
through one normal transaction only after the plan is explicitly applied.

---

## 9. Hard Error Protocol

When something goes wrong:

1. **Agent can't find information** → run `scripts/search.mjs` across the memory tree, check root-0 index
2. **Information contradicts itself** → identify the primary source, deprecate the duplicate
3. **Branch is too large to navigate** → run growth audit, split
4. **Wrong root selected** → move entry, leave `bkz:` reference at old location

See `hard-error-protocol.md` for detailed error recovery procedures.

---

## 10. Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                  URDR MEMORY REFERENCE                        │
├─────────────────────────────────────────────────────────────┤
│ Layers:                                                      │
│   🌱 Roots (4 stable files, rarely change)                  │
│      ↓                                                     │
│   🌿 Branches (## categories within roots)                  │
│      ↓                                                     │
│   🍃 Leaves (specific, dated information)                   │
│                                                             │
│ Insertion:                                                   │
│   1. Information arrives                                     │
│   2. Select root (which domain?)                            │
│   3. Select branch (fits? → add) (no? → create)             │
│   4. Write as leaf (under correct branch)                    │
│                                                             │
│ Retrieval (4 steps, <300 tokens):                           │
│   1. Identify subject                                        │
│   2. Select root                                            │
│   3. Pick branch                                            │
│   4. Read leaf                                              │
│                                                             │
│ Cross-reference:                                             │
│   Single primary → "bkz: <root>/<branch>" elsewhere         │
│                                                             │
│ Old information:                                             │
│   Never delete → keep in place or move to "historical"      │
│                                                             │
│ Growth:                                                      │
│   Root 9+ branches → new root                               │
│   Branch 50+ leaves → split (sub-groups)                    │
│   Info in 3+ places → cross-ref broken, fix                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. Closing Note

This architecture is not a static document — it's **a living system**. As each agent adds roots, grows branches, and produces leaves, it evolves. But the core principle stays:

> **Structure is the prerequisite of findability. Disorganization is the fastest route to forgetting.**

Urðr remembers — so you don't have to. 🌳
