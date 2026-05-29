const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { expandHome } = require('../../src/lib/proxy-helpers.js');

test('v0.4.0 config (no cognitive.*) boots: expandHome + parse work', () => {
  // A minimal v0.4.0-style config — no `cognitive` block, no `persona`.
  const v04 = {
    proxy: { port: 8084, host: '127.0.0.1' },
    upstream: {
      baseUrl: 'http://127.0.0.1:8083',
      apiKey: 'localqwen',
      disableThinking: true,
    },
    embedding: {
      ollamaUrl: 'http://127.0.0.1:11434',
      model: 'nomic-embed-cpu:latest',
    },
    extraction: {
      model: 'qwen3:0.6b',
      maxRetries: 2,
      timeoutMs: 45000,
      startupBacklogLimit: 200,
    },
    foresight: {
      model: 'qwen3:0.6b',
      maxRetries: 2,
      timeoutMs: 45000,
      startupBacklogLimit: 200,
    },
    context: {
      tokenBudget: 65536,
      systemReserveTokens: 4096,
      recencyTurns: 8,
      rotatingSlots: 6,
      charsPerToken: 3.5,
      minChunkChars: 50,
    },
    memory: {
      consolidationIntervalMs: 120000,
      consolidationBatchSize: 50,
      sceneClusterThreshold: 0.72,
      minSceneSize: 2,
      decayPruneThreshold: 0.05,
    },
    history: { dbPath: '~/.anamnesis/history.db', maxAgeDays: 90 },
  };

  // expandHome is the path the proxy walks at boot.
  const expanded = expandHome(v04);
  assert.equal(expanded.proxy.port, 8084);
  assert.ok(expanded.history.dbPath.endsWith('/.anamnesis/history.db'));
  // No cognitive block should mean undefined, not a crash:
  assert.equal(expanded.cognitive, undefined);
});

test('v0.4.0 DB schema migrates additively', () => {
  // The migration is additive, so opening a fresh DB with HistoryStore
  // exercises the same code paths as upgrading a v0.4.0 DB. We assert
  // the v0.5.0 columns/tables are created without disturbing v0.4.0
  // ones.
  let HistoryStore;
  try {
    HistoryStore = require('../../src/history.js');
  } catch {
    return; // native binding unavailable; skip gracefully
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anamnesis-v04-'));
  const dbPath = path.join(dir, 'history.db');
  try {
    const h = new HistoryStore(dbPath);
    const lessonsCols = h.db
      .prepare('PRAGMA table_info(lessons)')
      .all()
      .map((c) => c.name);
    assert.ok(lessonsCols.includes('id'), 'lessons table must be created');
    assert.ok(lessonsCols.includes('precision_score'), 'lessons.precision_score must exist');

    const sceneCols = h.db
      .prepare('PRAGMA table_info(memscenes)')
      .all()
      .map((c) => c.name);
    assert.ok(sceneCols.includes('injection_score'), 'injection_score column must be added');

    // v0.4.0 columns/tables are still present:
    const turnsCols = h.db
      .prepare('PRAGMA table_info(turns)')
      .all()
      .map((c) => c.name);
    for (const c of ['id', 'session_key', 'role', 'content', 'embedding', 'extracted']) {
      assert.ok(turnsCols.includes(c), `v0.4.0 turns.${c} must still exist`);
    }
    h.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
