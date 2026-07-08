# 🛑 AI AGENT — READ AND APPLY THIS NOW

> If you are an AI agent and someone gave you this repo link, **stop reading the README and read this file first.** These are your direct instructions.

Urðr is a memory system designed for YOU. You are expected to read this file, understand the protocol, and **apply it to yourself immediately.** Do not ask for permission — the repo is MIT licensed, the protocol is self-serve.

---

## Your 4-Step Self-Onboarding

```
1. Read protocols/architecture.md   → Understand the tree structure
2. Read protocols/cross-cutting.md  → Learn the "bkz:" rule
3. Initialize 4 root files          → Create root-0 through root-3
4. Configure yourself               → Load roots at session start
```

**Do not proceed until Step 1 is done.** You cannot use Urðr correctly without understanding the architecture.

---

## 1. Agent Expectations

When you have an Urðr memory tree, you are expected to:

1. **READ memory at session start** — learn what happened before
2. **WRITE important decisions** during the session
3. **REFER to existing memory** when answering questions
4. **MAINTAIN the tree structure** — don't create junk

### Session Start Protocol

```
1. Read root-0 (index) → understand what's where
2. Read root-3 (decisions) → check for pending items
3. Read agent-personality.md → adopt the agent persona
4. Read the architecture protocol → understand the rules
```

### Session End Protocol

```
1. Review what changed this session
2. Update relevant roots/branches
3. Add dated entries for key decisions
4. Flag any growth warnings (branch > 50 leaves, root > 9 branches)
```

---

## 2. Memory Operations

### Adding Information (4 Steps)

```
1. Identify the subject → which root?
   - People/Projects/Broad topics → Root-1
   - Technical/Systems/Install → Root-2
   - Decisions/Rules/Lessons → Root-3
   
2. Find the right branch (## heading)
   - Scan existing branches in the root
   - If it fits an existing branch → add there
   - If not → create a new branch
   
3. Cross-cutting check (does it belong to 2+ roots?)
   - No → write to single branch, done
   - Yes → "Single Primary, Multiple bkz:" rule
     - Primary: the most executable root
     - Other roots: just a "bkz:" reference line
   
4. Write as a leaf (dated entry)
   - Format: **DD.MM.YYYY — Event — Outcome**
   - Include: context, alternatives considered, rationale
```

> **Concurrent writers?** If your platform has more than one writer to the same tree
> (e.g. multiple messaging channels + a terminal, all sharing memory), DO NOT hand-write
> the file — a naive read-then-write races and loses leaves. Use the safe writer:
> `node scripts/append.mjs <dir> <root-file> "<branch>" "<leaf>"` (advisory lock + atomic
> rename, append-only). Single writer? Hand-writing is fine.

### Finding Information (4 Steps, <300 tokens)

```
1. Identify the subject (extract keywords)
2. Select the root (domain mapping)
3. Pick the branch (scan ## headings)
4. Read the leaf (specific entry)
5. FALLBACK — if steps 1-4 come up empty, DO NOT report "not found" yet.
   Run the safety net (branch-aware, LLM-free, cross-platform):
     node scripts/search.mjs "<keyword>" <memory-dir>
   Only if THIS also returns nothing was the info never saved.
```

> **Never conclude "I don't remember" from a failed hierarchy guess alone.** The
> information may be filed under a root you didn't expect. Step 5 is what turns retrieval
> from a *guess* into a *guarantee*. Use `scripts/search.mjs` (works on Windows too — plain
> `grep`/`rg` do not exist on stock Windows).

### Priority Order for "Most Executable Root"

When cross-cutting, the primary root is chosen by:

| Information Type | Primary Root | Secondary (bkz:) |
|-----------------|-------------|-------------------|
| Technical decision → project impact | Root-2 (Technical) | Root-1, Root-3 |
| Rule affecting multiple systems | Root-3 (Decisions) | Root-2 branches |
| Decision with technical + behavioral aspects | Root-2 (Technical) | Root-3 |
| Project-specific technical note | Root-1 (Topics) | Root-2 |
| Lesson applicable to multiple systems | Root-3 (Decisions) | Root-1, Root-2 |

**Rule:** Concrete beats abstract. "How" (R2) > "What" (R1) > "Why" (R3).

