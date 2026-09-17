# GLM-4.5 / GLM-4.6 tool-calling format

Native tool-calling convention of Zhipu AI / Z.ai's **GLM-4.5** family (`zai-org/GLM-4.5` 355B-A32B and `zai-org/GLM-4.5-Air` 106B-A12B, `model_type: "glm4_moe"`), shared byte-for-byte by **GLM-4.6**. Unlike the JSON-in-a-tag conventions used by most families, GLM emits each tool call as an **XML-like** block: `<tool_call>{name}` followed by alternating `<arg_key>`/`<arg_value>` element pairs, closed by `</tool_call>`. The prompt is a GLM-style sequence opened by `[gMASK]<sop>` with turn markers `<|system|>`, `<|user|>`, `<|assistant|>`, `<|observation|>`. An inference server turns the raw stream into OpenAI-style `tool_calls` with a parser plus a reasoning parser: both vLLM and SGLang expose `--tool-call-parser glm45 --reasoning-parser glm45` (vLLM additionally needs `--enable-auto-tool-choice`). Tool calling and reasoning are driven entirely by the bundled `chat_template.jinja`; thinking mode is on by default and is disabled per-request with `chat_template_kwargs={"enable_thinking": False}`.

This document was verified against the authoritative `chat_template.jinja` from the HF repo (fetched raw and **rendered locally with Jinja2** — `trim_blocks=True, lstrip_blocks=True`, transformers' `tojson` filter — to produce the byte-exact streams below), `tokenizer_config.json` and `generation_config.json` for the exact token IDs and stop tokens, the model card, and the vLLM (`Glm4MoeModelToolParser`) and SGLang (`Glm4MoeDetector`) parser sources. The HF `resolve`/`blob` web paths redirect to the model-card API; the byte-exact source was obtained via the `resolve/main/...:raw` cache (template commit `cbb2c7cfb52fa128a9660cb1a7a78e017899e115`). The GLM-4.5 and GLM-4.6 `chat_template.jinja` files are identical (same content hash `41478957…`).

## Special tokens

Token IDs are from `tokenizer_config.json` (`added_tokens_decoder`). Note the split: the turn/role markers are registered as **special** tokens, whereas the structural tool-call and thinking tags are each a single dedicated vocabulary token but flagged **`special: false`** (they are emitted/printed as ordinary text, not stripped as control tokens).

| Token (verbatim) | ID | `special` | Purpose |
|---|---|---|---|
| `[gMASK]` | 151331 | true | GLM prefix / blank-infilling sentinel; first token of every prompt |
| `<sop>` | 151333 | true | "Start of piece" — immediately follows `[gMASK]` to open the sequence |
| `<eop>` | 151334 | true | "End of piece" (not emitted by the chat template) |
| `<\|system\|>` | 151335 | true | Opens a system turn (and the injected tools turn) |
| `<\|user\|>` | 151336 | true | Opens a user turn (also an EOS id — see below) |
| `<\|assistant\|>` | 151337 | true | Opens an assistant turn / generation prompt |
| `<\|observation\|>` | 151338 | true | Opens a tool-result (observation) turn (also an EOS id) |
| `<\|endoftext\|>` | 151329 | true | End-of-text; `eos_token` and `pad_token` |
| `<think>` | 151350 | false | Opens the reasoning span inside an assistant turn |
| `</think>` | 151351 | false | Closes the reasoning span |
| `<tool_call>` | 151352 | false | Opens one tool call; function name follows on the same line |
| `</tool_call>` | 151353 | false | Closes one tool call |
| `<arg_key>` | 151356 | false | Opens an argument-name element |
| `</arg_key>` | 151357 | false | Closes an argument-name element |
| `<arg_value>` | 151358 | false | Opens an argument-value element |
| `</arg_value>` | 151359 | false | Closes an argument-value element |
| `<tool_response>` | 151354 | false | Wraps one tool result inside an observation turn |
| `</tool_response>` | 151355 | false | Closes a tool result |
| `/nothink` | 151360 | true | Soft switch appended to user text to suppress thinking |

Notes on exactness:
- All pipes are ASCII `|` (U+007C); GLM uses no fullwidth `｜` (U+FF5C) or `▁` (U+2581) variants (unlike DeepSeek). Reproduce `<|system|>`, `<|user|>`, `<|assistant|>`, `<|observation|>` exactly, and `[gMASK]` with literal square brackets.
- Because `<tool_call>`, `<arg_key>`, `<arg_value>`, `<tool_response>`, `<think>` (and their closers) each map to exactly **one** token ID, they cost one token apiece in the stream — but being `special: false` they round-trip through detokenization as plain text. Parsers therefore match them as literal substrings in the decoded text, not as control-token ids.
- `eos_token_id` is a **list**: `[151329, 151336, 151338]` = `<|endoftext|>`, `<|user|>`, `<|observation|>` (from `generation_config.json`). This is how a tool-call turn ends: after `</tool_call>` the model emits `<|observation|>`, which is an EOS id, so generation halts and the server reports a tool call (see Turn structure).

## Roles / channels / turn structure

Every prompt begins with the literal two-token prefix `[gMASK]<sop>` (no following newline). Turns are then concatenated, each introduced by its role marker; there is no per-turn terminator token in rendered history (the next marker, or an EOS id during generation, ends a turn).

- **System** (`<|system|>`): role marker, newline, then the message text. When `tools` are supplied, a synthetic tools system turn is rendered **first**, before any user-supplied system turn (the two are separate `<|system|>` blocks — see Tool definitions).
- **User** (`<|user|>`): role marker, newline, then text. If `enable_thinking` is false, the literal `/nothink` is appended to the user text (unless it already ends with `/nothink`).
- **Assistant** (`<|assistant|>`): role marker, then a reasoning span and/or visible content and/or tool calls. The reasoning span is `\n<think>{reasoning}</think>`; visible content follows on its own line; tool calls follow as `<tool_call>…</tool_call>` blocks.
- **Tool result** (`<|observation|>`): role marker introducing one or more `<tool_response>…</tool_response>` blocks (see Tool-result format).

Thinking / reasoning channel:
- Reasoning lives in `<think>…</think>` inside the assistant turn. The `--reasoning-parser glm45` extracts it into a separate `reasoning_content` field; the visible answer is whatever follows `</think>`.
- **Only the reasoning of assistant turns after the last user message is kept.** The template renders every earlier assistant turn with an empty `<think></think>` and drops its `reasoning_content` (or any inline `<think>…</think>` embedded in `content`). This keeps stale chains of thought out of the context on later turns.
- An assistant turn with neither preserved reasoning nor an explicit chain renders `\n<think></think>` (empty), then content/tool calls.

Generation prompt (`add_generation_prompt=True`):
- **Thinking mode (default):** the prompt ends with a bare `<|assistant|>`; the model continues with `\n<think>…</think>` then its answer or tool calls.
- **Non-thinking mode** (`enable_thinking=false`): the prompt ends with `<|assistant|>\n<think></think>`, pre-filling an empty reasoning span so the model goes straight to the answer.

How a tool-call turn terminates: there is no dedicated "stop after tool call" token. The model emits `</tool_call>` and then `<|observation|>` (token 151338), which is one of the three EOS ids, so decoding stops. The server inspects the text, finds `<tool_call>`, and returns `finish_reason: "tool_calls"`.

## Tool definitions

When the request carries `tools`, the template prepends one `<|system|>` turn containing a fixed preamble, the tool list wrapped in `<tools>…</tools>`, and a literal description of the output format. Each tool is serialized with `tool | tojson(ensure_ascii=False)` — i.e. the **entire OpenAI tool object verbatim**, including the `{"type": "function", "function": {…}}` wrapper, with default JSON spacing (`", "` / `": "`). One tool per line.

```text
<|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call>
```

The `<tool_call>{function-name}` / `<arg_key>` / `<arg_value>` lines above are part of the **prompt text** (the format spec the model is told to follow), not an example call. This tools turn is emitted only when `tools` is non-empty, and it is closed implicitly by the next role marker (e.g. a user-supplied `<|system|>` or the first `<|user|>`), with no blank line between them.

## Tool-call format

The model emits a call as an `<tool_call>` block: the function **name on the same line** as the opening tag, a newline, then one `<arg_key>…</arg_key>` + `<arg_value>…</arg_value>` pair per argument, closed by `</tool_call>`. Minimal single call (assistant generation in thinking mode; reasoning shown for realism):

```text
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
```

Anatomy and value encoding (this is the single most error-prone part):

- The function name is the text between `<tool_call>` and the first newline — there is **no** wrapping tag around it and **no** space after `<tool_call>`.
- Each argument is two adjacent elements: `<arg_key>name</arg_key>` then `<arg_value>value</arg_value>`, conventionally one pair per line.
- **Argument values are NOT uniformly JSON.** The template renders each value as `value | tojson(ensure_ascii=False) if value is not string else value`:
  - **string** values are emitted **raw, without surrounding quotes** → `<arg_value>Beijing</arg_value>` (not `"Beijing"`).
  - **non-string** values (number, boolean, null, object, array) are JSON-encoded → `<arg_value>3</arg_value>`, `<arg_value>true</arg_value>`, `<arg_value>{"k": 1}</arg_value>`.
- A **zero-argument** call has no pairs: the name is followed by a newline and the closer — `<tool_call>get_time\n</tool_call>`.

Because string values lose their quotes, a parser must decide per argument whether to JSON-decode or treat the value as a literal string. Both reference parsers do this by consulting the tool's JSON Schema: if the parameter's type is `string`, the raw text is taken as-is; otherwise the value is JSON-decoded (with `ast.literal_eval` and raw-string fallbacks). The model is trained to follow the schema, so it emits a bare string exactly when the parameter is string-typed.

## Multiple / parallel tool calls

Two or more calls in one turn are emitted as consecutive `<tool_call>…</tool_call>` blocks separated by a single newline (no wrapper element around the set). Raw assistant emission for two parallel calls with mixed argument types:

```text
<think>Two cities. Call get_weather twice in parallel.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Shanghai</arg_value>
<arg_key>days</arg_key>
<arg_value>3</arg_value>
<arg_key>verbose</arg_key>
<arg_value>true</arg_value>
</tool_call>
```

Note `Beijing`/`Shanghai`/`celsius` (string) are bare, while `3` (number) and `true` (boolean) are JSON literals. Parsers split on the non-greedy `<tool_call>.*?</tool_call>` regex, so any number of calls is supported; each becomes a separate entry in `tool_calls[]`.

## Tool-result format

Results are returned in an **observation** turn. For a single result: the `<|observation|>` marker, a newline, then the result wrapped in `<tool_response>` / `</tool_response>`:

```text
<|observation|>
<tool_response>
{"temperature": 26, "unit": "celsius", "condition": "Sunny"}
</tool_response>
```

The content between the tags is inserted **verbatim** (callers typically pass a JSON string, but any text is allowed). For **multiple** results from a set of parallel calls, the `<|observation|>` marker appears **once** and each result gets its own `<tool_response>` block (consecutive `tool`-role messages are merged under a single observation turn):

```text
<|observation|>
<tool_response>
{"temperature": 26, "condition": "Sunny"}
</tool_response>
<tool_response>
{"temperature": 30, "condition": "Cloudy"}
</tool_response>
```

The chat template reads **only** the tool message's `content` — it does not consult any `tool_call_id`. Results are therefore correlated to calls **positionally / by order**, not by an embedded id (GLM's wire format carries no per-call id; see API mapping).

