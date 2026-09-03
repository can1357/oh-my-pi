# Qwen3 tool-calling format (Hermes convention)

Tool-calling convention of Alibaba's **Qwen3** family (`Qwen/Qwen3-*`: dense `0.6B–32B` and MoE `30B-A3B`/`235B-A22B`; same template line as `Qwen2.5-*` and `QwQ-32B`). It is the **Hermes** convention — the XML+JSON format originated by NousResearch's Hermes 2 Pro and adopted verbatim by Qwen, plus a long tail of community fine-tunes. The envelope is **ChatML**: every turn is `<|im_start|>{role}\n{body}<|im_end|>\n`. Available tools are advertised in the system turn inside a `<tools>…</tools>` block (one JSON spec per line); the model emits each call as a `<tool_call>\n{json}\n</tool_call>` block whose `arguments` is a **nested JSON object** (not a stringified JSON); tool results are fed back inside `<tool_response>…</tool_response>`. Hybrid reasoning is carried in `<think>…</think>`. The format ships in the model's own `chat_template`, so an inference server enables it with no extra template: vLLM uses `--enable-auto-tool-choice --tool-call-parser hermes` (pair with `--reasoning-parser deepseek_r1` for the thinking split); SGLang exposes the matching parsers (e.g. `--reasoning-parser qwen3`).

Verified against: Qwen's canonical function-calling guide (`qwen.readthedocs.io/en/latest/framework/function_call.html`, read in full incl. the Qwen-Agent + vLLM sections), the byte-exact `chat_template` field of `Qwen/Qwen3-8B`'s `tokenizer_config.json` (HF resolve-cache commit `b968826d9c46dd6066d109eabc6255188de91218`, rendered locally with Jinja2 for the raw streams below) and its `added_tokens_decoder` for token IDs, the NousResearch `Hermes-Function-Calling` README, and the vLLM tool-calling docs (`hermes` parser + Qwen models section).

## Special tokens

Only the three ChatML markers are "special" control tokens (`special=true`, skipped by `skip_special_tokens`). The reasoning and tool markers are also single vocabulary tokens (one ID each) but are registered with `special=false`, i.e. they render as ordinary text and are **not** stripped by `skip_special_tokens`. The `<tools>`/`</tools>` wrapper has **no** dedicated token at all — it is plain text that BPE-splits into several tokens. IDs are from `Qwen/Qwen3-8B` `added_tokens_decoder`.

| Token (verbatim) | ID | `special` | Purpose |
|---|---|---|---|
| `<\|im_start\|>` | 151644 | true | Start of a turn; followed immediately by the role name + `\n` |
| `<\|im_end\|>` | 151645 | true | End of a turn; the chat stop token |
| `<\|endoftext\|>` | 151643 | true | Base EOS / pad token |
| `<think>` | 151667 | false | Opens the reasoning block |
| `</think>` | 151668 | false | Closes the reasoning block |
| `<tool_call>` | 151657 | false | Opens one tool call |
| `</tool_call>` | 151658 | false | Closes one tool call |
| `<tool_response>` | 151665 | false | Opens one tool result |
| `</tool_response>` | 151666 | false | Closes one tool result |
| `<tools>` … `</tools>` | — | — | Plain text wrapper around the tool list in the system turn (not a single token) |

Notes on exactness:
- All markers use the ASCII pipe `|` (U+007C) and ASCII angle brackets. Qwen3 has **no** fullwidth (`｜` U+FF5C) or `▁` (U+2581) variants — that is DeepSeek/SentencePiece territory, not Qwen.
- `<|im_start|>` and `<|im_end|>` are the only tokens that matter for splitting turns. Because `<tool_call>`, `</tool_call>`, `<tool_response>`, `<think>`, `</think>` are `special=false`, they survive a `skip_special_tokens=True` decode, which is exactly why the regex-based `hermes` parser can recover them from decoded text.
- The model card confirms `</think>` = token `151668` (used by the reference parsing snippet `output_ids[::-1].index(151668)`).

## Roles / channels / turn structure

ChatML. Each message renders as:

```text
<|im_start|>{role}
{body}<|im_end|>
```

