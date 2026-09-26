# reflect

> Synthesize an answer over the active long-term memory backend.

## Source
- Entry: `packages/coding-agent/src/tools/memory-reflect.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/reflect.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/bank.ts` — best-effort first-use bank/mission setup (`ensureBankExists`).
  - `packages/coding-agent/src/hindsight/state.ts` — session state, shared bank scope, recall/reflect config.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `reflect` call and error mapping.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped local recall and context formatting.
- Dakera collaborators:
  - `packages/coding-agent/src/dakera/reflect.ts` — client-side synthesis: model resolution, prompt rendering, completion call.
  - `packages/coding-agent/src/dakera/state.ts` — ranked recall over the agent id.
  - `packages/coding-agent/src/prompts/memories/dakera-reflect-system.md` and `dakera-reflect-input.md` — synthesis prompts.
  - `docs/tools/retain.md` — shared backend, storage, scoping, and mental-model behavior.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- The tool is registered only for `memory.backend = "hindsight"`, `"mnemopi"`, or `"dakera"`; it is absent for `"off"` and `"local"`.
- In unrestricted sessions with an explicit tool list, registration auto-includes the shared `recall`/`retain`/`reflect` set. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://reflect`; an explicitly requested tool remains top-level.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Question to answer from long-term memory. |
| `context` | `string` | No | Extra guidance. Hindsight sends it as `context`; Mnemopi and Dakera append trimmed context to the recall query under `Additional context:`. |

## Outputs
Returns a single-shot tool result.

Hindsight:
- `content[0].type = "text"`
- `content[0].text = response.text?.trim() || "No relevant information found to reflect on."`
- `details = {}`
- The tool returns the Hindsight server's synthesized text directly; it does not expose raw recall hits.

Mnemopi:
- if no scoped recall results exist: `content[0].text = "No relevant information found to reflect on."`
- otherwise: `content[0].text = "Based on recalled memories:\n\n<formatted context>"`
- `details = {}`
- The local path performs recall plus formatting; it does not call a synthesis model or separate synthesis endpoint. Its result can therefore be raw recalled context rather than a blended answer.

Dakera:
- `content[0].type = "text"`
- `content[0].text` = the synthesis model's answer over the recalled memories, oldest-first, each prefixed with its timestamp and `memory_type`.
- `details = {}`
- Empty recall and an empty model answer both return `No relevant information found to reflect on.` — an empty answer is a result, not an error.
- Nothing is written back: a reflection stored as a memory would feed the next recall.

## Flow
1. `MemoryReflectTool.createIf(...)` exposes the tool when `memory.backend` is `"hindsight"`, `"mnemopi"`, or `"dakera"`.
2. `execute(...)` runs under `untilAborted(...)`.
3. If the backend is `dakera`:
   - it reads `session.getDakeraSessionState()` and throws if the backend was not started; it also throws if the session carries no `modelRegistry`;
   - `state.recallHits(...)` runs one recall over the question (with `Additional context:` appended when `context` is set) and ranks the hits by `smart_score`, then `weighted_score`, then `score`; the request carries `dakera.recallTimeoutMs`;
   - `runDakeraReflect(...)` resolves the synthesis model (`dakera.reflectModel`, else the `smol` role, else `default`), renders `dakera-reflect-input.md` over the question plus the formatted hits, and makes one non-streaming completion call with `maxTokens: 1024` and low reasoning, under `dakera.reflectTimeoutMs`;
   - a completion whose `stopReason` is `error` throws its `errorMessage` (or `Dakera reflect model error`).
4. If the backend is `mnemopi`:
   - it reads `session.getMnemopiSessionState()` and throws if the backend was not started;
   - if `context` has non-whitespace content, it recalls with `<query>\n\nAdditional context:\n<context>`; otherwise it recalls with `query`;
   - it calls `state.recallResultsScoped(...)` using the same local scoping and merge behavior as `recall`;
   - if results exist, it renders them through `state.formatContextScoped(...)` and prefixes `Based on recalled memories:`.
5. If the backend is `hindsight`:
   - it reads `session.getHindsightSessionState()` and throws if the backend was not started;
   - it calls `ensureBankExists(...)` with the current `bankId`, config, and the session state's `banksSet`;
   - `ensureBankExists(...)` best-effort `PUT`s `/v1/default/banks/{bank_id}` (`createBank`) with optional `reflect_mission` / `retain_mission` once per bank per session state; failures are swallowed;
   - it calls `state.client.reflect(...)` with `query`, optional `context`, configured recall budget, and bank-scope tag filters;
   - `HindsightApi.reflect(...)` POSTs `/v1/default/banks/{bank_id}/reflect` and defaults its own budget to `"low"` when callers omit one; this tool always passes the configured budget;
   - blank or whitespace-only responses are replaced with `No relevant information found to reflect on.`
