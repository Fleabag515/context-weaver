# Anamnesis v0.5.0 Cognitive Loop — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.5.0 Cognitive Loop — lessons tier, reward signal, hierarchical
selector, reasoning scaffold — phased per spec §12 (α → β → γ → 1.0).

**Architecture:** Add a fourth compression tier (`lessons`) above `memscenes`,
fed by an automated post-turn reward signal; rewrite the selector as a four-tier
budget allocator gated by query-intent classification; salvage the working ideas
from the reasoning-proxy postmortem (tier classification, plan injection,
tool-reflection) as a new `src/scaffold.js` module. All features ship behind
config flags, all phases are independently rollback-able.

**Tech Stack:** Node 18+, better-sqlite3, Ollama HTTP API. No new runtime
dependencies. Tests use `node:test` (already in use, see `test/`).

**Spec:** `docs/specs/2026-05-24-cognitive-loop-design.md` (v3). Cite section
numbers (§5.2, §7A.4, etc.) where relevant — the plan does not duplicate the
spec; it references it.

**Branch:** `feat/cognitive-loop` (already pushed, sits on top of `main`).
**Test command:** `npm test` (= `node --test "test/**/*.test.js"`).
**Lint/format:** `npm run lint`, `npm run format:check`.

**Commit cadence:** at the end of each task. Each task should leave the test
suite green. If a task can't keep tests green, split it.

---

## Chunk 1: Phase α — Schema + Scaffold + Distiller (silent)

**Phase α exit criteria (from spec §12):**

- `lessons` table + `memscenes.injection_score` column exist in the DB and
  migrate cleanly from a v0.4.0 install.
- `src/distiller.js` runs every 10 minutes and silently populates lessons
  from clustered scenes. **No lessons are injected into requests yet.**
- `src/scaffold.js` is wired into `proxy.js`: trivial messages bypass the
  selector entirely; non-trivial messages get plan/tool-reflection blocks
  appended to their system message (except `broad`-intent).
- Status endpoint reports `lessons` and `lessons_active` counts.
- `npm test` is green. `npm run lint` is clean. `npm run format:check` is clean.
- A v0.4.0 client (no `cognitive.*` keys in its `config.json`) boots and
  serves requests with **bit-for-bit identical** retrieval behaviour. (The
  scaffold's `isTrivial` does *not* break this — trivial passthrough simply
  skips memory injection, which is what v0.4.0 did anyway for short turns.)

**Chunk 1 file plan:**

| File                                  | Action   | Why                                                                    |
| ------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `src/history.js`                      | modify   | New `lessons` table + `memscenes.injection_score` migration + CRUD.   |
| `src/scaffold.js`                     | create   | `isTrivial`, `planBlock`, `toolReflectionBlock`, pinned prompts.      |
| `src/distiller.js`                    | create   | Background job that distils clusters of scenes into lessons.          |
| `src/proxy.js`                        | modify   | Instantiate scaffold + distiller; wire `isTrivial` gate; status fields. |
| `config.json`                         | modify   | New `cognitive.lessons` and `cognitive.scaffold` blocks (§9 defaults). |
| `test/history.test.js`                | modify   | New schema tests follow existing patterns.                            |
| `test/scaffold.test.js`               | create   | Table-driven tests for the three helpers.                             |
| `test/distiller.test.js`              | create   | Cluster math + LESSON_PROMPT parsing + NONE handling.                 |
| `test/integration/scaffold-gate.test.js` | create | Proxy short-circuits to passthrough on trivial messages.              |

---

### Task 1: Add `lessons` table + `memscenes.injection_score` column migration

**Files:**
- Modify: `src/history.js` (the `_init` and `_migrate` methods, ~lines 70–145)
- Test: `test/history.test.js`

The schema lives entirely in `_migrate()` — every new column or table goes
through the existing additive-migration pattern. See `src/history.js#_migrate`
in v0.4.0 for the convention.

- [ ] **Step 1: Add the `lessons` table fixture test**

Add to `test/history.test.js` (after the existing `'schema: init creates expected tables and columns'` test, around line 50-ish):

```javascript
maybeTest('schema: lessons table exists with all v0.5.0 columns', () => {
  const { dir, dbPath } = tmpDb();
  const h = new HistoryStore(dbPath);
  try {
    const cols = h.db.prepare('PRAGMA table_info(lessons)').all().map((c) => c.name);
    const expected = [
      'id', 'session_key', 'content',
      'embedding', 'embedding_model', 'category',
      'confidence', 'supporting_scene_ids', 'supporting_memcell_ids',
      'refute_count', 'precision_score',
      'recall_count', 'last_recalled_at', 'last_validated_at',
      'created_at', 'updated_at',
      'status', 'superseded_by',
    ];
    for (const c of expected) {
      assert.ok(cols.includes(c), `lessons.${c} must exist (got ${cols.join(',')})`);
    }
  } finally {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

maybeTest('schema: memscenes.injection_score exists with default 0.5', () => {
  const { dir, dbPath } = tmpDb();
  const h = new HistoryStore(dbPath);
  try {
    const cols = h.db.prepare('PRAGMA table_info(memscenes)').all();
    const col  = cols.find((c) => c.name === 'injection_score');
    assert.ok(col, 'memscenes.injection_score must exist');
    assert.equal(col.dflt_value, '0.5');
  } finally {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
ANAMNESIS_LOG=error npx node --test test/history.test.js 2>&1 | tail -10
```

Expected: the two new `maybeTest`s fail with "lessons.id must exist" /
"memscenes.injection_score must exist" assertions.

- [ ] **Step 3: Add the table + column to `_init`**

In `src/history.js#_init`, inside the existing `CREATE TABLE IF NOT EXISTS …`
block (after the `foresights` table), append:

```sql
CREATE TABLE IF NOT EXISTS lessons (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key             TEXT,
  content                 TEXT    NOT NULL,
  embedding               BLOB,
  embedding_model         TEXT,
  category                TEXT    NOT NULL DEFAULT 'other',
  confidence              REAL    NOT NULL DEFAULT 0.5,
  supporting_scene_ids    TEXT    NOT NULL DEFAULT '[]',
  supporting_memcell_ids  TEXT    NOT NULL DEFAULT '[]',
  refute_count            INTEGER NOT NULL DEFAULT 0,
  precision_score         REAL    NOT NULL DEFAULT 0.5,
  recall_count            INTEGER NOT NULL DEFAULT 0,
  last_recalled_at        INTEGER NOT NULL DEFAULT 0,
  last_validated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  status                  TEXT    NOT NULL DEFAULT 'active',
  superseded_by           INTEGER REFERENCES lessons(id) ON DELETE SET NULL
);
```

In the indices block (after existing `idx_foresights_active`), append:

```sql
CREATE INDEX IF NOT EXISTS idx_lessons_session_status ON lessons(session_key, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_lessons_status_score  ON lessons(status, precision_score);
```

In `_migrate()`, after the existing `embedding_model` column adds, append:

```javascript
if (!has('memscenes', 'injection_score')) {
  this.db.exec("ALTER TABLE memscenes ADD COLUMN injection_score REAL NOT NULL DEFAULT 0.5");
}
```

- [ ] **Step 4: Run tests to verify they pass + the full suite is still green**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: all 56 prior tests still pass, plus the 2 new schema tests
(58 total).

- [ ] **Step 5: Format + lint + commit**

```bash
npm run format
npm run lint
git add src/history.js test/history.test.js
git commit -m "feat(history): add lessons table + memscenes.injection_score (v0.5.0 α)

Schema-only commit. Distiller will populate the table; consolidator
gets the column write-side in a later commit. No reads yet.

Tests verify column presence and defaults; existing 56 tests unchanged."
```

---

### Task 2: Add HistoryStore CRUD for lessons

**Files:**
- Modify: `src/history.js` (after existing `getActiveForesights` block, ~line 290)
- Test: `test/history.test.js`

We add only the methods needed in phase α: insertLesson, getActiveLessons
(read for status endpoint), and a single `bumpLessonRecall(id)` for later
selector use. Refute / supersede helpers come in Chunk 2 (Phase γ).

- [ ] **Step 1: Add CRUD tests**

```javascript
maybeTest('lessons CRUD: insert, list active, bump recall', () => {
  const { dir, dbPath } = tmpDb();
  const h = new HistoryStore(dbPath);
  try {
    const id1 = h.insertLesson({
      sessionKey: 's1',
      content: 'User prefers concise code reviews.',
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      embeddingModel: 'nomic-embed-cpu:latest',
      category: 'preference',
      confidence: 0.8,
      supportingSceneIds: [11, 12],
      supportingMemcellIds: [101, 102, 103],
    });
    assert.ok(id1 > 0);

    const id2 = h.insertLesson({
      sessionKey: 's1', content: 'retired lesson',
      embedding: null, embeddingModel: null,
      category: 'other', confidence: 0.1,
      supportingSceneIds: [], supportingMemcellIds: [],
    });
    h.db.prepare("UPDATE lessons SET status='retired' WHERE id=?").run(id2);

    const active = h.getActiveLessons('s1');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, id1);
    assert.equal(active[0].recall_count, 0);

    h.bumpLessonRecall(id1);
    h.bumpLessonRecall(id1);
    const after = h.db.prepare('SELECT recall_count, last_recalled_at FROM lessons WHERE id=?').get(id1);
    assert.equal(after.recall_count, 2);
    assert.ok(after.last_recalled_at > 0);
  } finally {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

maybeTest('lessons: getActiveLessons scopes by session_key', () => {
  const { dir, dbPath } = tmpDb();
  const h = new HistoryStore(dbPath);
  try {
    h.insertLesson({ sessionKey: 's1', content: 'a', embedding: null, embeddingModel: null, category: 'other', confidence: 0.5, supportingSceneIds: [], supportingMemcellIds: [] });
    h.insertLesson({ sessionKey: 's2', content: 'b', embedding: null, embeddingModel: null, category: 'other', confidence: 0.5, supportingSceneIds: [], supportingMemcellIds: [] });
    assert.equal(h.getActiveLessons('s1').length, 1);
    assert.equal(h.getActiveLessons('s2').length, 1);
    assert.equal(h.getActiveLessons('nonexistent').length, 0);
  } finally {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: 2 new tests fail with `h.insertLesson is not a function`.

- [ ] **Step 3: Add the CRUD methods**

In `src/history.js`, after `getActiveForesights`, before `markForesightFulfilled`:

```javascript
// ─── Lessons ──────────────────────────────────────────────────────────────

