# Kimi K2 tool-calling format

Native tool-calling convention of Moonshot AI's **Kimi K2** family (`moonshotai/Kimi-K2-Instruct` and `-Base`, `model_type: "kimi_k2"`, 1T-param MoE). It is a ChatML-like envelope built on a TikToken tokenizer (160K vocab): every turn is `<|im_{class}|>{name}<|im_middle|>{body}<|im_end|>`, and tool calls are emitted inside the assistant turn wrapped by a dedicated `<|tool_calls_section_begin|>…<|tool_calls_section_end|>` block. All control tokens are plain ASCII `<|…|>` forms (no fullwidth/unicode variants, unlike DeepSeek). An inference server turns the raw stream into OpenAI-style `tool_calls` with a parser: vLLM and SGLang both expose `--tool-call-parser kimi_k2` (vLLM additionally requires `--enable-auto-tool-choice`). The chat template (a standalone `chat_template.jinja` since the 2025.8.11 update) injects the tool schemas and renders the per-turn markers.

This document was verified against the model card, the official `docs/tool_call_guidance.md` and `docs/deploy_guidance.md` (GitHub `MoonshotAI/Kimi-K2`), the raw `chat_template.jinja` and `tokenizer_config.json` from the HF repo (rendered locally for the byte-exact streams below), and the vLLM `kimi_k2` tool parser source.

## Special tokens

The five tool-call markers required for manual parsing, plus the ChatML envelope markers. Token IDs are from `tokenizer_config.json` (`added_tokens_decoder`).

| Token (verbatim) | ID | Purpose |
|---|---|---|
| `<\|tool_calls_section_begin\|>` | 163595 | Opens the tool-call section inside an assistant turn |
| `<\|tool_call_begin\|>` | 163597 | Opens one individual tool call |
| `<\|tool_call_argument_begin\|>` | 163598 | Separates the tool-call ID from its JSON arguments |
| `<\|tool_call_end\|>` | 163599 | Closes one individual tool call |
| `<\|tool_calls_section_end\|>` | 163596 | Closes the tool-call section |
| `<\|im_system\|>` | 163594 | Start marker for system-class turns (`system`, `tool`, `tool_declare`) |
| `<\|im_user\|>` | 163587 | Start marker for a user turn |
| `<\|im_assistant\|>` | 163588 | Start marker for an assistant turn |
| `<\|im_middle\|>` | 163601 | Separates the role/name header from the message body |
| `<\|im_end\|>` | 163586 | Ends any turn |
| `[BOS]` | 163584 | Sequence-begin token (see notes; not emitted by the chat template) |
| `[EOS]` | 163585 | Sequence-end token |

Notes on exactness:
- The five tool tokens use ASCII pipe `|` (U+007C) and underscores; reproduce them exactly. There are no fullwidth pipe (`｜`) or `▁` variants in Kimi K2.
- `<|im_middle|>` is the only envelope token whose ID (163601) is out of sequence with the others (163586–163599); a `163600` slot is unused.
- Image inputs render via a content macro as the literal sequence `<|media_start|>image<|media_content|><|media_pad|><|media_end|>`. These media markers appear in the template but are **not** registered in `added_tokens_decoder`, so they tokenize as ordinary text rather than single special tokens. They are irrelevant to text tool calling and are listed here only for completeness.

## Roles / channels / turn structure

Kimi K2 uses a ChatML-style envelope. Every message is rendered as:

```text
<|im_{class}|>{name}<|im_middle|>{body}<|im_end|>
```

- There are exactly **three** start-marker tokens, chosen by `role`:
  - `user` → `<|im_user|>`
  - `assistant` → `<|im_assistant|>`
  - everything else (`system`, `tool`, and the synthetic `tool_declare`) → `<|im_system|>`