6. Backend failures are logged with `logger.warn("reflect failed", ...)` and rethrown as `Error` instances when needed.

## Modes / Variants
- Hindsight tool path: one remote reflect request, optionally focused by `context`.
- Mnemopi tool path: one local scoped recall followed by context formatting.
- Dakera tool path: one recall plus one client-side synthesis call. Dakera has no generative endpoint — `consolidate` and `knowledge_summarize` concatenate their inputs rather than synthesize (and `consolidate` ignores `dry_run`, merging and deleting the sources), so neither can stand in for `reflect`.
- Hindsight bank scoping:
  - `global` — no tag filter.
  - `per-project` — separate bank id per project label (git primary checkout root basename; cwd basename outside a repo).
  - `per-project-tagged` — shared bank id plus `project:<project label>` filter with `tagsMatch = "any"`.
- Mnemopi bank scoping:
  - `global` — reads the shared bank.
  - `per-project` — reads the bank derived from the absolute cwd basename plus a hash of that cwd.
  - `per-project-tagged` — reads the cwd-derived project bank and shared bank, then merges results.
  - Per-project modes may also include safe cwd-matching legacy banks discovered at startup.
- Session scope: reads cross-session memory data, but does not persist local output. Subagent aliases use the parent's backend scope.

## Side Effects
- Network
  - Hindsight: optional `PUT /v1/default/banks/{bank_id}` from `ensureBankExists(...)`, then `POST /v1/default/banks/{bank_id}/reflect`.
  - Dakera: `POST /v1/memory/recall`, then the synthesis model's own provider call.
  - Mnemopi: none unless configured embedding or LLM providers are used by the local runtime during recall.
- Session state
  - Reads session-held backend scope and config only. Does not update `lastRecallSnippet`, Hindsight mental-model cache, or retain queues.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Tool availability requires `memory.backend` to be `"hindsight"`, `"mnemopi"`, or `"dakera"`; default `memory.backend` is `"off"`.
- Tool-level params: only `query` is required; `context` is optional. Both are plain strings with no schema-level minimum length.
- Hindsight budget comes from `hindsight.recallBudget`, default `"mid"`.
- Hindsight `reflect` has no client-side token cap parameter here; its request deadline defaults to `hindsight.reflectTimeoutMs = 120_000`.
- Hindsight bank initialization tracks up to `MISSION_SET_CAP = 10_000` bank ids per session state, then drops half of the sorted set.
- Mnemopi result count is capped by `mnemopi.recallLimit`, default `8` and runtime-clamped to at least 1; each recalled content preview is capped at 500 characters by default.
- Dakera input is capped by `dakera.recallTopK` (default `8`) and the synthesis answer by `maxTokens: 1024`. Each leg has its own deadline — `dakera.recallTimeoutMs` (default `30_000`) for the recall request, `dakera.reflectTimeoutMs` (default `120_000`) for the completion call — so there is no single reflect-wide deadline; the two stack. Recall failures degrade to the no-information text only when the recall itself returns nothing — a thrown `DakeraError` propagates.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Throws `Dakera backend is not initialised for this session.` when `memory.backend == "dakera"` but no state exists, and `Dakera reflect has no model registry for this session.` when the session cannot supply one.
- Dakera throws `Dakera reflect needs a model: set dakera.reflectModel or a smol/default model role.` when none of those resolve, and the model's own error message when the completion stops with `error`.
- Hindsight HTTP, fetch, and timeout failures become `HindsightError`; HTTP errors include `statusCode` and parsed `details` when available.
- Hindsight `ensureBankExists(...)` failures are logged at debug level and hidden from the caller; only the later reflect request can fail visibly.
- Mnemopi recall catches failures per target and logs them. Healthy targets still contribute; if every attempted target fails, the original error or a multi-bank `AggregateError` is thrown rather than converted to the no-information text.
- Non-`Error` failures caught by the tool are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: storage, subagent aliasing, bank scoping, seed mental models, and prompt injection.
- Hindsight `reflect` does not read the cached `<mental_models>` block directly. It queries the Hindsight server over bank contents. The same session may separately have mental-model context in developer instructions.
- Hindsight reflect and retain missions are bank-level server settings, not per-request payload. The tool only ensures them best-effort before reflecting.
- Mnemopi `reflect` is local recall plus formatting. It does not implement the synthesis promised by the generic model-facing `reflect` prompt.
- Dakera `reflect` is the only backend whose synthesis runs in omp: the answer is a model completion over recalled rows, so its quality is bounded by what recall surfaced, and the answer itself is never stored.
