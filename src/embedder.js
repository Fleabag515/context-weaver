/**
 * embedder.js — Ollama embedding client
 * Calls nomic-embed-cpu (or any Ollama embedding model) to produce vectors.
 */

const http = require('http');

class Embedder {
  constructor(ollamaUrl, model) {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
  }

  /**
   * Embed a single string. Returns Float32Array or null on failure.
   */
  async embed(text) {
    const body = JSON.stringify({ model: this.model, input: text });
    try {
      const raw = await this._post('/api/embed', body);
      const data = JSON.parse(raw);
      // Ollama /api/embed returns { embeddings: [[...]] }
      const vec = data.embeddings?.[0] ?? data.embedding;
      if (!vec) return null;
      return new Float32Array(vec);
    } catch (err) {
      console.warn('[embedder] embed failed:', err.message);
      return null;
    }
  }

  /**
   * Cosine similarity between two Float32Arrays.
   */
  static cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.ollamaUrl);
      const opts = {
        hostname: url.hostname,
        port:     url.port || 80,
        path,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = http.request(opts, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('embed timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = Embedder;