- The `{name}` segment between the marker and `<|im_middle|>` is `message.name or message.role`. This is the only "channel"/sub-role label Kimi K2 has. For ordinary turns it is literally `system`, `user`, or `assistant`; for a tool-result turn it is the tool's `name` (the function name) when supplied, otherwise `tool`; for the tool-schema turn it is the literal `tool_declare`.
- `<|im_end|>` terminates every turn. The chat template does **not** emit `[BOS]`/`[EOS]`; turn boundaries are purely `<|im_*|>` markers (the tokenizer is TikToken-based with `add_bos_token`/`add_eos_token` unset, and the manual-parse flow feeds the rendered template straight to `/completions`).
- **Default system prompt:** if the first message is not a `system` message, the template injects `<|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|>` before the first turn.
- **Generation prompt:** with `add_generation_prompt=True` the template ends with `<|im_assistant|>assistant<|im_middle|>`, and the model generates from there.
- **Thinking/reasoning:** `Kimi-K2-Instruct` is a "reflex-grade" model with no long thinking, so there is no reasoning channel in this format. (Thinking variants are handled separately — vLLM ships a distinct `kimi_k2` reasoning parser keyed on a `</think>` token — but that is out of scope for the Instruct tool-call format documented here.)

## Tool definitions

Available tools are advertised in a single dedicated turn placed at the very top of the prompt (before any system/user turn), using the synthetic `tool_declare` sub-role under the `<|im_system|>` marker:

```text
<|im_system|>tool_declare<|im_middle|>{TOOLS_JSON}<|im_end|>
```

`{TOOLS_JSON}` is the standard OpenAI-style `tools` array serialized to JSON with **compact separators** `(',', ':')` (no spaces). The array elements are passed through verbatim, i.e. each is `{"type":"function","function":{"name":…,"description":…,"parameters":{…}}}` with a JSON-Schema `parameters` object. Example (single tool, exactly as emitted):

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|>
```

The `tool_declare` turn is rendered only when `tools` is non-empty.

## Tool-call format

When the model decides to call a function, it emits — inside the assistant turn, after any natural-language content — a tool-calls section. Minimal single call (this is the assistant generation that follows `<|im_assistant|>assistant<|im_middle|>`):

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|>
```

Anatomy of one call:

```text
<|tool_call_begin|>  functions.{func_name}:{idx}  <|tool_call_argument_begin|>  {JSON arguments}  <|tool_call_end|>
```

- The token between `<|tool_call_begin|>` and `<|tool_call_argument_begin|>` is the **tool-call ID**, with the fixed form `functions.{func_name}:{idx}`.
  - `functions.` is a literal prefix (it is not derived from the tool schema).
  - `{func_name}` is the called function's name; the function name is recovered by parsing it back out of this ID, not from a separate field.
  - `{idx}` is the **0-based call index** within the current assistant turn (`0` for the first call, `1` for the second, …).
- After `<|tool_call_argument_begin|>` comes the raw JSON arguments object (e.g. `{"city": "Beijing"}`), terminated by `<|tool_call_end|>`.
- All calls of the turn live between one `<|tool_calls_section_begin|>` / `<|tool_calls_section_end|>` pair. Any assistant text content precedes `<|tool_calls_section_begin|>`.
- The whole assistant turn is still closed by `<|im_end|>` and the completion's `finish_reason` becomes `tool_calls`.

## Multiple / parallel tool calls

Two or more calls in one turn are emitted as consecutive `<|tool_call_begin|>…<|tool_call_end|>` blocks inside a single section, with the index incrementing per call. Raw assistant emission for two parallel calls:

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_call_begin|>functions.get_weather:1<|tool_call_argument_begin|>{"city": "Shanghai"}<|tool_call_end|><|tool_calls_section_end|>
```

Note the IDs `functions.get_weather:0` and `functions.get_weather:1` — same function, distinct trailing index. The index is per-turn (it resets to `0` in the next assistant turn).

## Tool-result format

Tool execution results are fed back as a turn with `role: "tool"`. Because `tool` is not `user`/`assistant`, it renders under the `<|im_system|>` marker; the sub-role label is the message's `name` (the function name) when present, else `tool`. The body is a literal `## Return of {tool_call_id}` header line followed by the result content:

```text
<|im_system|>get_weather<|im_middle|>## Return of functions.get_weather:0
{"weather": "Sunny"}<|im_end|>
```

- `{tool_call_id}` echoes the exact ID from the originating call (`functions.get_weather:0`), which is how the model correlates a result with the call that produced it.
- The result `content` is inserted verbatim on the line after the header; callers typically pass a JSON string (e.g. `json.dumps(tool_result)`).
- If the `tool` message omits `name`, the envelope becomes `<|im_system|>tool<|im_middle|>## Return of …`.

## End-to-end example

A complete multi-turn weather exchange. These are the exact rendered streams (system + user supplied explicitly; line breaks inside a turn are literal, turns are otherwise contiguous).

