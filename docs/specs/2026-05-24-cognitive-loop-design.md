# Anamnesis v0.5.0 — Cognitive Loop

**Status:** Draft v2 (revised after spec review)
**Date:** 2026-05-24
**Author:** Fleabag515 + Claude (design pair)
**Targets:** v0.5.0
**Builds on:** v0.4.0 persona system (`a74b390`) and the v0.3.0 audit pass.
**Revision history:** v1 → v2 — addresses six reviewer issues (persona/lessons overlap, reward-signal math, allocation calibration, phase-independence rollback, benchmark methodology, structural gaps).

---

## 1. Motivation

Anamnesis today stores three layers of episodic state — `turns`, `memcells`,
`memscenes` — plus a parallel `foresights` pipeline and (as of v0.4.0) a
`character_profile` with drift detection. This works, but the model still
sees mostly raw or lightly-clustered recall on every turn. There is no
mechanism by which Anamnesis distils what it has *learned about the user
and the domain*; and there is no closed-loop signal telling the retrieval
system what was actually useful.

Three problems follow:

1. **Wasted parameters.** A small model running locally (e.g. `qwen3:0.6b`)
   carries no specific knowledge of this user. It re-derives the same
   inferences every turn, from scratch, even though Anamnesis already
   has the raw material to skip that work.
2. **Memory bloat.** As `memcells` and `memscenes` grow, retrieval cost
   creeps up and signal-to-noise drops. Decay helps but does not consolidate.
3. **No feedback loop.** We have no way to tell which retrievals helped
   and which were noise. Decay is purely time- and recall-frequency-based;
   it is not coupled to outcome quality.

The proposal is a **Cognitive Loop**: a new compression tier (`lessons`) on
top of `memscenes`, fed by an automated **reward signal** computed from
each completed turn, surfaced through a **hierarchical retrieval selector**
that allocates the per-request memory budget across four tiers
(`lesson → scene → memcell → turn`) based on query intent.

The vision the design serves: **a small local model + Anamnesis behaves
competitively with a much larger model on long-running personal-assistant
tasks**, by carrying distilled, validated, per-user knowledge in a tight
context window that's reassembled fresh each turn.

## 2. Goals & Non-Goals

### Goals

- Add a `lessons` tier above `memscenes` that stores compact, validated,
  generalised knowledge about the **user, domain, and tool environment** —
  derived from clusters of related scenes.
- Add an automated reward signal that scores each injected memory item
  based on whether it appears to have helped the resulting response.
- Add a hierarchical selector that chooses how much of each tier to
  inject based on the shape of the current query.
- Make all three feature-flagged and incrementally rolloutable; ship the
  data-model migration so an existing v0.4.0 install upgrades cleanly.
- Co-exist cleanly with the v0.4.0 persona/character system. Persona owns
  agent self-knowledge; lessons own knowledge *about everything else*. The
  two are mutually exclusive by construction (see §5.6).
- Define a small benchmark suite that can demonstrate the "small model +
  Anamnesis ≈ large model alone" claim numerically — separate workstream,
  but in this spec because it justifies the design.

### Non-Goals (v0.5.0)

- A user-facing UI for browsing or editing lessons. Inspector is deferred
  to v0.6.0.
- Cross-instance federation or sync of lessons between Anamnesis nodes.
- Explicit user feedback signals (thumbs-up / thumbs-down). The reward
  loop is fully automated in v0.5.0; explicit feedback is a v0.6+ option.
- Replacing or subsuming the v0.4.0 persona system. Persona stays first-
  class; lessons are an orthogonal tier with a strict scope boundary.
- A latency-based reward signal. Reviewer flagged its bidirectionality
  (short = confident OR curt; long = thorough OR hedging). Deferred.
- Re-training or fine-tuning any model.

## 3. Vision and Success Criteria

A user running `qwen3:0.6b` behind Anamnesis for two weeks should observe:

1. The agent's responses cite specific past decisions or preferences that
   were *never explicitly recalled* in the current session.
2. Repeated user corrections ("I already told you it's X") drop measurably
   compared to v0.4.0 baseline.
3. Open foresights are closed at a higher rate.
4. The model's effective context window appears unchanged (4–8K tokens)
   but the perceived "memory horizon" is months.

These are observable from the proxy and become the v0.5.0 telemetry KPIs.

### Quantitative success target

Defined on the benchmark suite in §13. "Points" means:

> **Score:** the fraction of evaluation prompts on which the system under
> test produces a response judged correct by a *pinned grader* (model,
> version, temperature, prompt-version recorded in `bench/REPORT.md`).
> Reported as a percentage (0–100).

Targets:

- `qwen3:0.6b + Anamnesis v0.5.0` ≥ `qwen3:0.6b raw` + 30 points on the
  personalisation task category.
- `qwen3:0.6b + Anamnesis v0.5.0` within 15 points of `llama-3.1-70b raw`
  on the long-horizon-recall category.

(Targets are aspirations, not gates. The bench harness reports actuals.)

