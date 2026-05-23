/**
 * history.js — SQLite-backed conversation history store
 * Persists every turn with its embedding vector for later retrieval.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class HistoryStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT    NOT NULL,
        role        TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        embedding   BLOB,
        token_est   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_key, created_at);
    `);
  }

  /**
   * Store a single turn. embedding is Float32Array or null.
   */
  insertTurn(sessionKey, role, content, embedding, tokenEst) {
    const embBlob = embedding ? Buffer.from(embedding.buffer) : null;
    this.db.prepare(`
      INSERT INTO turns (session_key, role, content, embedding, token_est)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionKey, role, content, embBlob, tokenEst);
  }

  /**
   * Fetch all turns for a session ordered oldest→newest.
   */
  getSessionTurns(sessionKey) {
    return this.db.prepare(`
      SELECT id, role, content, embedding, token_est, created_at
      FROM turns WHERE session_key = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionKey);
  }

  /**
   * Deserialise a stored embedding blob back to Float32Array.
   */
  static toFloat32(blob) {
    if (!blob) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }

  /**
   * Prune turns older than maxAgeDays across all sessions.
   */
  prune(maxAgeDays) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    const { changes } = this.db.prepare(
      'DELETE FROM turns WHERE created_at < ?'
    ).run(cutoff);
    return changes;
  }
}

module.exports = HistoryStore;
