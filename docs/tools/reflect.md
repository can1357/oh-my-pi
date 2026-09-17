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
  - `docs/tools/retain.md` — shared backend, storage, scoping, and mental-model behavior.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- The tool is registered only for `memory.backend = "hindsight"` or `"mnemopi"`; it is absent for `"off"` and `"local"`.
- In unrestricted sessions with an explicit tool list, registration auto-includes the shared `recall`/`retain`/`reflect` set. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://reflect`; an explicitly requested tool remains top-level.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Question to answer from long-term memory. |
| `context` | `string` | No | Extra guidance. Hindsight sends it as `context`; Mnemopi appends trimmed context to the recall query under `Additional context:`. |

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

## Flow
1. `MemoryReflectTool.createIf(...)` exposes the tool when `memory.backend` is either `"hindsight"` or `"mnemopi"`.
2. `execute(...)` runs under `untilAborted(...)`.
3. If the backend is `mnemopi`:
   - it reads `session.getMnemopiSessionState()` and throws if the backend was not started;
   - if `context` has non-whitespace content, it recalls with `<query>\n\nAdditional context:\n<context>`; otherwise it recalls with `query`;
   - it calls `state.recallResultsScoped(...)` using the same local scoping and merge behavior as `recall`;
   - if results exist, it renders them through `state.formatContextScoped(...)` and prefixes `Based on recalled memories:`.
4. If the backend is `hindsight`:
   - it reads `session.getHindsightSessionState()` and throws if the backend was not started;
   - it calls `ensureBankExists(...)` with the current `bankId`, config, and the session state's `banksSet`;
   - `ensureBankExists(...)` best-effort `PUT`s `/v1/default/banks/{bank_id}` (`createBank`) with optional `reflect_mission` / `retain_mission` once per bank per session state; failures are swallowed;
   - it calls `state.client.reflect(...)` with `query`, optional `context`, configured recall budget, and bank-scope tag filters;
   - `HindsightApi.reflect(...)` POSTs `/v1/default/banks/{bank_id}/reflect` and defaults its own budget to `"low"` when callers omit one; this tool always passes the configured budget;
   - blank or whitespace-only responses are replaced with `No relevant information found to reflect on.`
5. Backend failures are logged with `logger.warn("reflect failed", ...)` and rethrown as `Error` instances when needed.

## Modes / Variants
- Hindsight tool path: one remote reflect request, optionally focused by `context`.
- Mnemopi tool path: one local scoped recall followed by context formatting.
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
  - Mnemopi: none unless configured embedding or LLM providers are used by the local runtime during recall.
- Session state
  - Reads session-held backend scope and config only. Does not update `lastRecallSnippet`, Hindsight mental-model cache, or retain queues.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Tool availability requires `memory.backend` to be `"hindsight"` or `"mnemopi"`; default `memory.backend` is `"off"`.
- Tool-level params: only `query` is required; `context` is optional. Both are plain strings with no schema-level minimum length.
- Hindsight budget comes from `hindsight.recallBudget`, default `"mid"`.
- Hindsight `reflect` has no client-side token cap parameter here; its request deadline defaults to `hindsight.reflectTimeoutMs = 120_000`.
- Hindsight bank initialization tracks up to `MISSION_SET_CAP = 10_000` bank ids per session state, then drops half of the sorted set.
- Mnemopi result count is capped by `mnemopi.recallLimit`, default `8` and runtime-clamped to at least 1; each recalled content preview is capped at 500 characters by default.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Hindsight HTTP, fetch, and timeout failures become `HindsightError`; HTTP errors include `statusCode` and parsed `details` when available.
- Hindsight `ensureBankExists(...)` failures are logged at debug level and hidden from the caller; only the later reflect request can fail visibly.
- Mnemopi recall catches failures per target and logs them. Healthy targets still contribute; if every attempted target fails, the original error or a multi-bank `AggregateError` is thrown rather than converted to the no-information text.
- Non-`Error` failures caught by the tool are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: storage, subagent aliasing, bank scoping, seed mental models, and prompt injection.
- Hindsight `reflect` does not read the cached `<mental_models>` block directly. It queries the Hindsight server over bank contents. The same session may separately have mental-model context in developer instructions.
- Hindsight reflect and retain missions are bank-level server settings, not per-request payload. The tool only ensures them best-effort before reflecting.
- Mnemopi `reflect` is local recall plus formatting. It does not implement the synthesis promised by the generic model-facing `reflect` prompt.