## 4. Architectural Overview

```
   turn ──▶ memcell ──▶ memscene ──▶ lesson         (compression ladder)
     │         │           │           │
     └─────────┴───────────┴───────────┘
                    │
            response observer
            ┌─────────────────────┐
            │  drift check (v0.4) │
            │  reward signal (v0.5)│
            │  foresight closure  │
            └─────────────────────┘
                    │
                   ▼
        importance / decay / precision
        updates to cells, scenes, lessons


           Selector (per request)
   ┌──────────────────────────────────────┐
   │  classify query intent               │
   │  budget = total - system - recency   │
   │  tier 1: lessons (top K)             │
   │  tier 2: scenes  (top K)             │
   │  tier 3: memcells (top K, optional)  │
   │  tier 4: verbatim turns (if budget)  │
   └──────────────────────────────────────┘
                    │
                    ▼
   <character> + <lessons> + <memory> + <foresight>
            + [rotating turns] + [recency]
```

### Where each component lives

| Component                    | New / existing | File                          |
| ---------------------------- | -------------- | ----------------------------- |
| `lessons` table              | new            | `src/history.js` (migration)  |
| Lesson distiller             | new            | `src/distiller.js`            |
| Lesson validator (refute)    | new            | `src/distiller.js`            |
| Response observer (router)   | new            | `src/observer.js`             |
| Reward signal computation    | new            | `src/observer.js`             |
| Hierarchical selector        | rewritten      | `src/selector.js`             |
| Query-intent classifier      | new            | `src/lib/intent.js`           |
| Persona drift hook           | unchanged      | `src/persona.js`              |
| Telemetry endpoint additions | new            | `src/proxy.js`                |

Two new modules total (`distiller.js`, `observer.js`); one rewritten
(`selector.js`); one new helper (`lib/intent.js`); minor edits elsewhere.

## 5. Component 1 — Lessons Tier

### 5.1 Conceptual definition

A **lesson** is a short, generalised, validated rule about the user, the
domain, or the tool environment, extracted from a cluster of related
`memscenes`. Lessons are *not* summaries — a summary says "we talked
about X." A lesson says "the rule that explains X is Y."

Lessons differ from `memscenes` along three axes:

- **Granularity:** scenes summarise; lessons generalise. A scene is
  "user set up systemd for anamnesis on May 23." A lesson is "this user
  deploys Node services via systemd + NVM under `/home/fleabag/…`."
- **Validation:** scenes are write-once; lessons accumulate confirming
  and refuting evidence and can decay or branch.
- **Density:** scenes inject in ~40–80 tokens; lessons in ~15–40 tokens
  but carry far more compressed signal.

### 5.2 Schema

New table `lessons`:

| Column                      | Type    | Notes                                                                       |
| --------------------------- | ------- | --------------------------------------------------------------------------- |
| `id`                        | INTEGER | PK                                                                          |
| `session_key`               | TEXT    | Matches existing scope; nullable for "global" lessons in a future tier.     |
| `content`                   | TEXT    | The lesson itself, ≤80 words.                                               |
| `embedding`                 | BLOB    | Float32Array of `content` only (resolved: cheaper, matches retrieval).      |
| `embedding_model`           | TEXT    | Same convention as scenes/cells.                                            |
| `category`                  | TEXT    | One of `technical \| decision \| preference \| personal \| context \| other`. Unified with memcell taxonomy. |
| `confidence`                | REAL    | 0–1; LLM-assigned at generation, updated by reward + refutation.            |
| `supporting_scene_ids`      | TEXT    | JSON array of `memscenes.id`.                                               |
| `supporting_memcell_ids`    | TEXT    | JSON array of `memcells.id`. Set at generation; not maintained on prune.    |
| `refute_count`              | INTEGER | Times a contradicting memcell has been observed since last revalidation.    |
| `precision_score`           | REAL    | 0–1, EMA of reward-loop signal. Default 0.5.                                |
| `recall_count`              | INTEGER | Number of times injected. Incremented by selector — see §7.5.               |
| `last_recalled_at`          | INTEGER | unixepoch of last injection; drives "idle" decay path.                      |
| `last_validated_at`         | INTEGER | unixepoch.                                                                  |
| `created_at` / `updated_at` | INTEGER | unixepoch.                                                                  |
| `status`                    | TEXT    | `active \| superseded \| retired`. Only `active` is injectable.             |
| `superseded_by`             | INTEGER | FK to `lessons.id` when a branched lesson takes over.                       |

Indices: `(session_key, status, updated_at)` and `(status, precision_score)`.

### 5.3 Generation

A new background job `distiller.runOnce()` runs every
`memory.distillationIntervalMs` (default 600s — 5× consolidation interval)
per session:

1. Fetch scenes that have ≥ `minScenesPerLesson` (default 3) related
   neighbours (cosine ≥ `lessonClusterThreshold`, default 0.78 — slightly
   higher than scene clustering since lessons are coarser).