**Stage 1 — prompt fed to the model** (`tools` set, `add_generation_prompt=True`):

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|><|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What's the weather like in Beijing today? Use the tool to check.<|im_end|><|im_assistant|>assistant<|im_middle|>
```

**Assistant generation** (model output; server reports `finish_reason: "tool_calls"`):

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|><|im_end|>
```

**Stage 2 — prompt for the next turn**, after appending the assistant tool-call turn and the tool result turn (`add_generation_prompt=True`):

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|><|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What's the weather like in Beijing today? Use the tool to check.<|im_end|><|im_assistant|>assistant<|im_middle|><|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|><|im_end|><|im_system|>get_weather<|im_middle|>## Return of functions.get_weather:0
{"weather": "Sunny"}<|im_end|><|im_assistant|>assistant<|im_middle|>
```

**Final assistant generation** (model produces natural-language answer terminated by `<|im_end|>`; `finish_reason: "stop"`):

```text
It's sunny in Beijing today.<|im_end|>
```

## OpenAI-compatible API mapping

With a server parser active (`--tool-call-parser kimi_k2`), the raw stream maps onto the Chat Completions shape as follows:

- `choices[].finish_reason` = `"tool_calls"` when the turn contained a tool-calls section (otherwise `"stop"`).
- `choices[].message.tool_calls[]` — one entry per `<|tool_call_begin|>…<|tool_call_end|>` block:
  - `.id` = the raw call ID verbatim, e.g. `"functions.get_weather:0"`.
  - `.type` = `"function"`.
  - `.function.name` = the function name parsed out of the ID. vLLM computes `id.split(":")[0].split(".")[-1]` → `"get_weather"`.
  - `.function.arguments` = a **JSON string** (the raw text captured between `<|tool_call_argument_begin|>` and `<|tool_call_end|>`), e.g. `"{\"city\": \"Beijing\"}"`. Clients `json.loads()` it before use.
- Tool results are sent back as messages of the form:

  ```json
  {"role": "tool", "tool_call_id": "functions.get_weather:0", "name": "get_weather", "content": "{\"weather\": \"Sunny\"}"}
  ```

  `tool_call_id` must equal the `id` returned for the call; `name` becomes the `<|im_system|>{name}<|im_middle|>` sub-role; `content` becomes the body after `## Return of …`.
- Streaming: deltas arrive as `choices[].delta.tool_calls[]` with an `index`; the function `name`/`id` stream once the call header is complete, then `function.arguments` streams as incremental string fragments to be concatenated (standard OpenAI tool-call streaming assembly).

Moonshot's hosted API (`platform.moonshot.ai`) exposes both OpenAI- and Anthropic-compatible endpoints; the Anthropic-compatible one scales temperature as `real_temperature = request_temperature * 0.6`. Recommended sampling temperature for `Kimi-K2-Instruct` is `0.6`.

## Parsing notes & gotchas

- **ID → name parsing differs between references.** The official
  `tool_call_guidance.md` uses `function_id.split('.')[1].split(':')[0]`,
  while vLLM and omp take the last dot-separated segment before the colon.
  The latter tolerates additional namespace segments, but neither convention
  can preserve a literal dot as part of the function name; tool names SHOULD
  follow the documented `functions.{name}:{idx}` shape without dots in
  `{name}`.
- **Extraction regexes differ too.** Guidance: `<\|tool_call_begin\|>\s*(?P<tool_call_id>[\w\.]+:\d+)\s*<\|tool_call_argument_begin\|>\s*(?P<function_arguments>.*?)\s*<\|tool_call_end\|>`. vLLM: ID class is `[^<]+:\d+` and the argument body uses a negative lookahead `(?:(?!<\|tool_call_begin\|>).)*?` so adjacent calls aren't merged. Both run with `DOTALL`.
- **`skip_special_tokens` must be False.** The parser depends on the literal marker text surviving detokenization; vLLM forces `skip_special_tokens = False` when tools are enabled and `tool_choice != "none"`. If markers are stripped, no tool call is detected.
- **Arguments are unvalidated raw text.** Whatever the model emits between the argument marker and `<|tool_call_end|>` is passed straight through as the `arguments` string; it must be valid JSON for downstream `json.loads`, and the model can emit malformed/truncated JSON. Validate before executing.
- **Index semantics.** `{idx}` is the per-turn call counter starting at `0`; it is not a global counter and resets each assistant turn. Do not assume IDs are unique across turns — disambiguate by turn when persisting history.
- **Streaming marker splits.** Section and call markers can be split across token boundaries.
  vLLM holds back any trailing suffix that partially matches a marker and streams
  argument fragments. omp's owned scanner also holds partial markers, but buffers a
  call's arguments until `<|tool_call_end|>` and emits no `toolArgDelta` events.