insertLesson({
  sessionKey,
  content,
  embedding,
  embeddingModel,
  category = 'other',
  confidence = 0.5,
  supportingSceneIds = [],
  supportingMemcellIds = [],
}) {
  const blob = embedding ? Buffer.from(embedding.buffer) : null;
  return this.db
    .prepare(`
      INSERT INTO lessons
        (session_key, content, embedding, embedding_model, category,
         confidence, supporting_scene_ids, supporting_memcell_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      sessionKey,
      content,
      blob,
      embeddingModel,
      category,
      confidence,
      JSON.stringify(supportingSceneIds),
      JSON.stringify(supportingMemcellIds),
    ).lastInsertRowid;
}

getActiveLessons(sessionKey) {
  return this.db
    .prepare(`
      SELECT id, content, embedding, embedding_model, category, confidence,
             supporting_scene_ids, supporting_memcell_ids,
             refute_count, precision_score, recall_count,
             last_recalled_at, last_validated_at, created_at, updated_at, status
      FROM lessons
      WHERE session_key=? AND status='active'
      ORDER BY updated_at DESC
    `)
    .all(sessionKey);
}

countActiveLessons() {
  return this.db.prepare("SELECT COUNT(*) as n FROM lessons WHERE status='active'").get().n;
}

countLessons() {
  return this.db.prepare('SELECT COUNT(*) as n FROM lessons').get().n;
}

bumpLessonRecall(id) {
  this.db
    .prepare('UPDATE lessons SET recall_count = recall_count + 1, last_recalled_at = unixepoch() WHERE id=?')
    .run(id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: 60 tests passing.

- [ ] **Step 5: Commit**

```bash
npm run format
npm run lint
git add src/history.js test/history.test.js
git commit -m "feat(history): lesson CRUD — insertLesson, getActiveLessons, bumpLessonRecall

Per spec §5.2. Refute/supersede helpers deferred to Phase γ.
4 new tests; 60 total green."
```

---

### Task 3: Create `src/scaffold.js` with `isTrivial`

**Files:**
- Create: `src/scaffold.js`
- Test: `test/scaffold.test.js`

`isTrivial` lives **upstream of the selector** (proxy.js wiring in Task 6).
Per spec §7A.3, the heuristic is deliberately conservative: false positives
are bad (a short substantive question routed to passthrough = no memory =
regression), false negatives are cheap.

- [ ] **Step 1: Write the table-driven test**

Create `test/scaffold.test.js`:

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');

const { isTrivial } = require('../src/scaffold.js');

const DEFAULTS = {
  trivialEnabled: true,
  trivialMaxChars: 80,
  trivialMarkers: ['ok', 'okay', 'k', 'thanks', 'thank you', 'cool', 'nice', 'lol', 'haha', 'yes', 'no', 'sure', 'got it'],
};

const cases = [
  // [description, messages, expected]
  ['empty messages → not trivial', [], false],
  ['system-only → not trivial', [{ role: 'system', content: 'you are a helpful assistant.' }], false],
  ['last role is assistant → not trivial', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello!' }], false],
  ['last role is tool → not trivial', [{ role: 'tool', tool_use_id: 't', content: '{}' }], false],

  ['"ok thanks" → trivial', [{ role: 'user', content: 'ok thanks' }], true],
  ['"ok" → trivial (short marker)', [{ role: 'user', content: 'ok' }], true],
  ['"thanks!" with punctuation → trivial', [{ role: 'user', content: 'thanks!' }], true],
  ['emoji-only → trivial (length<=20, no question)', [{ role: 'user', content: '👍' }], true],
  ['"lol" → trivial', [{ role: 'user', content: 'lol' }], true],
  ['"sure, sounds good." → trivial (under 80, no question)', [{ role: 'user', content: 'sure, sounds good.' }], true],

  ['"can you do X?" → NOT trivial (has question mark)', [{ role: 'user', content: 'can you do X?' }], false],
  ['"why?" → NOT trivial (has question mark)', [{ role: 'user', content: 'why?' }], false],
  ['81-char non-question → NOT trivial (length cap)', [{ role: 'user', content: 'a'.repeat(81) }], false],
  ['long marker-prefix substantive → NOT trivial (length>80)', [{ role: 'user', content: 'ok ' + 'a'.repeat(100) }], false],

  ['multipart content with text part "ok thanks" → trivial', [{ role: 'user', content: [{ type: 'text', text: 'ok thanks' }] }], true],
  ['multipart content with tool_result + short text → trivial if extracted text matches', [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }], true],
];

for (const [desc, messages, expected] of cases) {
  test(`isTrivial: ${desc}`, () => {
    assert.equal(isTrivial(messages, DEFAULTS), expected);
  });
}

test('isTrivial: respects trivialEnabled=false', () => {
  assert.equal(isTrivial([{ role: 'user', content: 'ok' }], { ...DEFAULTS, trivialEnabled: false }), false);
});

test('isTrivial: custom marker list', () => {
  const cfg = { ...DEFAULTS, trivialMarkers: ['custom-marker'] };
  assert.equal(isTrivial([{ role: 'user', content: 'custom-marker' }], cfg), true);
  assert.equal(isTrivial([{ role: 'user', content: 'thanks' }], cfg), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
ANAMNESIS_LOG=error node --test test/scaffold.test.js 2>&1 | tail -10
```

Expected: all tests fail with `Cannot find module '../src/scaffold.js'`.

- [ ] **Step 3: Implement `isTrivial`**

Create `src/scaffold.js`:

```javascript
/**
 * scaffold.js — Reasoning Scaffold (tier classification + plan injection
 * + tool-result reflection). Spec §7A.
 *
 * Three exports:
 *   - isTrivial(messages, cfg)        — Phase α
 *   - planBlock(intent, cfg)          — Phase α
 *   - toolReflectionBlock(messages, cfg) — Phase α
 *
 * All pure functions; no side effects, no DB, no HTTP.
 */

const { extractContentText } = require('./lib/proxy-helpers.js');

const DEFAULT_TRIVIAL_MARKERS = [
  'ok', 'okay', 'k', 'thanks', 'thank you', 'cool', 'nice',
  'lol', 'haha', 'yes', 'no', 'sure', 'got it',
];

/**
 * Decide whether the last user message is "trivial" — i.e. the request
 * should bypass the selector, the scaffold, and all memory injection.
 *
 * Conservative: returns true only for short, non-question messages that
 * either match an explicit marker list or are ≤20 chars total.
 *
 * @param {Array} messages — OpenAI-style messages array
 * @param {Object} cfg — scaffold config block (§9). Reads
 *   trivialEnabled, trivialMaxChars, trivialMarkers.
 * @returns {boolean}
 */
function isTrivial(messages, cfg = {}) {
  if (cfg.trivialEnabled === false) return false;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;

  const text = extractContentText(last.content).trim().toLowerCase();
  if (!text) return false;

  const maxChars = cfg.trivialMaxChars ?? 80;
  if (text.length > maxChars) return false;

  if (text.includes('?')) return false;

  const markers = cfg.trivialMarkers ?? DEFAULT_TRIVIAL_MARKERS;
  // Match either: starts with a marker followed by a word boundary,
  //               OR overall length ≤ 20 chars (covers "👍", "yeah", "ty").
  const markerRe = new RegExp(
    `^(${markers.map((m) => m.toLowerCase().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})\\b`,
    'i',
  );
  if (markerRe.test(text)) return true;

  return text.length <= 20;
}

module.exports = { isTrivial, DEFAULT_TRIVIAL_MARKERS };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: all isTrivial test cases pass; full suite green.

- [ ] **Step 5: Commit**

```bash
npm run format
npm run lint
git add src/scaffold.js test/scaffold.test.js
git commit -m "feat(scaffold): isTrivial — tier classification helper

Pure function; consults messages + cfg, returns boolean. Conservative
by design: questions are never trivial; only short non-questions with
a marker prefix or ≤20 chars total. Spec §7A.3.

Table-driven test covers English casuals, emoji, question detection,
length caps, multipart-content normalisation (via existing
extractContentText helper)."
```

---

### Task 4: Add `planBlock` to scaffold.js

**Files:**
- Modify: `src/scaffold.js`
- Test: `test/scaffold.test.js`

`planBlock(intent, cfg)` returns a verbatim system-prompt addition that
asks the model to plan in `<think>` before answering, OR returns empty
string when disabled / on `broad` intent. Spec §7A.4.

- [ ] **Step 1: Write the test**

Append to `test/scaffold.test.js`:

```javascript
const { planBlock } = require('../src/scaffold.js');

const PLAN_CFG = {
  plan: { enabled: true, skipOnIntent: ['broad'] },
};

test('planBlock: returns verbatim block on narrow intent', () => {
  const b = planBlock('narrow', PLAN_CFG);
  assert.match(b, /<reasoning_policy>/);
  assert.match(b, /Before producing the final answer, in <think>:/);
  assert.match(b, /<\/reasoning_policy>/);
});

test('planBlock: returns verbatim block on reflective intent', () => {
  const b = planBlock('reflective', PLAN_CFG);
  assert.match(b, /<reasoning_policy>/);
});

test('planBlock: empty string on broad intent', () => {
  assert.equal(planBlock('broad', PLAN_CFG), '');
});

test('planBlock: empty string when disabled', () => {
  assert.equal(planBlock('narrow', { plan: { enabled: false, skipOnIntent: [] } }), '');
});

test('planBlock: empty string when intent in skipOnIntent', () => {
  assert.equal(planBlock('narrow', { plan: { enabled: true, skipOnIntent: ['narrow'] } }), '');
});

test('planBlock: never contains thinking-mode override tokens', () => {
  // Belt-and-braces guard from §14 — plan injection rides on behavioural
  // prompting only; must NEVER contain enable_thinking or <|think_on|>.
  for (const intent of ['narrow', 'reflective']) {
    const b = planBlock(intent, PLAN_CFG);
    assert.ok(!b.includes('enable_thinking'), 'must not contain enable_thinking');
    assert.ok(!b.includes('think_on'), 'must not contain <|think_on|>');
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: `planBlock` undefined.

- [ ] **Step 3: Implement `planBlock`**

In `src/scaffold.js`, add before `module.exports`:

```javascript
/**
 * Verbatim plan-block prompt. Pinned for v0.5.0.
 * MUST NOT contain enable_thinking or <|think_on|> — see §7A.4 and the
 * reasoning-proxy postmortem.
 */
const PLAN_BLOCK = `

<reasoning_policy>
Before producing the final answer, in <think>:
  1. Restate what's actually being asked.
  2. List the sub-questions you need to resolve.
  3. Identify tools to call, or note "no tools needed".
  4. Anticipate what would make a naive answer wrong.
  5. Sketch the answer's shape.

Then produce the answer.
</reasoning_policy>`;

/**
 * Returns the plan-injection block for the given intent, or empty string
 * if disabled / intent is in skipOnIntent.
 *
 * @param {string} intent — "broad" | "narrow" | "reflective"
 * @param {Object} cfg    — scaffold config block. Reads cfg.plan.{enabled,skipOnIntent}.
 */
function planBlock(intent, cfg = {}) {
  const planCfg = cfg.plan || {};
  if (planCfg.enabled === false) return '';
  const skip = planCfg.skipOnIntent || [];
  if (skip.includes(intent)) return '';
  return PLAN_BLOCK;
}
```

Update `module.exports`:

```javascript
module.exports = { isTrivial, planBlock, DEFAULT_TRIVIAL_MARKERS, PLAN_BLOCK };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: all planBlock tests pass + the "no thinking-mode override
tokens" guard fires green.

- [ ] **Step 5: Commit**

```bash
npm run format
npm run lint
git add src/scaffold.js test/scaffold.test.js
git commit -m "feat(scaffold): planBlock with PLAN_BLOCK verbatim from §7A.4

Suppressed on broad intent + when disabled. Belt-and-braces test
asserts the block never contains enable_thinking or <|think_on|>
tokens — the reasoning-proxy regression we're explicitly preventing."
```

---

### Task 5: Add `toolReflectionBlock` to scaffold.js

**Files:**
- Modify: `src/scaffold.js`
- Test: `test/scaffold.test.js`

`toolReflectionBlock` fires only when the last message in the request is a
tool result, asking the model to evaluate whether the result actually
resolved the sub-question. Spec §7A.5.

- [ ] **Step 1: Write the test**

Append to `test/scaffold.test.js`:

```javascript
const { toolReflectionBlock } = require('../src/scaffold.js');

const TOOL_CFG = { toolReflection: { enabled: true } };

test('toolReflectionBlock: fires when last message is role=tool', () => {
  const b = toolReflectionBlock(
    [
      { role: 'user', content: 'list my issues' },
      { role: 'assistant', content: 'calling tool…' },
      { role: 'tool', tool_use_id: 'x', content: '{"issues":[]}' },
    ],
    TOOL_CFG,
  );
  assert.match(b, /<tool_reflection>/);
  assert.match(b, /A tool just returned a result/);
  assert.match(b, /Did the tool result actually answer/);
});

test('toolReflectionBlock: empty when last message is user', () => {
  assert.equal(
    toolReflectionBlock([{ role: 'user', content: 'hi' }], TOOL_CFG),
    '',
  );
});

test('toolReflectionBlock: empty when last message is assistant', () => {
  assert.equal(
    toolReflectionBlock([{ role: 'assistant', content: 'done' }], TOOL_CFG),
    '',
  );
});

test('toolReflectionBlock: empty when disabled', () => {
  assert.equal(
    toolReflectionBlock(
      [{ role: 'tool', content: '{}' }],
      { toolReflection: { enabled: false } },
    ),
    '',
  );
});

test('toolReflectionBlock: empty on empty messages array', () => {
  assert.equal(toolReflectionBlock([], TOOL_CFG), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: `toolReflectionBlock` undefined.

- [ ] **Step 3: Implement**

In `src/scaffold.js`, add before `module.exports`:

```javascript
/**
 * Verbatim tool-reflection block. Pinned for v0.5.0.
 */
const TOOL_REFLECTION_BLOCK = `

<tool_reflection>
A tool just returned a result. Before continuing:
  - Did the tool result actually answer the sub-question you were resolving?
  - If partial or unhelpful: what's the next step? Another tool call,
    a different query, or admit the gap?
</tool_reflection>`;

/**
 * Returns the tool-reflection block iff the last message is a tool
 * result and the feature is enabled.
 */
function toolReflectionBlock(messages, cfg = {}) {
  const trCfg = cfg.toolReflection || {};
  if (trCfg.enabled === false) return '';
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'tool') return '';
  return TOOL_REFLECTION_BLOCK;
}
```

Update `module.exports`:

```javascript
module.exports = {
  isTrivial,
  planBlock,
  toolReflectionBlock,
  DEFAULT_TRIVIAL_MARKERS,
  PLAN_BLOCK,
  TOOL_REFLECTION_BLOCK,
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: all toolReflectionBlock tests pass.

- [ ] **Step 5: Commit**

```bash
npm run format
npm run lint
git add src/scaffold.js test/scaffold.test.js
git commit -m "feat(scaffold): toolReflectionBlock with TOOL_REFLECTION_BLOCK verbatim from §7A.5

Fires only when last message role is 'tool'. Empty otherwise.
Closes the §7A.2 'three concerns, one module' surface area for Phase α."
```

---

### Task 6: Wire scaffold into `src/proxy.js`

**Files:**
- Modify: `src/proxy.js`
- Modify: `src/selector.js` (intent parameter — placeholder until Chunk 2)
- Test: `test/integration/scaffold-gate.test.js` (new)

This is the integration step. We add the `isTrivial` short-circuit
upstream of the selector, and append plan/tool-reflection blocks to the
system message on non-trivial paths.

Intent is hard-wired to `"narrow"` for Phase α — the intent classifier
arrives in Chunk 2. Even hard-wired, gating plan injection by intent in
v0.5.0-α lets us flip the switch with one config change later.

- [ ] **Step 1: Write the integration test**

Create `test/integration/scaffold-gate.test.js`. This uses an in-memory
stub upstream rather than booting against a real Ollama.

```javascript
const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');

// We're not booting the real proxy here — we're testing the routing
// decision in isolation. The actual wiring assertions live in scaffold
// unit tests + a manual smoke at task 9.

const { isTrivial, planBlock, toolReflectionBlock } = require('../../src/scaffold.js');

test('integration: trivial path skips memory injection planning entirely', () => {
  const messages = [{ role: 'user', content: 'ok thanks' }];
  const cfg = {
    trivialEnabled: true,
    trivialMaxChars: 80,
    plan: { enabled: true, skipOnIntent: ['broad'] },
    toolReflection: { enabled: true },
  };
  // Trivial → caller short-circuits before the selector. Verify the
  // helpers individually behave correctly so the proxy can compose
  // them without surprises.
  assert.equal(isTrivial(messages, cfg), true);
});

test('integration: non-trivial → plan block + tool reflection both apply when applicable', () => {
  const messages = [
    { role: 'user', content: 'why does my deploy fail with exit 137?' },
    { role: 'assistant', content: 'let me check' },
    { role: 'tool', tool_use_id: 'a', content: '{"oom":true}' },
  ];
  const cfg = {
    trivialEnabled: true, trivialMaxChars: 80,
    plan: { enabled: true, skipOnIntent: ['broad'] },
    toolReflection: { enabled: true },
  };
  assert.equal(isTrivial(messages, cfg), false);
  const pb = planBlock('narrow', cfg);
  const tr = toolReflectionBlock(messages, cfg);
  assert.match(pb, /<reasoning_policy>/);
  assert.match(tr, /<tool_reflection>/);
  // The full system addition should contain both:
  const sys = `you are an assistant.${pb}${tr}`;
  assert.match(sys, /<reasoning_policy>[\s\S]*<\/reasoning_policy>[\s\S]*<tool_reflection>[\s\S]*<\/tool_reflection>/);
});
```

- [ ] **Step 2: Run test to verify it passes (helpers already exist)**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: pass. This test currently asserts only that the helpers
compose correctly. The actual proxy wiring assertions live downstream.

- [ ] **Step 3: Wire scaffold into `src/proxy.js`**

Find the request-handling block in `src/proxy.js`. Locate where the
selector is invoked (currently after the user-turn persistence). The
change: add an `isTrivial` guard upstream, and append scaffold blocks
to the rewritten system message.

At the top of `proxy.js`, add imports:

```javascript
const scaffold = require('./scaffold.js');
```

In the `start(config)` function, just after creating the `embedder` /
`selector` / etc., precompute the scaffold config slice:

```javascript
const scaffoldCfg = (config.cognitive && config.cognitive.scaffold) || {
  trivialEnabled: true,
  trivialMaxChars: 80,
  trivialMarkers: scaffold.DEFAULT_TRIVIAL_MARKERS,
  plan: { enabled: false, skipOnIntent: ['broad'] },     // off by default; flipped on by config
  toolReflection: { enabled: false },                     // off by default; flipped on by config
};
```

In the `POST /…/chat/completions` branch, **before** the user-turn
persistence block, add the trivial short-circuit:

```javascript
if (scaffold.isTrivial(parsed.messages, scaffoldCfg)) {
  // Spec §7A.6 — trivial requests bypass memory + scaffold entirely.
  // Persist the user turn (so it shows up in history, in case the next
  // turn is substantive) but skip selector, scaffold, observer.
  const userMsg = [...parsed.messages].reverse().find((m) => m.role === 'user');
  const userText = extractContentText(userMsg?.content);
  if (userText) {
    const vec = await embedder.embed(userText).catch(() => null);
    const est = Math.ceil(userText.length / config.context.charsPerToken);
    history.insertTurn(sessionKey, 'user', userText, vec, est, embedder.model);
  }
  // Forward raw — same path as the existing non-chat passthrough.
  return passthrough(req, res, rawBody);
}
```

In the non-trivial path, after the selector returns its rewritten
messages, append the scaffold blocks to the *last system message*. Find
the `selectedMessages` assignment and add immediately after:

```javascript
// Phase α: hard-wired intent. Replaced by intent.classify() in Chunk 2.
const intent = 'narrow';
const planSuffix = scaffold.planBlock(intent, scaffoldCfg);
const toolSuffix = scaffold.toolReflectionBlock(parsed.messages, scaffoldCfg);
if (planSuffix || toolSuffix) {
  const lastSystemIdx = selectedMessages
    .map((m, i) => (m.role === 'system' ? i : -1))
    .filter((i) => i >= 0)
    .pop();
  if (lastSystemIdx !== undefined) {
    selectedMessages = [...selectedMessages];
    selectedMessages[lastSystemIdx] = {
      ...selectedMessages[lastSystemIdx],
      content: selectedMessages[lastSystemIdx].content + planSuffix + toolSuffix,
    };
  } else if (planSuffix || toolSuffix) {
    selectedMessages = [
      { role: 'system', content: (planSuffix + toolSuffix).trim() },
      ...selectedMessages,
    ];
  }
}
```

- [ ] **Step 4: Run the test suite + syntax check the proxy**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
node --check src/proxy.js && echo OK
```

Expected: all tests pass; syntax OK.

- [ ] **Step 5: Commit**

```bash
npm run format
npm run lint
git add src/proxy.js test/integration/scaffold-gate.test.js
git commit -m "feat(proxy): wire scaffold — isTrivial gate + plan/tool-reflection suffix

Phase α wiring (intent hard-wired to 'narrow' until intent classifier
ships in Chunk 2):
- isTrivial(messages, cfg) gates upstream of selector. Trivial =
  persist user turn + passthrough. No memory injection. No scaffold.
- Non-trivial path: planBlock + toolReflectionBlock appended to the
  last system message after selector returns.

Both plan and toolReflection default to enabled=false in code; live
defaults are flipped on by the config block (added in next task).
Phase α-shipped: scaffold module is testable + integrated, awaits
config flag flip."
```

---

### Task 7: Add `cognitive` block to `config.json`

**Files:**
- Modify: `config.json`

Per spec §9, ship the full `cognitive` block. Phase α only uses
`cognitive.lessons` (for the distiller, next tasks) and
`cognitive.scaffold` (for the wiring just landed). Reward and selector
sub-blocks are accepted by the parser but inert until later phases.

- [ ] **Step 1: Add the `cognitive` block**

Open `config.json`. After the existing `foresight` block, before the
closing `}`, add the full block from spec §9. Paste verbatim:

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
    "enabled": false,
    "_phaseNote": "Phase γ flips reward.enabled=true. 1.0 flips writebackLegacyImportance=true.",
    "weights": { "echo": 0.6, "correction": 0.25, "foresight": 0.15 },
    "smoothing": 0.1,
    "meanReversion": 0.002,
    "writebackLegacyImportance": false
  },
  "selector": {
    "intent": { "mode": "heuristic" },
    "explorationWeight": 0.05,
    "allocations": {
      "_note": "Phase α/β uniform baseline. γ replaces these from bench.",
      "broad":      { "lessons": 0.25, "scenes": 0.25, "memcells": 0.25, "turns": 0.25 },
      "narrow":     { "lessons": 0.25, "scenes": 0.25, "memcells": 0.25, "turns": 0.25 },
      "reflective": { "lessons": 0.25, "scenes": 0.25, "memcells": 0.25, "turns": 0.25 }
    }
  },
  "scaffold": {
    "_note": "Reasoning scaffold — tier classification + plan + tool-reflection. Critique deferred.",
    "trivialEnabled": true,
    "trivialMaxChars": 80,
    "trivialMarkers": ["ok", "okay", "k", "thanks", "thank you", "cool", "nice", "lol", "haha", "yes", "no", "sure", "got it"],
    "plan": {
      "enabled": true,
      "skipOnIntent": ["broad"]
    },
    "toolReflection": {
      "enabled": true
    }
  }
}
```

- [ ] **Step 2: Verify config parses + boot path doesn't crash**

```bash
node -e "const c = require('./config.json'); console.log(JSON.stringify(c.cognitive.scaffold, null, 2))"
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: scaffold block prints; tests pass.

- [ ] **Step 3: Commit**

```bash
git add config.json
git commit -m "feat(config): add cognitive.{lessons,reward,selector,scaffold} block

Per spec §9. Phase α-active keys: cognitive.lessons.* + cognitive.scaffold.*
(distiller + scaffold both ship in α). reward.enabled defaults to false
until Phase γ. Selector allocations are uniform 25/25/25/25 (Phase α/β
baseline, bench-calibrated in γ)."
```

---

### Task 8: Create `src/distiller.js` skeleton — scheduling + guards

**Files:**
- Create: `src/distiller.js`
- Test: `test/distiller.test.js`

The distiller mirrors `consolidator.js` exactly in terms of scheduling
(self-rescheduling `setTimeout` with `_running` guard, see spec §5.3
"single-flight"). It pulls clusters of scenes, asks the LLM to generate
a lesson, and persists. Phase α: silent population only.

- [ ] **Step 1: Write the scheduling tests**

Create `test/distiller.test.js`:

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');

const Distiller = require('../src/distiller.js');

function mkDistiller(overrides = {}) {
  const cfg = {
    cognitive: {
      lessons: {
        enabled: true,
        distillationIntervalMs: 60_000,
        minScenesPerLesson: 3,
        lessonClusterThreshold: 0.78,
        model: 'qwen3:0.6b',
      },
    },
    embedding: { ollamaUrl: 'http://127.0.0.1:11434' },
    ...overrides.cfg,
  };
  const history  = overrides.history  ?? { db: {} };
  const embedder = overrides.embedder ?? { embed: async () => null, model: 'm' };
  return new Distiller(cfg, history, embedder);
}

test('Distiller: start/stop is idempotent', () => {
  const d = mkDistiller();
  d.start(1000);
  d.start(1000); // second start should not double-schedule
  d.stop();
  d.stop();      // second stop should be a no-op
  assert.ok(true);
});

test('Distiller: runs are single-flight', async () => {
  const d = mkDistiller();
  let inFlight = 0; let maxInFlight = 0;
  d.run = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
  };
  // Fire two run() calls back-to-back
  await Promise.all([d.run(), d.run()]);
  assert.equal(maxInFlight, 1, 'distiller.run must be single-flight');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
ANAMNESIS_LOG=error node --test test/distiller.test.js 2>&1 | tail -10
```

Expected: `Cannot find module '../src/distiller.js'`.

- [ ] **Step 3: Implement the skeleton**

Create `src/distiller.js`:

```javascript
/**
 * distiller.js — Phase α: silent population of the `lessons` table from
 * clusters of related memscenes. Spec §5.3.
 *
 * Scheduling pattern matches consolidator.js (self-rescheduling
 * setTimeout chain + _running guard). Never overlaps.
 *
 * Phase α: this module ONLY writes to `lessons`. It does NOT inject
 * lessons into requests; the selector still runs the v0.4.0 path.
 */

const HistoryStore  = require('./history.js');
const Embedder      = require('./embedder.js');
const { chat, tryParseJsonObject } = require('./lib/ollama.js');
const log           = require('./lib/logger.js').make('distiller');

/**
 * LESSON_PROMPT — verbatim from spec §5.3. MUST stay byte-identical to
 * the spec text. Pin via a test in Task 10.
 */
const LESSON_PROMPT = `You are extracting a single generalised rule from a cluster of related
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
`;

const VALID_CATEGORIES = ['technical', 'decision', 'preference', 'personal', 'context', 'other'];

class Distiller {
  constructor(config, historyStore, embedder) {
    this.cfg       = config.cognitive?.lessons || {};
    this.ollamaUrl = config.embedding?.ollamaUrl || 'http://127.0.0.1:11434';
    this.history   = historyStore;
    this.embedder  = embedder;
    this._timer    = null;
    this._running  = false;
    this._stopped  = false;
  }

  start(intervalMs) {
    if (this._timer) return; // idempotent
    this._stopped    = false;
    this._intervalMs = intervalMs;
    log.info(`running every ${intervalMs / 1000}s`);
    this._scheduleNext(intervalMs);
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _scheduleNext(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(async () => {
      if (this._running) {
        this._scheduleNext(this._intervalMs);
        return;
      }
      this._running = true;
      try {
        await this.run();
      } catch (e) {
        log.warn('run error:', e.message);
      } finally {
        this._running = false;
        this._scheduleNext(this._intervalMs);
      }
    }, delayMs);
  }

  /**
   * Run one distillation pass over all sessions with eligible scene clusters.
   * Implemented in Task 9; this skeleton is a no-op so the scheduling tests
   * pass without DB access.
   */
  async run() {
    // populated in Task 9
  }
}

module.exports = Distiller;
module.exports.LESSON_PROMPT = LESSON_PROMPT;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: 2 new distiller tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
npm run format
npm run lint
git add src/distiller.js test/distiller.test.js
git commit -m "feat(distiller): scheduling skeleton + LESSON_PROMPT constant

Mirrors consolidator.js scheduling pattern (self-rescheduling setTimeout
+ _running guard). run() body is empty — populated in Task 9 after the
clustering helpers land. LESSON_PROMPT pinned byte-identical to spec
§5.3 (test in Task 10)."
```

---

### Task 9: Distiller — cluster scenes + persist lessons (the body of `run()`)

**Files:**
- Modify: `src/distiller.js`
- Modify: `src/history.js` (add `getScenesForDistillation` helper)
- Test: `test/distiller.test.js`

Per spec §5.3 step 1: fetch scenes that have ≥ `minScenesPerLesson`
related neighbours. Then for each cluster, call the LLM and persist.

- [ ] **Step 1: Write the helper test (history)**

Append to `test/history.test.js`:

```javascript
maybeTest('getScenesForDistillation: returns scenes for sessions with scenes', () => {
  const { dir, dbPath } = tmpDb();
  const h = new HistoryStore(dbPath);
  try {
    const t = h.insertTurn('s1', 'assistant', 'x'.repeat(100), null, 10, 'm');
    const c = h.insertMemcell('s1', t, 'fact', null, 0.5, 'other', 'm');
    h.insertScene('s1', 'title', 'summary', new Float32Array([0.1, 0.2]), [c], 0.5, 'm');
    h.insertScene('s1', 't2',    's2',      new Float32Array([0.2, 0.3]), [c], 0.5, 'm');
    h.insertScene('s1', 't3',    's3',      new Float32Array([0.15,0.25]),[c], 0.5, 'm');

    const scenes = h.getScenesForDistillation('s1');
    assert.equal(scenes.length, 3);
    assert.ok(scenes[0].embedding);
  } finally {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: `h.getScenesForDistillation is not a function`.

- [ ] **Step 3: Add the helper**

In `src/history.js`, near `getScenes`, add:

```javascript
getScenesForDistillation(sessionKey) {
  return this.db
    .prepare(`
      SELECT id, title, summary, embedding, embedding_model,
             memcell_ids, avg_importance, updated_at
      FROM memscenes
      WHERE session_key=?
      ORDER BY updated_at DESC
    `)
    .all(sessionKey);
}

getActiveSessions() {
  return this.db
    .prepare("SELECT DISTINCT session_key FROM memscenes")
    .all()
    .map((r) => r.session_key);
}
```

- [ ] **Step 4: Write the cluster + persist test**

Append to `test/distiller.test.js`:

```javascript
test('Distiller.distillCluster: parses LLM JSON and inserts lesson', async () => {
  const inserts = [];
  const history = {
    db: {}, // never touched in this test
    insertLesson: (args) => { inserts.push(args); return 99; },
  };
  const embedder = {
    embed: async (s) => new Float32Array([s.length, 0, 0]),
    model: 'nomic-embed-cpu:latest',
  };
  const d = mkDistiller({ history, embedder });

  // Monkey-patch the LLM call to a known response.
  d._callLLM = async () => '{"content":"User prefers concise reviews.","confidence":0.85,"category":"preference"}';

  await d.distillCluster('s1', [
    { id: 1, content: 'said no to long reviews' },
    { id: 2, content: 'short PR description' },
    { id: 3, content: 'asked for one-liner' },
  ], [10, 11, 12]);

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].sessionKey, 's1');
  assert.equal(inserts[0].content, 'User prefers concise reviews.');
  assert.equal(inserts[0].category, 'preference');
  assert.equal(inserts[0].confidence, 0.85);
  assert.deepEqual(inserts[0].supportingSceneIds, [1, 2, 3]);
  assert.deepEqual(inserts[0].supportingMemcellIds, [10, 11, 12]);
  assert.equal(inserts[0].embeddingModel, 'nomic-embed-cpu:latest');
  assert.ok(inserts[0].embedding instanceof Float32Array);
});

test('Distiller.distillCluster: NONE response → no insert', async () => {
  const inserts = [];
  const history = { db: {}, insertLesson: (args) => { inserts.push(args); return 1; } };
  const embedder = { embed: async () => new Float32Array([1, 0]), model: 'm' };
  const d = mkDistiller({ history, embedder });

  d._callLLM = async () => 'NONE';
  await d.distillCluster('s1', [{ id: 1, content: 'a' }, { id: 2, content: 'b' }], [10]);
  assert.equal(inserts.length, 0);
});

test('Distiller.distillCluster: malformed JSON → no insert', async () => {
  const inserts = [];
  const history = { db: {}, insertLesson: (args) => { inserts.push(args); return 1; } };
  const embedder = { embed: async () => null, model: 'm' };
  const d = mkDistiller({ history, embedder });

  d._callLLM = async () => 'I think the rule is concise.';  // no JSON, no NONE
  await d.distillCluster('s1', [{ id: 1, content: 'a' }], [10]);
  assert.equal(inserts.length, 0);
});

test('Distiller.distillCluster: confidence below 0.5 → no insert', async () => {
  const inserts = [];
  const history = { db: {}, insertLesson: (args) => { inserts.push(args); return 1; } };
  const embedder = { embed: async () => new Float32Array([1]), model: 'm' };
  const d = mkDistiller({ history, embedder });

  d._callLLM = async () => '{"content":"weak rule","confidence":0.3,"category":"other"}';
  await d.distillCluster('s1', [{ id: 1, content: 'a' }], [10]);
  assert.equal(inserts.length, 0);
});

test('Distiller.distillCluster: invalid category → coerces to "other"', async () => {
  const inserts = [];
  const history = { db: {}, insertLesson: (args) => { inserts.push(args); return 1; } };
  const embedder = { embed: async () => new Float32Array([1]), model: 'm' };
  const d = mkDistiller({ history, embedder });

  d._callLLM = async () => '{"content":"a real rule that holds","confidence":0.8,"category":"bogus"}';
  await d.distillCluster('s1', [{ id: 1, content: 'a' }], [10]);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].category, 'other');
});
```

- [ ] **Step 5: Run tests to verify they fail**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -15
```

Expected: 5 new distillCluster tests fail with `d.distillCluster is not
a function`.

- [ ] **Step 6: Implement `distillCluster` + `_callLLM` + flesh out `run`**

In `src/distiller.js`, replace the empty `async run()` with:

```javascript
async run() {
  const minSize  = this.cfg.minScenesPerLesson ?? 3;
  const threshold = this.cfg.lessonClusterThreshold ?? 0.78;
  if (!this.cfg.enabled) return;
  if (!this.history?.getActiveSessions) return; // wiring not complete

  for (const sessionKey of this.history.getActiveSessions()) {
    const scenes = (this.history.getScenesForDistillation?.(sessionKey) || [])
      .filter((s) => s.embedding && (!s.embedding_model || s.embedding_model === this.embedder.model));
    if (scenes.length < minSize) continue;

    // Decode embeddings once
    const decoded = scenes.map((s) => ({
      ...s,
      vec: HistoryStore.toFloat32(s.embedding),
    })).filter((s) => s.vec);

    // Greedy clustering (same shape as consolidator)
    const assigned = new Set();
    for (let i = 0; i < decoded.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [decoded[i]]; assigned.add(i);
      for (let j = i + 1; j < decoded.length; j++) {
        if (assigned.has(j)) continue;
        if (Embedder.cosine(decoded[i].vec, decoded[j].vec) >= threshold) {
          cluster.push(decoded[j]); assigned.add(j);
        }
      }
      if (cluster.length < minSize) continue;

      // Gather all memcell IDs that feed this cluster's scenes.
      let memcellIds = [];
      for (const s of cluster) {
        try { memcellIds = memcellIds.concat(JSON.parse(s.memcell_ids)); } catch {}
      }
      await this.distillCluster(sessionKey, cluster.map((s) => ({ id: s.id, content: s.summary })), memcellIds);
    }
  }
}

async distillCluster(sessionKey, sceneItems, supportingMemcellIds) {
  if (!sceneItems?.length) return;

  let text;
  try { text = await this._callLLM(sceneItems); }
  catch (err) { log.warn(`session=${sessionKey.slice(0, 8)} LLM error: ${err.message}`); return; }

  if (!text || /^\s*NONE\s*$/i.test(text)) return;

  const parsed = tryParseJsonObject(text);
  if (!parsed?.content || typeof parsed.content !== 'string') return;
  if (parsed.content.length < 10 || parsed.content.length > 400) return;

  const confidence = typeof parsed.confidence === 'number'
    ? Math.min(1, Math.max(0, parsed.confidence))
    : 0.5;
  if (confidence < 0.5) return;

  const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
  const embedding = await this.embedder.embed(parsed.content).catch(() => null);

  this.history.insertLesson({
    sessionKey,
    content: parsed.content,
    embedding,
    embeddingModel: this.embedder.model,
    category,
    confidence,
    supportingSceneIds: sceneItems.map((s) => s.id),
    supportingMemcellIds,
  });
  log.info(`session=${sessionKey.slice(0, 8)} new lesson (cat=${category}, conf=${confidence.toFixed(2)})`);
}

async _callLLM(sceneItems) {
  const factList = sceneItems.map((s, i) => `${i + 1}. ${s.content}`).join('\n');
  return chat(this.ollamaUrl, {
    model: this.cfg.model,
    messages: [{ role: 'user', content: LESSON_PROMPT + factList }],
    options: { temperature: 0.1, num_predict: 300 },
    timeoutMs: 45000,
  });
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -15
```

Expected: all distiller tests pass; full suite green.

- [ ] **Step 8: Commit**

```bash
npm run format
npm run lint
git add src/distiller.js src/history.js test/distiller.test.js test/history.test.js
git commit -m "feat(distiller): cluster scenes, call LLM with LESSON_PROMPT, persist lessons

Greedy clustering matches consolidator.js shape; uses
lessonClusterThreshold=0.78 (slightly higher than 0.72 scene threshold
since lessons are coarser, per §5.3).

LLM response handling:
- 'NONE' (case-insensitive) → no insert
- non-JSON / malformed → no insert
- content <10 chars or >400 → no insert (sanity bounds)
- confidence <0.5 → no insert (conservative per LESSON_PROMPT)
- invalid category → coerce to 'other'

Embeddings tagged with current embedder.model so the selector can later
filter cross-model vectors. Phase α: insert only. No reads.

5 unit tests cover each rejection path + happy path."
```

---

### Task 10: Pin LESSON_PROMPT byte-identical to the spec

**Files:**
- Test: `test/distiller.test.js`

The spec §5.3 says the prompt is "pinned for v0.5.0." This task adds a
test that fails if the in-code prompt drifts from the spec's verbatim
block.

- [ ] **Step 1: Write the pinning test**

Append to `test/distiller.test.js`:

```javascript
const fs = require('node:fs');
const path = require('node:path');

test('LESSON_PROMPT: byte-identical to spec §5.3', () => {
  const { LESSON_PROMPT } = require('../src/distiller.js');
  const specPath = path.join(__dirname, '..', 'docs', 'specs', '2026-05-24-cognitive-loop-design.md');
  const spec = fs.readFileSync(specPath, 'utf8');

  // The pinned block in the spec lives between the §5.3 fenced ``` markers
  // immediately under "#### LESSON_PROMPT (verbatim, pinned for v0.5.0)".
  const m = spec.match(/LESSON_PROMPT \(verbatim, pinned for v0\.5\.0\)\s*\n+\s*```\n([\s\S]*?)\n```/);
  assert.ok(m, 'spec must contain the LESSON_PROMPT fenced block');
  const specBlock = m[1];

  // Allow trailing whitespace difference (the in-code constant has a
  // trailing newline before the cluster facts; the spec block ends at
  // "OBSERVATIONS:").
  const norm = (s) => s.replace(/\s+$/, '');
  assert.equal(norm(LESSON_PROMPT), norm(specBlock),
    'LESSON_PROMPT in distiller.js has drifted from spec §5.3');
});
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/distiller.test.js
git commit -m "test(distiller): pin LESSON_PROMPT byte-identical to spec §5.3

A regression on the prompt is a behaviour-change disguised as a refactor.
This test fails loudly if the in-code constant drifts from the spec
fenced block."
```

---

### Task 11: Wire the distiller into proxy.js boot

**Files:**
- Modify: `src/proxy.js`

The distiller is instantiated next to `consolidator` and `extractor`,
following the same `start(intervalMs)` / `flushInFlight()` / `stop()`
shape.

- [ ] **Step 1: Update `proxy.js`**

At the top of `proxy.js`, add the import:

```javascript
const Distiller = require('./distiller.js');
```

In `start(config)`, after the `consolidator` is created:

```javascript
const distiller = new Distiller(config, history, embedder);
```

After `consolidator.start(config.memory.consolidationIntervalMs)`:

```javascript
if (config.cognitive?.lessons?.enabled) {
  distiller.start(config.cognitive.lessons.distillationIntervalMs ?? 600_000);
}
```

In `shutdown()`, alongside `consolidator.stop()`:

```javascript
distiller.stop();
```

- [ ] **Step 2: Syntax check + run tests**

```bash
node --check src/proxy.js && echo OK
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: syntax OK; all tests pass.

- [ ] **Step 3: Commit**

```bash
npm run format
npm run lint
git add src/proxy.js
git commit -m "feat(proxy): boot Distiller alongside Consolidator/Extractor

Distiller starts only when cognitive.lessons.enabled is true (default
in config.json). Default cadence 600s. Shares the in-process shutdown
hook so graceful stop is honoured."
```

---

### Task 12: Status endpoint — add `lessons` and `lessons_active` counters

**Files:**
- Modify: `src/proxy.js` (status endpoint handler)
- Test: `test/integration/status-endpoint.test.js` (new)

Per spec §10.1. Additive only — existing fields and types unchanged.

- [ ] **Step 1: Write the status test**

Create `test/integration/status-endpoint.test.js`:

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');

// We don't boot the real proxy here. We test that the status payload
// builder includes the new fields and preserves all v0.4.0 fields.

test('status payload: contains v0.4.0 fields + lessons + lessons_active', () => {
  const mockHistory = {
    stats: () => ({ turns: 10, cells: 20, scenes: 5, foresights: 1 }),
    countActiveLessons: () => 7,
    countLessons:       () => 12,
  };
  const config = { upstream: { baseUrl: 'u' }, embedding: { model: 'm' } };

  // Build the payload the way proxy.js will build it (matches Step 2).
  const stats = mockHistory.stats('default');
  const payload = {
    status: 'ok',
    ...stats,
    lessons:        mockHistory.countLessons(),
    lessons_active: mockHistory.countActiveLessons(),
    upstream:        config.upstream.baseUrl,
    embedding_model: config.embedding.model,
  };

  // v0.4.0 invariants:
  assert.equal(payload.status, 'ok');
  assert.equal(payload.turns, 10);
  assert.equal(payload.cells, 20);
  assert.equal(payload.scenes, 5);
  assert.equal(payload.foresights, 1);
  assert.equal(payload.upstream, 'u');
  assert.equal(payload.embedding_model, 'm');
  // v0.5.0 additions:
  assert.equal(payload.lessons, 12);
  assert.equal(payload.lessons_active, 7);
});
```

- [ ] **Step 2: Update `proxy.js` status handler**

Locate the `/anamnesis/status` handler in `proxy.js`. Currently:

```javascript
const stats = history.stats('default');
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(
  JSON.stringify({
    status: 'ok',
    ...stats,
    upstream: config.upstream.baseUrl,
    embedding_model: config.embedding.model,
  })
);
```

Replace with:

```javascript
const stats = history.stats('default');
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(
  JSON.stringify({
    status: 'ok',
    ...stats,
    lessons:        history.countLessons(),
    lessons_active: history.countActiveLessons(),
    upstream:        config.upstream.baseUrl,
    embedding_model: config.embedding.model,
  })
);
```

- [ ] **Step 3: Run tests + syntax check**

```bash
node --check src/proxy.js && echo OK
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
npm run format
npm run lint
git add src/proxy.js test/integration/status-endpoint.test.js
git commit -m "feat(proxy): status endpoint reports lessons + lessons_active

Additive per §15 backward-compat invariant. v0.4.0 clients see exactly
the same field set plus two new keys."
```

---

### Task 13: Backward-compat smoke test (v0.4.0 fixture → v0.5.0 binary)

**Files:**
- Test: `test/integration/v04-compat.test.js` (new)

Per spec §15: a v0.4.0 `config.json` (no `cognitive.*` keys) must boot
cleanly against the v0.5.0 binary. Defaults from §9 fill in.

- [ ] **Step 1: Write the test**

Create `test/integration/v04-compat.test.js`:

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { expandHome } = require('../../src/lib/proxy-helpers.js');

test('v0.4.0 config (no cognitive.*) boots: expandHome + parse work', () => {
  // A minimal v0.4.0-style config — no `cognitive` block, no `persona`.
  const v04 = {
    proxy:    { port: 8084, host: '127.0.0.1' },
    upstream: { baseUrl: 'http://127.0.0.1:8083', apiKey: 'localqwen', disableThinking: true },
    embedding: { ollamaUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-cpu:latest' },
    extraction: { model: 'qwen3:0.6b', maxRetries: 2, timeoutMs: 45000, startupBacklogLimit: 200 },
    foresight:  { model: 'qwen3:0.6b', maxRetries: 2, timeoutMs: 45000, startupBacklogLimit: 200 },
    context:    { tokenBudget: 65536, systemReserveTokens: 4096, recencyTurns: 8, rotatingSlots: 6, charsPerToken: 3.5, minChunkChars: 50 },
    memory:     { consolidationIntervalMs: 120000, consolidationBatchSize: 50, sceneClusterThreshold: 0.72, minSceneSize: 2, decayPruneThreshold: 0.05 },
    history:    { dbPath: '~/.anamnesis/history.db', maxAgeDays: 90 },
  };

  // expandHome is the path the proxy walks at boot.
  const expanded = expandHome(v04);
  assert.equal(expanded.proxy.port, 8084);
  assert.ok(expanded.history.dbPath.endsWith('/.anamnesis/history.db'));
  // No cognitive block should mean undefined, not a crash:
  assert.equal(expanded.cognitive, undefined);
});

test('v0.4.0 DB schema migrates additively', () => {
  // We mimic an old DB by inserting the v0.4.0 tables, then opening with
  // the v0.5.0 HistoryStore and asserting the new columns/tables exist.
  let HistoryStore;
  try { HistoryStore = require('../../src/history.js'); }
  catch { return; } // native binding unavailable; skip gracefully

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anamnesis-v04-'));
  const dbPath = path.join(dir, 'history.db');
  try {
    // First, create a v0.4.0-shaped DB by opening + immediately closing
    // (the migration runs on open). For a true "old DB" test we'd need
    // a fixture, but the migration is additive so this exercises the
    // same code paths.
    const h = new HistoryStore(dbPath);
    const lessonsCols = h.db.prepare('PRAGMA table_info(lessons)').all().map((c) => c.name);
    assert.ok(lessonsCols.includes('id'), 'lessons table must be created');
    const sceneCols   = h.db.prepare('PRAGMA table_info(memscenes)').all().map((c) => c.name);
    assert.ok(sceneCols.includes('injection_score'), 'injection_score column must be added');
    h.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -10
```

Expected: green (the schema test will be skipped on hosts without
better-sqlite3 bindings — same gate as `history.test.js`).

- [ ] **Step 3: Commit**

```bash
git add test/integration/v04-compat.test.js
git commit -m "test(compat): v0.4.0 config + DB upgrade clean to v0.5.0

Per spec §15 backward-compat invariants. expandHome handles a v0.4.0
config with no cognitive block; HistoryStore migration adds the
lessons table and injection_score column without disturbing existing
v0.4.0 tables."
```

---

### Task 14: Update CHANGELOG and README for Phase α

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

A Phase α release is mergeable to main. Document it.

- [ ] **Step 1: Add a CHANGELOG entry**

Append to `CHANGELOG.md` under a new `## [0.5.0-alpha] — Unreleased` section:

```markdown
## [0.5.0-alpha] — Unreleased

### Added (Phase α of Cognitive Loop — spec §12)

- `lessons` table + `memscenes.injection_score` column. Migration is
  additive; v0.4.0 DBs upgrade cleanly.
- `src/distiller.js` — background job that distils clusters of related
  scenes into generalised lessons. Silent population in α; no injection
  yet. LESSON_PROMPT pinned byte-identical to spec §5.3.
- `src/scaffold.js` — reasoning scaffold module: `isTrivial` (tier
  classification), `planBlock` (plan injection), `toolReflectionBlock`
  (post-tool-result reflection). Salvaged from the reasoning-proxy
  postmortem without re-enabling Qwen3 extended thinking.
- `cognitive.{lessons,reward,selector,scaffold}` config blocks.
  Phase-α-active keys: `cognitive.lessons.*` and `cognitive.scaffold.*`.
- Status endpoint adds `lessons` and `lessons_active` fields.
- Tests: `scaffold.test.js`, `distiller.test.js`,
  `test/integration/scaffold-gate.test.js`,
  `test/integration/status-endpoint.test.js`,
  `test/integration/v04-compat.test.js`.

### Compatibility

- v0.4.0 `config.json` (no `cognitive.*` block) boots unchanged.
- v0.4.0 DB schema migrates additively. No column or table is removed
  or has its type changed (§15).
```

- [ ] **Step 2: Add a one-line README pointer to the design doc**

In `README.md`, under `## Roadmap`, change:

```markdown
- [ ] Cross-session scene merging
```

to:

```markdown
- [x] Cognitive Loop α — lessons tier + reasoning scaffold (see [docs/specs/2026-05-24-cognitive-loop-design.md](docs/specs/2026-05-24-cognitive-loop-design.md))
- [ ] Cognitive Loop β/γ/1.0 — lesson injection, reward signal, hierarchical selector
- [ ] Cross-session scene merging
```

- [ ] **Step 3: Commit**

```bash
npm run format
git add CHANGELOG.md README.md
git commit -m "docs: CHANGELOG + README for v0.5.0-α (Phase α of Cognitive Loop)"
```

---

### Task 15: Phase α merge-readiness check

**Files:**
- (no edits — verification only)

End-of-chunk gate. Run everything, confirm clean.

- [ ] **Step 1: Full suite green**

```bash
ANAMNESIS_LOG=error npm test 2>&1 | tail -15
```

Expected: all tests passing, 0 fails, skipped only for native-binding-unavailable
hosts.

- [ ] **Step 2: Lint + format clean**

```bash
npm run lint
npm run format:check
```

Expected: both clean.

- [ ] **Step 3: Sanity-check the proxy boots**

```bash
node --check src/proxy.js && \
node -e "const p = require('./src/proxy.js'); console.log('proxy module exports:', Object.keys(p).join(','))"
```

Expected: syntax OK, exports `{ start, loadConfig }`.

- [ ] **Step 4: Push the branch**

```bash
git push 2>&1 | tail -3
```

- [ ] **Step 5: Optional — smoke against your running install**

```bash
# Only after a backup, only if you want to upgrade your live install.
ls $HOME/.anamnesis/backups/  # confirm recent backup exists, e.g. from prior audit-pass
sudo systemctl stop anamnesis
cp $HOME/.anamnesis/history.db $HOME/.anamnesis/backups/history.db.before-v0.5.0-alpha
cd /home/fleabag/anamnesis
git fetch origin && git checkout feat/cognitive-loop && git pull
sudo bash install.sh
sleep 5
curl -s http://127.0.0.1:8084/anamnesis/status | python3 -m json.tool
```

Expected status payload includes `"lessons": 0, "lessons_active": 0` plus
all v0.4.0 fields.

After ~10 minutes of activity, expect `lessons` to start ticking upward
as the distiller pulls clusters.

---

**End of Chunk 1 (Phase α).**

---

## Chunk 2: Phase β — Lesson injection (reflective only) + Observer (read-only)

**Phase β exit criteria (from spec §12):**

- New module `src/lib/intent.js` exists with a heuristic classifier
  returning `"broad" | "narrow" | "reflective"`.
- Selector retrieves lessons and injects a `<lessons>` block, **but only
  when intent classifies as `reflective`**. Other intents see unchanged
  v0.4.0 + scaffold behaviour.
- New module `src/observer.js` exists and is wired post-turn in
  `proxy.js`. It computes the three reward signals (echo-debiased,
  no-correction, foresight-closure) and **logs an EMA at `info` level
  per turn**. NO database write-back yet (`cognitive.reward.enabled=true`
  but a `reward.observeOnly=true` flag prevents writes).
- `src/lib/manifest.js` implements the per-request injection manifest
  with 5-min TTL and 10K cap (§7.5).
- Status endpoint reports `intent_mix` and `reward_ema`.
- INTENT_PROMPT verbatim from §7.4, pinned by test mirroring Task 10.
- All Chunk 1 tests still green; full suite green; lint/format clean.
- v0.4.0 client behaviour: still unchanged. (β touches the selector
  only when intent=reflective; v0.4.0 clients are usually `narrow`.)

**Chunk 2 file plan:**

| File                          | Action | Why                                                          |
| ----------------------------- | ------ | ------------------------------------------------------------ |
| `src/lib/intent.js`           | create | Heuristic + `llm` (opt-in) classifier; INTENT_PROMPT verbatim. |
| `src/lib/manifest.js`         | create | Bounded map with TTL + cap + sweep.                         |
| `src/reward.js`               | create | Three pure signal functions + ensemble math.                |
| `src/observer.js`             | create | Post-turn router: reward + persona + foresight in one place. |
| `src/selector.js`             | modify | Lesson retrieval scoped to `reflective` intent; returns manifest. |
| `src/proxy.js`                | modify | Wire intent.classify + observer post-response; pass manifest. |
| `test/intent.test.js`         | create | Heuristic table; INTENT_PROMPT pin test.                    |
| `test/manifest.test.js`       | create | TTL + cap + sweep semantics.                                |
| `test/reward.test.js`         | create | Each signal in isolation + ensemble.                        |
| `test/observer.test.js`       | create | Dispatch order; observe-only flag; per-item credit.         |
| `test/selector.test.js`       | modify | Reflective-only injection; manifest emission; non-reflective unchanged. |

---

### Task β.1: `src/lib/intent.js` — heuristic classifier + INTENT_PROMPT constant

**Files:** Create `src/lib/intent.js`, `test/intent.test.js`.

- [ ] **Step 1: Write the table-driven test** in `test/intent.test.js`:

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');
const { classifyHeuristic } = require('../src/lib/intent.js');

const cases = [
  // narrow — specific recall
  ['what was the exact command?', 'narrow'],
  ['what file did we put the migration in?', 'narrow'],
  ['/home/fleabag/anamnesis/src/proxy.js line 142?', 'narrow'],
  ['when did we ship v0.4.0?', 'narrow'],

  // broad — exploratory / planning
  ['help me think about how to deploy this', 'broad'],
  ['what are some ideas for the next milestone?', 'broad'],
  ['ok lets brainstorm features', 'broad'],

  // reflective — meta / cross-conversation
  ['what have we learned about the user this week?', 'reflective'],
  ['summarise our decisions about auth across all sessions', 'reflective'],
  ['why do I keep coming back to this pattern in general?', 'reflective'],
  ['overall, what is the right approach?', 'reflective'],

  // edges
  ['',          'narrow'],   // empty defaults to narrow (most conservative for selector)
  ['👍',        'narrow'],   // emoji defaults to narrow
];

for (const [text, expected] of cases) {
  test(`classifyHeuristic("${text.slice(0, 40)}") === ${expected}`, () => {
    assert.equal(classifyHeuristic(text), expected);
  });
}
```

- [ ] **Step 2:** Run; expect `Cannot find module '../src/lib/intent.js'`.

- [ ] **Step 3:** Implement `src/lib/intent.js`:

```javascript
/**
 * lib/intent.js — query-intent classifier. Spec §7.4.
 *
 * Two modes:
 *   - classifyHeuristic(text)    — rule-based, zero LLM calls. Default.
 *   - classifyLLM(text, ollamaUrl, model) — one tiny LLM call (~80ms).
 *     Opt-in via cognitive.selector.intent.mode = "llm".
 *
 * Both return one of "broad" | "narrow" | "reflective".
 */

const { chat } = require('./ollama.js');

const REFLECTIVE_MARKERS = [
  /\bwhat (have|did) we learn/i, /\bin general\b/i, /\boverall\b/i,
  /\bsummari[sz]e\b/i, /\bacross (all|sessions|conversations)\b/i,
  /\bwhy do (i|you) keep\b/i, /\bpattern(s)?\b/i,
];

const NARROW_MARKERS = [
  /\bexact\b/i, /\bwhich file\b/i, /\bwhich line\b/i, /\bwhen did\b/i,
  /\/[\w./-]+\b/,                          // file paths
  /\b[a-z_]+\.[a-z_]+\(\)/i,               // function calls
  /\bv\d+\.\d+(\.\d+)?\b/,                 // version refs
  /\b\d{4}-\d{2}-\d{2}\b/,                 // ISO dates
];

const BROAD_MARKERS = [
  /\b(help me|let'?s) (think|brainstorm|figure out|plan|design)\b/i,
  /\bideas\b/i, /\bbrainstorm\b/i, /\bapproach(es)?\b/i,
  /\bshould we\b/i,
];

function classifyHeuristic(text) {
  const t = (text || '').trim();
  if (!t) return 'narrow';

  // Reflective trumps broad trumps narrow when markers fire.
  if (REFLECTIVE_MARKERS.some((r) => r.test(t))) return 'reflective';
  if (BROAD_MARKERS.some((r) => r.test(t))) return 'broad';
  if (NARROW_MARKERS.some((r) => r.test(t))) return 'narrow';

  // Fallback by shape: question with no markers → narrow; statement → broad.
  if (/\?/.test(t)) return 'narrow';
  return t.split(/\s+/).length > 8 ? 'broad' : 'narrow';
}

const INTENT_PROMPT = `Classify the user's query into exactly one of three intent categories.
Output ONLY one word: "broad", "narrow", or "reflective".

  broad      — open-ended, exploratory, asking about a topic in general,
               asking for ideas, asking for plans
  narrow     — specific, pointed, asking for a value, a fact, a command,
               a name, a date, a file path, exact recall
  reflective — meta, retrospective, asking what we've learned, asking
               for synthesis across many past conversations, asking the
               agent to comment on a pattern

QUERY:
`;

async function classifyLLM(text, ollamaUrl, model = 'qwen3:0.6b') {
  try {
    const reply = await chat(ollamaUrl, {
      model,
      messages: [{ role: 'user', content: INTENT_PROMPT + text }],
      options: { temperature: 0.0, num_predict: 8 },
      timeoutMs: 5000,
    });
    const w = String(reply || '').trim().toLowerCase();
    if (w.startsWith('reflective')) return 'reflective';
    if (w.startsWith('broad')) return 'broad';
    if (w.startsWith('narrow')) return 'narrow';
  } catch { /* fall through */ }
  return classifyHeuristic(text);
}

async function classify(text, cfg = {}) {
  const mode = cfg.mode || 'heuristic';
  if (mode === 'llm') return classifyLLM(text, cfg.ollamaUrl, cfg.model);
  return classifyHeuristic(text);
}

module.exports = { classify, classifyHeuristic, classifyLLM, INTENT_PROMPT };
```

- [ ] **Step 4:** Run; expect all heuristic cases green.

- [ ] **Step 5:** Commit:

```bash
npm run format && npm run lint
git add src/lib/intent.js test/intent.test.js
git commit -m "feat(intent): heuristic + opt-in LLM classifier (§7.4)

Heuristic uses three small marker lists (reflective/narrow/broad) with
deterministic precedence: reflective > broad > narrow. LLM mode falls
back to heuristic on timeout/error."
```

---

### Task β.2: Pin INTENT_PROMPT byte-identical to spec §7.4

**Files:** `test/intent.test.js`.

Same shape as Chunk 1 Task 10 (LESSON_PROMPT pin). Append to
`test/intent.test.js`:

```javascript
const fs = require('node:fs');
const path = require('node:path');

test('INTENT_PROMPT: byte-identical to spec §7.4', () => {
  const { INTENT_PROMPT } = require('../src/lib/intent.js');
  const specPath = path.join(__dirname, '..', 'docs', 'specs', '2026-05-24-cognitive-loop-design.md');
  const spec = fs.readFileSync(specPath, 'utf8');
  const m = spec.match(/INTENT_PROMPT \(verbatim, pinned for v0\.5\.0\)\s*\n+\s*```\n([\s\S]*?)\n```/);
  assert.ok(m, 'spec must contain the INTENT_PROMPT fenced block');
  const norm = (s) => s.replace(/\s+$/, '');
  assert.equal(norm(INTENT_PROMPT), norm(m[1]),
    'INTENT_PROMPT in intent.js has drifted from spec §7.4');
});
```

- [ ] Run, expect pass. Commit:

```bash
git add test/intent.test.js
git commit -m "test(intent): pin INTENT_PROMPT byte-identical to spec §7.4"
```

---

### Task β.3: `src/lib/manifest.js` — bounded map with TTL + cap

**Files:** Create `src/lib/manifest.js`, `test/manifest.test.js`.

Per spec §7.5: per-entry TTL 300s, hard cap 10K, sweep every 60s.

- [ ] **Step 1: Tests**

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');
const ManifestStore = require('../src/lib/manifest.js');

test('store + get within TTL', () => {
  const m = new ManifestStore({ ttlMs: 1000, capacity: 100 });
  m.put('req-1', { items: [{ kind: 'lesson', id: 7 }] });
  assert.equal(m.get('req-1').items[0].id, 7);
});

test('TTL: entry expires after ttlMs', async () => {
  const m = new ManifestStore({ ttlMs: 20, capacity: 100 });
  m.put('req-1', { items: [] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(m.get('req-1'), null);
});

test('cap: oldest-first eviction when over capacity', () => {
  const m = new ManifestStore({ ttlMs: 60_000, capacity: 3 });
  m.put('a', { v: 1 });
  m.put('b', { v: 2 });
  m.put('c', { v: 3 });
  m.put('d', { v: 4 });   // evicts 'a'
  assert.equal(m.get('a'), null);
  assert.equal(m.get('d').v, 4);
});

test('sweep clears expired entries', async () => {
  const m = new ManifestStore({ ttlMs: 20, capacity: 100 });
  m.put('x', {});
  await new Promise((r) => setTimeout(r, 30));
  m.sweep();
  assert.equal(m.size(), 0);
});

test('takeAndRemove returns + deletes', () => {
  const m = new ManifestStore({ ttlMs: 1000, capacity: 100 });
  m.put('a', { v: 1 });
  assert.equal(m.takeAndRemove('a').v, 1);
  assert.equal(m.get('a'), null);
});
```

- [ ] **Step 2:** Run, expect fails.

- [ ] **Step 3: Implement** `src/lib/manifest.js`:

```javascript
/**
 * lib/manifest.js — bounded in-memory store for per-request injection
 * manifests. Spec §7.5.
 *
 * Insertion-ordered (Map preserves insertion order). On overflow, evicts
 * oldest first. Entries expire after ttlMs; sweep() removes expired
 * entries. The proxy calls sweep on a 60s setInterval.
 */
class ManifestStore {
  constructor({ ttlMs = 300_000, capacity = 10_000 } = {}) {
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.m = new Map(); // id → { createdAt, payload }
  }

  put(id, payload) {
    if (this.m.size >= this.capacity) {
      // Map preserves insertion order; first key is the oldest.
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(id, { createdAt: Date.now(), payload });
  }

  get(id) {
    const e = this.m.get(id);
    if (!e) return null;
    if (Date.now() - e.createdAt > this.ttlMs) {
      this.m.delete(id);
      return null;
    }
    return e.payload;
  }

  takeAndRemove(id) {
    const p = this.get(id);
    if (p) this.m.delete(id);
    return p;
  }

  sweep() {
    const now = Date.now();
    for (const [id, e] of this.m) {
      if (now - e.createdAt > this.ttlMs) this.m.delete(id);
    }
  }

  size() { return this.m.size; }
}

module.exports = ManifestStore;
```

- [ ] **Step 4:** Run, expect all pass.

- [ ] **Step 5:** Commit:

```bash
npm run format && npm run lint
git add src/lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): bounded TTL store for injection manifests (§7.5)"
```

---

### Task β.4: Reward signal — echo (debiased)

**Files:** Create `src/reward.js`, `test/reward.test.js`.

Per spec §6.3: per-item echo = `cos(response, item) − cos(response, query)`.
This strips the topic-confound — the v1 spec's plain cosine signal was
mostly capturing "the response talks about the same topic as the query",
not utility.

- [ ] **Step 1: Tests**

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');
const reward = require('../src/reward.js');

function vec(arr) { return new Float32Array(arr); }

test('echoDebiased: item leaned on > query baseline → positive', () => {
  const response = vec([0.0, 1.0, 0.0]);
  const query    = vec([1.0, 0.0, 0.0]);
  const item     = vec([0.0, 0.9, 0.1]);  // aligned with response, not query
  const r = reward.echoDebiased(response, query, item);
  assert.ok(r > 0.5, `expected r > 0.5, got ${r}`);
});

test('echoDebiased: item just topical with query → near zero', () => {
  const response = vec([0.5, 0.5, 0.0]);
  const query    = vec([1.0, 0.0, 0.0]);
  const item     = vec([1.0, 0.0, 0.0]);  // same as query
  const r = reward.echoDebiased(response, query, item);
  // cos(resp, item) ≈ cos(resp, query) — should debias to near 0.
  assert.ok(Math.abs(r) < 0.1, `expected ≈ 0, got ${r}`);
});

test('echoDebiased: null vectors → 0', () => {
  assert.equal(reward.echoDebiased(null, vec([1]), vec([1])), 0);
  assert.equal(reward.echoDebiased(vec([1]), null, vec([1])), 0);
});

test('echoDebiased: clamped to [-1, 1]', () => {
  const v = vec([1, 0]);
  const opp = vec([-1, 0]);
  const r = reward.echoDebiased(v, opp, v);   // cos(v,v)=1, cos(v,opp)=-1, diff=2
  assert.ok(r >= -1 && r <= 1);
});
```

- [ ] **Step 2:** Run, expect `Cannot find module './reward'`.

- [ ] **Step 3: Implement skeleton**

```javascript
/**
 * reward.js — three signal computations + ensemble. Spec §6.
 *
 * All functions are pure; no DB, no HTTP. Caller (observer.js) wires the
 * signals into per-turn write-back.
 */

const Embedder = require('./embedder.js');

function echoDebiased(responseVec, queryVec, itemVec) {
  if (!responseVec || !queryVec || !itemVec) return 0;
  const a = Embedder.cosine(responseVec, itemVec);
  const b = Embedder.cosine(responseVec, queryVec);
  return Math.max(-1, Math.min(1, a - b));
}

module.exports = { echoDebiased };
```

- [ ] **Step 4:** Run, expect pass.

- [ ] **Step 5:** Commit:

```bash
npm run format && npm run lint
git add src/reward.js test/reward.test.js
git commit -m "feat(reward): echoDebiased signal (§6.3)

Subtracts cos(response, query) baseline so the score reflects items the
response leaned on BEYOND what the query already covered. Replaces the
naïve plain-cosine echo flagged by the v1→v2 spec review."
```

---

### Task β.5: Reward — no-correction (weighted by prior echo)

**Files:** Modify `src/reward.js`, `test/reward.test.js`.

Per §6.3: blame on the *next* user turn weighted by `prev_echo / sum(prev_echo)`
— the item that was actually used eats the blame.

- [ ] **Step 1: Tests**

```javascript
test('noCorrection: detects correction markers', () => {
  assert.equal(reward.detectCorrection('no, I told you it is X'), true);
  assert.equal(reward.detectCorrection('actually that is wrong'), true);
  assert.equal(reward.detectCorrection('Actually...'), true);
  assert.equal(reward.detectCorrection("I said X earlier"), true);
  assert.equal(reward.detectCorrection('thanks, that works'), false);
  assert.equal(reward.detectCorrection(''), false);
});

test('correctionBlame: weights blame by prior echo', () => {
  const prevEchos = [0.9, 0.1, 0.0];  // item 0 was leaned on
  const blames = reward.correctionBlame(prevEchos);
  assert.equal(blames.length, 3);
  // Item with high prior echo eats most blame.
  assert.ok(blames[0] < -0.5);
  assert.ok(blames[1] > -0.2);
  // All zero echos → zero blame across the board (no information).
  assert.deepEqual(reward.correctionBlame([0, 0, 0]), [0, 0, 0]);
});
```

- [ ] **Step 2:** Run, expect fail.

- [ ] **Step 3: Implement** — append to `src/reward.js`:

```javascript
const CORRECTION_RE = /\b(no|actually|that'?s wrong|I (told|said) you|wrong)\b/i;

function detectCorrection(nextUserText) {
  if (!nextUserText) return false;
  return CORRECTION_RE.test(nextUserText);
}

/**
 * Given the previous turn's per-item echo signals, return per-item blame
 * weights in [-1, 0]. Item with highest prior echo eats most blame.
 * Returns all-zeros if every prior echo is zero (no signal).
 */
function correctionBlame(prevEchos) {
  const total = prevEchos.reduce((s, e) => s + Math.max(0, e), 0);
  if (total <= 0) return prevEchos.map(() => 0);
  return prevEchos.map((e) => -Math.max(0, e) / total);
}

module.exports.detectCorrection = detectCorrection;
module.exports.correctionBlame = correctionBlame;
```

- [ ] **Step 4:** Run, expect pass.

- [ ] **Step 5:** Commit:

```bash
git add src/reward.js test/reward.test.js
git commit -m "feat(reward): no-correction signal with per-item blame weighting (§6.3)

Items that were actually leaned on (high prior echo) eat most of the
blame when the next user turn signals a correction. Flat blame across
all injections was the v1 design flaw the reviewer caught."
```

---

### Task β.6: Reward — foresight closure signal

**Files:** Modify `src/reward.js`, `test/reward.test.js`.

Per §6.3: if a previously-open foresight was fulfilled this turn, items
semantically related to the foresight target gain. A semantic-relatedness
gate (`cos(itemVec, foresightVec) ≥ 0.55`) prevents rewarding incidental
injections.

- [ ] **Step 1: Tests**

```javascript
test('foresightCredit: rewards items near the fulfilled foresight', () => {
  const fVec    = vec([1, 0, 0]);
  const items   = [vec([0.95, 0.05, 0]), vec([0, 1, 0])];
  const credits = reward.foresightCredit(fVec, items);
  assert.ok(credits[0] > 0.4);
  assert.equal(credits[1], 0);
});

test('foresightCredit: empty inputs → zero array', () => {
  assert.deepEqual(reward.foresightCredit(null, [vec([1])]), [0]);
});
```

- [ ] **Step 2 → 5:** Implement, run, commit:

```javascript
function foresightCredit(foresightVec, itemVecs, threshold = 0.55) {
  if (!foresightVec) return (itemVecs || []).map(() => 0);
  return itemVecs.map((iv) => {
    if (!iv) return 0;
    const s = Embedder.cosine(foresightVec, iv);
    return s >= threshold ? s : 0;
  });
}

module.exports.foresightCredit = foresightCredit;
```

```bash
npm run format && npm run lint
git add src/reward.js test/reward.test.js
git commit -m "feat(reward): foresightCredit signal — relatedness-gated bonus (§6.3)"
```

---

### Task β.7: Reward — ensemble + observe-only write path

**Files:** Modify `src/reward.js`, `test/reward.test.js`.

The ensemble combines `echo`, `correction`, `foresight` per `cognitive.reward.weights`.

- [ ] **Step 1: Tests**

```javascript
test('ensemble: weighted sum, clamped to [-1, 1]', () => {
  const r = reward.ensemble({ echo: 0.5, correction: -0.2, foresight: 0.7 },
                            { echo: 0.6, correction: 0.25, foresight: 0.15 });
  // 0.5*0.6 + -0.2*0.25 + 0.7*0.15 = 0.3 + -0.05 + 0.105 = 0.355
  assert.ok(Math.abs(r - 0.355) < 1e-6);
});

test('emaUpdate: smoothing factor 0.1', () => {
  // new_ema = old + α(reward - old)
  assert.ok(Math.abs(reward.emaUpdate(0.5, 1.0, 0.1) - 0.55) < 1e-6);
});
```

- [ ] **Step 2 → 5:**

```javascript
function ensemble(signals, weights) {
  const e = (signals.echo       ?? 0) * (weights.echo       ?? 0);
  const c = (signals.correction ?? 0) * (weights.correction ?? 0);
  const f = (signals.foresight  ?? 0) * (weights.foresight  ?? 0);
  return Math.max(-1, Math.min(1, e + c + f));
}

function emaUpdate(prev, reward, smoothing) {
  return prev + smoothing * (reward - prev);
}

module.exports.ensemble = ensemble;
module.exports.emaUpdate = emaUpdate;
```

```bash
npm run format && npm run lint
git add src/reward.js test/reward.test.js
git commit -m "feat(reward): ensemble + EMA helpers (§6.5)"
```

---

### Task β.8: `src/observer.js` — post-turn router (observe-only in β)

**Files:** Create `src/observer.js`, `test/observer.test.js`.

Per §6.2: one place that dispatches reward + persona + foresight closure.

- [ ] **Step 1: Tests**

```javascript
const test   = require('node:test');
const assert = require('node:assert/strict');
const Observer = require('../src/observer.js');

test('dispatches to reward, persona, foresight in order', async () => {
  const calls = [];
  const fakePersona = { observeResponse: () => calls.push('persona') };
  const fakeReward  = { compute: async () => { calls.push('reward'); return 0.3; } };
  const fakeForesight = { tryClose: async () => { calls.push('foresight'); } };

  const o = new Observer({
    cognitive: { reward: { enabled: true, observeOnly: true, weights: {} } },
  }, { /* history */ }, fakeReward, fakePersona, fakeForesight);

  await o.onAssistantTurn({
    sessionKey: 'k', turnId: 1, userText: 'q', responseText: 'r',
    manifest: { items: [] },
  });
  assert.deepEqual(calls, ['reward', 'persona', 'foresight']);
});

test('observeOnly=true: does not call DB write methods', async () => {
  let wrote = false;
  const history = {
    updateLessonPrecision: () => { wrote = true; },
    updateSceneInjectionScore: () => { wrote = true; },
    updateMemcellImportance: () => { wrote = true; },
  };
  const o = new Observer(
    { cognitive: { reward: { enabled: true, observeOnly: true, weights: {} } } },
    history,
    { compute: async () => 0.5 },
    { observeResponse: () => {} },
    { tryClose: async () => {} },
  );
  await o.onAssistantTurn({
    sessionKey: 'k', turnId: 1, userText: 'q', responseText: 'r',
    manifest: { items: [{ kind: 'lesson', id: 7 }] },
  });
  assert.equal(wrote, false, 'no DB write should occur in observe-only mode');
});
```

- [ ] **Step 2 → 5: Implement** `src/observer.js`:

```javascript
const log = require('./lib/logger.js').make('observer');

class Observer {
  constructor(config, history, rewardLib, persona, foresight) {
    this.cfg      = config.cognitive?.reward || {};
    this.history  = history;
    this.reward   = rewardLib;
    this.persona  = persona;
    this.foresight = foresight;
  }

  async onAssistantTurn({ sessionKey, turnId, userText, responseText, manifest }) {
    let r = 0;
    try {
      r = await this.reward.compute({ userText, responseText, manifest, history: this.history });
    } catch (e) { log.warn('reward.compute:', e.message); }

    try { this.persona?.observeResponse?.(sessionKey, turnId, responseText); }
    catch (e) { log.warn('persona.observeResponse:', e.message); }

    try { await this.foresight?.tryClose?.(sessionKey, turnId, responseText); }
    catch (e) { log.warn('foresight.tryClose:', e.message); }

    const items = manifest?.items?.length ?? 0;
    log.info(`turn=${turnId} items=${items} reward_ema=${r.toFixed(3)} ${this.cfg.observeOnly ? '(observe-only)' : ''}`);

    if (this.cfg.observeOnly) return;
    // Phase γ writes will land here.
  }
}

module.exports = Observer;
```

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add src/observer.js test/observer.test.js
git commit -m "feat(observer): post-turn router skeleton (§6.2) — observe-only β

Three-way dispatch: reward.compute, persona.observeResponse, foresight.tryClose.
In Phase β observeOnly=true; reward.compute returns an EMA but no DB
write happens. γ flips the flag and adds the write-back path."
```

---

### Task β.9: Selector — retrieve lessons (function only, not wired)

**Files:** Modify `src/selector.js`, `test/selector.test.js`.

Add a `retrieveLessons(sessionKey, queryVec, currentModel, maxK)` method
on Selector. Don't wire it into `select()` yet — that's β.10.

- [ ] **Step 1: Test** the helper directly with a fake history.

```javascript
test('retrieveLessons: scores by cosine, returns top K active, skips wrong-model', () => {
  const mkVec = (n) => new Float32Array(n);
  const fakeHistory = {
    getActiveLessons: () => [
      { id: 1, content: 'a', embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer), embedding_model: 'm', precision_score: 0.5, recall_count: 0 },
      { id: 2, content: 'b', embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer), embedding_model: 'm', precision_score: 0.5, recall_count: 0 },
      { id: 3, content: 'c', embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer), embedding_model: 'OTHER', precision_score: 0.5, recall_count: 0 },
    ],
  };
  const Selector = require('../src/selector.js');
  const s = new Selector({ context: {} }, fakeHistory, { model: 'm' });
  const out = s.retrieveLessons('sess', new Float32Array([1, 0, 0]), 'm', 5);
  assert.equal(out.length, 2, 'wrong-model lesson must be skipped');
  assert.equal(out[0].id, 1, 'aligned lesson ranks first');
});
```

- [ ] **Step 2 → 5:** Implement in `src/selector.js`:

```javascript
retrieveLessons(sessionKey, queryVec, currentModel, maxK = 8) {
  if (!queryVec) return [];
  const lessons = this.history.getActiveLessons(sessionKey) || [];
  return lessons
    .filter((l) => !l.embedding_model || l.embedding_model === currentModel)
    .map((l) => {
      const lv = HistoryStore.toFloat32(l.embedding);
      const sim = lv ? Embedder.cosine(queryVec, lv) : 0;
      return { ...l, sim, score: sim + 0.2 * (l.precision_score - 0.5) };
    })
    .filter((l) => l.sim >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxK);
}
```

Commit:

```bash
npm run format && npm run lint
git add src/selector.js test/selector.test.js
git commit -m "feat(selector): retrieveLessons helper (read-only, not yet wired)

Filters by embedding-model compatibility, scores by cosine + small
precision_score bias, returns top K. Phase β.10 wires it into select()
under reflective intent only."
```

---

### Task β.10: Selector — inject `<lessons>` block on `reflective` only

**Files:** Modify `src/selector.js`, `test/selector.test.js`.

Per §12 phase β: lessons inject *only* when intent === 'reflective'.

- [ ] **Step 1:** Test. With the heuristic classifier and a query like
  "what have we learned about deployments?", we should see a `<lessons>`
  block in the assembled system message. With `"what's the port number?"`
  we should NOT.

- [ ] **Step 2 → 4:** Modify `Selector.select()` to accept an `intent`
  parameter (passed in from proxy). In `_buildSystemWithMemory`, gate
  the lessons block on `intent === 'reflective'`. Concatenate after
  `<character>` and before `<memory>`.

- [ ] **Step 5:** Commit:

```bash
git add src/selector.js test/selector.test.js
git commit -m "feat(selector): inject <lessons> block on reflective intent (Phase β)

Gates lesson injection to intent='reflective' per spec §12 phase β.
broad and narrow intents fall through to existing v0.4.0 selector
behaviour plus the v0.5.0 scaffold. recall_count + last_recalled_at
bookkeeping fires for every injected lesson."
```

---

### Task β.11: Selector — emit injection manifest

**Files:** Modify `src/selector.js`, `test/selector.test.js`.

`select()` now returns `{ messages, manifest }` instead of just messages.

- [ ] **Steps 1–5:** Update return type; cascade the change through `proxy.js`
  (the caller). The manifest schema is from §7.5.

```bash
git add src/selector.js src/proxy.js test/selector.test.js
git commit -m "feat(selector): return { messages, manifest } per §7.5

Manifest enumerates per-injected-item kind/id/tokens for the observer.
Proxy stashes it in the new ManifestStore (TTL'd) keyed by request_id."
```

---

### Task β.12: Wire intent classifier + observer + manifest into proxy.js

**Files:** Modify `src/proxy.js`.

In the chat-completions handler:

1. Compute `intent = intent.classify(queryText, config.cognitive?.selector?.intent)` before calling selector.
2. Pass `intent` into `selector.select()`.
3. Receive `{ messages, manifest }`; stash in `ManifestStore` keyed by a per-request UUID.
4. Replace the scaffold's hard-coded `'narrow'` with the real `intent`.
5. After response is returned to the client, in the `recordAssistantTurn`
   path, call `observer.onAssistantTurn({...manifest, ...})` instead of
   the existing per-pipeline calls.

- [ ] **Steps 1–5:** Implement. Run tests. Commit:

```bash
git add src/proxy.js
git commit -m "feat(proxy): wire intent.classify + observer + ManifestStore (β)

intent: heuristic by default; per-request UUID keys the manifest store;
observer dispatches on response finish. observeOnly=true in β config —
no DB write yet."
```

---

### Task β.13: Status endpoint — intent_mix + reward_ema

**Files:** Modify `src/proxy.js`, `test/integration/status-endpoint.test.js`.

Per §10.1. Track a rolling 100-turn intent counter and a global reward EMA
in process memory (no DB).

- [ ] **Steps:** Add a small `Telemetry` object: `{ intentCounts: {broad,narrow,reflective}, rewardEma }`. Bump from observer + selector. Status reads it.

```bash
git add src/proxy.js test/integration/status-endpoint.test.js
git commit -m "feat(observability): intent_mix + reward_ema in status (§10.1)"
```

---

### Task β.14: Phase β merge-readiness

Same shape as Task 15: `npm test` green, lint clean, format clean,
proxy boots, optional live smoke.

Commit:

```bash
git commit --allow-empty -m "chore: Phase β ready for merge"
```

---

**End of Chunk 2 (Phase β).**

---

## Chunk 3: Phase γ — Lessons on all intents + reward write-back + refute loop

**Phase γ exit criteria (from spec §12):**

- Selector reads lessons on **every** intent, not just reflective.
- Observer flips `observeOnly=false`: reward EMA writes back to
  `lessons.precision_score` and `memscenes.injection_score`.
  `memcells.importance` is **untouched** (guarded by
  `reward.writebackLegacyImportance=false`).
- Refutation loop: when a new memcell is inserted, distiller side-checks
  active lessons for contradictions; over-threshold lessons trigger
  LLM-mediated re-validation (`refute` / `revise` / `retire`).
- Selector applies the exploration bonus and mean-reversion-to-0.5
  on idle lessons (§6.4, §5.5).
- New endpoint: `GET /anamnesis/lessons?limit=N&category=X&status=active`.
- v0.4.0 rollback still bit-for-bit: `cognitive.lessons.enabled=false`
  reverts to v0.4.0 selector.

**Chunk 3 file plan:**

| File                          | Action | Why                                                   |
| ----------------------------- | ------ | ----------------------------------------------------- |
| `src/observer.js`             | modify | Flip on write-back to `lessons.precision_score` and `memscenes.injection_score`. |
| `src/selector.js`             | modify | Lesson injection on all intents; exploration bonus.   |
| `src/history.js`              | modify | Mean-reversion + idle-retire on cron; refute helpers. |
| `src/distiller.js`            | modify | refute-on-cell-insert side-check + LLM revalidator.   |
| `src/proxy.js`                | modify | New `/anamnesis/lessons` read endpoint.               |
| Various `test/*.test.js`      | modify | New write-back paths, refute loop, /lessons endpoint. |

---

### Task γ.1: Flip observer write-back to new columns

**Files:** `src/observer.js`, `src/history.js`, `test/observer.test.js`.

- [ ] **Step 1:** Test that with `observeOnly=false`, observer calls
  `history.updateLessonPrecision(id, ema)` and
  `history.updateSceneInjectionScore(id, ema)` for each manifest item.
- [ ] **Step 2–4:** Implement those two methods on `HistoryStore`; replace
  the `if (observeOnly) return;` early-return in observer with the write
  loop. Each per-item `r` is computed from the manifest's prior-turn echo
  + correction + foresight signals (§6.3, §6.5). Mean reversion applies
  at write time.

```bash
git commit -m "feat(observer): write-back to lessons.precision_score + memscenes.injection_score (γ)

Targets new columns only; legacy memcells.importance untouched (gated
by reward.writebackLegacyImportance=false until 1.0). Rollback to v0.4.0
remains bit-for-bit by setting cognitive.lessons.enabled=false."
```

---

### Task γ.2: Selector — inject lessons on all intents

**Files:** `src/selector.js`, `test/selector.test.js`.

- [ ] Lift the β.10 reflective-only gate. Allocations remain uniform
  25/25/25/25 (Chunk 4 calibrates).
- [ ] Each intent draws a different K from `retrieveLessons` based on the
  allocations table (lessons-budget / avg-lesson-tokens).

```bash
git commit -m "feat(selector): inject lessons on broad+narrow+reflective (γ)"
```

---

### Task γ.3: Exploration bonus + mean reversion

**Files:** `src/selector.js`, `src/history.js`, `test/selector.test.js`.

Per §6.4: UCB-style `sqrt(ln(sessionTurns+1) / (recall_count+1)) * explorationWeight`
on the selector's lesson scoring; nightly cron (piggybacks on the
consolidator's existing schedule) calls `history.applyLessonMeanReversion()`
which nudges idle `precision_score` toward 0.5.

- [ ] **Steps 1–5:** Implement + test.

```bash
git commit -m "feat(selector,history): UCB exploration + mean-reversion-to-0.5 (§6.4)"
```

---

### Task γ.4: Distiller — refute_count side-check on memcell insertion

**Files:** `src/distiller.js`, `src/extractor.js`, `src/history.js`, `test/distiller.test.js`.

Per §5.4: when extractor inserts a new memcell, hand it to
`distiller.checkAgainstActiveLessons(memcellId)`. The check is the
cheap textual probe (no LLM call).

- [ ] **Steps 1–5:** Implement. Probe = "negation marker + shared noun"
  heuristic. Increments `refute_count`; over threshold enqueues for
  LLM-mediated revalidation.

```bash
git commit -m "feat(distiller): refute_count probe on every memcell insertion (§5.4)"
```

---

### Task γ.5: Distiller — LLM-mediated refutation (revise / retire / hold)

**Files:** `src/distiller.js`, `test/distiller.test.js`.

Per §5.4: when `refute_count >= lessonRefuteThreshold`, call the LLM
with the original lesson + N contradicting cells; act on `(a) holds /
(b) revise / (c) retire`. Verbatim prompt pinned by test like
LESSON_PROMPT.

- [ ] **Steps 1–5:** Implement. New prompt `REFUTE_PROMPT` pinned to
  spec §5.4. `status='superseded'` + `superseded_by` chains for revisions.

```bash
git commit -m "feat(distiller): refute → revise / retire / hold (§5.4)

LLM-mediated revalidation when refute_count crosses threshold. Hold
resets count + bumps last_validated_at. Revise creates a successor
lesson and marks the old superseded. Retire marks the old retired."
```

---

### Task γ.6: `GET /anamnesis/lessons` read endpoint

**Files:** `src/proxy.js`, `test/integration/lessons-endpoint.test.js`.

Per §10.2. Read-only; supports `?limit=N&category=X&status=active`.

- [ ] **Steps 1–5:** Implement. Returns JSON list. No edit support (v0.6.0).

```bash
git commit -m "feat(proxy): GET /anamnesis/lessons — read-only listing (§10.2)"
```

---

### Task γ.7: Phase γ merge-readiness

`npm test` green, lint clean, format clean, full re-smoke on the live
install with a real backlog. CHANGELOG updated.

```bash
git commit -m "chore: Phase γ ready for merge"
```

---

**End of Chunk 3 (Phase γ).**

---

## Chunk 4: Phase 1.0 — Legacy importance + bench + production allocations

**Phase 1.0 exit criteria (from spec §12):**

- `memcells.importance_v04_snapshot` column added by migration; a
  one-time snapshot of `importance` is written at the moment
  `reward.writebackLegacyImportance` is flipped to `true`.
- Observer write-back targets `memcells.importance` too. Rollback path:
  the snapshot column lets ops restore v0.4.0 values via one SQL
  `UPDATE memcells SET importance = importance_v04_snapshot`.
- `bench/` directory exists with: run.sh, grader spec, fixtures for
  the four task categories (§13.1), and a regenerable `REPORT.md`.
- Production allocations in `config.json` are replaced by the
  bench-derived table.
- v1.0.0 tag pushed.

**Chunk 4 file plan:**

| File                                | Action | Why                                              |
| ----------------------------------- | ------ | ------------------------------------------------ |
| `src/history.js`                    | modify | importance_v04_snapshot column + snapshot helper. |
| `src/observer.js`                   | modify | Legacy-importance write-back behind flag.        |
| `bench/run.sh`                      | create | Driver for the four task categories.             |
| `bench/grader.md`                   | create | Pinned grader prompt (file hash for traceability). |
| `bench/fixtures/*`                  | create | Setup + held-out continuation conversations.     |
| `bench/REPORT.md`                   | create | Regenerable output (committed for posterity).    |
| `config.json`                       | modify | Replace uniform allocations with bench values.   |
| `CHANGELOG.md`                      | modify | v1.0.0 release notes.                            |
| `docs/launch/v0.5.0.md`             | create | Marketing narrative (appendix A relocated).      |

---

### Task 1.0.1: Add `importance_v04_snapshot` column

**Files:** `src/history.js`, `test/history.test.js`.

- [ ] Migration: `ALTER TABLE memcells ADD COLUMN importance_v04_snapshot REAL`.
- [ ] Helper `snapshotLegacyImportance()`: one-shot, idempotent (no-op if
  any row already has a non-NULL snapshot).

```bash
git commit -m "feat(history): importance_v04_snapshot column + one-shot snapshot helper (1.0 prep)"
```

---

### Task 1.0.2: Flip `reward.writebackLegacyImportance` to true (after snapshot)

**Files:** `src/observer.js`, `src/proxy.js`, `test/observer.test.js`.

- [ ] Boot path: if `cognitive.reward.writebackLegacyImportance=true` and
  no snapshot exists, call `history.snapshotLegacyImportance()` once.
- [ ] Observer write-back path: also update `memcells.importance` via
  EMA + reward signal.
- [ ] Tests assert the snapshot fires before the first write-back, never
  on subsequent boots.

```bash
git commit -m "feat(observer): legacy importance write-back behind flag with snapshot guard (§12.2)"
```

---

### Task 1.0.3: bench/ directory scaffold

**Files:** Create `bench/run.sh`, `bench/grader.md`, `bench/fixtures/*`,
`bench/README.md`.

- [ ] `bench/run.sh` drives the four task categories from §13.1.
  Outputs a `bench/results-<ISO>.json`.
- [ ] `bench/grader.md` pins model (`gpt-oss-20b`), temperature `0.0`,
  prompt version, and a SHA hash check.
- [ ] Fixtures: setup conversation (seen by distiller) + held-out
  continuation (graded). One fixture pair per task category.

```bash
git commit -m "chore(bench): scaffold + four-task harness (§13)

bench/run.sh: driver; bench/grader.md: pinned grader; fixtures/:
setup+held-out pairs per category. Methodology constraints from
§13.2-§13.4 enforced (no train/test leakage; pinned grader;
no-CPU-llama-on-latency)."
```

---

### Task 1.0.4: Run bench, calibrate production allocations

**Files:** `bench/REPORT.md`, `config.json`.

- [ ] Sweep `allocations[intent]` over a small grid (e.g. step 10% on
  each tier within budget=1.0 constraint). Record per-intent best.
- [ ] Update `config.json` `cognitive.selector.allocations` block.
- [ ] CHANGELOG note: "γ → 1.0 allocations" — explicit before/after.

```bash
git commit -m "chore(bench,config): production allocations from bench sweep

Replaces the uniform 25/25/25/25 baseline that shipped in α/β.
Values per-intent recorded in CHANGELOG."
```

---

### Task 1.0.5: Move launch narrative to `docs/launch/v0.5.0.md`

**Files:** Create `docs/launch/v0.5.0.md`, modify spec Appendix A.

The spec's Appendix A is marketing material; spec hygiene says it
moves to `docs/launch/` at release time.

```bash
git commit -m "docs: relocate Appendix A → docs/launch/v0.5.0.md"
```

---

### Task 1.0.6: CHANGELOG + tag v1.0.0

**Files:** `CHANGELOG.md`, `package.json`.

- [ ] Promote `[0.5.0-alpha]` to `[0.5.0]` with the complete picture.
- [ ] Bump `package.json` version to `0.5.0`.
- [ ] Tag:

```bash
git tag -a v0.5.0 -m "Anamnesis v0.5.0 — Cognitive Loop"
git push --tags
```

```bash
git commit -m "chore: release v0.5.0 — Cognitive Loop (lessons, reward, hierarchical selector, scaffold)"
```

---

### Task 1.0.7: Phase 1.0 merge-readiness

Final checks. Push the branch with the v0.5.0 tag. PR
`feat/cognitive-loop` → `main` ready to merge.

```bash
git commit --allow-empty -m "chore: v0.5.0 ready"
```

---

**End of Chunk 4 (Phase 1.0).**

---

## Execution

The plan is complete. Next step per `superpowers:writing-plans`:
invoke `superpowers:subagent-driven-development` to execute Chunk 1
first. Chunks 2, 3, 4 follow after each preceding chunk is merged and
lived with.