- Roles: `system`, `user`, `assistant`, `tool`. There is no separate "channel" concept; the only sub-stream is the `<think>` reasoning block inside an assistant turn.
- `<|im_end|>\n` terminates every turn. With `add_generation_prompt=True` the prompt ends with `<|im_start|>assistant\n` and the model continues from there.
- **System turn:** if the caller supplies a `system` message it becomes the first turn. When `tools` are present, the tool advertisement is merged **into** that same system turn (the user's system text first, then `\n\n`, then the `# Tools` block — see below). Qwen3 injects no default system prompt when none is given.
- **Tool-result turns use the `user` envelope.** Qwen3's template maps every `role: "tool"` message into a `<|im_start|>user` turn carrying `<tool_response>` blocks (consecutive tool messages are coalesced into one user turn). This differs from classic Hermes 2 Pro, which used a dedicated `<|im_start|>tool` turn for results — Qwen folds them into `user`.
- **Thinking/reasoning:** carried in `<think>…</think>` at the start of an assistant turn (see the Parsing notes for the toggle and the history-rerender rule).

## Tool definitions

Tools are advertised inside the system turn. The template emits a fixed preamble, then each tool object serialized with `tool | tojson` (`json.dumps(..., ensure_ascii=False)`) on **its own line**, then a fixed trailer. Each list element is the full OpenAI tool object `{"type": "function", "function": {...}}` (with a JSON-Schema `parameters` object). The exact, verbatim wrapper Qwen3 produces:

```text
<|im_start|>system
{optional original system content}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_current_temperature", "description": "Get current temperature at a location.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location"]}}}
{"type": "function", "function": {"name": "get_temperature_date", "description": "Get temperature at a location and date.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "date": {"type": "string", "description": "The date to get the temperature for, in the format \"Year-Month-Day\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location", "date"]}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
```

- If the first message is a `system` message, its content is placed before `# Tools` (separated by a blank line); otherwise the turn opens straight into `# Tools`.
- The trailing instruction is a literal part of the prompt, including the placeholder line `{"name": <function-name>, "arguments": <args-json-object>}` (those angle-bracket tokens are instructions, not emitted output).
- Version note: the original Hermes 2 Pro system prompt additionally embedded a `FunctionCall` pydantic schema line (`{"title": "FunctionCall", "type": "object", "properties": {"name": …, "arguments": …}}`). Qwen3 dropped that line; the wrapper above is exactly what Qwen3 emits.

## Tool-call format

The model emits each call as a `<tool_call>` line, a single-line JSON object, then `</tool_call>`. Minimal single call:

```text
<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA", "unit": "celsius"}}
</tool_call>
```

- `arguments` is a **nested JSON object**, not a JSON-encoded string. On the wire it is `"arguments": {"location": "..."}` — never `"arguments": "{\"location\": ...}"`. (The template renders a dict argument via `tojson`; only if a caller stored `arguments` as a pre-serialized string does it pass through verbatim.)
- The call object has exactly two keys, `name` (string) and `arguments` (object). There is no per-call ID on the wire — the OpenAI-style `tool_call_id` is minted by the server, not the model (see API mapping).
- A tool-calling assistant turn may also contain natural-language `content` before the first `<tool_call>`; the template inserts a `\n` between that content and the first call.

## Multiple / parallel tool calls

Parallel calls are emitted as consecutive `<tool_call>…</tool_call>` blocks within a single assistant turn, each separated by a newline:

```text
<|im_start|>assistant
<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA"}}
</tool_call>
<tool_call>
{"name": "get_temperature_date", "arguments": {"location": "San Francisco, CA, USA", "date": "2024-10-01"}}
</tool_call><|im_end|>
```

The parser returns these as `tool_calls[0]`, `tool_calls[1]`, … in emission order. The application must execute them and return one `<tool_response>` per call, in the same order.

## Tool-result format

Each executed result is wrapped in `<tool_response>…</tool_response>`. Qwen3 places them inside a **`user`** turn, and **coalesces** consecutive tool results into one turn (one `<tool_response>` block per result, newline-separated, a single closing `<|im_end|>`):

```text
<|im_start|>user
<tool_response>
{"temperature": 26.1, "location": "San Francisco, CA, USA", "unit": "celsius"}
</tool_response>
<tool_response>
{"temperature": 25.9, "location": "San Francisco, CA, USA", "date": "2024-10-01", "unit": "celsius"}
</tool_response><|im_end|>
```

- The body between the tags is the tool's return value (typically a JSON string, but any text is allowed). The function name is **not** repeated inside Qwen3's `<tool_response>` — ordering ties results to calls. (Classic Hermes 2 Pro instead nested `{"name": ..., "content": ...}` inside `<tool_response>` under a `tool` turn; Qwen3's template emits the bare content under a `user` turn.)
- At the OpenAI API layer a result message is `{"role": "tool", "content": "...", "tool_call_id": "..."}`; the template renders only its `content` into a `<tool_response>` block.

## End-to-end example

Complete multi-turn weather exchange in **non-thinking mode** (`enable_thinking=False`), exactly as `apply_chat_template` renders it for the live flow. With thinking disabled, each generation step injects an empty `<think>\n\n</think>\n\n` after `<|im_start|>assistant\n`; the model then emits its tool call / final answer. Copy-pasteable, byte-exact:

```text
<|im_start|>system
You are a helpful assistant. Current Date: 2024-09-30.

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_current_temperature", "description": "Get current temperature at a location.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location"]}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
<|im_start|>user
What's the temperature in San Francisco now?<|im_end|>
<|im_start|>assistant
<think>

</think>

<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA", "unit": "celsius"}}
</tool_call><|im_end|>
<|im_start|>user
<tool_response>
{"temperature": 26.1, "location": "San Francisco, CA, USA", "unit": "celsius"}
</tool_response><|im_end|>
<|im_start|>assistant
<think>

</think>

The current temperature in San Francisco is 26.1°C.<|im_end|>
```

In **thinking mode** (`enable_thinking=True`, the default) the generation prompt instead ends with a bare `<|im_start|>assistant\n` and the model itself produces the `<think>…real reasoning…</think>` block before the `<tool_call>`. (When re-rendering stored history, the template keeps the `<think>` block only for the last assistant message or messages that carry `reasoning_content`, and strips reasoning from earlier turns — see Parsing notes.)

## OpenAI-compatible API mapping

With `--enable-auto-tool-choice --tool-call-parser hermes`, vLLM converts the raw stream into a standard Chat Completions response:

- `finish_reason`: `"tool_calls"` when the turn ended on tool calls (otherwise `"stop"`).
- `message.role`: `"assistant"`; `message.content`: `null` for a pure tool-call turn (any pre-call prose becomes `content`).
- `message.tool_calls[]`: one entry per `<tool_call>` block, each:
  - `id`: server-generated, e.g. `"chatcmpl-tool-924d705adb044ff88e0ef3afdd155f15"` (the model emits no ID).
  - `type`: `"function"`.
  - `function.name`: the call's `name`.
  - `function.arguments`: a **JSON string** at the API boundary, e.g. `'{"location": "San Francisco, CA, USA"}'`. The wire format is a nested object, but the server re-serializes it to a string here (`json.loads(...)` it before use), matching OpenAI and Qwen-Agent.
- With thinking + `--reasoning-parser deepseek_r1`, the `<think>…</think>` content is split out into `message.reasoning_content` and removed from `content`.
- Feeding results back: append `{"role": "tool", "content": <result>, "tool_call_id": <id-from-the-call>}` for each result. `tool_call_id` links a result to its call (Qwen3's template ignores the id when rendering — ordering is what reaches the model — but the API still requires it).

Example assistant message returned for the two-call query:

```text
finish_reason='tool_calls'
message.content = None
message.tool_calls = [
  {id:'chatcmpl-tool-924d…', type:'function', function:{name:'get_current_temperature', arguments:'{"location": "San Francisco, CA, USA"}'}},
  {id:'chatcmpl-tool-7e30…', type:'function', function:{name:'get_temperature_date',   arguments:'{"location": "San Francisco, CA, USA", "date": "2024-10-01"}'}},
]
```

## omp / pi converter behavior

The repository's `qwen3` dialect is an **owned in-band converter**. Select it
with `PI_DIALECT=qwen3` (or the equivalent agent configuration). With tools
present, the agent appends the Qwen3 format guide and compact tool catalog to
the system prompt, removes native provider tools, rewrites earlier calls and
results as text in this syntax, and scans streamed output back into canonical
pi tool-call events. `hermes` remains a separate selectable dialect even
though both emit the same basic JSON-in-`<tool_call>` convention (see
[hermes.md](hermes.md)).

The catalog's current family-affinity helper maps every model id containing
`qwen` to `qwen3`, including Qwen3-Coder. For a Coder endpoint, set
`tools.format=native` (or the equivalent native-tool setting) and configure the
serving endpoint itself with its `qwen3_xml` parser. `qwen3_xml` is not an
OMP-owned dialect and therefore is not a valid `tools.format` value.

The omp renderer always writes a nested `arguments` object and renders
parallel calls newline-separated. Results become newline-delimited
`<tool_response>` blocks inside the synthetic user history message. The
scanner mints an id (`ptc_…`) and emits `toolStart` as soon as the leading JSON
contains a complete string `name`. It waits for `</tool_call>` before emitting
`toolEnd` and does not stream argument deltas. At close it uses the shared
repairing JSON parser. For compatibility it also accepts a stringified
`arguments` value and parses it once more, although the owned renderer never
emits that shape. A completed string parse failure or non-object argument
normalizes to `{}`; a completed outer object whose name cannot be recovered is
consumed without creating a call.

If EOF arrives after the name was recovered but before `</tool_call>`, no
`toolEnd` is emitted, but the canonical call created by `toolStart` survives
with empty arguments and may be dispatched on a normal stop. Malformed input
that never yields a name produces no call.

Thinking parsing is enabled by default: `<think>…</think>` becomes thinking
events and is excluded from visible text. Callers creating the scanner can set
`parseThinking: false`, in which case thinking markup is left as ordinary
text.

## Parsing notes & gotchas

- **Arguments object vs string:** on the wire `arguments` is a nested JSON object; the OpenAI layer hands it back as a JSON string. Code that reads the raw stream must parse an object; code that reads the API must `json.loads` the string. Do not double-encode.
- **`<tools>` is not a token.** Only count on `<|im_start|>`/`<|im_end|>` (and the `*tool_call*`/`*tool_response*`/`*think*` single tokens) being atomic. `<tools>`/`</tools>` are plain text.
- **Regex/streaming parse:** the vLLM `hermes` parser (`vllm/tool_parsers/hermes_tool_parser.py`, `Hermes2ProToolParser`) keys on the literal `<tool_call>` / `</tool_call>` substrings and JSON-decodes the body, supporting multiple blocks per turn. In streaming it buffers from `<tool_call>` until it can incrementally parse `name` then `arguments`; partial argument JSON is emitted as argument deltas. Text before the first `<tool_call>` is streamed as ordinary content.
- **Thinking toggle:** `enable_thinking=False` (passed via `chat_template_kwargs={"enable_thinking": False}` over the OpenAI API, or `tokenizer.apply_chat_template(..., enable_thinking=False)`) injects an empty `<think>\n\n</think>\n\n` into the generation prompt, hard-suppressing reasoning. Soft switches `/think` and `/no_think` in a user/system message flip it per-turn when thinking is enabled. Greedy decoding is discouraged for Qwen3 (repetition risk).
- **History rerender asymmetry:** when `apply_chat_template` re-renders a stored conversation, it emits the `<think>` block only for the final assistant message or messages carrying `reasoning_content`; reasoning from earlier turns is dropped. So a stored intermediate tool-call assistant turn shows no `<think>` block, while the live generation step that produced it was prefixed with one (in non-thinking mode). Reasoning is preserved only within the current multi-step tool sequence (after the last real user query).
- **Reasoning models + stopword templates:** Qwen warns against ReAct-style stopword tool templates for Qwen3, since reasoning text may contain the stopwords and corrupt parsing — use this native Hermes template instead.
- **Robustness:** the format is prompt/template-driven, so malformed output is possible
  (truncated JSON, missing `</tool_call>`, prose mixed into a call, or stringified
  arguments). vLLM may fall back to content depending on its parser path; omp's
  owned scanner instead consumes a recognized block and emits no call when the
  outer JSON/name cannot be recovered. Named / `required` tool choice can route
  through vLLM's structured-outputs backend when using vLLM native tools, but
  owned mode sends no native provider tool definition and therefore cannot rely
  on that backend.
- **Version/scope:** this `hermes` template covers `Qwen3-*`, `Qwen2.5-*`, and `QwQ-32B`. It does **not** cover `Qwen3-Coder`, which uses a different XML scheme parsed by a serving engine's `qwen3_xml` parser. OMP has no `qwen3_xml` owned dialect; use `tools.format=native` and configure that parser at the endpoint.

## Sources

- Qwen function-calling guide: https://qwen.readthedocs.io/en/latest/framework/function_call.html
- Qwen3-8B chat template + token IDs (`tokenizer_config.json`, `chat_template` + `added_tokens_decoder`): https://huggingface.co/Qwen/Qwen3-8B/resolve/main/tokenizer_config.json (verified via HF resolve-cache commit `b968826d9c46dd6066d109eabc6255188de91218`)
- Qwen3-8B model card (thinking modes, `enable_thinking`, `</think>`=151668): https://huggingface.co/Qwen/Qwen3-8B
- NousResearch Hermes-Function-Calling (origin of the convention): https://github.com/NousResearch/Hermes-Function-Calling
- vLLM tool-calling docs (`hermes` parser, Qwen models, auto tool choice): https://docs.vllm.ai/en/latest/features/tool_calling/