- **`finish_reason` varies by engine.** The official guide explicitly warns the terminal `finish_reason` for tool calls "may vary across different engines"; loop on `finish_reason == "tool_calls"` but be defensive.
- **Engine fallback.** Kimi K2 reuses the DeepSeek-V3 architecture; `config.json` sets `model_type: "kimi_k2"` so engines apply the right parser. If you force `model_type: "deepseek_v3"` as a compatibility workaround, no native Kimi tool parser is available and you must parse the `<|tool_calls_section_*|>` markers manually.
- **Parser availability.** vLLM ships both a Python (`KimiK2ToolParser`) and a newer Rust tool parser; SGLang implements its own `kimi_k2` parser. All key off the same five markers and the `functions.{name}:{idx}` ID convention documented here.
- **Whitespace artifact.** When no `system` message is supplied, the template injects the default system prompt and a small `\n  ` (newline + two spaces) can appear before the first `<|im_user|>` marker. It is harmless (tokenizes around the markers), but supplying an explicit system message yields the clean streams shown above.

## omp / pi converter behavior

The repository's `kimi` dialect is an **owned in-band converter**. Select it
with `PI_DIALECT=kimi` (or the equivalent agent configuration). With tools
present, the agent appends the Kimi guide and compact tool catalog to the
system prompt, removes native provider tools, rewrites prior calls/results in
Kimi text form, and converts streamed output back into canonical pi events.
Kimi-family model affinity resolves to this dialect.

The renderer emits one section per assistant call batch. It preserves a
pre-existing id that already begins with `functions.`; otherwise it generates
`functions.{name}:{batchIndex}`. Tool results are rendered as consecutive
`<|im_system|>{name}<|im_middle|>## Return of …<|im_end|>` turns, and canonical
tool-result messages are collapsed into one synthetic user message containing
that text.

The scanner recognizes only calls inside a section. Once the argument marker
arrives it preserves the raw header as the call id, derives the name from the
last dot-separated segment before the first colon, and emits `toolStart`. It
buffers the argument body until `<|tool_call_end|>`, then applies the shared
repairing JSON parser and emits `toolEnd`; it does **not** emit incremental
argument deltas. Invalid/non-object completed arguments normalize to `{}`.
If EOF arrives after `toolStart` but before the close marker, no `toolEnd` is
emitted, yet the canonical `{}` call remains and may be dispatched on a normal
stop. Only incomplete input that never reaches the argument marker is
discarded without creating a call. Section markers are suppressed from visible
text, while an isolated call marker outside a section remains ordinary text.

Thinking parsing is enabled by default and maps `<think>…</think>` to thinking
events. `parseThinking: false` leaves those tags and their contents in visible
text.

## Sources

- Model card (Tool Calling section, OpenAI-style example, deployment/API notes): https://huggingface.co/moonshotai/Kimi-K2-Instruct
- Official tool-call guidance (markers, ID convention, manual parser, `extract_tool_call_info`): https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/docs/tool_call_guidance.md (the HF `resolve`/`blob` paths redirected to the model card; verified against this GitHub raw file)
- Deployment guide (`--tool-call-parser kimi_k2`, `--enable-auto-tool-choice`, SGLang flag, `model_type` fallback): https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/docs/deploy_guidance.md
- Chat template (`chat_template.jinja`, rendered locally for byte-exact streams): https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/main/chat_template.jinja
- Tokenizer config (special-token IDs in `added_tokens_decoder`): https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/main/tokenizer_config.json
- vLLM `kimi_k2` tool parser (markers, regex, name-parsing, `skip_special_tokens`, streaming): https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/kimi_k2_tool_parser.py
- vLLM PR adding the parser: https://github.com/vllm-project/vllm/pull/20789
- vLLM tool-calling docs: https://docs.vllm.ai/en/latest/features/tool_calling/
