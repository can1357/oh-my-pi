# refresh

> Re-reads config surfaces frozen at session start (skills, rules, settings, default model, MCP) and swaps the fresh values into the running session — no restart, conversation preserved.

## Source
- Entry: `packages/coding-agent/src/tools/refresh.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/refresh.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — `AgentSession.refresh(scope)` orchestrates the reload, fans the roster to subagents, and gates the system-prompt rebuild. Auto-run is gated by the tool's `approval = "exec"` tier through `resolveApproval` (exec outranks the `always-ask` / `write` mode caps, so it prompts).
  - `packages/coding-agent/src/extensibility/reload.ts` — `reloadSkillsAndRules(...)`, `REFRESH_SCOPES`, `RefreshScope`, `RefreshResult`.
  - `packages/coding-agent/src/capability/rule-buckets.ts` — `bucketRules(...)` splits discovered rules into TTSR / always-apply / rulebook.
  - `packages/coding-agent/src/slash-commands/builtin-registry.ts` — the `/refresh [scope]` human surface.
  - `packages/coding-agent/src/session/acp-permission-gate.ts` — `refresh` is listed in `PERMISSION_REQUIRED_TOOLS` and given a `getPermissionIntent` branch, so a connected ACP client is prompted for permission before refresh executes. `mcp`, `all`, and `settings` share one privileged identity (title `Refresh {scope} (may reconnect MCP servers)`, `cacheKey: "refresh:mcp-exec"`); `skills` and `rules` keep a per-scope `cacheKey: "refresh:{scope}"`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | `"skills" \| "rules" \| "settings" \| "mcp" \| "all"` | No (default `all`) | Which frozen config surface to re-read from disk. |

The scope set is single-sourced from `REFRESH_SCOPES` (`reload.ts`); the arktype schema and the `/refresh` argument validator both derive from it.

## Outputs
Single-shot `AgentToolResult<RefreshToolDetails>`.

- `content`: one text part — `summarizeRefresh(scope, result)`, e.g. `Refreshed (all): 12 skills, 7 rules, settings updated, model swapped, MCP reconnected.` An empty result renders `Refreshed (<scope>): nothing to reload.`
- `details`: `{ scope, result }` where `result` is a `RefreshResult`:
  - `skills?: number` — skills active after a roster reload.
  - `rules?: number` — rules addressable via `rule://` after a roster reload.
  - `settingsChanged?: boolean` — merged settings view changed on a settings reload.
  - `modelSwapped?: boolean` — active default model swapped on a settings reload.
  - `mcp?: true` — MCP servers rediscovered and tools rebound (`true` when the reconnect ran; omitted when no MCP manager exists).

If the session exposes no `refresh` hook, `execute` returns `Refresh is unavailable in this session.` as an error result.

## Flow
1. `RefreshTool.execute(...)` resolves `scope` (default `all`) and calls `session.refresh(scope)`.
2. `AgentSession.refresh(scope)` derives three booleans — `doRoster` (`all`/`skills`/`rules`), `doSettings` (`all`/`settings`), `doMcp` (`all`/`mcp`) — and tracks `rosterChanged`.
3. Roster (`doRoster`, requires a TTSR manager):
   - `reloadSkillsAndRules(...)` re-runs the init discovery pipeline (`loadSkills` + `loadCapability(rules)` + `bucketRules`) and swaps the `activeSkills`/`activeRules` process globals.
   - `applyReloadedSkills(...)` threads the fresh skills into this session's `#skills` and fans them out to this session's running descendants on the registry it was created against; returns whether the top-level skill set changed. A descendant whose snapshot actually moved also gets its own base system prompt rebuilt — dispatched onto that descendant's tool-registry mutation tail, not awaited, so a slow or already-busy child cannot stall the parent's refresh.
   - A rules delta is computed by comparing the rendered rulebook + always-apply buckets against the prior snapshot (`#rosterRules`), so a rules-only change also rebuilds the prompt.
   - `#applyReloadedRoster?.(...)` threads the fresh skills/rules into the system-prompt closure locals.
