# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## 自动会话标题

计划批准后的执行会话与普通会话使用同一标题生成流程，遵循 `title.generator`、`title.icons` 和 `TITLE_SYSTEM.md`，不再直接显示由计划文件名转换的纯文本标题。

在 `/settings` → Tasks → Modes 开启「逐条检查标题偏离」，或在配置中设置：

```yaml
title:
  refreshOnDrift: true
```

此开关默认关闭。启用后，每条真实用户消息（包括简短确认）均进入串行偏离判断；需要为 `judge` 模型角色配置并认证原生 System One/Decisions 模型。未配置、判断失败或标题仍适用时保留当前标题，不回退到聊天模型进行判断。手动命名、`--no-title`、中断和会话切换均受保护。

确认偏离后复用首次生成的请求：判定提前运行，但生成等待该轮主回复的首个文本或工具调用块开始，避免在主请求预填充前抢跑；取消或主回复失败会结束等待。默认 `fork` 保留主会话模型、系统提示、工具定义、思考参数和 `promptCacheKey`，仅在末尾追加标题请求，且使用独立请求会话，不改变主对话。缓存能否实际命中仍取决于提供商；`tiny` 和自定义 `TITLE_SYSTEM.md` 继续使用原有标题模型路径。开启逐条模式时不再重复执行 `title.refreshAfterPrompts` 的间隔检查。

## Bash visualization

Embedded-shell calls default to Python-like **Pseudo**; switch to **Raw** for the original command. Syntax appears incrementally as the shell compiles it. Active commands retain their colors while inactive code fades; only failures get `×`. Values appear beside each variable's latest observed setter.

In Tern, the toggle and menu stay in the command segment; replay controls live in the inspector. In the inspector, `v` toggles Raw/Pseudo; `c/i/d/e/u` toggle color, inline variables, idioms, effects and embedded programs; `s` splits original/Pseudo. Space plays or pauses retained execution, arrows step, `r` resets, `l` returns live, and `−/+` changes speed. Escape closes.

Replay retains up to 20,000 records, 2 MiB output and 8 MiB payload; evictions are indicated. Effect badges are heuristic, not safety guarantees. Remote-script interiors are marked untraced; PTY/user-shell calls keep their plain command view.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
