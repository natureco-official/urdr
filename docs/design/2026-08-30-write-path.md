# Write Path — Design (v1.4)

**Status:** draft — the measurement below reshaped the original idea
**Prior art:** Context Pack (read path), Context Tax layer (session-long reads)

## The problem

Writing a leaf today costs more than the append itself:

1. **Orientation** — the agent must know exact root files and branch names.
   Guessing is common and fails loudly: in the sessions that built v1.1–v1.3,
   the agent hit `branch not found` twice ("Active Constraints" vs the real
   "Constraints (Kırmızı Çizgiler)", "Systems" vs "Systems & Stack"), and each
   failure cost a grep/read/retry cycle — hundreds of tokens per miss, plus
   the context-tax multiplier on everything brought in to recover.
2. **Duplicates** — nothing warns the agent that a near-identical leaf
   already exists; the lint finds it only after the fact.
3. **Format drift** — each branch has a leaf format (dates, `edge:`/`bkz:`
   syntax) documented in template comments the agent never sees at write time.

## The measurement that changed the design

The original proposal was a **deterministic branch resolver**: score the
draft text against every branch, auto-pick the destination. We prototyped it
(stem-normalized IDF overlap, six scoring variants) and evaluated it honestly
— leave-one-out over a real 111-leaf / 23-branch production tree: every leaf
removed, then asked "where does this belong?".

| Variant | top-1 | top-3 |
|---|---|---|
| raw IDF overlap | 22.9% | 41.3% |
| + branch-size prior | 20.2% | 42.2% |
| stem(5) + raw | **23.9%** | **46.8%** |
| stem(5) + size prior | 23.9% | 45.9% |
| stem(5) + sqrt-vocab norm | 18.3% | 42.2% |
| stem(5) + probe norm | 19.3% | 43.1% |

Best shortlist recall: top-5 = 56.9%. Root-file accuracy: top-1 37.6%.

**Why it fails:** the destination is determined by leaf *type* × topic, not
topic alone. A decision about project X shares its vocabulary with the
project's topic branch, but belongs in the decision log. Bag-of-words sees
the topic; the type is invisible to it.

**Design consequence (the honest one):** a resolver that misfiles 3 of 4
leaves must not write, and a shortlist that misses the true branch 43% of
the time is worse than the full branch list — which, on trees of this size,
costs ~200 tokens anyway. Meanwhile there is already an intelligence in the
loop that sees the draft and classifies type effortlessly: **the agent
itself**. Urðr's job is not to out-think it with worse tools; it is to hand
it exact, budget-capped facts so its decision is cheap and its append never
bounces.

## Components (v1.4)

### 1. `urdr_write_context(draftText)` — the surgical pre-write brief

One call, ~250–350 tokens, deterministic, replaces map + root-file reads +
trial-and-error:

- **Exact destination inventory** — every root file with its purpose line
  (from the template header) and its branch names *verbatim* (the #1 failure
  killer: no more guessed branch names).
- **Near-duplicate warnings** — trigram similarity of the draft against
  existing leaves (reusing the lint's duplication machinery); each warning
  carries the existing leaf id so the agent can extend instead of duplicate.
- **Format hint** — the target-root leaf format from template comments
  (`<!-- Format: ... -->`), plus `edge:`/`bkz:` syntax reminder.
- **Advisory ranking** — the lexical scorer's top candidates, explicitly
  labeled advisory with their evidence words, never a decision. (Measured
  accuracy above ships in the tool description; on large trees it narrows
  attention, on small trees it is ignorable.)
- **Receipt contract** — what `urdr_append` returns, so the agent plans a
  one-call write.

Flows through the context-tax layer like every read tool: repeated calls
answer `unchanged`, oversized replies park in the spool.

### 2. `urdr_append` hardening

- **Fuzzy branch recovery** — `branch not found` errors now carry a
  deterministic suggestion: `did you mean "Systems & Stack"?` (token-overlap
  + edit-distance over the file's real branch names, ties lexicographic).
  This alone would have converted both observed real-world failures into
  immediate self-corrections.
- **`dupeGuard: true`** (opt-in) — refuses the append when trigram
  similarity with an existing leaf exceeds the lint threshold, returning
  that leaf's id instead. Zero information loss: the caller decides to
  force, extend, or drop.

### 3. Explicitly rejected (recorded so it stays rejected)

- **Auto-writing resolver / one-call `urdr_write`** — rejected on the
  measurement above. Silent misfiling corrupts the tree's trustworthiness,
  which is the product. Revisit only if a future type-aware scorer clears
  top-1 ≥ 90% on the replay bench — the bench ships, so the bar is testable.
- **LLM-assisted routing** — violates the zero-LLM identity; not measured,
  not needed.

## Proof plan

- **Replay bench** — `scripts/write-bench.mjs`: the leave-one-out
  methodology above, runnable on any tree (`--root`), reporting top-1/3/5
  and root accuracy. Published numbers stay reproducible; anyone can
  re-measure on their own tree before trusting the advisory ranking.
- **Rock 11** — determinism of the ranking and fuzzy suggestions; verbatim
  branch names in write_context; near-dup warning fires on a planted
  duplicate and stays silent otherwise; dupeGuard refuses/allows correctly;
  fuzzy suggestion converts both historical failure cases; write_context
  respects the token budget and parks when oversized.

## Token math (expected, to be re-measured after build)

| | today | v1.4 |
|---|---|---|
| happy path | map (~80–500) + append | write_context (~300) + append |
| name-miss path | + grep/read/retry (~500–2000) | eliminated (verbatim names + fuzzy recovery) |
| duplicate path | append + later lint + cleanup | warned before writing |

The win is not the happy path (roughly a wash on small trees); it is the
elimination of the failure and duplicate paths, which are the expensive ones
— and they compound through the context-tax multiplier.

## Honest limits

- The advisory ranking is topic-blind-to-type by construction; its measured
  numbers ship with it. It is a spotlight, not a judge.
- Near-duplicate detection inherits the lint's trigram thresholds — fuzzy
  paraphrases below the threshold pass silently.
- write_context adds one tool call on trees small enough that `urdr_map`
  plus luck was often sufficient; the payoff grows with tree size and with
  the cost of a bounced append.
