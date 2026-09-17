# DeepSeek tool-calling wire format

DeepSeek's chat models (DeepSeek-V3, V3-0324, R1, R1-0528, and DeepSeek-V3.1) share a
single tokenizer family and a distinctive envelope built from **fullwidth-pipe** special
tokens such as `<｜begin▁of▁sentence｜>` and `<｜User｜>`. Tool calling is emitted as a run
of dedicated special tokens (`<｜tool▁calls▁begin｜>` … `<｜tool▁calls▁end｜>`) rather than
JSON-in-text or XML. This document centers on **DeepSeek-V3.1** (the current hybrid
thinking/non-thinking model) and documents the older **DeepSeek-V3-0324** and
**DeepSeek-R1-0528** format as an explicit version difference, because their on-the-wire
tool syntax is *not* the same as V3.1's.

An inference server enables it with a chat template plus a tool-call parser:

- vLLM V3.1: `--enable-auto-tool-choice --tool-call-parser deepseek_v31 --chat-template examples/tool_chat_template_deepseekv31.jinja` (optionally `--reasoning-parser deepseek_r1`).
- vLLM V3-0324 / R1-0528: `--enable-auto-tool-choice --tool-call-parser deepseek_v3 --chat-template examples/tool_chat_template_deepseekv3.jinja` (V3-0324) or `tool_chat_template_deepseekr1.jinja` (R1-0528).
- The model's own `tokenizer_config.json` `chat_template` (and the identical `assets/chat_template.jinja`) renders the V3.1 envelope, tool calls, and tool outputs; it does **not** synthesize the `## Tools` advertisement block, so vLLM ships a template that does (see below).

> Verified against: the DeepSeek-V3.1 model card "Chat Template" / "ToolCall" sections, the
> byte-identical `chat_template` in `tokenizer_config.json` and `assets/chat_template.jinja`,
> the `added_tokens` in `tokenizer.json` (token IDs), `config.json` (bos/eos IDs), the
> DeepSeek-V3-0324 and DeepSeek-R1-0528 `tokenizer_config.json` chat templates, the vLLM
> `tool_chat_template_deepseekv31.jinja`, and the vLLM tool-calling / reasoning-outputs docs.

## A note on the unusual Unicode (do not substitute ASCII)

DeepSeek's markers do **not** use the ASCII vertical bar `|` (U+007C) or ASCII underscore
`_`. They use:

- `｜` — **U+FF5C FULLWIDTH VERTICAL LINE**, as the delimiter just inside the angle brackets.
- `▁` — **U+2581 LOWER ONE EIGHTH BLOCK** (the SentencePiece word-boundary glyph), as the
  separator *between words* inside a token, e.g. `begin▁of▁sentence`, `tool▁calls▁begin`.

So `<｜tool▁calls▁begin｜>` is `<` + `｜`(FF5C) + `tool` + `▁`(2581) + `calls` + `▁`(2581) +
`begin` + `｜`(FF5C) + `>`. Copying these tokens as `<|tool_calls_begin|>` (ASCII pipe +
underscore) produces tokens the model never trained on and will silently break parsing and
generation. The only DeepSeek markers that use ASCII brackets are the thinking tags
`<think>` / `</think>` (plain `<`, `/`, `>`) and the rarely used `<|EOT|>` (ASCII pipes).

## Special tokens

Token IDs are from DeepSeek-V3.1 `tokenizer.json` (`added_tokens`); `vocab_size` is 129280.
The `special` column reflects the tokenizer's `"special"` flag (it governs
`skip_special_tokens`); note that the role/think/tool markers are `special: false`.

