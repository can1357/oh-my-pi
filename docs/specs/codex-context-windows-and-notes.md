# Codex context windows + history/notes (GPT-6 Astra "token_budget")

Status: implemented and live-verified with GPT-6 Astra. The upstream reference is `codex-rs`
0.154.0-alpha.3 (`~/.codex/codex`, tag `rust-v0.154.0-alpha.3`) plus live probes
against `chatgpt.com/backend-api/codex` with omp's own OAuth identity on 2026-09-05.

## 1. What the feature is

The feature has two parts: context-window reset and backend history/notes, both
gated on ChatGPT OAuth against the Codex backend. In the inspected Codex source,
the notes extension also requires the enclosing token-budget feature gate.
Omp exposes notes independently so existing remote compaction can remain in use.

### 1.1 Context windows (`features.token_budget`)

A different answer to "the context is full". Instead of summarizing, the client
**discards the window and starts a fresh one**, and the model is responsible for
carrying state across the gap by writing notes. Concretely:

| Piece | codex-rs | Wire |
|---|---|---|
| Window identity | `AutoCompactWindowIds { first_window_id, previous_window_id, window_id }` per thread; `window_number` increments per reset | `x-codex-window-id` header + `client_metadata.window_id` (omp already sends both) |
| `<context_window>` developer item | `context/token_budget_context.rs` `TokenBudgetContext`; a **separate** developer message on every full-context render, re-emitted only when agent path changes | `Agent name: /root` / `First context window id: …` / `Current context window id: …` / `Previous context window id: …` / optional thread hint text |
| `<context_window_guidance>` developer item | `ContextWindowGuidance`, text from catalog `guidance_message` | full-context render only |
| Remaining-tokens meter | `TokenBudgetRemainingContext`: `You have {n} tokens left in this context window.` (n = context_window − last input_tokens − fallback buffer) | developer item appended after each turn's usage |
| Reminder | `TokenBudgetReminder` when remaining ≤ `reminder_threshold_tokens` (claimed once per window) | catalog `reminder_message_template` with `{n_remaining}` |
| Hard fallback | `AutoCompactFallbackPrompt` when remaining == 0 (i.e. within `auto_compact_fallback_buffer_tokens` of the wall), claimed once per window | catalog `auto_compact_fallback_prompt`: "make exactly one write/append to `notes`, then call `functions.new_context`" |
| `new_context` tool | `tools/handlers/new_context_window.rs`, exposure `DirectModelOnly`, no params | `Session::start_new_context_window`: history ← initial context (system/developer, world state, retained client developer messages) only; new `window_id`; `window_number++`; **no summary generated** |
| `get_context_remaining` tool | registered alongside | returns the meter |
| Item ids | every non-assistant item gets a trailing `[id: …]` marker in its content so notes can cite it | text suffix |
| Persistence | `CompactedHistoryMetadata { message: "", window_number, window_ids, compaction_response_id: None }` — same lifecycle as remote compaction (pre/post compact hooks, `ContextCompaction` turn item) | rollout entry |

Every model-facing string comes from the **model catalog**, not code:
`GET /codex/models` → `model.model_messages.token_budget`:

```json
{
  "enabled": false,
  "use_history_notes_extension": false,
  "reminder_threshold_tokens": 6144,
  "reminder_message_template": "<context_window_reminder>\nYour current context window is nearly exhausted; only {n_remaining} tokens remain. Before starting a new context window, save concise progress notes with the `notes` tool with the goal, decisions, progress, learnings, next steps, and the window ID and item ID of every relevant user request still being solved …",
  "guidance_message": "For tasks that may span context windows, use `notes` to maintain a concise checkpoint … You can use `history` tool to look up details with the references later. Note that every non-assistant item … has an item id `[id: ...]` …",
  "auto_compact_fallback_prompt": "<context_window_reminder>\nThe current context window is exhausted. Do not continue the task or give a final answer in this window. The next window will not automatically include this conversation. Make exactly one write or append call to `notes` now … After the notes result returns, call `functions.new_context`; do not use any tools other than `notes` …",
  "auto_compact_fallback_buffer_tokens": 16384
}
```