## End-to-end example

A complete multi-turn weather exchange. These are the exact locally rendered streams; newlines inside a turn are literal and turns are otherwise contiguous (no separators between markers).

**Stage 1 — prompt fed to the model** (`tools` set, one prior system message, `add_generation_prompt=True`, thinking mode):

```text
[gMASK]<sop><|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call><|system|>
You are a helpful assistant.<|user|>
What's the weather in Beijing?<|assistant|>
```

**Assistant generation** (model output; it ends by emitting `<|observation|>`, an EOS id, so decoding stops there; server returns `finish_reason: "tool_calls"`):

```text
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
```

**Stage 2 — prompt for the next turn**, after appending the assistant tool-call turn and the tool result, then `add_generation_prompt=True`:

```text
[gMASK]<sop><|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call><|system|>
You are a helpful assistant.<|user|>
What's the weather in Beijing?<|assistant|>
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call><|observation|>
<tool_response>
{"temperature": 26, "unit": "celsius", "condition": "Sunny"}
</tool_response><|assistant|>
```

**Final assistant generation** (natural-language answer, terminated by `<|endoftext|>`; `finish_reason: "stop"`):

```text
<think>Got it, 26C and sunny.</think>
It's 26°C and sunny in Beijing right now.
```

Two subtleties visible above: (1) the reasoning of the assistant tool-call turn is **preserved** in Stage 2 only because it is the segment after the last user message; with another user turn after it, that `<think>…</think>` would be re-rendered empty. (2) The tool-call turn and the observation turn abut directly (`</tool_call><|observation|>`), and the observation abuts the next assistant marker (`</tool_response><|assistant|>`).