2. For each cluster, ask an LLM with `LESSON_PROMPT` (verbatim below) to
   either output a single lesson **or** the literal string `NONE`.
3. If a lesson is returned:
   - Compute embedding with the active embedding model.
   - Insert into `lessons` with status `active`, `confidence` from the
     LLM, `category` classified from the source scenes' modal category.
4. Existing lessons are *not* regenerated; the cluster grows
   `supporting_scene_ids` only if the lesson already exists and matches.

#### LESSON_PROMPT (verbatim, pinned for v0.5.0)

```
You are extracting a single generalised rule from a cluster of related
observations about an AI assistant's ongoing relationship with a user.

OUTPUT ONLY one of:
  (a) A JSON object: {"content": "…", "confidence": 0.0-1.0, "category": "…"}
  (b) The literal string: NONE

Rules for "content":
  - At most 80 words.
  - State the rule plainly. Examples:
      "User runs Node services as systemd units under /home/fleabag/."
      "User prefers concise code reviews that lead with bugs over style."
  - Categories: technical | decision | preference | personal | context | other

CRITICAL — scope boundary:
  Lessons are about THE USER, THE DOMAIN, or THE TOOL ENVIRONMENT.
  Lessons are NEVER about the AI assistant itself — not its voice, its
  tone, its personality, its evolution, its writing style, its
  archetypal patterns. Those belong to a separate persona system and
  MUST NOT appear in lessons. If the cluster is principally about how
  the AI behaves rather than what it knows, output NONE.

Be conservative. If the cluster supports no clear generalisation, or
supports one only with low confidence (<0.5), output NONE.

OBSERVATIONS:
```

(The cluster scenes are appended after this prompt.)

#### Edge cases

- **Ollama unavailable.** Distiller catches HTTP errors and the
  scheduling loop's outer try/catch logs them via `log.warn`. The next
  scheduled tick retries. No DB writes occur on failure. (Same pattern
  as consolidator.)
- **Single-flight.** `distiller` uses the same self-rescheduling
  `setTimeout` + `_running` guard as `consolidator` — never overlaps.

### 5.4 Validation and refutation

Every time a new `memcell` is inserted, the distiller runs a fast
side-check (no LLM call, no extra HTTP):

1. Embed the cell (already done by `extractor`).
2. For active lessons in the same session with embedding cosine ≥ 0.85,
   compute a cheap textual contradiction probe — substring search for
   known negation markers paired with shared nouns. This is a heuristic
   filter, not a definitive contradiction detector.
3. If the probe fires, increment `lesson.refute_count`. If `refute_count`
   crosses `lessonRefuteThreshold` (default 3), enqueue the lesson for
   LLM-mediated re-validation.

LLM-mediated re-validation (`distiller.refute(lessonId)`):

- Asks: "Given the original lesson and N new contradicting observations,
  which of (a) the lesson still holds, (b) the lesson needs to be revised,
  (c) the lesson is now wrong?"
- (a) → reset `refute_count`, bump `last_validated_at`.
- (b) → generate a successor lesson, mark old `status='superseded'`
  with `superseded_by` set.
- (c) → mark `status='retired'`.

This is what makes the loop feel like belief revision rather than pure
accumulation.

### 5.5 Decay

All decay timescales are in **days**.

| Tier      | Half-life (days)                |
| --------- | ------------------------------- |
| memcells  | `30 + importance * 60`          |
| memscenes | (existing decay applies)        |
| lessons   | `90 + confidence * 180`         |

Lessons with `recall_count = 0` AND `precision_score < 0.2` AND idle
(no `last_recalled_at` write) for `lessonIdleRetireDays` (default 60)
are auto-retired by setting `status='retired'`. This is the
symmetry-breaking mechanism that prevents stale lessons from sitting
forever in active limbo.

### 5.6 What lessons are NOT for — boundary with the persona system

The v0.4.0 persona system owns *agent self-knowledge*:

- The agent's `name`, `archetype`, `vibe`, `style_markers`,
  `behavioral_patterns` (the persona schema, see `src/persona.js`
  `EXTRACT_PROMPT`).
- `evolution_notes` — the agent's *own* growth ("Mark has been giving
  more concise replies").
- `drift_reminder` — when the agent has drifted from its character.

The v0.5.0 lessons tier owns *everything else*:

- Knowledge about the **user** (preferences, history, decisions,
  identity, environment).
- Knowledge about the **domain** (this project, this codebase, these
  systems, these constraints).
- Knowledge about the **tool environment** (Ollama on this box, NVM
  layout, systemd unit names).

The `LESSON_PROMPT` (§5.3) instructs the LLM to output `NONE` for any
cluster principally about the agent itself. The distiller does no
further filtering; we rely on the prompt's scope clause plus refutation
to keep these clean.

This boundary is **strict**, not best-effort. If you find lessons
emerging about the agent's voice or style, that is a refutation event:
mark the lesson `retired` and tighten the prompt.

