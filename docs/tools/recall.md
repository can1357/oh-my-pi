# recall

> Search the active long-term memory backend and return matching memories.

## Source
- Entry: `packages/coding-agent/src/tools/memory-recall.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/recall.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — session state, recall query defaults, prompt-side auto-recall.
  - `packages/coding-agent/src/hindsight/content.ts` — result formatting and UTC timestamp formatting.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `recall` call and error mapping.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id and tag-filter scoping.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped local recall and result formatting with ids.
  - `packages/coding-agent/src/mnemopi/config.ts` — local bank scoping and recall limits.
- Dakera collaborators:
  - `packages/coding-agent/src/dakera/state.ts` — session state, recall query defaults, prompt-side auto-recall.
  - `packages/coding-agent/src/dakera/client.ts` — HTTP `recall` call, response unwrapping, ranking.
  - `packages/coding-agent/src/dakera/bank.ts` — agent-id scoping.
  - `docs/tools/retain.md` — shared backend, storage, scoping, and retention behavior.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- The tool is registered only for `memory.backend = "hindsight"`, `"mnemopi"`, or `"dakera"`; it is absent for `"off"` and `"local"`.
- In unrestricted sessions with an explicit tool list, registration auto-includes the shared `recall`/`retain`/`reflect` set for any of those backends. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://recall`; an explicitly requested tool remains top-level.
- Execution is single-shot. The tool does not emit streaming argument/result updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Natural-language search query. The tool passes it through unchanged except Mnemopi `per-project-tagged` may run an internal shared-bank fallback query. |

## Outputs
Returns a single-shot tool result.

When matches exist:
- `content[0].type = "text"`
- `content[0].text = "Found <n> relevant memory/memories (as of YYYY-MM-DD HH:MM UTC):\n\n<bullet list>"`
- `details = {}`

Hindsight bullet format comes from `formatMemories(...)`:
- each bullet is `- <text> [<type>] (<mentioned_at>)`; the type and timestamp suffixes appear only when those fields are present.

Dakera reuses the same `formatMemories(...)` renderer, with `<type>` as the row's `memory_type` and `<mentioned_at>` as its `created_at` (Unix seconds, rendered as an ISO-8601 UTC instant). Hits are re-sorted by `smart_score`, falling back to `weighted_score` and then `score`, because the server returns several scoring layers and the strongest one is not always in `score`.

Mnemopi bullet format comes from `formatScopedRecallWithIds(...)`:
- each bullet is `- <content> (id: <id>) [<source>] (<YYYY-MM-DD>) c:<score>`; an unavailable id renders as `(id unavailable)`, and source, date, and score are omitted when absent.
- Mnemopi recall content is a preview capped at 500 characters by default (`RECALL_CONTENT_PREVIEW_CHARS` / `RecallOptions.contentPreviewChars` in `packages/mnemopi/src/core/beam/recall.ts`; `0` or a negative limit disables clipping — the explicit tool path uses the default). A clipped preview ends in `…`; fetch the full row with `read memory://<id>` before a wholesale `memory_edit update`.
- Although the internal recall row carries `truncated` and `full_length`, this tool returns formatted text with `details = {}` and does not expose those fields.

When no matches exist:
- `content[0].text = "No relevant memories found."`
- `details = {}`
- `useless = true`, allowing callers/renderers to treat the result as non-contributing context.

## Flow
1. `MemoryRecallTool.createIf(...)` exposes the tool when `memory.backend` is `"hindsight"`, `"mnemopi"`, or `"dakera"`.
2. `execute(...)` wraps the operation in `untilAborted(...)`.
3. If the backend is `dakera`:
   - it reads `session.getDakeraSessionState()` and throws if the backend was not started;
   - it calls `state.recallFormatted(params.query, signal)`;
   - `DakeraApi.recall(...)` POSTs `/v1/memory/recall` with `agent_id`, the query, and the configured `top_k` / `min_importance` / `rerank`;
   - hits are re-ranked client-side and formatted with `formatMemories(...)`.
4. If the backend is `mnemopi`:
   - it reads `session.getMnemopiSessionState()` and throws if the backend was not started;
   - it calls `state.recallResultsScoped(params.query)`;
   - scoped recall queries every resolved recall bank with `recallEnhanced(query, recallLimit, { includeFacts: true, channelId: bank })`, merges/deduplicates results by id/content, sorts them, and truncates to `recallLimit`;
   - per-project modes may include safe legacy banks whose working-memory rows all belong to the active absolute cwd; startup scanning is capped at 64 candidate bank directories;
   - in `per-project-tagged`, the shared bank may receive one extra fallback query with project-bank literal tokens stripped so broad global memories still match;
   - results are formatted with ids for later full-row reads and `memory_edit`.
5. If the backend is `hindsight`:
   - it reads `session.getHindsightSessionState()` and throws if the backend was not started;
   - it calls `state.client.recall(...)` with `bankId`, query, configured `budget`, `maxTokens`, `types`, and bank-scope tag filters;
   - `HindsightApi.recall(...)` POSTs `/v1/default/banks/{bank_id}/memories/recall`;
   - results are formatted into a plain-text list with `formatMemories(...)`.
