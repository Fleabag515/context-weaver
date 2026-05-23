# context-weaver

An intelligent context rotation proxy for LLM inference. Sits between your OpenClaw (or any OpenAI-compatible client) and llama-server, giving the model a smarter view of conversation history than a simple sliding window.

## The problem

LLMs have a fixed context window. Naive solutions either:
- **Truncate** — throw away old turns entirely (the model forgets)
- **Summarise** — compress old context into a summary (lossy, irreversible)

## How context-weaver works

Every turn is stored persistently in a local SQLite database with its embedding vector. Each time you send a new message, context-weaver assembles the context window like this:

```
┌─────────────────────────────┐
│  System messages (always)   │
├─────────────────────────────┤
│  Rotating old turns         │  ← scored by cosine similarity to current query
│  (relevance-selected)       │    oldest→newest within selection
├─────────────────────────────┤
│  Last N turns verbatim      │  ← always included (recency buffer)
│  (recency buffer)           │
└─────────────────────────────┘
```

Old turns that aren't relevant to the current message are silently dropped *for this turn* — but stay in the DB and can surface again later when they become relevant. The model always has:
1. Everything recent (last 8 turns by default)
2. The most relevant old context for what's being discussed right now

## Architecture

```
OpenClaw ──→ context-weaver :8084 ──→ llama-server :8083
                    │
                    ├── SQLite history DB  (~/.context-weaver/history.db)
                    └── Ollama embeddings  (nomic-embed-cpu)
```

## Install

```bash
sudo bash install.sh
```

Then update OpenClaw's `llamaserver.baseUrl` to `http://127.0.0.1:8084/v1`.

## Config (`config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `proxy.port` | `8084` | Port this proxy listens on |
| `upstream.baseUrl` | `http://127.0.0.1:8083` | llama-server URL |
| `context.tokenBudget` | `65536` | Total token budget (match llama-server ctx-size) |
| `context.recencyTurns` | `8` | Turn pairs always included verbatim |
| `context.rotatingSlots` | `6` | Max old turn pairs added via relevance scoring |
| `context.charsPerToken` | `3.5` | Token estimation ratio |
| `embedding.model` | `nomic-embed-cpu:latest` | Ollama model for embeddings |
| `history.maxAgeDays` | `90` | Auto-prune turns older than this |

## Roadmap

- [ ] Streaming response support (store assistant turn from streamed chunks)
- [ ] Per-agent session isolation via OpenClaw headers
- [ ] Web UI for browsing/searching history
- [ ] OpenClaw plugin wrapper
- [ ] Configurable recency decay curve
