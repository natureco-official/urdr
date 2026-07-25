# CLAUDE.md — Urðr Memory for Claude Code

> Give this file to Claude Code and it can set itself up. The steps below were followed
> end to end on a real machine (Windows 11, Claude Code CLI), including the parts that fail
> if you type them the obvious way.

---

## Part 1 — Setup (do this once)

### Step 1: Install the MCP server

```bash
npm install -g urdr-mcp-server
```

Note the install path — you need it in step 3:

- macOS / Linux: `$(npm root -g)/urdr-mcp-server/scripts/mcp-server.mjs`
- Windows: `%APPDATA%\npm\node_modules\urdr-mcp-server\scripts\mcp-server.mjs`

### Step 2: Create the memory tree

```bash
git clone https://github.com/natureco-official/urdr.git
cd urdr
./scripts/init.sh --path ~/urdr-memory --lang en --agent-name Claude --user-name YOUR_NAME
```

`--lang tr` gives Turkish root names (`kök-0-indeks.md` …). Pick one; mixing is not supported.

**On Windows without a bash shell**, `init.sh` will not run. Copy the templates instead:

```powershell
mkdir $HOME\urdr-memory
copy templates\root-*.md            $HOME\urdr-memory\
copy templates\agent-personality.md $HOME\urdr-memory\
mkdir $HOME\urdr-memory\protocols
copy protocols\*.md                 $HOME\urdr-memory\protocols\
```

### Step 3: Register the MCP server with Claude Code

```bash
claude mcp add urdr --scope user -- node "<path-from-step-1>" --root "<your-tree>"
```

Real example (Windows — forward slashes work and avoid escaping pain):

```bash
claude mcp add urdr --scope user -- node \
  "C:/Users/you/AppData/Roaming/npm/node_modules/urdr-mcp-server/scripts/mcp-server.mjs" \
  --root "C:/Users/you/urdr-memory"
```

Verify:

```bash
claude mcp list        # expect: urdr: node ... - ✔ Connected
```

**Two things that will bite you:**

- `claude mcp add urdr -- npx -y urdr-mcp-server …` **fails** with `error: unknown option '-y'`.
  Claude's own argument parser consumes `-y` before `npx` ever sees it. Install globally and
  point at the `.mjs` file instead — that is why step 1 exists.
- `claude mcp add-json` with a quoted JSON blob **fails in PowerShell** (`Invalid configuration`)
  because the quotes are mangled before Claude sees them. Use the `--` form above, from bash.

### Step 4: Make Claude load it automatically ← the step people miss

Registering the MCP server gives Claude the *tools*. It does not make Claude *read* the memory
at session start. Claude Code's own memory index is what loads automatically, so point it at
the tree and keep nothing else in it.

Replace the contents of `~/.claude/projects/<project-slug>/memory/MEMORY.md` with:

```markdown
# Memory → Urðr

My memory is not in this folder. **Single source: `~/urdr-memory`** (Urðr memory tree).

**At session start:**
1. Read `~/urdr-memory/root-0-index.md` — the routing map.
2. Read `root-3-decisions.md` → `## Pending` — unfinished work.

| Root | File | Contents |
|---|---|---|
| Root-0 | `root-0-index.md` | Index, routing |
| Root-1 | `root-1-topics.md` | People, projects, subjects |
| Root-2 | `root-2-technical.md` | Systems, tools, setup, gotchas |
| Root-3 | `root-3-decisions.md` | Decisions, rules, lessons, pending |

**Search** with `urdr_search` (folds Turkish İ/i correctly). **Write** with `urdr_append`
(skips near-duplicates, warns on contradictions). Run `urdr_lint` occasionally.

New info: person/project → Root-1 · technical/how → Root-2 · decision/rule/lesson → Root-3.

> Never write content into this file. It holds the pointer only; knowledge goes into Urðr.
```

### Step 5: Migrating memories you already have

Don't delete anything. Copy the old files into the tree, then summarise:

```bash
mkdir -p ~/urdr-memory/archive
cp ~/.claude/projects/<slug>/memory/*.md ~/urdr-memory/archive/
rm ~/urdr-memory/archive/MEMORY.md
```

Then write one short leaf per archived file into the right root, ending with
`→ archive/<file>.md`. Roots stay small and readable; depth lives in `archive/` and is read
only when needed.

This is what fixes the real problem: a single memory file that grows past the context limit
gets **silently truncated**, and the rules inside it disappear without anyone noticing.

### Step 6: Verify it actually works

```bash
node scripts/search.mjs "some term" ~/urdr-memory
node scripts/lint.mjs ~/urdr-memory
```

Both also accept `--root <dir>` if you prefer the same flag the MCP server uses.

Expected search output — file, branch and leaf, so you can see the path to the answer:

```
root-1-topics.md › ## Products › - **Cupertino Terminal** — …
```

Turkish check: `İŞLER` and `isler` must return the same results. If they don't, you are not
running the folding search.

---

## Part 2 — Session protocol (how Claude uses it)

### At session start

1. Read `~/urdr-memory/root-0-index.md` — understand the map.
2. Read `root-3-decisions.md` → `## Pending` — check what needs attention.
3. Read `agent-personality.md` — adopt the agent persona.

### When learning new information

Ask: **which root?**

- A person, project, or topic? → **Root-1**
- Technical (system, API, install, gotcha)? → **Root-2**
- A decision, rule, or lesson? → **Root-3**

Write with `urdr_append` rather than editing files by hand — it de-duplicates and flags
contradictions instead of quietly stacking near-identical leaves.

### When answering questions

1. Identify the subject
2. Select the root
3. Pick the branch (`##` heading)
4. Read the leaf

**Target:** <300 tokens to find the answer.

---

## Writing Conventions

### Date Format
All entries use: `**DD.MM.YYYY — Title — Details**`

### Cross-References
When information belongs to multiple roots:
- Write full content in ONE primary root (most concrete)
- Add `see: <root>/<branch>` in the others
- Never duplicate content

### Entries to ALWAYS Write
- Project decisions with rationale
- Technical setup notes (install steps, configs)
- Bug root causes and fixes
- Recurring patterns and lessons

### Entries to NEVER Write
- Credentials, API keys, tokens
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
node ./scripts/lint.mjs ~/urdr-memory          # duplicates, contradictions, growth
node ./scripts/migrate.mjs --help              # transactional restructuring
./scripts/init.sh --path ~/other-tree --lang tr
```

---

## Quick Reference

```
ADD INFO:    Which root? (R1=topic, R2=technical, R3=decision)
             → Which branch? → Write dated leaf
             → Cross-cutting? → Primary + see: refs

FIND INFO:   Subject → Root → Branch → Leaf (<300 tokens)

FIX ERRORS:  Data loss? → git restore
             Contradiction? → find primary, reconcile
             Misplaced? → move + leave a see: bridge
```

---

*This CLAUDE.md configures Claude Code for the Urðr memory system.*
*See protocols/architecture.md for the full specification.* 🌳