The v1 spec's Open Question 3 ("keep them since they reinforce") is
hereby resolved: **no**, do not keep them. Persona is canonical for
agent self-knowledge; lessons would only confuse things.

## 6. Component 2 — Reward Signal

### 6.1 Goal

For every memory item injected into a request, observe — automatically —
whether the resulting response appears to have used and benefited from it.
Feed that signal back into `precision_score` (lessons), `injection_score`
(scenes), and — only behind a separate flag, see §6.5 — `importance`
(memcells).

### 6.2 Architecture

A new module `src/observer.js` is the single post-turn router. It
receives:

- the user message,
- the assistant response,
- the `injection_manifest` — items injected this turn (see §7.5).

It computes three signals (latency dropped, see Non-Goals), ensembles
them, and writes back. None of these require user input.

### 6.3 The three signals (v0.5.0)

| Signal              | What it measures                                                                                                                                   | Debiasing                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Echo (debiased)** | For each injected item: `cosine(response, item) − cosine(response, query)`. Removes the topic-confound — items only score positive if the response leans on them *beyond* what the query already covers. | Subtracts the query-response baseline. Negative deltas allowed (penalty for items the response ignored entirely). |
| **No-correction (weighted)** | On the *next* user turn, detect correction markers (English list, expandable). If detected, items injected the previous turn lose, **weighted by their per-item echo from that turn** — so the item that actually got used takes most of the blame, not the entire injection set. | Per-item blame = `prev_echo / sum(prev_echo)`. Items with zero echo last turn get zero blame.        |
| **Foresight closure** | If this turn marked a previously-open foresight `fulfilled`, items semantically related to the foresight target gain.                                                                  | Semantic relatedness gate avoids rewarding incidental injections.                                       |

Each signal is normalised to `[-1, +1]`. The ensemble is a weighted sum
(weights configurable, see §9). The per-item reward `r` is clamped to
`[-1, +1]`.

### 6.4 Exploration / symmetry-breaking

To prevent positive feedback loops where injected items reinforce only
themselves, the selector applies a UCB-style exploration bonus to
items that have low `recall_count` relative to the session age, and
the writer applies a slow regression to the mean:

- `precision_score` decays toward `0.5` at a rate of
  `rewardMeanReversion` (default `0.002` per day) when the item is
  not recalled. This is in addition to the active-use EMA updates.
- The selector's tier-1 scoring includes a `+exploration` term equal to
  `sqrt(ln(sessionTurns + 1) / (recall_count + 1)) * explorationWeight`
  (default `explorationWeight = 0.05`). Small enough not to dominate
  relevance, large enough to occasionally surface low-recall items.

### 6.5 Write-back, in two layers

| Target field                       | Writer                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| `lessons.precision_score`          | EMA of `r`. New column, v0.5.0-native.                              |
| `lessons.confidence`               | Bumped slightly up on strongly positive r, down on strongly neg.    |
| `memscenes.injection_score` (new)  | EMA of `r`. New column, v0.5.0-native.                              |
| `memcells.importance` (legacy)     | **Only when `reward.writebackLegacyImportance = true`.**            |

The EMA factor is `rewardSmoothing` (default `0.1`) — slow enough that
a single noisy turn can't flip a lesson.

The legacy-importance flag is what makes phase γ rollback-safe (see
§12.2). Until that flag is set, v0.5.0 only touches new columns;
`memcells.importance` remains a v0.4.0-pure value and the v0.4.0
selector path (when `cognitive.lessons.enabled = false`) sees no
behaviour change.

### 6.6 Persona/drift integration

The v0.4.0 persona drift check is conceptually the same shape: post-turn,
observe the response, write something back. The observer hosts both:

- `observer.onAssistantTurn(...)` dispatches to:
  - `reward.compute(...)` (new in v0.5.0)
  - `persona.observeResponse(...)` (existing, unchanged)
  - `foresight.tryClose(...)` (existing, lightly tightened)

This consolidates three near-duplicate hooks into one place, but does
not change their semantics.

## 7. Component 3 — Hierarchical Selector

### 7.1 Today

`Selector.select()` does scene-first retrieval, expands to candidate
turns, fills budget. It assumes one "rotating turns" slot pool sized by
`context.rotatingSlots`.

### 7.2 New behaviour

The selector becomes a four-tier budget allocator. Pseudocode:

```js
const budget = tokenBudget - systemReserveTokens - recencyTokens - systemTokens;
const intent = await intent.classify(queryText);  // narrow | broad | reflective
const allocation = budgetAllocation(intent, budget);
const lessonItems = retrieveLessons(queryVec, allocation.lessons);
const sceneItems  = retrieveScenes( queryVec, allocation.scenes);
const cellItems   = allocation.memcells.tok > 0
  ? retrieveCells(queryVec, allocation.memcells)
  : [];
const turnItems   = allocation.turns.tok > 0
  ? retrieveTurnsFromScenes(sceneItems, allocation.turns)
  : [];

// recall_count + last_recalled_at bookkeeping (§5.2) happens at injection time:
for (const item of [...lessonItems, ...sceneItems, ...cellItems, ...turnItems]) {
  history.bumpRecall(item.kind, item.id);  // ++recall_count, set last_recalled_at = now
}

const manifest = buildManifest({ intent, items: [...lessonItems, ...sceneItems, ...cellItems, ...turnItems] });
return { messages: assembleInjection({character, lessonItems, sceneItems, foresight, cellItems, turnItems}), manifest };
```

