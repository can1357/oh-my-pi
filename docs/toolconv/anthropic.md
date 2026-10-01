# Anthropic Claude tool use (Messages API content blocks)

Anthropic's Claude is a hosted model family, not a local model with a `--tool-call-parser` flag. The canonical tool-calling convention is the **Messages API** (`POST /v1/messages`, header `anthropic-version: 2023-06-01`): tools are advertised in a top-level `tools` array, the model returns structured `tool_use` **content blocks** with `stop_reason: "tool_use"`, and you feed results back as `tool_result` content blocks inside a `user` message. Tool use is enabled by including `tools` (optionally with `tool_choice`). OMP's native `anthropic-messages` provider consumes these structured blocks; its separately selected `anthropic` dialect uses prompt-driven XML instead.

Under the hood the model is trained to emit an **XML** function-call syntax (`<function_calls>` / `<invoke>` / `<parameter>`); the API serializes your JSON-Schema tools into a system prompt and converts the model's XML output into JSON `tool_use` blocks. That underlying format is documented as the *secondary* convention below, together with the older, now-retired prompt-based **legacy XML** format (`<tool_name>` / `<parameters>` / `<function_results>`) that pre-dates the Messages API and still surfaces when you do tool use purely through prompting.

For the native Messages API adapter, the authoritative shape is the JSON content-block format. The XML sections describe a separate in-band conversion path; they are not the native provider's wire format.

---

## Content-block types & stop reasons

Anthropic has no token-level tool delimiters in the public API. The unit is the **content block**: every `message.content` is an array of typed blocks. Tool calling adds two block types and one stop reason; streaming adds a delta type.

| Item | Where | Shape / meaning |
| --- | --- | --- |
| `text` block | assistant & user | `{"type":"text","text":"..."}`. Plain prose. Assistant may emit text *before* its tool calls. |
| `tool_use` block | assistant | `{"type":"tool_use","id":"toolu_...","name":"<tool>","input":{...}}`. The function call. `input` is a **nested JSON object** (already parsed), conforming to the tool's `input_schema`. |
| `tool_result` block | user | `{"type":"tool_result","tool_use_id":"toolu_...","content":<string \| block[]>,"is_error":<bool?>}`. The executed result, sent back in a `user` message. |
| `server_tool_use` block | assistant | `{"type":"server_tool_use","id":"srvtoolu_...","name":"web_search","input":{...}}`. Emitted for Anthropic-executed server tools; you do **not** return a `tool_result` for these. |
| `web_search_tool_result` (and similar) | assistant | Server-tool output, injected by Anthropic inline in the assistant turn. |
| `thinking` / `redacted_thinking` block | assistant | `thinking` carries reasoning text and a `signature`; `redacted_thinking` carries opaque `data`, not a signature field. Preserve these fields when replaying a thinking/tool turn. |
| `stop_reason: "tool_use"` | response top level | The model invoked one or more tools and is waiting for results. Drives the agentic loop. |
| `stop_reason: "end_turn"` | response top level | Natural completion (no tool call); the loop exits. |
| Other `stop_reason` | response top level | `"max_tokens"`, `"stop_sequence"`, `"pause_turn"` (long server-tool turn, resend as-is to continue), `"refusal"`, `"sensitive"` (output flagged by safety filters), `"model_context_window_exceeded"` (output truncated at the context window, treated like `max_tokens`), `"compaction"` (pause after a server compaction summary). |
| `id` prefixes | — | Messages `msg_…`; client tool calls `toolu_…`; server tool calls `srvtoolu_…`. |