6. Backend failures are logged with `logger.warn("recall failed", ...)` and rethrown as `Error` instances when needed.

## Modes / Variants
- Tool path: explicit query-only recall. It does not compose context from recent turns.
- Backend auto-recall has a richer query-composition path in `HindsightSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` and `MnemopiSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)`. `DakeraSessionState` has the same pair.
- Hindsight bank scoping:
  - `global` — no tag filter.
  - `per-project` — separate bank id per project label (git primary checkout root basename; cwd basename outside a repo).
  - `per-project-tagged` — shared bank id plus `project:<project label>` filter with `tagsMatch = "any"`, so project-tagged and untagged global memories can both surface.
- Mnemopi bank scoping:
  - `global` — recall reads the shared bank.
  - `per-project` — recall reads the bank derived from the absolute cwd basename plus a hash of that absolute cwd.
  - `per-project-tagged` — recall reads the cwd-derived project bank and shared bank, then merges results.
  - Per-project modes may also read safely identified legacy cwd-only banks to recover memories created under the earlier git-root-derived scheme.
- Session scope: reads cross-session memory data, using the active session's cached config and scope. Subagent aliases use the parent's backend scope.
- Dakera scoping (the isolation unit is the `agent_id`; there is no bank):
  - `global` — one agent id, so every project's memories mix; retains carry a `project:<label>` tag that recall cannot filter on.
  - `per-project` — `[<prefix>-]<agentId|omp>-<project label>` (project label from the git primary checkout root basename; cwd basename outside a repo), so projects cannot read each other's memories. A `dakera.agentId` in the repository's `.omp/config.yml` replaces that whole derived id — see `docs/memory.md`.
  - `per-project-tagged` is not offered: recall has no tag filter, so a shared id with per-project tags would retain into a scope it could never read back.

## Side Effects
- Network
  - Hindsight: `POST /v1/default/banks/{bank_id}/memories/recall`.
  - Dakera: `POST /v1/memory/recall`.
  - Mnemopi: none unless configured local runtime providers perform embedding/LLM work during recall.
- Session state
  - None on success for the explicit tool path. Unlike backend auto-recall, this tool does not update `lastRecallSnippet` or refresh the system prompt.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Tool availability requires `memory.backend` to be `"hindsight"`, `"mnemopi"`, or `"dakera"`; default `memory.backend` is `"off"`.
- Hindsight client default budget for raw `HindsightApi.recall(...)` is `"mid"`; this tool overrides from config.
- Hindsight recall settings:
  - `hindsight.recallBudget = "mid"`
  - `hindsight.recallMaxTokens = 1024`
  - `hindsight.recallTypes = ["world", "experience"]`
  - `hindsight.recallTimeoutMs = 30_000`
- Mnemopi recall settings:
  - `mnemopi.recallLimit = 8` (runtime-clamped to at least 1)
  - `mnemopi.scoping = "per-project"`
  - content preview cap is 500 characters per result
- Dakera recall settings:
  - `dakera.recallTopK = 8`
  - `dakera.recallMinImportance = 0` (a floor on stored importance, not a stable relevance cutoff: Dakera raises a memory's importance every time it is read)
  - `dakera.recallRerank = true`
  - `dakera.recallTimeoutMs = 30_000`
- The explicit tool path does not apply `hindsight.recallContextTurns`, `hindsight.recallMaxQueryChars`, `mnemopi.recallContextTurns`, `mnemopi.recallMaxQueryChars`, `dakera.recallContextTurns`, or `dakera.recallMaxQueryChars`; those caps only affect backend auto-recall query composition.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Throws `Dakera backend is not initialised for this session.` when `memory.backend == "dakera"` but no state exists.
- Hindsight HTTP, fetch, and timeout failures become `HindsightError`; HTTP errors include `statusCode` and parsed `details` when available.
- Dakera HTTP failures become `DakeraError` with `statusCode` and a `<op> failed: <server detail>` message; fetch and timeout failures carry no `statusCode` and read `<op> request failed: …` / `<op> request timed out after Ns`.
- Mnemopi recall catches failures per target and logs them. Healthy targets still contribute results; if every attempted target fails, the original error (one target) or an `AggregateError` with bank details (multiple targets) is thrown rather than converted to an empty result.
- Non-`Error` failures caught by the tool are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: storage, subagent aliasing, bank scoping, mission setup, and mental-model behavior.
- Hindsight mental models are not fetched by this tool. They may already be present in the agent's developer instructions because the backend caches a `<mental_models>` block separately from recall results.
- Mnemopi developer instructions may include a `<memories>` block from auto-recall; this explicit tool does not update that block.
- The tool returns memory hits; it does not synthesize across them. Use `reflect` for remote Hindsight or Dakera synthesis; Mnemopi's `reflect` variant is local recall plus formatting.