### 7.3 Allocations — calibration, not assertion

The v1 spec hard-coded percentages without justification. v2 makes them
**calibrated, not asserted**.

**Phase α / β: uniform baseline.** Each intent uses
`{ lessons: 25%, scenes: 25%, memcells: 25%, turns: 25% }`. This is
deliberately bland; its job is to be a control, not a winner.

**Phase γ acceptance criterion:** the bench harness (§13) sweeps the
allocation matrix and emits a recommended production table. The
production allocations land in `config.json` as part of the γ → 1.0
promotion. They are versioned in CHANGELOG.

**Open question:** whether the production table is fixed in config or
auto-tuned per session via the reward EMA. v0.5.0 ships static; v0.6.0
may experiment with auto-tune.

### 7.4 Intent classifier

`src/lib/intent.js` exposes `classify(queryText) → "broad" | "narrow" | "reflective"`.
Two implementations, picked by config:

- `heuristic` (default in v0.5.0-alpha): rule-based — counts question
  words, presence of specific identifiers (file paths, function names,
  dates), presence of reflective markers ("why", "in general",
  "overall").
- `llm`: one Qwen3:0.6b call with `INTENT_PROMPT` (below), ~80ms. Opt-in
  via `cognitive.selector.intent.mode = "llm"`.

#### INTENT_PROMPT (verbatim, pinned for v0.5.0)

```
Classify the user's query into exactly one of three intent categories.
Output ONLY one word: "broad", "narrow", or "reflective".

  broad      — open-ended, exploratory, asking about a topic in general,
               asking for ideas, asking for plans
  narrow     — specific, pointed, asking for a value, a fact, a command,
               a name, a date, a file path, exact recall
  reflective — meta, retrospective, asking what we've learned, asking
               for synthesis across many past conversations, asking the
               agent to comment on a pattern

QUERY:
```

The heuristic implementation must agree with this prompt's intent
definitions; a parity test in `test/intent.test.js` enforces both
implementations agree on a hand-curated table of ~30 example queries.

### 7.5 Injection manifest

The selector emits an `injection_manifest` object alongside the
rewritten messages. The proxy stores it transiently keyed by request,
hands it to the observer on the post-turn hook, and deletes it after.

Schema:

```js
{
  request_id: "...",
  created_at: 1748134567,   // unixepoch
  intent: "broad",
  items: [
    { kind: "lesson",  id: 17,   tokens: 18 },
    { kind: "scene",   id: 92,   tokens: 64 },
    { kind: "memcell", id: 4231, tokens: 22 },
    { kind: "turn",    id: 1518, tokens: 280 }
  ]
}
```

**Lifetime / eviction:** the in-memory manifest map is bounded:

- Per-entry TTL: `300s` (5 min). After that, the entry is discarded
  even if the observer never fired (client disconnect, upstream timeout).
- Hard size cap: `10000` entries. If exceeded, oldest-first eviction.
- Sweep cadence: every 60s.

This is what closes the loop — without it, the reward signal has
nothing to credit or blame. Without the TTL/cap, it leaks.

## 8. Data Model Changes

### 8.1 New tables

- `lessons` — see §5.2.

### 8.2 New columns

| Table       | Column              | Type    | Purpose                                |
| ----------- | ------------------- | ------- | -------------------------------------- |
| `memscenes` | `injection_score`   | REAL    | EMA from reward loop, default 0.5.     |
| `lessons`   | (all new — see §5.2) |        |                                        |

### 8.3 Migration

Handled in `history.js#_migrate()` following existing conventions. All
columns added with safe defaults so existing v0.4.0 DBs upgrade without
loss.

Lessons are **not backfilled** at migration time. The distiller will
populate them on its first scheduled run after upgrade.

## 9. Configuration

New `config.json` block. All v0.5.0 features are gated by `enabled`
flags.

```jsonc
"cognitive": {
  "lessons": {
    "enabled": true,
    "distillationIntervalMs": 600000,
    "minScenesPerLesson": 3,
    "lessonClusterThreshold": 0.78,
    "lessonRefuteThreshold": 3,
    "decayHalfLifeDaysBase": 90,
    "lessonIdleRetireDays": 60,
    "model": "qwen3:0.6b"
  },
  "reward": {
    "enabled": true,
    "weights": { "echo": 0.6, "correction": 0.25, "foresight": 0.15 },
    "smoothing": 0.1,
    "meanReversion": 0.002,
    "writebackLegacyImportance": false
  },
  "selector": {
    "intent": {
      "mode": "heuristic",
      "_modeNote": "heuristic | llm"
    },
    "explorationWeight": 0.05,
    "allocations": {
      "_note": "Phase α/β uniform baseline. γ replaces these from bench.",
      "broad":      { "lessons": 0.25, "scenes": 0.25, "memcells": 0.25, "turns": 0.25 },
      "narrow":     { "lessons": 0.25, "scenes": 0.25, "memcells": 0.25, "turns": 0.25 },
      "reflective": { "lessons": 0.25, "scenes": 0.25, "memcells": 0.25, "turns": 0.25 }
    }
  }
}
```