Streaming adds these SSE events / delta types (full list under [Roles / channels](#roles--channels--turn-structure) and [Tool-call format](#tool-call-format)):

| Streaming item | Shape / meaning |
| --- | --- |
| `message_start` | Carries a `Message` skeleton with empty `content`, `stop_reason: null`. |
| `content_block_start` | Opens a block at `index`. For a tool call: `content_block.{type:"tool_use",id,name,input:{}}` — `input` starts as an **empty object**. |
| `content_block_delta` / `input_json_delta` | `{"type":"input_json_delta","partial_json":"<chunk>"}` — a **partial JSON string** fragment of `tool_use.input`. |
| `content_block_delta` / `text_delta` | `{"type":"text_delta","text":"..."}`. |
| `content_block_delta` / `thinking_delta`, `signature_delta` | Extended-thinking content / signature. |
| `content_block_stop` | Closes the block at `index`; this is when accumulated `partial_json` is complete and safe to `JSON.parse`. |
| `message_delta` | Top-level updates; carries the final `delta.stop_reason` (e.g. `"tool_use"`) and **cumulative** `usage`. |
| `message_stop` | End of stream. |
| `ping` / `error` | Keep-alive; `error` (e.g. `overloaded_error`) may appear mid-stream. |

### Legacy XML tags (prompt-based, pre-Messages-API)

The retired prompt-based format used these tags. They are nested-element tags (no attributes), distinct from the modern attribute form (`<invoke name="…">`). Verified against Anthropic's archived "Legacy tool use" doc (see [Sources](#sources)).

| Tag | Role | Notes |
| --- | --- | --- |
| `<tools>` … `</tools>` | tool advertising | Container in the system prompt wrapping all `<tool_description>` entries. |
| `<tool_description>` | tool advertising | One per tool: holds `<tool_name>`, `<description>`, `<parameters>`. |
| `<tool_name>` | both | Function name (used in definitions, calls, and results). |
| `<parameters>` / `<parameter>` | definition | `<parameters>` wraps `<parameter>` entries, each with `<name>`, `<type>`, `<description>`. |
| `<function_calls>` | model output | Wraps one or more `<invoke>` blocks. |
| `<invoke>` | model output | One function call; contains `<tool_name>` + a `<parameters>` block of `<paramName>value</paramName>` child tags. |
| `<function_results>` | tool result (fed back) | Wraps `<result>` (success) or `<error>` (failure). |
| `<result>` / `<stdout>` | tool result | `<result>` holds `<tool_name>` + `<stdout>`; the output text goes in `<stdout>`. |
| `<error>` | tool result | Replaces `<result>` when the function raised. |
| `</function_calls>` | stop sequence | Passed as `stop_sequence` so generation halts after a call. |
| `<scratchpad>` / `<answer>` | model output | Conventionally used for chain-of-thought and final answer in legacy prompts. |

---

## Roles / channels / turn structure

The Messages API uses primarily two conversational roles, `user` and `assistant`, alternating. There is **no** dedicated `tool`/`function` role, and the standard system prompt is a separate top-level `system` parameter (string or text-block array) — not a message role. (Claude Opus 4.8+ and the Fable/Mythos 5 generation additionally accept an opt-in mid-conversation `system` **message** role, gated behind the `mid-conversation-system-2026-04-07` beta; otherwise only `user`/`assistant` are valid.) Tool data rides inside the normal roles:

- `assistant` messages contain AI-generated `text`, `thinking`, and `tool_use` (and `server_tool_use`) blocks.
- `user` messages contain your `text`/`image`/`document` content and `tool_result` blocks.

There are no named "channels". The closest analogue to a reasoning channel is the extended-thinking `thinking` content block (a first-class block with a cryptographic `signature`), kept separate from the user-visible `text` block. When thinking is enabled alongside tools, the `thinking` block(s) from a tool-calling turn must be passed back unmodified in the follow-up request.

The agentic loop is keyed on `stop_reason`:

1. Send `tools` + the user message.
2. Claude responds with `stop_reason: "tool_use"` and one or more `tool_use` blocks (optionally preceded by a `text` block).
3. Execute each tool; build a `tool_result` block per call.
4. Append the assistant message **and** a `user` message carrying all `tool_result` blocks; resend.
5. Repeat while `stop_reason == "tool_use"`; exit on `end_turn` (or another terminal reason).

Strict ordering rules (a 400 otherwise):
- `tool_result` blocks must come **first** in the `user` message's `content` array (any text after them).
- The `tool_result` `user` message must **immediately follow** the assistant `tool_use` message — nothing in between.
- Every `tool_use.id` must be answered by a `tool_result.tool_use_id` in that next message.

---

## Tool definitions

Tools are passed in the top-level `tools` array. Each user-defined (client) tool is a **flat** object — no `{"type":"function", "function":{…}}` wrapper (that wrapper is OpenAI's). Fields:

- `name` — matches `^[a-zA-Z0-9_-]{1,64}$`.
- `description` — detailed plaintext (the single biggest driver of tool-call quality).
- `input_schema` — a JSON Schema object (**not** `parameters`) describing the input the model must produce.
- Optional: `cache_control` (prompt-cache breakpoint), `strict` (structured-outputs beta), `eager_input_streaming` (fine-grained tool-streaming beta).

```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
        "description": "The city and state, e.g. San Francisco, CA"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "The unit of temperature, either 'celsius' or 'fahrenheit'"
      }
    },
    "required": ["location"]
  }
}
```

Anthropic-schema client tools (`bash`, `text_editor`, `computer`, `memory`) and server tools (`web_search`, `web_fetch`, `code_execution`, `tool_search`) instead carry a versioned `type`, e.g. `{"type": "web_search_20250305", "name": "web_search"}`.

### OMP native-adapter schema normalization

The native Anthropic provider does not forward a pi tool's JSON Schema unchanged. Before placing it in `input_schema`, OMP keeps these keywords:

- on every node: `$ref`, `$defs`, `$schema`, `definitions`, `type`, `enum`, `const`, `description`, `title`, `default`, and `nullable`;
- nested `anyOf` and `allOf` (root combinators are not retained, and `oneOf` is not retained at any depth);
- on objects: `properties`, `required`, and `additionalProperties`;
- on arrays: `items`, `prefixItems`, and `minItems` only when it is `0` or `1`;
- on strings: `format` only for `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, or `uuid`.

Other constraints—including `pattern`, string-length limits, numeric ranges, `maxItems`, unsupported formats, and unsupported combinators—are appended to that node's `description`. They remain model-visible guidance but are no longer machine-enforced schema keywords. Object nodes default to `additionalProperties: false`; an explicit `true` or schema-valued `additionalProperties` remains open (an empty schema normalizes to `true`).

OMP sends `strict: true` only for eligible built-in tools (`bash`, `python`, `edit`, and `find`) when neither `PI_NO_STRICT` nor provider compatibility/runtime fallback has disabled strict tools, the tool has not opted out, the raw schema avoids `oneOf`, `allOf`, `$ref`, `patternProperties`, and `propertyNames`, and every object is closed. Selection is capped at 20 strict tools per request and shares budgets of 24 optional properties and 16 union uses: after the optional budget is exhausted, another optional property must be converted to required-and-nullable using union budget or that tool remains non-strict. Other tools use the normalized non-strict schema. OMP sends `eager_input_streaming: true` only when the model compatibility data and effective endpoint support it: first-party Anthropic endpoints qualify, as do custom endpoints explicitly configured for that capability; a canonical model rerouted to an unqualified non-Anthropic endpoint does not.

`tool_choice` controls invocation (four options):
- `{"type":"auto"}` — model decides (default when `tools` present).
- `{"type":"any"}` — must call some tool.
- `{"type":"tool","name":"get_weather"}` — must call that specific tool.
- `{"type":"none"}` — no tools (default when no `tools`).

With `any` or `tool` the API prefills the assistant turn, so no leading natural-language text precedes the `tool_use` block. Add `"disable_parallel_tool_use": true` inside `tool_choice` to cap at one tool per turn. (Extended thinking only supports `auto`/`none`.)

OMP's `AnthropicOptions.toolChoice` accepts `"auto"`, `"any"`, `"none"`, or `{ type: "tool", name }`. Forced choices are downgraded to `auto` for compaction requests or models whose compatibility data disables forced tool choice. Otherwise OMP removes explicit thinking configuration for forced choices; adaptive-only models that support output effort are pinned to `effort: "low"`. The high-level option does not expose `disable_parallel_tool_use`.

The native adapter maps `tool_use` blocks to canonical `toolCall` blocks and projects `input_json_delta` as `toolcall_delta`. It maintains best-effort argument objects during streaming and finalizes with the repairing JSON parser, rather than requiring every fragment to be valid JSON. A failed final parse preserves recovered arguments; if none were recovered, it supplies `__parseError` and a bounded `__rawJson` excerpt.

Consecutive canonical `toolResult` messages become one `user` message of `tool_result` blocks. Empty successful results use `content: ""`; empty errors become `"Tool failed with no output."`. Images from error results are moved after the result blocks. Endpoints with `requiresToolResultId` also receive an `id` matching `tool_use_id`. Tools marked `deferLoading` are sent with `defer_loading: true`.

Native stop reasons map to pi's `stopReason`: `tool_use` → `toolUse`; `max_tokens` and `model_context_window_exceeded` → `length`; `refusal` and `sensitive` → `error`; `end_turn`, `stop_sequence`, `pause_turn`, and `compaction` → `stop`. Unknown reasons are reported and treated as `stop`.

### How the API turns this into a prompt (the bridge to XML)

When `tools` is present, the API constructs a tool-use system prompt with this skeleton (verified from "Define tools"):

```text
In this environment you have access to a set of tools you can use to answer the user's question.
{{ FORMATTING INSTRUCTIONS }}
String and scalar parameters should be specified as is, while lists and objects should use JSON format. Note that spaces for string values are not stripped. The output is not expected to be valid XML and is parsed with regular expressions.
Here are the functions available in JSONSchema format:
{{ TOOL DEFINITIONS IN JSON SCHEMA }}
{{ USER SYSTEM PROMPT }}
{{ TOOL CONFIGURATION }}
```

`{{ TOOL DEFINITIONS IN JSON SCHEMA }}` is your `tools` array serialized to JSON Schema. `{{ FORMATTING INSTRUCTIONS }}` is the (unpublished) block teaching the model the XML syntax with `antml:` namespace prefixes (shown under [Tool-call format → underlying XML](#underlying-xml-modern-attribute-form-with-antml-namespace)). The note "parsed with regular expressions" is why output need not be well-formed XML.

---

## Tool-call format

The wire format your application consumes is JSON. A single call is one `tool_use` content block in the assistant message, with `stop_reason: "tool_use"` at the top level:

```json
{
  "id": "msg_01Aq9w938a90dw8q",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    {
      "type": "text",
      "text": "I'll check the current weather in San Francisco for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 472, "output_tokens": 65 }
}
```

Key facts for a parser:
- `tool_use.input` is an already-parsed **object**, never a JSON string.
- A leading `text` block is optional and informational; do not rely on its wording.
- Match calls to results by `id` → `tool_use_id`.

### Underlying XML (modern attribute form with antml: namespace)

Before the API converts it, the model literally emits an XML block. The current (Claude 3+) form is attribute-based:

```text
<function_calls>
<invoke name="get_weather">
<parameter name="location">San Francisco, CA</parameter>
<parameter name="unit">celsius</parameter>
</invoke>
</function_calls>
```

Current Claude models prefix these tags with an `antml:` XML namespace prefix (e.g. `antml:function_calls`, `antml:invoke name="…"`, `antml:parameter name="…"`). The API strips all of this and exposes only the JSON `tool_use` block; integrators should target the JSON, not the XML.

### OMP `anthropic` dialect

Select the owned dialect with `PI_DIALECT=anthropic` or the agent's `dialect`/`getDialect` configuration. When tools are present, the agent appends the dialect guide and a compact JSON tool catalog to the system prompt, removes native tools from the request, and re-encodes prior tool calls/results as text. This is separate from the native `anthropic-messages` adapter.

The dialect renderer always emits the unprefixed attribute form above, wraps multiple calls in one `<function_calls>` block, and renders each argument as a `<parameter name="…">` child. With a tool schema, string-only arguments (including nullable strings) are inserted as literal text; other values are JSON-serialized. Tool and parameter names are XML-attribute-escaped, but parameter bodies are not XML-escaped. The scanner does not decode XML entities. It accepts `antml:`-prefixed tags, `<tool_calls>` as a wrapper alias, and a bare `<invoke name="…">` outside either wrapper. The child-tag legacy `<invoke><tool_name>…` format is not supported.

The scanner mints `ptc_…` call ids because this XML has none. It scans streamed text statefully, emits `toolArgDelta` events while each named parameter body arrives, and publishes the coerced argument object with `toolEnd` after `</invoke>`. A parameter value is capped at 1,000,000 JavaScript string code units; overflow gains an explicit truncation suffix. Schema-declared strings stay strings; other nonempty values use repairing JSON parsing and fall back to raw text on failure. An explicit `string` attribute overrides the schema: `false`, `0`, and `no` (case-insensitive) enable parsing; other supplied values keep the body as a string. Empty bodies stay strings.

Standalone `AnthropicInbandScanner` defaults to `parseThinking: false`; the owned-stream projector enables it. With `parseThinking: true`, `<thinking>`, `<think>`, and `<scratchpad>` (prefixed or unprefixed) become thinking events. With it disabled, those tags remain visible outside tool wrappers; incidental text inside a tool wrapper is discarded.

`</invoke>` gates `toolEnd`, but it does not gate creation of the canonical call. Once an opening `<invoke name="…">` has emitted `toolStart`, EOF only resets scanner-local state. On a normally stopped stream, OMP retains that call, changes the turn to `toolUse`, and may dispatch it even though no `toolEnd` arrived. Any `toolArgDelta` text already accumulated survives in the call (without the close-time coercion); a call with no accumulated parameter text runs with `{}`. A `length` stop remains non-runnable.

History encoding groups consecutive results into a `user` message, keeping result images as separate image blocks after the XML. A tool-calling assistant turn is replayed as text plus rendered calls, without its thinking blocks. The standalone transcript renderer is a different surface: it uses `Human:` / `Assistant:` text turns and renders thinking as `<thinking>…</thinking>`, not Messages API JSON.

The owned stream cuts off fabricated results at `<function_results>` or `<tool_response>` (aborting by default), retaining calls parsed before that boundary. If a provider nevertheless returns native structured calls, the first real native or in-band call chooses the channel for that turn, preventing duplicate dispatch.

---

## Multiple / parallel tool calls

Parallel calls are the default. Claude emits **multiple `tool_use` blocks in a single assistant message**:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me check both cities." },
    {
      "type": "tool_use",
      "id": "toolu_01weather_sf",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA" }
    },
    {
      "type": "tool_use",
      "id": "toolu_02weather_nyc",
      "name": "get_weather",
      "input": { "location": "New York, NY" }
    }
  ]
}
```

You return **all** results in **one** `user` message, one `tool_result` per call, results first:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01weather_sf",
      "content": "San Francisco: 68F, partly cloudy"
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_02weather_nyc",
      "content": "New York: 45F, clear skies"
    }
  ]
}
```

Calls in one turn are **unordered** and may be run concurrently. If two batched calls turn out to depend on each other, return the natural error in a `tool_result` with `"is_error": true`; Claude reissues the dependent call on a later turn. (In the legacy XML format, parallelism is multiple `<invoke>` blocks inside one `<function_calls>`.)

---

## Tool-result format

A result is a `tool_result` block inside a `user` message:

- `tool_use_id` (required) — the `id` of the `tool_use` it answers.
- `content` (optional) — a string, **or** an array of `text`/`image`/`document` blocks. Omit for an empty result.
- `is_error` (optional) — `true` for execution failures; put a useful message in `content`.

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "15 degrees"
    }
  ]
}
```

Error result:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "ConnectionError: the weather service API is not available (HTTP 500)",
      "is_error": true
    }
  ]
}
```

Rich result (text + image blocks):

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": [
        { "type": "text", "text": "15 degrees" },
        {
          "type": "image",
          "source": { "type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQSkZJRg..." }
        }
      ]
    }
  ]
}
```