| Token (verbatim) | ID | `special` | Purpose |
| --- | --- | --- | --- |
| `<｜begin▁of▁sentence｜>` | 0 | true | BOS; prepended once at the very start of the prompt. |
| `<｜end▁of▁sentence｜>` | 1 | true | EOS; ends every assistant/tool turn and is the stop token. |
| `<｜▁pad▁｜>` | 2 | true | Padding (`pad_token`; the model card/config also reuse EOS as pad). |
| `<｜search▁begin｜>` | 128796 | false | Search-agent query open (thinking-mode search tool). |
| `<｜search▁end｜>` | 128797 | false | Search-agent query close. |
| `<think>` | 128798 | false | Opens the reasoning/thinking span. ASCII brackets. |
| `</think>` | 128799 | false | Closes the reasoning span; **also emitted in non-thinking mode** (see below). |
| `<｜fim▁hole｜>` / `<｜fim▁begin｜>` / `<｜fim▁end｜>` | 128800–128802 | false | Fill-in-the-middle (not chat). |
| `<｜User｜>` | 128803 | false | User role marker. |
| `<｜Assistant｜>` | 128804 | false | Assistant role marker. |
| `<\|EOT\|>` | 128805 | true | End-of-turn (legacy; ASCII pipes, rarely used in chat). |
| `<｜tool▁calls▁begin｜>` | 128806 | false | Opens the assistant's batch of tool calls. |
| `<｜tool▁calls▁end｜>` | 128807 | false | Closes the batch of tool calls. |
| `<｜tool▁call▁begin｜>` | 128808 | false | Opens a single tool call inside the batch. |
| `<｜tool▁call▁end｜>` | 128809 | false | Closes a single tool call. |
| `<｜tool▁outputs▁begin｜>` | 128810 | false | Opens a batch of tool results (**R1-0528 / V3-0324 only**). |
| `<｜tool▁outputs▁end｜>` | 128811 | false | Closes a batch of tool results (**R1-0528 / V3-0324 only**). |
| `<｜tool▁output▁begin｜>` | 128812 | false | Opens a single tool result. |
| `<｜tool▁output▁end｜>` | 128813 | false | Closes a single tool result. |
| `<｜tool▁sep｜>` | 128814 | false | Separator inside a tool call (between name and arguments). |

`config.json` confirms `bos_token_id: 0`, `eos_token_id: 1`.

## Roles / channels / turn structure

There is no OpenAI-style `system`/`developer` channel token. Roles are inline markers and
the prompt is one flat string:

```text
<｜begin▁of▁sentence｜>{system_prompt}<｜User｜>{query}<｜Assistant｜>{response}<｜end▁of▁sentence｜>
```

- **System prompt** has no marker. All `system` messages are concatenated (joined with
  `\n\n` when there are several) and emitted immediately after `<｜begin▁of▁sentence｜>`,
  before the first `<｜User｜>`. When tools are present the `## Tools` block is appended to
  this system text (separated by `\n\n`).
- **User turn**: `<｜User｜>` + content. (No EOS after the user text in V3.1; the assistant
  marker follows directly.)
- **Assistant turn**: opens with `<｜Assistant｜>`, then a thinking tag, then content, then
  `<｜end▁of▁sentence｜>`.
- **Thinking vs non-thinking (V3.1 hybrid)** — selected by the template, not by the model:
  - Non-thinking generation prefix: `…<｜Assistant｜></think>` — the model starts *after* a
    `</think>` it never had to open. Unlike DeepSeek-V3, V3.1 always injects this `</think>`.
  - Thinking generation prefix: `…<｜Assistant｜><think>` — the model emits its chain of
    thought, closes with `</think>`, then the answer.
  - In multi-turn context, **every** stored assistant turn keeps a `</think>`; only the last
    turn's leading thinking tag reflects the requested mode. When rendering a stored
    assistant message, any text up to and including `</think>` is stripped from `content`
    before re-emitting (the template does `content.split('</think>', 1)[1]`).
- **Tool calling runs in non-thinking mode.** The model card states "Toolcall is supported
  in non-thinking mode," and the V3.1 tool template opens the tool-call turn with
  `<｜Assistant｜></think>`. With vLLM, V3.1 reasoning is disabled by default; enable it via
  `chat_template_kwargs={"thinking": true}`.
