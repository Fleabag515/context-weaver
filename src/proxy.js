#!/usr/bin/env node
/**
 * proxy.js — Context Weaver main server
 *
 * Listens on config.proxy.port, intercepts /v1/chat/completions,
 * runs context selection, forwards to llama-server, stores response.
 *
 * All other routes are passed through transparently.
 */

const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const config      = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
const HistoryStore = require('./history.js');
const Embedder    = require('./embedder.js');
const Selector    = require('./selector.js');

const history  = new HistoryStore(config.history.dbPath);
const embedder = new Embedder(config.embedding.ollamaUrl, config.embedding.model);
const selector = new Selector(config, history, embedder);

// Prune old history on startup
const pruned = history.prune(config.history.maxAgeDays);
if (pruned > 0) console.log(`[proxy] pruned ${pruned} old turns from history`);

// ---------------------------------------------------------------------------
// Session key derivation — use Authorization header or a fixed fallback
// ---------------------------------------------------------------------------
function getSessionKey(req) {
  const auth = req.headers['authorization'] ?? '';
  // OpenClaw sends the agent+user combo in a custom header if available
  const ocSession = req.headers['x-openclaw-session'] ?? req.headers['x-session-id'] ?? '';
  if (ocSession) return `oc:${ocSession}`;
  if (auth)      return `auth:${auth.slice(-16)}`;
  return 'default';
}

// ---------------------------------------------------------------------------
// Forward a request to the upstream llama-server
// ---------------------------------------------------------------------------
function forward(reqOpts, body) {
  return new Promise((resolve, reject) => {
    const upUrl  = new URL(config.upstream.baseUrl);
    const isHttps = upUrl.protocol === 'https:';
    const lib    = isHttps ? https : http;

    const opts = {
      hostname: upUrl.hostname,
      port:     upUrl.port || (isHttps ? 443 : 80),
      path:     reqOpts.path,
      method:   reqOpts.method,
      headers:  {
        ...reqOpts.headers,
        'Authorization': `Bearer ${config.upstream.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const upReq = lib.request(opts, upRes => {
      const chunks = [];
      upRes.on('data', d => chunks.push(d));
      upRes.on('end', () => resolve({ status: upRes.statusCode, headers: upRes.headers, body: Buffer.concat(chunks) }));
    });
    upReq.on('error', reject);
    upReq.setTimeout(300000, () => { upReq.destroy(); reject(new Error('upstream timeout')); });
    upReq.write(body);
    upReq.end();
  });
}

// ---------------------------------------------------------------------------
// Main server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);

    // Only intercept chat completions
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let parsed;
      try { parsed = JSON.parse(rawBody.toString()); }
      catch { return passthrough(req, res, rawBody); }

      if (!Array.isArray(parsed.messages)) return passthrough(req, res, rawBody);

      const sessionKey = getSessionKey(req);
      const streaming  = parsed.stream === true;

      // --- Store incoming user turn & embed it ---
      const userMsg = parsed.messages.findLast?.(m => m.role === 'user')
                   ?? parsed.messages.filter(m => m.role === 'user').pop();

      let queryVec = null;
      if (userMsg?.content) {
        queryVec = await embedder.embed(userMsg.content);
        const tokenEst = Math.ceil(userMsg.content.length / config.context.charsPerToken);
        history.insertTurn(sessionKey, 'user', userMsg.content, queryVec, tokenEst);
      }

      // --- Run context selection ---
      let selectedMessages;
      try {
        selectedMessages = await selector.select(sessionKey, parsed.messages);
      } catch (err) {
        console.error('[proxy] selector error, falling back to original messages:', err.message);
        selectedMessages = parsed.messages;
      }

      const rewritten = { ...parsed, messages: selectedMessages };
      const rewrittenBody = Buffer.from(JSON.stringify(rewritten));

      // --- Forward to upstream ---
      let upRes;
      try {
        upRes = await forward(req, rewrittenBody);
      } catch (err) {
        console.error('[proxy] upstream error:', err.message);
        res.writeHead(502);
        return res.end(JSON.stringify({ error: err.message }));
      }

      // --- Store assistant response ---
      if (!streaming) {
        try {
          const upParsed = JSON.parse(upRes.body.toString());
          const assistantContent = upParsed.choices?.[0]?.message?.content ?? '';
          if (assistantContent) {
            const aVec     = await embedder.embed(assistantContent.slice(0, 2000));
            const tokenEst = Math.ceil(assistantContent.length / config.context.charsPerToken);
            history.insertTurn(sessionKey, 'assistant', assistantContent, aVec, tokenEst);
          }
        } catch { /* non-fatal */ }
      }

      // --- Return response to client ---
      res.writeHead(upRes.status, upRes.headers);
      return res.end(upRes.body);
    }

    // All other routes: pass through transparently
    passthrough(req, res, rawBody);
  });
});

async function passthrough(req, res, body) {
  try {
    const upRes = await forward(req, body);
    res.writeHead(upRes.status, upRes.headers);
    res.end(upRes.body);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  }
}

server.listen(config.proxy.port, config.proxy.host, () => {
  console.log(`[context-weaver] proxy listening on ${config.proxy.host}:${config.proxy.port}`);
  console.log(`[context-weaver] upstream: ${config.upstream.baseUrl}`);
  console.log(`[context-weaver] embedding: ${config.embedding.model} @ ${config.embedding.ollamaUrl}`);
  console.log(`[context-weaver] token budget: ${config.context.tokenBudget}, recency: ${config.context.recencyTurns} turns, rotating slots: ${config.context.rotatingSlots}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