When `cognitive.lessons.enabled = false`, the selector falls back to
the v0.4.0 logic exactly (no lesson tier, single rotating-turn pool).
This is the rollback path.

## 10. Observability

### 10.1 Status endpoint extensions

`GET /anamnesis/status` adds (additive only — see §15):

```jsonc
{
  "lessons":         42,
  "lessons_active":  38,
  "intent_mix":      { "broad": 0.42, "narrow": 0.51, "reflective": 0.07 },
  "reward_ema":      0.18
}
```

### 10.2 New endpoint: `GET /anamnesis/lessons`

Read-only listing of lessons for debugging.
`GET /anamnesis/lessons?limit=20&category=…&status=active`. Includes
confidence, precision_score, supporting scene IDs. No edit endpoints in
v0.5.0 (per non-goals).

### 10.3 Logging

A new `[observer]` log line per turn at `ANAMNESIS_LOG=debug`:

```
[observer] turn=4521 intent=broad items=8 reward=+0.34 (echo+0.50, corr=n/a, fore+0.70)
```

`corr=n/a` until the *next* user turn closes it; rewrite is in-place at
that point (or the entry is evicted by TTL, see §7.5, in which case the
corr signal is simply unobserved).

### 10.4 Ollama-down behaviour

All LLM-dependent paths (distiller, refuter, intent classifier in `llm`
mode, persona) catch HTTP/timeout errors at the call boundary, log
once at `warn`, and return a "no-op" result. The scheduling loops
continue; no state is half-written. This mirrors the existing
consolidator/extractor/foresight behaviour and is one of the things
the audit pass tightened in v0.3.0.

## 11. Testing Strategy

### 11.1 Unit tests (`test/`)

- `lessons.test.js` — schema migration, CRUD, refute_count semantics.
- `distiller.test.js` — clustering logic against fixture scenes;
  LESSON_PROMPT prompt template; happy path + NONE path; agent-scope
  rejection (a fixture about agent voice should produce NONE).
- `observer.test.js` — each of the three signals in isolation, the
  debiasing math for echo, blame-weighting for no-correction, ensemble
  math, EMA writeback semantics, mean-reversion timestep.
- `intent.test.js` — heuristic classifier on a hand-curated table of
  ~30 queries, *and* LLM-mode parity check on the same table.
- `selector.test.js` (rewritten) — allocations math, manifest
  construction including TTL/eviction, exploration bonus monotonicity,
  fallback when `cognitive.lessons.enabled = false`.

### 11.2 Integration tests

A new `test/integration/` directory with an in-memory upstream stub
exercises:

- Full request → selector → upstream stub → observer → DB writeback.
- An injected lesson that semantically matches the response gains
  `precision_score` *above the query baseline* (echo-debiasing test).