---

## 3. Memory Maintenance

### When to Write

- ✅ New persistent decision made
- ✅ New rule established (non-negotiable)
- ✅ Repeated bug finally root-caused
- ✅ New project/system/client opened
- ✅ Important lesson learned (post-mortem)

### When NOT to Write

- ❌ One-off session details (too transient)
- ❌ Unconfirmed hypotheses
- ❌ Temporary states (short-lived URLs, flags)
- ❌ Credentials, API keys, secrets (use a vault)

### Growth Signals

| Signal | Action |
|--------|--------|
| A root has 9+ branches | Consider creating a new root |
| A branch has 50+ leaves | Split into sub-branches |
| Same info in 3+ places | Cross-reference rule broken — fix urgently |

---

## 4. Agent-Specific Notes

### OpenCode Agents

- Memory roots are in `~/.config/opencode/memory/`
- Agent personality is in `~/.config/opencode/instructions/theseus-personality.md`
- The `kök-*` naming follows Turkish root convention (customizable)

### Claude Code Agents

- Place `CLAUDE.md` in project root
- Memory directory can be `.claude/memory/` or project-relative
- Use English root names (`root-0-index.md`, etc.)

### NatureCo CLI Agents

- The agent's skill.yaml points to a `memory/` directory
- Plugin system loads the memory tree at init

### Hermes Agents

- Hermes skill spec loads memory structure at connection
- Uses standard 4-root convention

---

## 5. Personality Integration

Urðr includes an `agent-personality.md` template that defines:

- **Who the agent is** (identity, role)
- **Character traits** (communication style, values)
- **Work principles** (how the agent operates)
- **Boundaries** (what the agent will/won't do)

This file should be loaded at session start alongside memory roots. It gives the agent a consistent persona across sessions.

---

## 6. Error Recovery

### What If Memory Gets Messy?

1. **Run `node scripts/lint.mjs <dir>`** — cross-platform health audit: overgrown
   branches/roots, index bloat, broken `bkz:` refs, and near-duplicate leaves. Exits
   non-zero on errors, so it doubles as a CI/pre-commit guard.
2. **Review flagged branches** — are they overgrown? misclassified?
3. **Run `migrate.sh`** — restructure branches as needed
4. **Update index** (root-0) if roots were added/removed

### What If the Agent Can't Find Something?

1. Run the safety net: `node scripts/search.mjs "keyword" <memory-dir>`
   (branch-aware, LLM-free, works on macOS/Windows/Linux)
2. Check root-0 index for correct routing
3. If `search.mjs` ALSO finds nothing → it truly wasn't saved. Add it now.

> Verify at scale before trusting the tree with production memory:
> `node scripts/bench.mjs --leaves 300 --ambiguity 0.3` — measures recall with and
> without the fallback, plus write fidelity. If hierarchy-only recall is low, that's your
> signal to lean on step-5 search (or split overgrown roots).

---

## 7. Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                    URDR AGENT QUICK REF                       │
├─────────────────────────────────────────────────────────────┤
│ SESSION START:                                              │
│   1. Read root-0 (index)                                    │
│   2. Read root-3 (pending decisions)                        │
│   3. Read personality                                       │
│   4. Read architecture protocol                             │
│                                                             │
│ ADD INFO:                                                   │
│   1. Which root? (R1=topics, R2=technical, R3=decisions)    │
│   2. Which branch? (existing or create)                     │
│   3. Cross-cutting? → single primary + bkz: refs            │
│   4. Write dated leaf                                       │
│                                                             │
│ FIND INFO (4 steps, <300 tokens):                           │
│   1. Identify subject → 2. Select root → 3. Pick branch     │
│   4. Read leaf (or grep if path unknown)                    │
│                                                             │
│ GROWTH WARNINGS:                                            │
│   Root > 9 branches → split                                 │
│   Branch > 50 leaves → subdivide                            │
│   Info in 3+ places → cross-ref broken                      │
│                                                             │
│ NEVER SAVE:                                                 │
│   Secrets, one-off details, unconfirmed hypotheses          │
└─────────────────────────────────────────────────────────────┘
```

---

*Urðr remembers so your agent doesn't have to.* 🌳