4. Settings (`doSettings`): `settings.reload()` re-reads every overlay (pure re-read, no write); on a change `#applyReloadedModel()` re-resolves and swaps the default model unless a session `/model` override is pinned. The reload also reconciles state a re-read alone cannot reach: the live agent's queue modes (`steeringMode`/`followUpMode`/`interruptMode`, held in `Agent` state), and a prompt rebuild when a prompt-affecting setting (`personality`, `tools.xdevDocs`/`tools.xdevInlineDevices`) actually moved. Both compare pre- against post-reload values, so an unrelated edit changes nothing.
5. MCP (`doMcp`): `disconnectAll()` then `discoverAndConnect({ enableProjectConfig, filterExa, filterBrowser })` — threading the same options startup uses — then `refreshMCPTools(...)` rebinds the tools.
6. The base system prompt is rebuilt once (`refreshBaseSystemPrompt()`) iff `rosterChanged`; a no-op refresh leaves the prompt byte-identical so prompt caching keeps hitting.

## Modes / Variants
- `skills` / `rules` — re-scan the roster; both re-scan together, the scope names which count you get back.
- `settings` — re-read settings layers and re-resolve the default model.
- `mcp` — disconnect and rediscover MCP servers, rebinding their tools.
- `all` — every surface above.
- `/refresh [scope]` — the human slash-command surface; validates the argument against `REFRESH_SCOPES` and prints `summarizeRefresh(...)`.

## Side Effects
- Filesystem
  - None written. Pure re-read: no config file is written or reformatted.
- Session state
  - Swaps the `activeSkills` / `activeRules` process globals.
  - Overwrites `#skills` on this session and every registered session (advisors included; they never resolve `skill://`, so it is a harmless no-op for them).
  - May swap the session's active model (`doSettings`), unless a session `/model` override is pinned.
  - Reconnects MCP transports and rebinds MCP tools (`doMcp`) — for a stdio server this spawns its `command` as a subprocess.
- User-visible prompts / interactive UI
  - Rebuilds the advertised system prompt when the roster changed.
  - `/refresh` prints the one-line summary.

## Limits & Caps
- Tool execution mode: `approval = "exec"`, `concurrency = "exclusive"`, `strict = true`, `loadMode = "discoverable"`.
- `approval = "exec"`: refresh reconnects MCP (arbitrary subprocess exec) and mutates cross-session state, so `resolveApproval` prompts for it (exec tier outranks the `always-ask` / `write` mode caps) and it never auto-runs in those modes — only `yolo` (exec cap) auto-allows.
- ACP permission gate: `refresh` is in `PERMISSION_REQUIRED_TOOLS` (`acp-permission-gate.ts`), so when an ACP client is connected it must approve the call via `getPermissionIntent`. Only `skills` and `rules` are benign — they re-read the roster from disk and spawn nothing — so they keep a per-scope `cacheKey` (`refresh:{scope}`) and an "always allow" there stays scope-local. `settings` shares the privileged `refresh:mcp-exec` key with `mcp` and `all`, because a persisted `browser.enabled` flip reaches `MCPManager.reconcileBrowserFilter` and connects browser stdio servers — so approving it is approving MCP reconnection (arbitrary subprocess exec), and the prompt title says so. This is complementary to the exec-tier gate above: the exec tier governs in-process approval modes, the ACP gate is the ACP-client permission prompt.
- The roster path is a no-op when the session has no TTSR manager.
- The MCP path is a no-op when no process-global `MCPManager` exists.

## Errors
- Session without a `refresh` hook: `execute` returns `Refresh is unavailable in this session.` with `isError: true`.
- `/refresh <bad-scope>`: the command surfaces `Unknown refresh scope "<arg>". Use: skills, rules, settings, mcp, all.`
- `/refresh` failures are caught by the command handler and surfaced as `Refresh failed: <message>`.

## Notes
- Reusing the live TTSR manager across reloads preserves in-flight injected/trigger state; a brand-new or rulebook/always-apply rule is picked up, but an *edited condition* on an already-registered TTSR rule is not re-read (that sub-case still needs a restart).
- `bucketRules` gates a TTSR-conditioned rule on manager membership (`hasRule`), so a rule already consumed by TTSR on a prior reload is not re-bucketed into the rulebook — keeping the rendered roster reload-stable.
- The MCP refresh threads `enableProjectConfig` from settings, so a session that opted out of project-level MCP (`mcp.enableProjectConfig: false`) stays opted out across a refresh.