- **Search-agent channel**: a separate thinking-mode protocol using `<｜search▁begin｜>` /
  `<｜search▁end｜>` (see the model card's `assets/search_tool_trajectory.html`); out of
  scope for ordinary function calling.

## Tool definitions

Tools are advertised as a **Markdown block injected into the system area** (after the system
prompt, before the first `<｜User｜>`). The chat template in `tokenizer_config.json` does not
build this block from a `tools=[…]` argument; the caller (or vLLM's
`tool_chat_template_deepseekv31.jinja`) constructs it. Reproduced verbatim from the
DeepSeek-V3.1 model card, the full layout is
`<｜begin▁of▁sentence｜>{system prompt}\n\n{tool_description}<｜User｜>{query}<｜Assistant｜></think>`
where `{tool_description}` is:

```text
## Tools
You have access to the following tools:

### {tool_name1}
Description: {description}

Parameters: {json.dumps(parameters)}

IMPORTANT: ALWAYS adhere to this exact format for tool use:
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>

Where:
- `tool_call_name` must be an exact match to one of the available tools
- `tool_call_arguments` must be valid JSON that strictly follows the tool's Parameters Schema
- For multiple tool calls, chain them directly without separators or spaces
```

Each tool contributes one `### {name}` section with a `Description:` line and a
`Parameters: {…}` line whose value is the compact JSON of the JSON-Schema parameters object
(`json.dumps(parameters)` in the card, `parameters | tojson` in vLLM's template). The
`IMPORTANT:` instruction block is appended once, after the last tool.

## Tool-call format

The model emits one batch wrapper containing one or more calls. Each call is
`name <｜tool▁sep｜> arguments`, where **arguments is a raw JSON object string** (no code
fence). Minimal single call (what the model generates after the `<｜Assistant｜></think>`
prefix):

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

Grammar (V3.1):

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>{name}<｜tool▁sep｜>{json_args}<｜tool▁call▁end｜>{…more calls…}<｜tool▁calls▁end｜>
```

- `{name}` must exactly match an advertised tool name. It comes **first**, immediately after
  `<｜tool▁call▁begin｜>`.
- `{json_args}` is valid JSON conforming to the tool's parameter schema, inlined directly.
- The whole assistant turn is then closed by the template/server with
  `<｜end▁of▁sentence｜>`.

(V3.1 has **no** `type` field and **no** ` ```json ` fence around arguments — that is the
older R1/V3-0324 convention; see Version differences.)

## Multiple / parallel tool calls

All calls live inside one `<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>` wrapper. After the
first `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>`, each additional call is **another
`<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>` chained directly, with no separator, newline, or
space between calls** (the card: "chain them directly without separators or spaces"):

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA"}<｜tool▁call▁end｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "Seattle, WA"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

Note that `<｜tool▁calls▁begin｜>` (plural, id 128806) appears exactly once; each call uses
the singular `<｜tool▁call▁begin｜>` (id 128808) / `<｜tool▁call▁end｜>` (id 128809).

## Tool-result format

Executed results are fed back as `tool`-role messages. In **V3.1** each result is wrapped in
the singular output tokens, with **no** plural `<｜tool▁outputs▁…｜>` wrapper, emitted right
after the assistant tool-call turn's `<｜end▁of▁sentence｜>`:

```text
<｜tool▁output▁begin｜>{result_text}<｜tool▁output▁end｜>
```

`{result_text}` is the raw tool output (typically a JSON string, but any text). For multiple
results, the V3.1 template emits one `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` per `tool`
message, concatenated directly. There is **no tool-call ID in the wire format** — results are
matched to calls **positionally** (order of outputs ↔ order of calls).

The model then produces its final answer **directly after `<｜tool▁output▁end｜>`** with no
`<｜Assistant｜>` marker and no `</think>` (see Parsing notes — the V3.1 reference template
deliberately renders post-tool assistant content as just `content<｜end▁of▁sentence｜>`).

> R1-0528 / V3-0324 differ: results are enclosed in a `<｜tool▁outputs▁begin｜>` …
> `<｜tool▁outputs▁end｜>` batch wrapper, with each result as
> `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` and multiple results newline-separated.

## End-to-end example

A complete DeepSeek-V3.1 **non-thinking** multi-turn exchange. Everything is one flat string;
inline `←` comments mark where the model's generation begins (they are not part of the
stream). Whitespace inside the `## Tools` block is literal newlines.

```text
<｜begin▁of▁sentence｜>You are a helpful assistant.

## Tools
You have access to the following tools:

### get_weather
Description: Get the current weather for a location

Parameters: {"type": "object", "properties": {"location": {"type": "string", "description": "City and state, e.g. San Francisco, CA"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}

IMPORTANT: ALWAYS adhere to this exact format for tool use:
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>

Where:
- `tool_call_name` must be an exact match to one of the available tools
- `tool_call_arguments` must be valid JSON that strictly follows the tool's Parameters Schema
- For multiple tool calls, chain them directly without separators or spaces
<｜User｜>What's the weather in San Francisco?<｜Assistant｜></think><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA", "unit": "celsius"}<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁output▁begin｜>{"temperature": 18, "unit": "celsius", "condition": "Foggy"}<｜tool▁output▁end｜>It's currently 18°C and foggy in San Francisco.<｜end▁of▁sentence｜>
```

Reading the spans:

