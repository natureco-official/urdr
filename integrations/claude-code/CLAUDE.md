# CLAUDE.md — Urðr Memory for Claude Code

> This file configures Claude Code to use the Urðr tree-structured memory system.
> Place this file in your project root to enable persistent memory across Claude Code sessions.

---

## Memory Structure

This project uses **Urðr**, a tree-structured memory system with 4 roots:

| Root | File | Contents |
|------|------|----------|
| Root-0 | `~/my-memory/root-0-index.md` | Index & routing |
| Root-1 | `~/my-memory/root-1-topics.md` | People, projects, subjects |
| Root-2 | `~/my-memory/root-2-technical.md` | Systems, APIs, technical |
| Root-3 | `~/my-memory/root-3-decisions.md` | ADRs, constraints, lessons |

---

## Session Protocol

### At Session Start

1. Read `~/my-memory/root-0-index.md` — understand the map
2. Read `~/my-memory/root-3-decisions.md` → `## Pending` branch — check what needs attention
3. Read `~/my-memory/agent-personality.md` — adopt the agent persona

### When Learning New Information

Ask yourself: **which root?**

- Is this about a person, project, or topic? → **Root-1**
- Is this technical (system, API, language)? → **Root-2**
- Is this a decision, rule, or lesson? → **Root-3**

### When Answering Questions

Follow the 4-step retrieval:
1. Identify the subject
2. Select the root
3. Pick the branch (## heading)
4. Read the leaf (specific entry)

**Target:** <300 tokens to find the answer.

---

## Writing Conventions

### Date Format
All entries use: `**DD.MM.YYYY — Title — Details**`

### Cross-References
When information belongs to multiple roots:
- Write full content in ONE primary root (most concrete)
- Add `bkz: <root>/<branch>` line in other roots
- Never duplicate content

### Entries to ALWAYS Write
- Project decisions with rationale
- Technical setup notes (install steps, configs)
- Bug root causes and fixes
- Recurring patterns and lessons

### Entries to NEVER Write
- Credentials, API keys, tokens (use vault)
- One-off session details
- Unconfirmed hypotheses

---

## Branch Growth Rules

| Threshold | Action |
|-----------|--------|
| Branch reaches 30 leaves | Review for split |
| Branch reaches 50 leaves | Must split into sub-branches |
| Root reaches 9+ branches | Consider creating new root file |

---

## Maintenance

```bash
# Run these commands from the Urðr checkout
node ./scripts/lint.mjs ~/my-memory

# Init memory outside the Urðr checkout
./scripts/init.sh --path ~/my-memory --lang en

# Inspect transactional restructuring operations
node ./scripts/migrate.mjs --help
```

---

## Quick Reference

```
ADD INFO:    Which root? (R1=topic, R2=technical, R3=decision)
             → Which branch? → Write dated leaf
             → Cross-cutting? → Primary + bkz: refs

FIND INFO:   Subject → Root → Branch → Leaf (<300 tokens)

FIX ERRORS:  Data loss? → git restore
             Contradiction? → find primary, reconcile
             Misplaced? → move + leave bkz: bridge
```

---

*This CLAUDE.md configures Claude Code for the Urðr memory system.*
*See protocols/architecture.md for the full specification.* 🌳