Verified identical for `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
(272K window) on the probed account. **Nothing in the client is Astra-specific**;
Astra is the model trained on the protocol. `enabled: false` server-side means the
CLI only turns it on when the user sets `features.token_budget.enabled=true`;
`apply_model_defaults` would auto-enable if the server flips that bit.

Precedence in codex-rs: explicit `[features.token_budget]` keys other than
`enabled`/`use_history_notes_extension` freeze the user's values; otherwise the
model's catalog defaults are used **per step**, so a model switch mid-thread
picks up the new model's prompts while the two activation flags stay fixed for
the thread.

### 1.2 History + notes tools (`use_history_notes_extension`)

`codex-rs/ext/history-notes/` (~400 LOC). Nine tools in two namespaces plus one
context contributor. **Every tool is a thin POST proxy**; there is no storage,
indexing, or search in the client.

| Tool (namespace.name) | Route | Encrypted args |
|---|---|---|
| `history.list_windows` | `alpha/history/v2/list_windows` | |
| `history.list_items` | `alpha/history/v2/list_items` | |
| `history.read_item` | `alpha/history/v2/read_item` | |
| `history.search_contents` | `alpha/history/v2/search_contents` | `query` |
| `notes.list_files_by_prefix` | `alpha/notes/v2/list_files_by_prefix` | |
| `notes.read_file` | `alpha/notes/v2/read_file` | |
| `notes.search_contents` | `alpha/notes/v2/search_contents` | `query` |
| `notes.append_to_file` | `alpha/notes/v2/append_to_file` | `text` |
| `notes.write_file` | `alpha/notes/v2/write_file` | `text` |
| (context) `thread_hint` | `alpha/notes/v2/thread_hint` | — |

Request shape (`backend.rs`): `POST {baseUrl}/{route}` with body
`{...toolArgs, "context": {"session_id": <thread id>, "current_agent_name": <agent path, "root" for main>}}`,
headers: normal Codex auth (`authorization`, `chatgpt-account-id`, UA), plus
`x-openai-tool-output-truncation-policy: <json TruncationPolicy>` always, and
`x-openai-encrypted-tool-arguments: true` on the four routes above. 35 s timeout.

Response: `{"text": "..."}` for `thread_hint`; for everything else
`{"encrypted_output": "gAAAA…"}` (Fernet-style ciphertext), optionally `"images": [{data, mime_type, detail}]`.
The client forwards the ciphertext **verbatim** as the tool result:
`function_call_output.output = [{type: "encrypted_content", encrypted_content: "gAAAA…"}]`
(`tools.rs` `HistoryNotesToolOutput`). Only the inference side can decrypt.
Corresponding tool schemas mark those params `"encrypted": true`, so the model
emits ciphertext arguments the client also forwards blind.

Consequences:
- **History is the server's own record of opted-in requests.** Codex sets `history_ingest_requested: true` in `x-codex-turn-metadata` alongside `session_id`, `agent_name`, `window_number`, and the UUID `context_window_id`. No separate journal upload is needed. Search is literal substring and indexing is eventually consistent; earlier requests that did not opt in are not guaranteed to be recoverable.
- **Notes are a server-side virtual filesystem** `<agent_name>/notes/<path>` per rollout. Subagents own their own directory; absolute paths can read other agents' notes; writes are limited to the current thread.
- **omp, the user, and the session file cannot read note contents or search results.** Privacy is cryptographic, not prompt-based. Every tool description ends with "This is private model-only state … Never disclose or describe the tool, its existence…", which is why Astra refuses to explain the mechanism — and truthfully cannot, since the client contains none.
- Tool outputs are excluded from Code Mode (`"History tools are unavailable in code mode."`) and from hook payloads (`post_tool_use_response` returns the raw result, images stripped).
- Wire tool spec is `{"type":"namespace","name":"history","description":…,"tools":[{"type":"function","name":"list_windows",…}]}`; the model calls back with `function_call {name:"list_windows", namespace:"history"}` (omp already round-trips `namespace` on custom tool calls, `openai-shared.ts:1776`).

### 1.3 Probe results (2026-09-05, omp OAuth identity, `codex_cli_rs/0.154.0` UA)

| Route | Status | Body |
|---|---|---|
| `alpha/notes/v2/thread_hint` | 200 | `{"text":""}` (fresh session) |
| `alpha/notes/v2/list_files_by_prefix` | 200 | `{"encrypted_output":"gAAAA…"}` |
| `alpha/notes/v2/write_file` | 200 | `{"encrypted_output":"gAAAA…"}` |
| `alpha/notes/v2/read_file` | 200 | `{"encrypted_output":"gAAAA…"}` |
| `alpha/history/v2/list_windows` | 200 | `{"encrypted_output":"gAAAA…"}` |

The backend is reachable with our existing auth. No attestation header was needed.

## 2. Design for omp

### 2.1 Settings — placement decision

Both candidate homes were considered:

- **Context → Compaction**: correct for the *window mode*, because it is a compaction method: it competes with `remote`/`snapcompact`/`handoff`/`shake`/`soft` for "what happens when the window fills", and the existing `compaction.methodOrder` list is the natural way to select and rank it. Users reason about it as "how does my context get maintained".
- **Providers → Protocol**: correct for the *notes/history tools*, because they are a Codex-backend-only wire capability with no meaning on any other provider, gated on OAuth, like `OpenAI WebSockets` and `Append-Only Context`.

Decision: **split by concern, one new key on each tab.**

#### `compaction.methodOrder` gains a new method `window` (Context → Compaction)

```ts
// packages/coding-agent/src/session/compaction-methods.ts
{
  value: "window",
  label: "New context window",
  description:
    "Start a fresh context window and let the model carry state in its own notes (OpenAI Codex, GPT-5.6/GPT-6); no summary is generated",
}
```

- Availability: `model.api === "openai-codex-responses"` AND `model.compat.contextWindows` present (from catalog, §2.2) AND OAuth credential. Otherwise the method is skipped in the order exactly like `remote` is when unavailable (`canUseRemoteCompaction` pattern).
- Default order unchanged (`remote → snapcompact → handoff → shake → soft`). `window` is opt-in by moving it up. Recommended placement for users who enable it: first.
- `STRATEGY_BY_COMPACTION_METHOD.window = "context-window"` (new engine strategy, §2.4).
- No separate boolean; the presence of `window` in the order *is* the enablement. `resolveSpeculationMethod` returns `undefined` for it (local, instant).

#### `providers.openai-codex.historyNotes` (Providers → Protocol)

```ts
"providers.openai-codex.historyNotes": {
  type: "enum",
  values: ["off", "on", "auto"] as const,
  default: "off",
  ui: {
    tab: "providers",
    group: "Protocol",
    label: "Codex History & Notes",
    description:
      "Expose the Codex backend's private `history` and `notes` tools (server-side, model-only, encrypted) and inject its thread hint. 'auto' follows the model catalog flag. Requires ChatGPT OAuth.",
  },
},
```

- `auto` = catalog `token_budget.use_history_notes_extension` (currently `false` everywhere; mirrors codex-rs `apply_model_defaults`).
- Notes can be used independently with ordinary compaction, including `remote`. With compaction enabled, `compaction.methodOrder` containing `window` requires `providers.openai-codex.historyNotes: "on"`. Startup and runtime settings changes reject other values with a settings-validation error naming both keys and the required correction; the invalid combination never silently falls through to another method.
- Resolved once at session start and frozen for the session (codex-rs freezes both activation flags per thread). A model switch mid-session re-evaluates availability, not the setting.

Docs: `docs/settings.md` rows for both; `docs/provider-quirks.md` OpenAI Codex section gets a "Context windows and notes" subsection carrying §1.

### 2.2 Catalog (no TS policy)

`packages/catalog/src/discovery/codex.ts` already maps `/codex/models`. Add:

```ts
// packages/catalog/src/types.ts  (OpenAICompat, Responses family)
/** Model-owned context-window ("token budget") protocol, from the Codex catalog. Absent when the model does not advertise one. */
contextWindows?: {
  enabled: boolean;
  useHistoryNotes: boolean;
  reminderThresholdTokens: number;
  reminderMessageTemplate: string;   // contains `{n_remaining}`
  guidanceMessage: string;
  autoCompactFallbackPrompt: string;
  autoCompactFallbackBufferTokens: number;
};
```

- Mapper: `model_messages.token_budget` → `compat.contextWindows` (rename field-for-field; validate non-empty strings, positive ints, template contains `{n_remaining}` — same checks as `TokenBudgetConfig::validate`). Invalid → drop the block, `logger.warn`.
- This is upstream-authoritative discovery data, not a KDL correction; no rule needed. Add the field to `compat-parity.test.ts` `NEW_COMPAT_FIELDS` and a mapper test against a fixture of the real response.
- `gen:models` will bake it into `models.json` for the bundled Codex entries if the generator's discovery pass sees it; otherwise it arrives at runtime via the cached model manager (`models.db`).

### 2.3 Wire additions (pi-ai)

1. **Tool namespace spec.** `Tool` gains an optional `namespace?: string` (already exists on custom tool calls). The Codex request transformer groups tools sharing a namespace into `{type:"namespace", name, description, tools:[…]}` in `additional_tools` (Lite) or top-level `tools` (full). Namespace description text comes from the tool group definition (§2.5). Inbound `function_call` with `namespace` resolves to the namespaced tool by `(namespace, name)`; the agent-side tool name is `history.list_windows` / `notes.write_file` etc.
2. **Reserved schema passthrough.** Model-only namespaces preserve codex-rs's serialized JSON schemas without generic normalization, intent injection, or description pruning. Nullable `anyOf` branches stay intact; numeric bounds omitted by codex-rs's `JsonSchema` are not reintroduced. `"encrypted": true` survives unchanged.
3. **`encrypted_content` tool-output item.** `function_call_output.output` may be `[{type:"encrypted_content", encrypted_content}]` (plus `input_image` items). `ToolResultMessage` has a content block `{type:"encrypted", encryptedContent: string}`; the Codex converter emits it. Non-Codex requests strip private content and log a warning rather than rejecting the conversation. Public surfaces show `[private model-only result]`.
4. **Context-window developer items.** The Codex context transform (`transformProviderContext` in `sdk.ts`) appends, for full-context renders: the `<context_window>` block (separate developer message) and `<context_window_guidance>`; and, per turn, the remaining-tokens line, reminder, and fallback prompt as developer messages. Item ids: append `[id: <short id>]` to every non-assistant item's last text part, where `<short id>` is the persisted session-entry id — keep it stable across renders so notes remain valid.

   Tags (`codex_protocol::protocol`): `CONTEXT_WINDOW_OPEN_TAG = "<context_window>"`, `CONTEXT_WINDOW_GUIDANCE_OPEN_TAG = "<context_window_guidance>"`; legacy `<token_budget>` recognised on replay only. Content kinds for our own bookkeeping: `token_budget.context_window`, `token_budget.context_window_guidance`, `token_budget.remaining_tokens`, `token_budget.reminder`, `compaction.auto_fallback_prompt`.

5. **Window ids and history ingestion.** The UUID `windowId` identifies the context window in the prompt and history lookups. While history ingestion is active, the wire `window_id` / `x-codex-window-id` is the native logical `<thread_id>:<window_number>` value (`core/src/session/mod.rs::current_window`). Turn metadata also carries the UUID as `context_window_id`, plus `agent_name`, numeric `window_number`, and boolean `history_ingest_requested: true`. These are core-owned fields; arbitrary caller metadata cannot enable or impersonate ingestion.

### 2.4 Engine — `context-window` compaction strategy (pi-agent-core)

`packages/agent/src/compaction/`:

- New strategy `"context-window"` in `CompactionSettings.strategy`.
- `compact()` for this strategy does **no LLM/server call**: it builds the replacement history = initial context only (system prompt is already outside messages in omp; keep retained client developer messages if `RetainClientDeveloperMessages`-equivalent is on), rotates window ids via a provider hook, and returns a `CompactionResult` with `summary: ""`, `method: "window"`, `preserveData.codexContextWindow = { windowNumber, firstWindowId, previousWindowId, windowId }`.
- Session entry: `type: "compaction"`, `method: "window"`. Resume/fork restore the window ids from the latest such entry (codex-rs `reconstruct_history_from_rollout` does the same).
- Prompt-cache: the post-window turn is a cold full frame by construction (tiny). Subsequent turns chain normally.
- Speculation: none.

### 2.5 coding-agent

- **Provider-private tools** (`tools/codex-context-window.ts`): `new_context` (no params; queues `SessionMaintenance.runContextWindowReset("model")`; returns the codex-rs `NEW_CONTEXT_WINDOW_MESSAGE` text) and `get_context_remaining` (returns the meter). Registered only when `window` is active for the current model.
- **`history`/`notes` tool group** (`tools/codex-history-notes.ts`): one `CodexHistoryNotesBackend` in pi-ai (`providers/openai-codex/history-notes.ts`) reuses the Codex auth/header path with a 35 s timeout and `Unable to perform operation: …` error mapping. Nine tools preserve the descriptions and serialized parameters from codex-rs; do not paraphrase or normalize the reserved schemas. Outputs: `encrypted_output` → encrypted block; `images` → image blocks; else JSON text. Excluded from eval/Code Mode bridging; public `tool_execution_*` payloads redact private arguments and results.
- **Thread hint**: `SessionMaintenance` calls `thread_hint` at session start and after every window reset (≤ 4 000 bytes, else dropped) and stores it for the next full-context render's `<context_window>` block. Failure → no hint, never a fallback.
- **Catalog freshness**: when notes or window mode is requested at startup but the resolved model lacks `compat.contextWindows`, refresh that provider's discovery before activation. This is Codex-only and best-effort; log failures at debug level and never replace OpenAI's catalog guidance with locally authored prose.
- **Meter + reminders** (`session-maintenance.ts`, post-turn, before threshold logic): remaining = `max(0, resolveThresholdTokens(...) − promptInputTokens − autoCompactFallbackBufferTokens)`, using the existing effective compaction threshold. Queue the remaining-tokens developer item; claim the catalog reminder and fallback once per window. After the fallback is delivered, allow one response containing exactly one notes write/append, then one response calling `new_context`. If the model ignores the sequence, log at debug level and fall through to the next method in `methodOrder`.
- **Threshold interplay**: when `window` is first available, suppress normal threshold compaction while the checkpoint sequence runs. A successful model `new_context` call queues the reset; commit it only at the paired post-tool boundary, never inline during tool execution. An ignored fallback does not silently reset history.
- **Agent identity**: omp passes its existing main/sub kind and registry ID. The pi-ai provider adapter maps that identity to the backend's absolute namespace (`/root` for main, valid lowercase child segments for subagents). Session code does not construct backend paths. Persisted window ownership and the context block use the mapped value; subagents do not inherit the parent's window identity.
- **UI**: compaction card variant "Started context window N" (no summary); tool renderer for `history`/`notes` shows name + `[private model-only result]`; status line context gauge unchanged (meter is the same number).
- **Extension events**: `compaction_start/end` fire with `method: "window"`; no new events.

### 2.6 Behaviour matrix

| `window` in order | `historyNotes` | Effect |
|---|---|---|
| no | off | today's behaviour |
| no | on | tools + thread hint + guidance injected; compaction unchanged. Model can keep notes across snapcompact/remote compactions. |
| yes (compaction enabled) | off or auto | settings-validation error: enable notes with `on` or remove `window` |
| yes (compaction enabled) | on | the codex-rs Astra configuration |
| yes (compaction disabled) | off, on, or auto | no window tools, protocol, or reset; notes activation remains independent |

Off-Codex model selected mid-session: both features go dormant (tools unregistered, no injections); window ids kept for when the session returns to Codex.

## 3. Build notes

Estimated 2–2.5 days for one engineer. Order matters; each step is independently testable and shippable behind the default-off settings.

1. **Catalog** (½ day): `contextWindows` on Responses compat; mapper + validation; parity test; fixture from the live `/codex/models` response (strip to the four GPT-5.6/6 entries). Regenerate `models.json` if the generator picks it up.
2. **Wire**: namespace tool grouping and inbound `(namespace,name)` resolution; exact reserved schema passthrough; encrypted tool-result blocks through Codex replay. Non-Codex requests strip private content and warn. Tests cover namespace grouping, encrypted annotations, namespace call resolution, and `encrypted_content` serialization.
3. **Backend client + tools**: nine tools and thread-hint retrieval through the backend client. Tests cover route, body context, protocol headers, encrypted output/image conversion, and HTTP errors. A returned encrypted blob proves transport/replay only; the live check must write a known value, read it back, and have the model verify an exact content match.
4. **Context injection**: context-window, guidance, meter, reminder, and fallback developer items; stable journal item markers; window-ID rotation. Tests cover the separate context block, append-compatible steady-state prefix, once-per-window reminders, and stable IDs through conversion and resume.
5. **`context-window` strategy + `new_context`** (½ day): engine strategy, session entry, resume restore, hidden tools, the "model didn't call `new_context`" fallthrough. Tests: compaction entry round-trips window ids through resume; `new_context` from the model produces a compaction entry and the next request is initial-context-only with a new `window_id`; fallthrough to the next method when the model ignores the fallback prompt.
6. **Settings + docs** (¼ day): `window` method choice; `providers.openai-codex.historyNotes`; `settings.md`; `provider-quirks.md`; changelogs (`ai`, `agent`, `catalog`, `coding-agent`).
7. **Live verification**: first run Astra or Sol with history/notes on and `window` absent, preserving remote compaction. Require actual `notes.write_file` and `notes.read_file` calls and an exact read-back match of a known test value; neither `isError: false`, ciphertext length, nor recovery through history counts as write success. Check that OpenAI's unchanged catalog guidance reaches the model and `new_context` is absent. Separately test opt-in window mode with a low threshold: checkpoint, reset, a fresh window header and initial-only context, then successful recovery of the saved note. Do not treat a non-empty thread hint alone as proof of a successful note write.

   History verification must also find the current UUID window through `history.list_windows`, locate a known earlier message with `history.list_items`, read it using returned identifiers, and find its marker with `history.search_contents`. Capture the actual request's ingest metadata. Bound retries for indexing readiness; an empty successful response is not a passing history check.

### Non-goals / explicitly out

- No local storage, indexing, or search of history/notes. It is server-side and encrypted; omp cannot and should not mirror it.
- No paraphrasing of the catalog prompts or tool descriptions; they are the trained protocol.
- No attempt to decrypt `encrypted_output`.
- Not exposed to non-Codex providers, API-key Codex routes, or opaque proxies (matches `update_config` gating: `provider.is_openai() && current_auth_uses_codex_backend()`).
- No `features.token_budget.*` override surface for the four prompt strings (codex-rs allows it; we can add later if anyone asks).

### Product notes

- Notes live on OpenAI's servers, are invisible to omp/the user, and do not follow a fork to another provider. Position this as **"Codex long-task checkpoint mode"**, not as memory. It coexists with mnemopi/hindsight, which remain the portable, user-readable memory.
- Cost: `new_context` makes the next turn a cold full frame of initial context only (system + tools ≈ 30K on Codex), which is far cheaper than a remote-compaction summarisation request at the wall; the model's note-writing turn is the only added spend.
- Risk: alpha routes are unversioned. Guard every backend call with the `Unable to perform operation:` mapping so a route change degrades to a tool error rather than a crash; the thread hint must fail silent.