1. `<｜begin▁of▁sentence｜>` + system text + `\n\n` + `## Tools…` block — prompt prefix.
2. `<｜User｜>What's the weather in San Francisco?` — user turn.
3. `<｜Assistant｜></think>` — non-thinking generation prefix (prompt). **Model generates from here.**
4. `<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>` — the model's tool call; server appends `<｜end▁of▁sentence｜>` and stops with `finish_reason: "tool_calls"`.
5. `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` — your executed result, appended to the prompt.
6. `It's currently 18°C and foggy in San Francisco.<｜end▁of▁sentence｜>` — **the model generates the final answer directly after the tool output** (no new `<｜Assistant｜>` marker), ending with EOS.

## OpenAI-compatible API mapping

When fronted by an OpenAI-compatible server (e.g. vLLM with `--tool-call-parser
deepseek_v31`):

- **`finish_reason`**: `"tool_calls"` when the model emitted a `<｜tool▁calls▁begin｜>…`
  batch; otherwise `"stop"`.
- **`message.tool_calls[]`**: one element per `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>`.
  - `.type` = `"function"`.
  - `.function.name` = the text between `<｜tool▁call▁begin｜>` and `<｜tool▁sep｜>`.
  - `.function.arguments` = the text between `<｜tool▁sep｜>` and `<｜tool▁call▁end｜>`, returned
    as a **JSON string** (per the OpenAI spec), not a nested object. The model already emits
    raw JSON there, so it is passed through.
  - `.id` = **synthesized by the server** (e.g. `chatcmpl-tool-…`). DeepSeek's wire format
    carries no call ID.
- **Tool result messages**: `{"role": "tool", "tool_call_id": "<id>", "content": "<result>"}`.
  The server renders `content` into `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`. Because the
  prompt has no IDs, `tool_call_id` is used only for client-side bookkeeping; **the model
  relies on ordering**, so preserve the order of results relative to the calls.
- **Assistant replay**: when you send a prior assistant turn back with `tool_calls`, the
  template inlines `function.arguments`. The HF reference template inlines it **verbatim**
  (assumes it is already a JSON string); vLLM's `tool_chat_template_deepseekv31.jinja` pipes
  it through `| tojson`. Send `arguments` as a JSON **string** per the OpenAI spec (see the
  gotcha below about double-encoding).

## Parsing notes & gotchas

- **Unicode is load-bearing.** Match `｜` = U+FF5C and `▁` = U+2581 exactly. ASCII
  `<|tool_calls_begin|>` will not tokenize to the special tokens. `<think>`/`</think>` use
  ASCII brackets; the rare `<|EOT|>` uses ASCII pipes.
- **Tool/role markers are `special: false`.** Only `<｜begin▁of▁sentence｜>`,
  `<｜end▁of▁sentence｜>`, `<｜▁pad▁｜>`, and `<|EOT|>` are flagged `special: true`. So
  decoding with `skip_special_tokens=True` will **not** strip `<｜tool▁calls▁begin｜>`,
  `<｜tool▁sep｜>`, `<｜Assistant｜>`, `</think>`, etc. — they remain in the decoded string for
  the parser to find. (Conversely, do not assume special-token filtering removes them.)