Server tools require **no** `tool_result` from you — Anthropic executes them and injects the result inline in the assistant turn. (Legacy XML feeds results back as `<function_results><result><tool_name>…</tool_name><stdout>…</stdout></result></function_results>`, or `<error>…</error>` on failure.)

OMP's prompt-driven dialect is different from Anthropic's server-tool behavior. It renders client results as:

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>15 degrees</stdout>
</result>
<error>
<tool_name>other_tool</tool_name>
<stderr>execution failed</stderr>
</error>
</function_results>
```

There is no result id in this XML, so results are correlated by call order. OMP includes the tool name in both success and error entries and does not encode `isError` anywhere else.

---

## End-to-end example

A complete multi-turn weather exchange. All JSON is valid.

**Request 1 — system + tools + user question:**

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a helpful weather assistant. Use the provided tools to answer.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Unit for the temperature" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco?" }
  ]
}
```

**Response 1 — assistant requests the tool (`stop_reason: "tool_use"`):**

```json
{
  "id": "msg_01Aq9w938a90dw8q",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    { "type": "text", "text": "I'll check the current weather in San Francisco for you." },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 472, "output_tokens": 65 }
}
```

**Request 2 — replay history, append the assistant turn and the `tool_result`:**

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a helpful weather assistant. Use the provided tools to answer.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Unit for the temperature" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco?" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I'll check the current weather in San Francisco for you." },
        {
          "type": "tool_use",
          "id": "toolu_01A09q90qw90lq917835lq9",
          "name": "get_weather",
          "input": { "location": "San Francisco, CA", "unit": "celsius" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "15 degrees Celsius, partly cloudy"
        }
      ]
    }
  ]
}
```

**Response 2 — assistant's final answer (`stop_reason: "end_turn"`):**

```json
{
  "id": "msg_01EeFG3hijk2lmno4PqrSt",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    { "type": "text", "text": "It's currently 15 degrees Celsius and partly cloudy in San Francisco." }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 530, "output_tokens": 18 }
}
```

### Streaming (SSE) shape of the tool call

The same tool call, streamed. Note `tool_use` opens with an empty `input`, the arguments arrive as `input_json_delta.partial_json` fragments, and the final `stop_reason` lands in `message_delta`. This block is reproduced verbatim from Anthropic's streaming docs:

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_014p7gG3wDgGV9EUtLvnow3U","type":"message","role":"assistant","model":"claude-opus-4-8","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" let"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'s"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" check"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"San"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" Francisc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"o,"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" CA\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

Reassembly: concatenate every `partial_json` for a given `index` (`"" + "{\"location\":" + " \"San" + " Francisc" + "o," + " CA\"}"` → `{"location": "San Francisco, CA"}`), then `JSON.parse` at that block's `content_block_stop`. Tool use also supports fine-grained streaming (`eager_input_streaming` per tool) for finer `partial_json` chunking.

---

## OpenAI-compatible API mapping

Anthropic integrates tools into the `user`/`assistant` message structure rather than using OpenAI's separate `tool` role and `function` wrapper. Field-by-field:

| Concept | Anthropic Messages API | OpenAI Chat Completions |
| --- | --- | --- |
| Tool definition wrapper | flat `{"name","description","input_schema"}` in `tools[]` | `{"type":"function","function":{"name","description","parameters"}}` in `tools[]` |
| Tool schema key | `input_schema` (JSON Schema) | `parameters` (JSON Schema) |
| "Must call a tool" | `tool_choice:{"type":"any"}` / `{"type":"tool","name":…}` | `tool_choice:"required"` / `{"type":"function","function":{"name":…}}` |
| Disable parallel calls | `tool_choice:{…,"disable_parallel_tool_use":true}` | `parallel_tool_calls:false` (top level) |
| Assistant call container | `tool_use` **content block** in `content[]` | `tool_calls[]` on the assistant `message` |
| Call id | `tool_use.id` = `toolu_…` | `tool_calls[].id` = `call_…` |
| Function name | `tool_use.name` | `tool_calls[].function.name` |
| Function arguments | `tool_use.input` = **nested JSON object** (parsed) | `tool_calls[].function.arguments` = **JSON string** (must `JSON.parse`) |
| "Tools were called" signal | `stop_reason:"tool_use"` | `finish_reason:"tool_calls"` |
| Result message role | `user` message containing `tool_result` block(s) | dedicated `{"role":"tool",…}` message(s) |
| Result ↔ call linkage | `tool_result.tool_use_id` | `tool` message `tool_call_id` |
| Result payload | `tool_result.content` = string **or** block array (text/image/document) | `tool` message `content` = string |
| Error result | `tool_result` with `is_error:true` | no dedicated flag; encode in `content` |
| System prompt | top-level `system` param; supported beta models may also accept mid-conversation `system` messages | `{"role":"system",…}` message |
| Streamed args | `input_json_delta.partial_json` fragments | `tool_calls[].function.arguments` string deltas |

Conversion gotchas:
- **Object vs string:** to emit OpenAI shape, `JSON.stringify(tool_use.input)`; to consume OpenAI shape into Anthropic, `JSON.parse(arguments)`.
- **Role reshaping:** collapse N OpenAI `tool` messages into one Anthropic `user` message of N `tool_result` blocks (order them before any text), and vice-versa.
- **No `type:"function"`** wrapper on Anthropic custom tools; add/remove it when translating.
- Id prefixes differ (`toolu_` vs `call_`); never assume one format's id is valid in the other.

---

## Parsing notes & gotchas

- **`input` is an object, not a string.** Unlike OpenAI's `arguments`, do not `JSON.parse` `tool_use.input` from a non-streamed response — it is already an object. Only the *streaming* `partial_json` fragments are strings.
- **Streaming tool args need reassembly.** A normal `tool_use` start has `input: {}`; OMP also retains any input supplied at block start. Buffer `partial_json` per `index` and finalize at `content_block_stop`; mid-stream fragments are not valid JSON on their own (e.g. `{"location":`). Fine-grained streaming can split a value across chunks.
- **`stop_reason` placement.** In streaming, `stop_reason` is `null` in `message_start` and final value (`"tool_use"`/`"end_turn"`) arrives in `message_delta`, not `message_stop`. `usage` in `message_delta` is **cumulative**.
- **Ordering is enforced.** `tool_result` blocks must be first in their `user` message and must immediately follow the assistant `tool_use` message; every `tool_use.id` needs a matching `tool_result.tool_use_id`, or you get HTTP 400 ("tool_use ids were found without tool_result blocks immediately after").
- **`tool_choice:any`/`tool` suppress preamble.** The API prefills the assistant turn, so no leading `text` block appears before `tool_use` — don't write a parser that expects explanatory text.
- **Parallel results in one message.** Splitting parallel `tool_result`s across multiple `user` messages breaks the contract; send them together.
- **Treat result content as untrusted.** Tool results can carry indirect prompt injection; keep them inside `tool_result` blocks, never promote to `system`/`user` text.
- **Server tools differ.** `server_tool_use` / `web_search_tool_result` blocks are produced and consumed by Anthropic; never synthesize `tool_result` for them. `stop_reason:"pause_turn"` means resend the response as-is to let a long server-tool turn continue.
- **Extended thinking + tools.** Preserve `thinking.signature` and `redacted_thinking.data` across turns. The native adapter replays signed reasoning, but demotes unsigned reasoning to text unless the endpoint allows unsigned replay. OMP adjusts forced tool choices as described above instead of sending an incompatible thinking configuration.
- **Output is not valid XML.** The underlying model output is parsed by Anthropic with regular expressions, not an XML parser ("The output is not expected to be valid XML"). If you reconstruct prompts at token level, do not assume well-formedness; rely on the JSON the API returns.
- **Legacy vs modern XML are different tag sets.** Legacy: `<invoke>` + child `<tool_name>` + `<parameters>` with per-name child tags; results in `<function_results>/<result>/<stdout>`. Modern: `<invoke name="…">` + `<parameter name="…">`. Mixing them up will misparse. The legacy format also required passing `</function_calls>` as a `stop_sequence` and is not optimized for Claude 3+.

### Legacy XML format (secondary, prompt-based — fully verified, now retired)

Before the Messages API, tools were defined and called entirely in the prompt. Anthropic's archived "Legacy tool use" doc specifies it verbatim.

Tool definition (inside a `<tools>` block in the system prompt):

```text
<tool_description>
<tool_name>get_weather</tool_name>
<description>
Retrieves the current weather for a specified location.
Returns a dictionary with two fields:
- temperature: float, the current temperature in Fahrenheit
- conditions: string, a brief description of the current weather conditions
Raises ValueError if the provided location cannot be found.
</description>
<parameters>
<parameter>
<name>location</name>
<type>string</type>
<description>The city and state, e.g. San Francisco, CA</description>
</parameter>
</parameters>
</tool_description>
```

Model-emitted call (multiple `<invoke>` for parallel calls; pass `</function_calls>` as a `stop_sequence`):

```text
<function_calls>
<invoke>
<tool_name>get_weather</tool_name>
<parameters>
<location>San Francisco, CA</location>
</parameters>
</invoke>
</function_calls>
```

Result fed back into the next user turn:

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>
59 degrees Fahrenheit, partly cloudy
</stdout>
</result>
</function_results>
```

Error result:

```text
<function_results>
<error>
error message goes here
</error>
</function_results>
```

The legacy system-prompt preamble (verbatim from the archived doc) was:

```text
In this environment you have access to a set of tools you can use to answer the user's question.
You may call them like this:
<function_calls>
<invoke>
<tool_name>$TOOL_NAME</tool_name>
<parameters>
<$PARAMETER_NAME>$PARAMETER_VALUE</$PARAMETER_NAME>
...
</parameters>
</invoke>
</function_calls>

Here are the tools available:
<tools>
...one <tool_description> per tool...
</tools>
```

Legacy notes: no built-in tools (everything is prompt-defined); Anthropic recommended ≤3–5 tools; the model conventionally wrapped reasoning in `<scratchpad>` and final output in `<answer>`. This format is "out of date" and "not optimized for Claude 3" — use the JSON Messages API for anything current.

---

## Sources

Repository implementation:
- [Native Anthropic adapter](../../packages/ai/src/providers/anthropic.ts) — `convertTools`, `normalizeAnthropicToolSchema`, `convertAnthropicMessages`, streaming block conversion, and stop-reason mapping.
- [Anthropic in-band dialect](../../packages/ai/src/dialect/anthropic.ts) — `AnthropicInbandScanner` and XML renderers.
- [Shared rendering](../../packages/ai/src/dialect/rendering.ts), [argument coercion](../../packages/ai/src/dialect/coercion.ts), [history encoding](../../packages/ai/src/dialect/history.ts), and [owned-stream projection](../../packages/ai/src/dialect/owned-stream.ts).
- [Tool catalog](../../packages/ai/src/dialect/catalog.ts) and [agent request preparation](../../packages/agent/src/agent-loop.ts).

External format references:

- Tool use overview — https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview
- How tool use works — https://docs.claude.com/en/docs/agents-and-tools/tool-use/how-tool-use-works
- Define tools (tool schema, `input_schema`, `tool_choice`, constructed system prompt) — https://docs.claude.com/en/docs/agents-and-tools/tool-use/define-tools
- Handle tool calls (`tool_use`/`tool_result`, `is_error`, ordering rules) — https://docs.claude.com/en/docs/agents-and-tools/tool-use/handle-tool-calls
- Parallel tool use — https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use
- Streaming messages (SSE events, `input_json_delta`, verbatim tool-use stream) — https://docs.claude.com/en/docs/build-with-claude/streaming
- Messages API reference (`stop_reason` enum, response shape, `tools`) — https://docs.claude.com/en/api/messages
- Legacy tool use (archived; verbatim XML tags and prompt) — https://web.archive.org/web/20240528231249/https://docs.anthropic.com/en/docs/legacy-tool-use ; also live localized copies, e.g. https://docs.anthropic.com/de/docs/legacy-tool-use (English path now redirects to the tool-use overview)