For **non-thinking** mode the user text carries the soft switch and the generation prompt pre-fills an empty think span:

```text
<|user|>
Hi there/nothink<|assistant|>
<think></think>
```

## OpenAI-compatible API mapping

With a server parser active (`--tool-call-parser glm45 --reasoning-parser glm45`), the raw stream maps onto Chat Completions as follows:

- `choices[].finish_reason` = `"tool_calls"` when the output contained at least one `<tool_call>` (otherwise `"stop"`).
- `choices[].message.content` = the text **before** the first `<tool_call>` (normalized to `null` if empty/whitespace). The `<think>…</think>` reasoning is removed by the reasoning parser and surfaced separately as `message.reasoning_content`.
- `choices[].message.tool_calls[]` — one entry per `<tool_call>…</tool_call>` block:
  - `.id` = a **server-generated** id (e.g. vLLM's `make_tool_call_id()`), **not** present in the model output. GLM emits no per-call id in the stream.
  - `.type` = `"function"`.
  - `.function.name` = the text after `<tool_call>` up to the first newline.
  - `.function.arguments` = a **JSON string** (an object), reconstructed from the `<arg_key>`/`<arg_value>` pairs with per-argument typing from the tool schema. vLLM returns `json.dumps(arg_dct, ensure_ascii=False)`, e.g. `"{\"location\": \"Beijing\", \"unit\": \"celsius\"}"`. Clients `json.loads()` it before use.
- **Request side — tool results** are sent back as `role: "tool"` messages, e.g.:

  ```json
  {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"temperature\": 26, \"unit\": \"celsius\", \"condition\": \"Sunny\"}"}
  ```

  The chat template renders only `content` (inside `<tool_response>`); `tool_call_id` is **ignored by the template** and matters only for the client's own bookkeeping. Order results to match the calls.
- **Request side — assistant tool-call history**: the OpenAI shape carries `function.arguments` as a JSON **string**, but the chat template iterates `arguments.items()` and therefore needs an **object**. vLLM/SGLang parse the string back into a dict before rendering; if you call `tokenizer.apply_chat_template` directly, pass `arguments` as a dict (and optionally `reasoning_content` as a string) or the template will raise.
- Disable thinking via `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` (OpenAI Python client) — this flips the template to the `/nothink` + pre-filled `<think></think>` path.

## Parsing notes & gotchas

- **String values are unquoted; typing needs the schema.** The decisive rule: a `<arg_value>` is a literal string iff the parameter is string-typed in the tool's JSON Schema; otherwise it is JSON. vLLM's `_is_string_type` and SGLang's `get_argument_type` both walk `properties[arg].type` (handling `anyOf`/`oneOf`/`enum`/`allOf`/type-arrays). If the schema is missing/loose, they fall back to "try `json.loads`, then `ast.literal_eval`, then treat as string" — so a bare word like `celsius` survives as a string, while `26` becomes a number. A string value that *looks* like JSON (e.g. a parameter typed `string` whose value is `{"a":1}`) is correctly kept as the literal string only because the schema says `string`.
- **Extraction regexes (GLM-4.5/4.6).** vLLM: calls via `<tool_call>.*?</tool_call>` (DOTALL); name/body via `<tool_call>([^\n]*)\n(.*)</tool_call>`; pairs via `<arg_key>(.*?)</arg_key>\s*<arg_value>(.*?)</arg_value>`. The name regex **requires a newline** after the name — matching the 4.5/4.6 template. SGLang uses an equivalent `(?:\\n|\n)` form so it also tolerates literal escaped `\n`.
- **`</arg_value>` in a value breaks parsing.** Values are captured non-greedily up to the next `</arg_value>`; a value whose text contains `</arg_value>` (or `</tool_call>`) truncates early. There is no escaping mechanism in the wire format.
- **Tool calls are parsed from `content` only, not from reasoning.** A `<tool_call>` emitted inside `<think>…</think>` is ignored by the tool parser (vLLM's reasoning/tool parsers cooperate so only post-`</think>` content is scanned). Don't expect calls made "while thinking" to fire.
- **Guided decoding is suppressed for GLM.** For `tool_choice: "required"` or a named tool, vLLM deliberately does **not** apply JSON structured-outputs/guided decoding, because that would force JSON output and conflict with GLM's XML syntax; the parser extracts from free-form XML instead.
- **`skip_special_tokens` must be off.** Although the tool/think tags are `special: false`, vLLM forces `skip_special_tokens = False` when tools are enabled (defensive against transformers 5.x detokenization changes) so the literal `<tool_call>`/`</tool_call>` text survives for the regex.
- **Streaming.** Long string arguments used to be buffered until the closing tag (vLLM issue #32829); the current parser re-parses the accumulated text each delta and emits only the diff, streaming incremental string content with an open-quote-then-fill strategy and holding back any partial trailing tag (`partial_tag_overlap`). The streamed tool name is the text before the first `\n` or `<arg_key>`. SGLang implements the same as an explicit XML→JSON state machine (`INIT → IN_KEY → WAITING_VALUE → IN_VALUE`). Malformed tails (a missing `</arg_value>` before `</tool_call>`) are closed off heuristically.
- **Lineage — GLM-4.5 vs GLM-4.6:** identical wire format and identical `chat_template.jinja` (same content hash); the same `glm45` parser serves both.
- **Lineage — GLM-4.7 / GLM-5 changed the format.** Newer models may omit
  structural newlines: the function name can sit directly before the first
  `<arg_key>`, zero-argument calls can be `<tool_call>func</tool_call>`, and
  parallel calls can abut. vLLM/SGLang require their distinct GLM-4.7
  parsers for this variant. omp's repository scanner is intentionally broader:
  it accepts newline, `<arg_key>`, or `</tool_call>` as the name delimiter, so
  the same `glm` dialect scanner handles both layouts.

## omp / pi converter behavior

The repository's `glm` dialect is an **owned in-band converter**. Select it
with `PI_DIALECT=glm`; legacy `PI_DIALECT=1` and `PI_DIALECT=true` also resolve
to GLM. With tools present, the agent appends the GLM format guide and compact
tool catalog to the system prompt, removes native provider tools, rewrites
prior calls/results into grammar-owned text, and scans assistant text back
into canonical pi events. GLM-family model affinity resolves to this dialect.

The owned renderer always emits the GLM-4.5 newline layout. It consults each
tool's normalized schema: string-only properties are emitted raw, while all
other values are JSON-serialized. Parallel calls are newline-separated. In
owned history, result batches become a synthetic user message containing
`<observation>` with one `<tool_response>` per result; the lower-level GLM
transcript renderer uses the model-native `<|observation|>` role marker
instead.

The scanner synthesizes `ptc_…` ids, emits `toolStart` once the name delimiter
arrives, and streams each argument body as keyed `toolArgDelta` events.
String-only schema properties stay verbatim; every other completed property is
parsed with strict `JSON.parse` after trimming and falls back to the original
raw text on failure. On flush, an unfinished key/value drops only the scanner's
private call state. If `toolStart` was already emitted, OMP retains the
canonical call and a normal stop may dispatch it; previously accumulated
arguments—including partial value text published through `toolArgDelta`—remain
on that call. Input that never yields a valid name emits no `toolStart` and
therefore leaves no call. The scanner also heals narrowly recognizable model
mistakes: `</arg_key>` used in place of `</arg_value>`, a stray wrong closer
before the real closer, and a missing value closer immediately before the next
argument or call close.

Thinking parsing is enabled by default and excludes `<think>…</think>` from
visible text. If `<tool_response>` appears in assistant output, the scanner
drops that tag and the remainder of the currently buffered chunk rather than
treating the hallucinated result as assistant content.

## Sources

- Chat template (authoritative; rendered locally for the byte-exact streams), GLM-4.5 commit `cbb2c7c…`: https://huggingface.co/zai-org/GLM-4.5/resolve/main/chat_template.jinja — the `blob`/web path redirects to the model-card API; verified via the raw `resolve/main` cache.
- Identical GLM-4.6 template (same content hash, confirming shared format): https://huggingface.co/zai-org/GLM-4.6/resolve/main/chat_template.jinja
- Special-token IDs and `special` flags (`added_tokens_decoder`, `additional_special_tokens`): https://huggingface.co/zai-org/GLM-4.5/resolve/main/tokenizer_config.json
- Stop tokens (`eos_token_id = [151329, 151336, 151338]`): https://huggingface.co/zai-org/GLM-4.5/resolve/main/generation_config.json
- Model card (server flags `--tool-call-parser glm45 --reasoning-parser glm45`, `enable_thinking` switch, parser links): https://huggingface.co/zai-org/GLM-4.5
- vLLM GLM-4.5/4.6 tool parser (`Glm4MoeModelToolParser`: regexes, schema-driven string typing, JSON-string `arguments`, streaming, `skip_special_tokens`): https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/glm4_moe_tool_parser.py
- vLLM GLM-4.7 tool parser (`Glm47MoeModelToolParser`: same-line name, optional/zero args): https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/glm47_moe_tool_parser.py
- SGLang GLM-4.5/4.6 detector (`Glm4MoeDetector`: format docstring, XML→JSON state machine, argument typing): https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/function_call/glm4_moe_detector.py
- SGLang GLM-4.7 detector (`Glm47MoeDetector`: newline-less / back-to-back calls): https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/function_call/glm47_moe_detector.py
- vLLM tool-calling docs: https://docs.vllm.ai/en/latest/features/tool_calling/