- **No code fence / no `type` field in V3.1.** A parser written for R1/V3-0324
  (`function<｜tool▁sep｜>name` + ` ```json ` block) will not parse V3.1, and vice-versa.
  V3.1 is `name<｜tool▁sep｜>raw_json`.
- **Chaining has no delimiter in V3.1.** Calls abut directly:
  `…<｜tool▁call▁end｜><｜tool▁call▁begin｜>…`. Do not split on newlines/whitespace; split on
  the `<｜tool▁call▁begin｜>` / `<｜tool▁call▁end｜>` boundaries. (R1/V3-0324 put a `\n` before
  each subsequent call.)
- **No tool-call IDs on the wire.** Match results to calls by position. A server must
  generate synthetic `tool_call_id`s for the OpenAI shape.
- **`</think>` appears even in non-thinking mode.** Strip the leading `</think>` (and any
  preceding reasoning) before treating the remainder as the visible answer; the template does
  `content.split('</think>', 1)[1]` when replaying stored turns.
- **Post-tool generation prompt quirk.** The reference V3.1 chat template only appends the
  `<｜Assistant｜></think>` generation prefix when the **last message is `user`**. After a
  `tool` message it appends nothing and the model continues straight after
  `<｜tool▁output▁end｜>`. Agent loops that re-template a conversation ending in a tool result
  must not expect (or double-insert) an assistant marker there.
- **`arguments` double-encoding risk.** On replay, vLLM's example template applies
  `arguments | tojson`. If `arguments` is already a JSON string (the OpenAI convention), that
  pipe will JSON-encode the string again (wrapping it in quotes and escaping it). Pass an
  object where the template expects `| tojson`, or a string where the template inlines
  verbatim — match the template you actually run.
- **Streaming.** Tool calls arrive token-by-token; the name is complete only at
  `<｜tool▁sep｜>`, and arguments are partial JSON until `<｜tool▁call▁end｜>`. Buffer per call
  boundary; do not attempt to `json.loads` arguments before the closing tool-call token.
- **Malformed output.** With `tool_choice="auto"` and no structural-tag constraint
  (`VLLM_ENFORCE_STRICT_TOOL_CALLING=false`), the model can emit invalid JSON in
  `tool_call_arguments` or a `tool_call_name` that does not match any tool; the parser
  extracts best-effort. Named/`required` tool choice uses the structured-outputs backend and
  guarantees schema-valid arguments.

## Version differences: V3.1 vs V3-0324 / R1-0528

The pre-V3.1 models (DeepSeek-V3-0324 and DeepSeek-R1-0528) share an older tool-call
encoding, served in vLLM with `--tool-call-parser deepseek_v3`. The per-call body is:

````text
<｜tool▁call▁begin｜>function<｜tool▁sep｜>{name}
```json
{json_args}
```<｜tool▁call▁end｜>
````

Differences from V3.1:

| Aspect | V3.1 (`deepseek_v31`) | V3-0324 / R1-0528 (`deepseek_v3`) |
| --- | --- | --- |
| Field order in a call | `{name}<｜tool▁sep｜>{args}` | `function<｜tool▁sep｜>{name}` (the literal `type`, then name) |
| Arguments wrapping | raw JSON, inline | fenced ` ```json … ``` ` block (name and args separated by `\n`) |
| Chaining of calls | abut directly, **no separator** | each subsequent call prefixed with `\n` |
| Tool results | `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` per message, no batch wrapper | wrapped in `<｜tool▁outputs▁begin｜>…<｜tool▁outputs▁end｜>`, results newline-separated |
| User→assistant boundary | user turn = `<｜User｜>{q}`; `<｜Assistant｜></think>` added at generation | user turn = `<｜User｜>{q}<｜Assistant｜>` (assistant marker appended in the user branch) |
| Thinking | hybrid; `thinking` kwarg toggles `<think>` vs `</think>` prefix | R1-0528 always reasoning (bare `<｜Assistant｜>` generation prefix, model opens `<think>` itself); V3-0324 non-reasoning |
| vLLM parser | `--tool-call-parser deepseek_v31` | `--tool-call-parser deepseek_v3` |

Example R1-0528 / V3-0324 parallel call with its result batch:

````text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
```json
{"location": "San Francisco, CA"}
```<｜tool▁call▁end｜>
<｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
```json
{"location": "Seattle, WA"}
```<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>{"temperature": 18}<｜tool▁output▁end｜>
<｜tool▁output▁begin｜>{"temperature": 14}<｜tool▁output▁end｜><｜tool▁outputs▁end｜>
````

The `deepseek_r1` **reasoning** parser (`--reasoning-parser deepseek_r1`) applies to the R1
series **and** to DeepSeek-V3.1; it extracts the `<think>…</think>` span into the response's
`reasoning` field. It is independent of the tool-call parser.

## DSML envelope (newer DeepSeek models)

Newer DeepSeek models (for example `deepseek-v4-pro`) emit tool calls in a second, XML-style
envelope — **DSML** — instead of the `<｜tool▁calls▁begin｜>` special-token run. The tag names
reuse the same fullwidth pipe (`｜`, U+FF5C), but the body is an Anthropic-style `invoke` /
`parameter` block rather than a `name<｜tool▁sep｜>{json}` pair:

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_weather">
<｜DSML｜parameter name="location" string="true">San Francisco, CA</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

- One `<｜DSML｜tool_calls>…</｜DSML｜tool_calls>` wrapper holds one or more
  `<｜DSML｜invoke name="…">…</｜DSML｜invoke>` calls; whitespace between tags is insignificant.
- Each argument is a `<｜DSML｜parameter name="…" string="…">value</｜DSML｜parameter>`. `string`
  defaults to `"true"` (value kept as a raw string); `string="false"` parses the value as JSON,
  so `…string="false">15</…>` decodes to the number `15`.
- An ASCII-pipe variant (`<|DSML|tool_calls>`, `<|DSML|invoke …>`, `<|DSML|parameter …>`) occurs
  on the wire alongside the fullwidth form.
- Several OpenAI-compatible hosts (DeepSeek's own API, NanoGPT, NVIDIA, Ollama / Ollama Cloud,
  Fireworks, OpenRouter, OpenCode) leak this envelope into visible `content` instead of returning
  structured `tool_calls`; a parser must heal it back into tool calls and strip the markers from
  user-visible text.

## omp / pi converter behavior

The repository's `deepseek` dialect is an **owned in-band converter**, not a
vLLM parser wrapper. Select it with `PI_DIALECT=deepseek` (or the equivalent
agent configuration). When tools are present, the agent appends the dialect
guide and compact tool catalog to the system prompt, removes native provider
tools from the request, re-encodes prior calls/results with this syntax, and
scans streamed assistant text back into canonical pi tool-call events.

The current scanner accepts all three forms described above:

- V3.1 `name<｜tool▁sep｜>{json}` calls;
- legacy `function<｜tool▁sep｜>name` plus a fenced JSON body; and
- fullwidth or ASCII DSML `invoke` / `parameter` blocks.

For V3.1 and legacy calls, omp emits `toolStart` after the header is complete
but buffers arguments until `<｜tool▁call▁end｜>`; it then uses the shared
repairing JSON parser. A missing/invalid completed argument object becomes
`{}`. Flush emits no `toolEnd` for an unfinished call and only clears the
scanner's private state. Once `toolStart` has been projected, however, the
canonical call remains and a normally stopped turn may dispatch it: unfinished
V3.1/legacy calls retain `{}`, while DSML calls retain any argument text already
published through `toolArgDelta`. DSML is genuinely incremental: parameter
body text is streamed as those deltas. A DSML parameter is a raw string unless
`string="false"`; the latter is repairing-JSON-decoded at a completed close and
falls back to the raw text if decoding fails. Call IDs for id-less DeepSeek
forms are synthesized as `ptc_…`.

The scanner also removes leaked DeepSeek chat-template control tokens from
visible text and, by default, maps `<think>…</think>` to thinking events. Its
renderer emits V3.1 calls, joins parallel calls without separators, and renders
multiple results as singular output blocks separated by newlines. The DSML
syntax is accepted for healing leaked provider output but is not the owned
dialect's emitted history format.

## Sources

- DeepSeek-V3.1 model card (Chat Template / ToolCall sections): <https://huggingface.co/deepseek-ai/DeepSeek-V3.1>
- DeepSeek-V3.1 `assets/chat_template.jinja`: <https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/assets/chat_template.jinja>
- DeepSeek-V3.1 `tokenizer_config.json` (`chat_template`, byte-identical to the jinja): <https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/tokenizer_config.json>
- DeepSeek-V3.1 `tokenizer.json` (`added_tokens` → token IDs and `special` flags): <https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/tokenizer.json>
- DeepSeek-V3.1 `config.json` (`bos_token_id`, `eos_token_id`, `vocab_size`): <https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/config.json>
- DeepSeek-R1-0528 model card and `tokenizer_config.json` (older tool format): <https://huggingface.co/deepseek-ai/DeepSeek-R1-0528> · <https://huggingface.co/deepseek-ai/DeepSeek-R1-0528/resolve/main/tokenizer_config.json>
- DeepSeek-R1 model card: <https://huggingface.co/deepseek-ai/DeepSeek-R1>
- DeepSeek-V3-0324 `tokenizer_config.json` (older tool format): <https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/resolve/main/tokenizer_config.json>
- vLLM tool-call template for V3.1 (`## Tools` injection + `| tojson`): <https://github.com/vllm-project/vllm/blob/main/examples/tool_chat_template_deepseekv31.jinja>
- vLLM Tool Calling docs (`deepseek_v3`, `deepseek_v31` parser flags): <https://docs.vllm.ai/en/latest/features/tool_calling/>
- vLLM Reasoning Outputs docs (`deepseek_r1` reasoning parser; V3.1 thinking default): <https://docs.vllm.ai/en/latest/features/reasoning_outputs/>
