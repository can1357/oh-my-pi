---
type: Concept
title: Context and token optimization
description: Tunables that reduce the per-request LLM context baseline for oh-my-pi-fork sessions without losing tools or functionality.
tags: [context, tokens, performance, caching, compaction, tools]
timestamp: 2026-07-07T00:00:00Z
---

# Context and token optimization

Every new user message is sent alongside a system prompt, project context, and a set of active tool schemas. The size of this fixed baseline directly affects latency, cost, and how much room remains for the actual conversation. This concept documents the baseline composition and the tunables that shrink it.

## What contributes to the baseline

At session start the provider request includes, at minimum:

1. **System prompt block** (`packages/coding-agent/src/prompts/system/system-prompt.md`)
   - Base contracts, role, tool list, tool-use guidelines, and personality text.
2. **Project prompt block** (`packages/coding-agent/src/prompts/system/project-prompt.md`)
   - Workstation metadata.
   - Loaded context files (`AGENTS.md`, `CLAUDE.md`, etc.).
   - Current date and working directory.
3. **Active tool schemas**
   - Name, description, and JSON schema parameters for every tool exposed to the model.
4. **Skills notice**
   - In lazy discovery mode, only a one-line count plus a `skill://?q=<keywords>` pointer is injected, rather than the full skill list.

The dominant variable is usually the **active tool schema block**: exposing every built-in tool at once adds tens of thousands of tokens before the first user turn.

## Recommended tunables

### 1. Hide non-essential tools behind discovery

`tools.discoveryMode: all` keeps only a small essential set (`read`, `bash`, `edit`, `find`, `search`, `write`, `todo`) plus the `search_tool_bm25` coordinator active. Specialized tools are retrieved on demand via `search_tool_bm25`.

- Location: `~/.ompk/agent/config.yml`
- Default in schema: already `all`, but writing it explicitly makes the behavior permanent and visible.

```yaml
tools:
  discoveryMode: all
```

### 2. Use provider-gated prefix caching

`provider.appendOnlyContext: auto` tells the harness to cache the system prompt + tool specs and keep an append-only message log, but **only** for providers known to support prefix caching (Anthropic, DeepSeek, Xiaomi/SGLang).

- For unknown providers, forcing `on` changes protocol behavior without caching gain.
- `auto` is the safe, default-aware setting.

```yaml
provider:
  appendOnlyContext: auto
```

### 3. Prefer deterministic compaction over summarization

`compaction.strategy` controls how the harness shrinks context when the window fills.

- `context-full` (default): sends the full conversation to a compaction model for summarization. Accurate but costs an extra LLM call.
- `shake`: drops heavy tool results and large blocks in place; original content remains recoverable via `artifact://`. No extra LLM call, and the active context stays smaller.

For long coding sessions, `shake` is usually the better cost/performance tradeoff.

```yaml
compaction:
  strategy: shake
```

### 4. Keep injected context files concise

`AGENTS.md` and `CLAUDE.md` are injected into every request. Trim redundant examples, outdated rules, and duplicated guidance. The project goal should be to keep each under ~8 KB of raw text.

## What to verify after tuning

After applying these changes, you can validate the effect by:

- Checking the token-usage display (`display.showTokenUsage: true`) on the first assistant turn of a fresh `/new` session.
- Watching for the cache-miss marker (`display.cacheMissMarker: true`) if you want to confirm prefix-cache behavior.
- Confirming that specialized tools are still reachable via `search_tool_bm25` when needed.