- An injected lesson the response ignores does NOT gain
  `precision_score` (even if it's topically similar to the query).
- A correction-pattern in the next user turn drops the importance of
  the prior turn's injections, weighted by their per-item echo.
- Manifest TTL: a request with no observer hook fired is evicted after
  5 min; no leaks.

### 11.3 Bench harness (separate workstream — see §13)

Lives under `bench/` not `test/`. Runs offline against canned
conversations and a real Ollama; produces a JSON report.

## 12. Rollout Plan

### 12.1 Phases

| Phase | Scope                                                                                            | Default flag state                                      |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| α     | Schema migration, distiller generates lessons in background, **no injection** yet.               | `lessons.enabled=true` (silent population)              |
| β     | Selector reads lessons tier under `reflective` intent only. Reward EMA observed but **not written**. | `selector.intent.mode=heuristic`                        |
| γ     | Selector reads lessons across all intents. Reward write-back to `lessons.precision_score` and `memscenes.injection_score` (NEW columns only).  | `reward.enabled=true`, `reward.writebackLegacyImportance=false` |
| 1.0   | Full reward write-back including `memcells.importance` (legacy). Refutation loop active. Intent classifier optionally `llm` mode. Production allocations from bench. | `reward.writebackLegacyImportance=true`                 |

### 12.2 Rollback guarantees

The v1 spec called each phase "independently shippable" but γ wrote
through to `memcells.importance`, poisoning it irreversibly. v2 fixes
this:

- **Through phase γ:** reward write-back targets only NEW columns
  (`lessons.precision_score`, `memscenes.injection_score`). The
  v0.4.0-pure `memcells.importance` is left alone. Disabling
  `cognitive.*` flags restores v0.4.0 behaviour bit-for-bit.
- **At 1.0 promotion:** `reward.writebackLegacyImportance` flips to
  `true`. Before flipping, the migration snapshots
  `memcells.importance` into `memcells.importance_v04_snapshot` so an
  emergency rollback can restore the v0.4.0 values.
- **`cognitive.lessons.enabled = false`** is the always-available
  full-stop switch; selector reverts to v0.4.0 path.

Each phase is one PR. Each PR is mergeable to main without breaking the
previous behaviour and is verifiable via the bench harness.

## 13. Benchmark Suite (Parallel Workstream)

`bench/`, separate spec but referenced here because it justifies the
design. v2 tightens the methodology after reviewer pushback.

### 13.1 Task categories

1. **Personalisation** — given a "setup conversation" in which the user
   expresses N preferences, **then a disjoint held-out continuation
   conversation** that the distiller has never seen, score how many
   preferences are correctly honoured.
2. **Long-horizon recall** — given a fixture with a fact mentioned once
   ~100 turns ago in a setup conversation, ask for it in the held-out
   continuation. Score: exact-match or paraphrase under the grader.
3. **Agentic continuity** — given an in-progress task with open
   foresights, resume after a (simulated) session break. Score: does
   the agent pick up where it left off?
4. **Drift resistance** (uses persona system) — over 100 turns of an
   adversarial prompt pushing against character markers, does the
   character hold? Persona-system metric.

### 13.2 Fixture construction — no train/test leakage

The setup conversation (used to populate Anamnesis) and the evaluation
continuation (used to score) must be **disjoint**. The distiller, the
extractor, and the consolidator MUST run only on the setup. The
grader sees only the continuation prompt and the system's response.

### 13.3 Pinned grader

```
grader.model:        gpt-oss-20b (chosen for OSS reproducibility; pinned tag)
grader.temperature:  0.0
grader.prompt_version: bench/grader-v1.md (file-pinned, hashed)
inter_rater_target:  ≥ 0.75 Cohen's κ on a 50-item human-graded calibration set
```

Reports include the grader checksum. If the grader changes, the bench
version bumps.

### 13.4 Configurations to compare

| System                                | Latency reportable | Notes                                       |
| ------------------------------------- | ------------------ | ------------------------------------------- |
| `qwen3:0.6b` raw                      | yes                |                                             |
| `qwen3:0.6b` + Anamnesis v0.4.0       | yes                |                                             |
| `qwen3:0.6b` + Anamnesis v0.5.0       | yes                |                                             |
| `llama-3.1-8b` raw                    | yes                | Commodity small-model baseline.             |
| `llama-3.1-70b` raw                   | **quality only**   | Wall-clock non-comparable on most hardware. |

### 13.5 Deliverable

A single `bench/REPORT.md` regenerated by `bench/run.sh`. The report is
what we'd link in a blog post or arXiv preprint.

## 14. Risks and Mitigations

| Risk                                                                       | Mitigation                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lessons hallucinate rules that aren't actually supported.                  | LESSON_PROMPT requires conservative `NONE` output; refutation loop catches false positives; `precision_score` gates use. |
| Reward signal is noisy → memory becomes worse over time.                   | Three-signal ensemble with debiasing; `smoothing=0.1`; mean-reversion to 0.5; γ does not touch legacy importance.        |
| Intent classifier mis-routes a query → wrong allocation.                   | Heuristic mode is overridable per-request via header; LLM mode is opt-in; allocations always include a non-zero turns tier. |
| Distillation interval too aggressive → background LLM load is heavy.       | Default 600s, configurable. Distiller is single-flight via the same guard as consolidator.                              |
| Schema migration breaks an existing v0.4.0 DB.                             | All migrations additive, with safe defaults; existing test covers PRAGMA inspection.                                    |
| Lessons drift from current reality but reward signal hasn't caught up yet. | Refute loop is independent of reward — even a never-injected lesson can be retired by contradicting cells.              |
| Persona / lessons accidentally overlap.                                    | LESSON_PROMPT scope clause; agent-scope rejection test in `distiller.test.js`; overlap is treated as a refutation event. |
| Positive feedback loop reinforces injected lessons forever.                | Mean-reversion of `precision_score` toward 0.5; exploration bonus in selector; idle retire.                              |
| Manifest map leaks memory.                                                 | 5-min TTL + 10K hard cap + 60s sweep (§7.5).                                                                            |

## 15. Backward Compatibility Invariants

The following promises must hold for any pre-existing v0.4.0 client that
points at a v0.5.0 Anamnesis:

1. **Status endpoint:** existing fields keep their names, types, and
   semantics. New fields are additive only. No field is removed or
   has its type changed.
2. **Chat completions:** request/response shapes are unchanged. The
   injected `<character>`, `<lessons>`, `<memory>`, `<foresight>`
   blocks are *content* the upstream sees, not protocol additions.
3. **Config file:** any v0.4.0 `config.json` (with no `cognitive`
   block) boots cleanly. Missing `cognitive.*` keys default to the v0.5.0
   defaults.
4. **DB schema:** all new columns have defaults; all new tables are
   `CREATE TABLE IF NOT EXISTS`. A v0.4.0 DB upgraded to v0.5.0 and
   then downgraded back (binary swap) MUST still be readable by v0.4.0
   — the new columns are ignored by v0.4.0 selects.

A backward-compat test in CI verifies (1) and (3) by booting a v0.4.0
fixture config + DB against the v0.5.0 binary and asserting the
status endpoint contains all old fields.

## 16. Out of Scope (Deferred)

- Lesson inspector / editor UI (v0.6.0).
- Explicit user feedback signals (thumbs up/down, "forget this", "lock
  this").
- Cross-Anamnesis federation / sync.
- A "playbook" tier above lessons. Four tiers are enough; we'll revisit
  only on real demand.
- Multi-model embedding (hot small + cold heavy).
- Replay/counterfactual ("what if I'd known X then?").
- Auto-tuning allocations per session (v0.6.0 experiment).
- Latency-as-reward (deferred indefinitely — bidirectional signal).
- Multilingual correction-marker dictionaries.

## 17. Resolved Open Questions (was §16 in v1)

| v1 Question                              | Resolution                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Lesson categories                        | Unify with memcells: `technical \| decision \| preference \| personal \| context \| other`. (§5.2)                |
| Embed off content or content+facts       | Content only. Cheaper, matches retrieval semantics. (§5.2)                                                         |
| Persona vs lessons overlap policing      | Strict exclusion. Lessons are about user/domain/environment, NEVER the agent itself. Enforced by prompt + test. (§5.6) |
| No-correction trigger words multilingual | English-only in v0.5.0; deferred. (§16)                                                                            |

## 18. Glossary

- **memcell** — atomic fact extracted from an assistant turn.
- **memscene** — thematic cluster of memcells with a title + summary.
- **lesson** — generalised rule about user/domain/environment, extracted from a cluster of memscenes (new in v0.5.0).
- **foresight** — extracted future intention.
- **persona / character profile** — agent identity (v0.4.0). Strict scope boundary with lessons (§5.6).
- **reward signal** — automated per-injected-item utility score (new in v0.5.0).
- **echo (debiased)** — per-item utility = cosine(response, item) − cosine(response, query).
- **injection manifest** — per-request record of what was injected, used by the observer. TTL'd (§7.5).
- **precision_score** — EMA of reward signal per lesson; gates further use.
- **intent** — `broad | narrow | reflective`, drives budget allocation.

---

## Appendix A — Launch narrative (lives in `docs/launch/` post-merge)

> A developer evaluating local-LLM memory has two reasons to look at
> Anamnesis today: it's a proxy (no library integration) and it's
> local-first. v0.5.0 gives them a third reason that's harder to find
> anywhere else: **the small model behaves bigger than it has any
> right to.**

This narrative is marketing material, not architectural specification.
At merge time it moves to `docs/launch/v0.5.0.md` for the release post.

## Appendix B — Reviewer issues addressed (v1 → v2)

| Reviewer issue                                       | Where addressed                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Persona / lessons overlap                            | §5.6 (strict exclusion); §17 (Q3 resolved); LESSON_PROMPT scope clause |
| Echo topic-confounded                                | §6.3 — debiased echo subtracts query-response baseline                |
| No-correction blames all items equally               | §6.3 — per-item blame weighted by prior echo                          |
| Latency signal ambiguous                             | §2 Non-Goals (dropped); §6.3 reduced to three signals                 |
| Positive feedback loop unbounded                     | §6.4 — mean reversion + exploration bonus + idle retire (§5.5)        |
| Allocations unjustified                              | §7.3 — uniform α/β baseline; γ bench-calibrated                       |
| Phase γ poisons `memcells.importance` irreversibly   | §6.5 + §12.2 — `writebackLegacyImportance` flag + snapshot column     |
| Benchmark methodology weak                           | §13 — held-out continuation, pinned grader, no-CPU-llama on latency   |
| Backward-compat invariants missing                   | §15 — new dedicated section + CI test                                 |
| Prompts not pinned                                   | §5.3 (LESSON_PROMPT) + §7.4 (INTENT_PROMPT) verbatim                  |
| Ollama-down behaviour                                | §10.4 — documented inherited behaviour                                |
| Lesson category mismatch                             | §5.2 — unified with memcell taxonomy                                  |
| `recall_count` update site                           | §7.2 + §5.2 (`last_recalled_at`) — bookkeeping in selector            |
| Injection manifest TTL                               | §7.5 — 5 min TTL, 10K cap, 60s sweep                                  |
| "Points" undefined                                   | §3 — defined operationally                                            |
| Decay units                                          | §5.5 — "All decay timescales are in days"                             |
| Embed off what                                       | §5.2, §17 — content only                                              |
| Appendix A in spec                                   | Marked for relocation to `docs/launch/v0.5.0.md`                      |
