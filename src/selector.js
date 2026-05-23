/**
 * selector.js — Context rotation engine
 *
 * Given the full conversation history and the current incoming messages,
 * assembles the optimal context window:
 *
 *   [ system messages ]
 *   [ ...rotating old turns, scored by relevance to current query ]
 *   [ ...last N turns verbatim (recency buffer) ]
 *
 * Older turns that don't make the relevance cut are silently dropped
 * for this turn — but remain in the history DB and may appear in future
 * turns when they become relevant again.
 */

const HistoryStore = require('./history.js');
const Embedder     = require('./embedder.js');

class Selector {
  constructor(config, historyStore, embedder) {
    this.cfg     = config.context;
    this.history = historyStore;
    this.embedder = embedder;
  }

  /**
   * Build the final messages array to send upstream.
   *
   * @param {string}   sessionKey  - unique key for this conversation
   * @param {object[]} incoming    - the messages[] from the client request
   * @returns {object[]}           - rewritten messages[] for the LLM
   */
  async select(sessionKey, incoming) {
    const {
      tokenBudget,
      systemReserveTokens,
      recencyTurns,
      rotatingSlots,
      charsPerToken,
      minChunkChars,
    } = this.cfg;

    // --- 1. Separate system messages from conversation turns ---
    const systemMsgs = incoming.filter(m => m.role === 'system');
    const convoMsgs  = incoming.filter(m => m.role !== 'system');

    // --- 2. The last message is the current user query ---
    const currentMsg = convoMsgs[convoMsgs.length - 1];
    const queryText  = currentMsg?.content ?? '';

    // --- 3. Embed the current query for relevance scoring ---
    const queryVec = await this.embedder.embed(queryText);

    // --- 4. Load full history from DB (excludes current incoming turns) ---
    const stored = this.history.getSessionTurns(sessionKey);

    // --- 5. Recency buffer: last N turns from incoming convo (always kept) ---
    const recencyMsgs = convoMsgs.slice(Math.max(0, convoMsgs.length - recencyTurns * 2));
    const recencyIds  = new Set(recencyMsgs.map((_, i) => `incoming-${convoMsgs.length - recencyMsgs.length + i}`));

    // --- 6. Candidate pool: stored turns not in the recency window ---
    //    We pair user+assistant turns as chunks for coherence.
    const chunks = this._pairTurns(stored);
    const recencyCount = Math.ceil(recencyMsgs.length / 2);
    const candidates = chunks.slice(0, Math.max(0, chunks.length - recencyCount));

    // --- 7. Score candidates by cosine similarity to current query ---
    const scored = candidates
      .filter(c => c.text.length >= minChunkChars)
      .map(c => {
        const storedVec = c.embedding ? HistoryStore.toFloat32(c.embedding) : null;
        const sim = storedVec && queryVec ? Embedder.cosine(queryVec, storedVec) : 0;
        return { ...c, sim };
      })
      .sort((a, b) => b.sim - a.sim);

    // --- 8. Fill rotating slots within token budget ---
    const systemTokens  = this._estimateTokens(systemMsgs, charsPerToken);
    const recencyTokens = this._estimateTokens(recencyMsgs, charsPerToken);
    let remaining = tokenBudget - systemReserveTokens - systemTokens - recencyTokens;

    const selected = [];
    for (const chunk of scored.slice(0, rotatingSlots * 3)) {  // oversample, then cap
      if (selected.length >= rotatingSlots) break;
      const cost = Math.ceil(chunk.text.length / charsPerToken);
      if (cost <= remaining) {
        selected.push(chunk);
        remaining -= cost;
      }
    }

    // --- 9. Sort selected chunks chronologically so context reads naturally ---
    selected.sort((a, b) => a.createdAt - b.createdAt);

    // --- 10. Assemble final messages ---
    const rotatingMsgs = selected.flatMap(c => c.messages);

    const final = [
      ...systemMsgs,
      ...rotatingMsgs,
      ...recencyMsgs,
    ];

    console.log(
      `[selector] session=${sessionKey.slice(0,8)} ` +
      `history=${stored.length} candidates=${candidates.length} ` +
      `selected=${selected.length} recency=${recencyMsgs.length} ` +
      `total=${final.length} budget_remaining=${remaining}`
    );

    return final;
  }

  /**
   * Pair consecutive user+assistant turns into coherent chunks.
   */
  _pairTurns(turns) {
    const chunks = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      // Use the assistant turn's embedding (it summarises the exchange)
      if (t.role === 'assistant') {
        const prev = turns[i - 1];
        const messages = prev && prev.role === 'user'
          ? [{ role: 'user', content: prev.content }, { role: 'assistant', content: t.content }]
          : [{ role: 'assistant', content: t.content }];
        chunks.push({
          messages,
          text:      messages.map(m => m.content).join(' '),
          embedding: t.embedding,
          createdAt: t.created_at,
        });
      }
    }
    return chunks;
  }

  _estimateTokens(msgs, charsPerToken) {
    return msgs.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / charsPerToken), 0);
  }
}

module.exports = Selector;
