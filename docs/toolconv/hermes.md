# Hermes tool-calling format

Tool-calling convention originated by NousResearch's **Hermes 2 Pro** (Llama-3-based open models) and carried on by the **Hermes 3** line, plus a long tail of community fine-tunes. The envelope is **ChatML**: every turn is `<|im_start|>{role}\n{body}<|im_end|>\n`. Available tools are advertised in the system turn inside a `<tools>…</tools>` block as OpenAI-style JSON tool objects; the model emits each call as a `<tool_call>\n{json}\n</tool_call>` block whose `arguments` is a **nested JSON object** (not a stringified JSON); tool results are fed back inside a **dedicated `<|im_start|>tool` turn** as `<tool_response>…</tool_response>` wrapping a `{"name": …, "content": …}` object — the result carries the function name, so results are self-describing as to the function called, but remain order-bound because the wire format has no unique call ID. Qwen3 adopted this convention with two tweaks (results folded into `user` turns with bare content, and the `FunctionCall` schema line dropped) — see [qwen3.md](qwen3.md). Hermes 3 adds an optional GOAP `<scratch_pad>` reasoning framework in front of calls; the classic Hermes 2 Pro function-calling spec has **no** dedicated thinking channel, although the omp scanner also recognizes `<think>…</think>` from R1-style fine-tunes (see the omp section).

Verified against: the NousResearch `Hermes-Function-Calling` README (read in full — the canonical system prompts, the call/result formats, and the inference example below are quoted from it), the vLLM tool-calling docs (`hermes` parser), and the omp implementation on `main` @ `4324de2` (every omp claim below carries a `file:line` reference).

## Special tokens

Only the ChatML markers are control tokens; the tool and reasoning markers are text-level strings inside the turn body. Token **IDs are model-specific** (each Hermes release has its own tokenizer), so they are deliberately not listed here.

| Marker (verbatim) | Kind | Purpose |
|---|---|---|
| `<\|im_start\|>` | ChatML control token | Start of a turn; followed immediately by the role name + `\n` |
| `<\|im_end\|>` | ChatML control token | End of a turn |
| `<tool_call>` | Text-level marker | Opens one tool call |
| `</tool_call>` | Text-level marker | Closes one tool call |
| `<tool_response>` | Text-level marker | Opens one tool result |
| `</tool_response>` | Text-level marker | Closes one tool result |
| `<tools>` … `</tools>` | Plain text | Wrapper around the tool list in the system turn |
| `<scratch_pad>` … `</scratch_pad>` | Text-level marker (Hermes 3) | GOAP reasoning sections before calls |
| `<think>` … `</think>` | Not in the Hermes 2 Pro spec | Thinking markers recognized by the omp scanner (R1-style fine-tunes) |

Notes on exactness:

- All markers use the ASCII pipe `|` (U+007C) and ASCII angle brackets.
- The README describes ChatML as adding "special tokens … to denote the beginning and end of any turn, along with roles for the turns"; only `<|im_start|>`/`<|im_end|>` matter for splitting turns. The tool markers are ordinary text, which is why regex/substring parsers recover them from decoded output.
- `<tools>`/`</tools>` have no token status at all — they are prompt-prose wrappers around the JSON tool list.

## Roles / channels / turn structure

ChatML. Each message renders as:

```text
<|im_start|>{role}
{body}<|im_end|>
```

- Roles: `system`, `user`, `assistant`, `tool`. There is no separate "channel" concept; the only sub-streams are the optional Hermes 3 `<scratch_pad>` (or R1-style `<think>`) block at the start of an assistant turn.
- `<|im_end|>\n` terminates every turn. With `add_generation_prompt=True` the prompt ends with `<|im_start|>assistant\n` and the model continues from there.
- **System turn:** if the caller supplies a `system` message it becomes the first turn. When tools are present, the tool advertisement **is** that system turn's content (the function-calling prompt quoted below) — there is no separate tools turn.
- **Tool-result turns use the dedicated `tool` role.** Every executed result is sent back as `<|im_start|>tool` turns carrying `<tool_response>` blocks. This is the classic Hermes 2 Pro shape; Qwen3's template folds the same blocks into `user` turns instead ([qwen3.md](qwen3.md) §Roles).
- **Thinking/reasoning:** no thinking channel exists in the Hermes 2 Pro function-calling spec. Hermes 3's tool-use template may interpose a `<scratch_pad>…</scratch_pad>` GOAP block (Goal / Actions / Observation / Reflection sections) before the `<tool_call>`.

## Tool definitions

Tools are advertised as the **system prompt itself**. The canonical Hermes 2 Pro prompt from the NousResearch README, verbatim:

```text
<|im_start|>system
You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools> [{"type": "function", "function": {"name": "get_stock_fundamentals", "description": "Get fundamental data for a given stock symbol using yfinance API.", "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}}] </tools> Use the following pydantic model json schema for each tool call you will make: {"title": "FunctionCall", "type": "object", "properties": {"name": {"title": "Name", "type": "string"}, "arguments": {"title": "Arguments", "type": "object"}}, "required": ["name", "arguments"]} For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": <function-name>, "arguments": <args-dict>}
</tool_call><|im_end|>
```

- Each list element is the full OpenAI tool object `{"type": "function", "function": {...}}` (with a JSON-Schema `parameters` object). The 2 Pro prompt embeds the whole JSON **array inline**; the Hermes 3 template puts the `<tools>` block on its own lines with the same JSON payloads.
- The trailing instruction is a literal part of the prompt, including the placeholder line `{"name": <function-name>, "arguments": <args-dict>}` (those angle-bracket tokens are instructions, not emitted output).
- The `FunctionCall` pydantic schema sentence documents the two-key call object; Qwen3 dropped that sentence when adopting the convention ([qwen3.md](qwen3.md) §Tool definitions).
- The Hermes 3 template additionally instructs the model to record GOAP reasoning inside `<scratch_pad>…</scratch_pad>` before calling functions, with `Actions` written as `result_var = functions.name(param=value, …)` lines.

## Tool-call format

The model emits each call as a `<tool_call>` line, a single-line JSON object, then `</tool_call>`. Minimal single call (README example, verbatim):

```text
<tool_call>
{"name": "get_stock_fundamentals", "arguments": {"symbol": "TSLA"}}
</tool_call>
```

- `arguments` is a **nested JSON object**, not a JSON-encoded string. On the wire it is `"arguments": {"symbol": "TSLA"}` — never `"arguments": "{\"symbol\": \"TSLA\"}"`.
- The call object has exactly two keys, `name` (string) and `arguments` (object), matching the `FunctionCall` schema. There is **no per-call ID on the wire** — the OpenAI-style `tool_call_id` is minted by the serving layer (see API mapping).
- A tool-calling assistant turn may also contain natural-language prose before the first `<tool_call>`.

## Multiple / parallel tool calls

Parallel calls are emitted as consecutive `<tool_call>…</tool_call>` blocks within a single assistant turn. The system prompt explicitly allows "one or more functions"; each block is parsed independently, and one `<tool_response>` must be returned per call.

## Tool-result format

Each executed result is fed back as a `<|im_start|>tool` turn whose body is a `<tool_response>` block wrapping a JSON object with the function **name** and the **content** (README example, verbatim):

```text
<|im_start|>tool
<tool_response>
{"name": "get_stock_fundamentals", "content": {"symbol": "TSLA", "company_name": "Tesla, Inc.", "sector": "Consumer Cyclical", "industry": "Auto Manufacturers", "market_cap": 611384164352, "pe_ratio": 49.604652, "pb_ratio": 9.762013, "dividend_yield": null, "eps": 4.3, "beta": 2.427, "52_week_high": 299.29, "52_week_low": 152.37}}
</tool_response>
<|im_end|>
```

- The `{"name": …, "content": …}` nesting makes each result self-describing as to the function called, but the binding to a particular call is still positional. Two parallel calls to the same function have the same `name`, and the raw format provides no unique call ID. (Qwen3 instead emits the bare content under a `user` turn and relies on ordering — [qwen3.md](qwen3.md) §Tool-result format.)
- At the OpenAI API layer a result message is `{"role": "tool", "content": "...", "tool_call_id": "..."}`; the rendering above is what the template produces from it.

## End-to-end example

Complete exchange assembled verbatim from the four consecutive code blocks of the NousResearch README's function-calling walkthrough (each turn checked byte-exact against the source):

```text
<|im_start|>user
Fetch the stock fundamentals data for Tesla (TSLA)<|im_end|>
<|im_start|>assistant
<tool_call>
{"name": "get_stock_fundamentals", "arguments": {"symbol": "TSLA"}}
</tool_call><|im_end|>
<|im_start|>tool
<tool_response>
{"name": "get_stock_fundamentals", "content": {"symbol": "TSLA", "company_name": "Tesla, Inc.", "sector": "Consumer Cyclical", "industry": "Auto Manufacturers", "market_cap": 611384164352, "pe_ratio": 49.604652, "pb_ratio": 9.762013, "dividend_yield": null, "eps": 4.3, "beta": 2.427, "52_week_high": 299.29, "52_week_low": 152.37}}
</tool_response>
<|im_end|>
<|im_start|>assistant
The stock fundamentals data for Tesla (TSLA) are as follows:
- **Symbol**: TSLA
- **Company Name**: Tesla, Inc.
- **Sector**: Consumer Cyclical
- **Industry**: Auto Manufacturers
- **Market Capitalization**: $566,160,130,480
- **Forward Price-to-Earnings Ratio (PE Ratio)**: 42.73
- **Price-to-Book Ratio (PB Ratio)**: 9.04
- **Dividend Yield**: N/A
- **Trailing Earnings Per Share (EPS)**: $4.3
- **Beta Value of the Stock**: 2.42
- **52-Week High Price of the Stock**: $299.29
- **52-Week Low Price of the Stock**: $152.37

This information provides a snapshot of Tesla's financial position and performance based on the fundamental data obtained from the yfinance API. It shows that Tesla has a substantial market capitalization and a relatively high P/E and P/B ratio compared to other stocks in its industry. The company does not pay a dividend at the moment, which is reflected by a 'Dividend Yield' of 'None'. The Beta value indicates that Tesla's stock has a moderate level of volatility relative to the market. The 52-week high and low prices give an idea of the stock's range over the past year. This data can be useful when assessing investment opportunities and making investment decisions.<|im_end|>
```

## OpenAI-compatible API mapping

Serving engines expose this convention through the **`hermes` tool-call parser** (vLLM: `--enable-auto-tool-choice --tool-call-parser hermes`, `Hermes2ProToolParser` — the same parser Qwen3 uses, see [qwen3.md](qwen3.md) §OpenAI-compatible API mapping and §Parsing notes for the verified streaming detail):

- `finish_reason`: `"tool_calls"` when the turn ended on tool calls (otherwise `"stop"`).
- `message.role`: `"assistant"`; `message.content`: `null` for a pure tool-call turn (any pre-call prose becomes `content`).
- `message.tool_calls[]`: one entry per `<tool_call>` block, each with a server-generated `id` (the model emits none), `type: "function"`, `function.name`, and `function.arguments` re-serialized as a **JSON string** at the API boundary (`json.loads(...)` it before use).
- Feeding results back: append `{"role": "tool", "content": <result>, "tool_call_id": <id-from-the-call>}` for each result; the engine renders it into the `<tool_response>` shape above.

## omp / pi converter behavior

The repository's `hermes` dialect is an **owned in-band converter**, registered in `packages/ai/src/dialect/factory.ts:16` and defined in `packages/ai/src/dialect/hermes.ts:195-206`. With tools present, the agent appends the Hermes format guide and compact tool catalog to the system prompt, removes native provider tools, rewrites earlier calls and results as text in this syntax, and scans streamed output back into canonical pi tool-call events. `qwen3` remains a separate selectable dialect even though both emit the same basic JSON-in-`<tool_call>` convention.

### Selection

Force the dialect with `tools.format: hermes` or `PI_DIALECT=hermes` (`resolveOwnedDialectFromEnv`, `packages/agent/src/agent-loop.ts:171-191`, consumed at `agent-loop.ts:1527`). The `tools.format` enum (`packages/coding-agent/src/config/settings-schema.ts:2655-2671`; UI labels at `2679-2697`) offers:

| `tools.format` value | UI label | Meaning |
|---|---|---|
| `auto` | Auto | Native tool calls unless the model is marked as not supporting them, then the model-family owned dialect (GLM fallback) |
| `native` | Native | Provider-native tool calls |
| `glm` | GLM | GLM-style in-band tool calls |
| `hermes` | Hermes | This dialect |
| `kimi` | Kimi | Kimi-style in-band tool calls |
| `xml` | XML | Generic XML in-band tool calls |
| `anthropic` | Anthropic | Anthropic-style in-band tool calls |
| `deepseek` | DeepSeek | DeepSeek-style in-band tool calls |
| `harmony` | Harmony | Harmony-style in-band tool calls |
| `qwen3` | Qwen3 | The Qwen3 owned dialect |
| `gemini` | Gemini | The Gemini owned dialect |
| `gemma` | Gemma | The Gemma owned dialect |
| `minimax` | MiniMax | The MiniMax owned dialect |

No model family maps to `hermes` automatically: `preferredDialect` (`packages/catalog/src/identity/dialect.ts:18-42`) never returns it, and `auto`'s fallback is `glm` (`packages/coding-agent/src/sdk.ts:628-633`). The dialect is reachable only by forcing it explicitly.

### Prompt and catalog

Owned mode appends `renderInbandToolPrompt`'s output (`packages/ai/src/dialect/catalog.ts:24-29`): a `# Tools` header, the `<tools>` block with **one OpenAI-style JSON tool object per line** (`catalog.ts:9-22`, template at `packages/ai/src/dialect/prompt-template.md`), then the Hermes format guide (`packages/ai/src/dialect/hermes.md`). The guide shows the exact `<tool_call>`/`<tool_response>` shapes, requires `arguments` to be a JSON object ("never a stringified JSON"), forbids HTML-escaping argument strings, and instructs the model to write the complete call before stopping and to never emit `<tool_response>` itself. This wrapper is omp's own — it is not the 2 Pro prose + `FunctionCall` schema sentence quoted above.

### Rendering

The renderer always writes:

- calls as `<tool_call>\n{single-line JSON}\n</tool_call>` with a **nested** `arguments` object (`hermes.ts:170-172`), parallel calls newline-separated (`hermes.ts:174-176`);
- results as `<tool_response>\n{bare result text}\n</tool_response>` blocks, newline-delimited (`packages/ai/src/dialect/rendering.ts:5-7`);
- the transcript as ChatML turns with a **dedicated `tool` result role** (`hermes.ts:186-193` → `renderChatMlTranscript` with `toolResultRole: "tool"`, `rendering.ts:107-136`; turn envelope at `rendering.ts:275-277`). Consecutive tool results coalesce into one run (`rendering.ts:125-129`); `developer` messages render as `system` (`rendering.ts:131`).

Two deliberate divergences from classic Hermes 2 Pro rendering: result bodies are **bare text** (not the `{"name": …, "content": …}` wrapper — the injected format guide shows the model the bare form), and the tool advertisement is omp's `# Tools` catalog. An assistant turn renders thinking first, then prose, then calls (`rendering.ts:116-123`); stored thinking round-trips as `<think>\n{text}\n</think>` with nested blocks unwrapped and joined by newlines (`hermes.ts:182-184` → `renderDelimitedThinking`, `rendering.ts:250-273`).

### Scanning

The `HermesInbandScanner` (`hermes.ts:21-168`) recognizes `<tool_call>`/`</tool_call>` and `<think>`/`</think>` (`hermes.ts:15-18`) and holds back partial marker suffixes across stream chunks (`hermes.ts:19,82`; `packages/ai/src/dialect/coercion.ts:114-126`). It mints an id (`ptc_…`, `hermes.ts:98`; `coercion.ts:109-112`) at `<tool_call>` and emits `toolStart` as soon as the leading JSON contains a complete string `name` (`hermes.ts:132-142`). It waits for `</tool_call>` before emitting `toolEnd` and does not stream argument deltas; at close it uses the shared repairing JSON parser and also accepts a stringified `arguments` value (parsed once more), normalizing non-object arguments to `{}` (`hermes.ts:144-160`; `coercion.ts:134-136`). The raw block is preserved on `toolEnd` (`hermes.ts:118-124`).

If EOF arrives after the name was recovered but before `</tool_call>`, no `toolEnd` is emitted, but the canonical call created by `toolStart` survives with empty arguments and may be dispatched on a normal stop (`hermes.ts:107-109`). A completed block whose `name` cannot be recovered is consumed without creating a call (`hermes.ts:147`).

The owned stream also watches for the model fabricating a `<tool_response>` of its own (`packages/ai/src/dialect/owned-stream.ts:22,205-206`) and, with `tools.abortOnFabricatedResult`, aborts the request (`packages/coding-agent/src/sdk.ts:3318`).

### Thinking parsing default

**The `HermesInbandScanner` constructor defaults thinking parsing to OFF**: `this.#parseThinking = options.parseThinking === true;` (`hermes.ts:32`). A consumer that calls `createInbandScanner("hermes")` without options (`factory.ts:32-34`) therefore gets `<think>…</think>` left in the visible text — the marker is not even searched for (`hermes.ts:79`).

This is the inverse of the sibling dialects, whose scanners default it ON: `qwen3` (`packages/ai/src/dialect/qwen3.ts:37`), `kimi` (`kimi.ts:45`), `glm` (`glm.ts:87`), `gemini` (`gemini.ts:52`), and `gemma` (`gemma.ts:45`) all use `options.parseThinking !== false`, and `deepseek` uses `options.parseThinking ?? true` (`deepseek.ts:107`). (`anthropic` shares the off-by-default shape, `anthropic.ts:107`.) The divergence is flagged in [#9257](https://github.com/can1357/oh-my-pi/issues/9257) and kept as-is pending a maintainer decision.

omp's own agent flow is unaffected either way: the owned-tool stream always constructs its scanners with `parseThinking: true` (`owned-stream.ts:200-204`), so under `tools.format: hermes` the agent loop parses `<think>` blocks into thinking events exactly like its siblings. The off-by-default constructor only matters for direct scanner consumers. When parsing is on, thinking events stream incrementally and an unterminated `<think>` block is logically closed on flush (`hermes.ts:48-75`).

## Parsing notes & gotchas

- **Arguments object vs string:** on the wire `arguments` is a nested JSON object; the OpenAI layer hands it back as a JSON string. Code that reads the raw stream must parse an object; code that reads the API must `json.loads` the string. Do not double-encode. (omp's scanner tolerates the stringified form for robustness; its renderer never emits it.)
- **`<tools>` is not a control token.** Only `<|im_start|>`/`<|im_end|>` delimit turns; everything else is substring matching on decoded text.
- **Regex/streaming parse:** the vLLM `hermes` parser keys on the literal `<tool_call>`/`</tool_call>` substrings and JSON-decodes the body, buffering from `<tool_call>` until it can incrementally parse `name` then `arguments` — full detail in [qwen3.md](qwen3.md) §Parsing notes.
- **Result binding:** classic Hermes 2 Pro includes the function name as metadata in the `{"name": …, "content": …}` nesting under a `tool` turn, but call/result binding remains positional because names need not be unique. Qwen3 also relies on ordering, with bare content under a `user` turn.
- **No thinking channel in the spec:** Hermes 2 Pro's function-calling prompt defines none, and Hermes 3's `<scratch_pad>` GOAP markup is **not** parsed by omp's hermes scanner (it recognizes only `<tool_call>` and `<think>`, `hermes.ts:15-19`) — scratchpad text stays visible. R1-style `<think>` blocks are handled (see the thinking default above).
- **History rerender:** omp re-renders stored `<think>` blocks for **every** assistant turn (`rendering.ts:116-123`), unlike Qwen3's chat template, which trims reasoning from all but the trailing assistant turns — keep that asymmetry in mind when comparing transcripts across the two dialects.
- **Robustness:** the format is prompt-driven, so malformed output is possible (truncated JSON, missing `</tool_call>`, prose mixed into a call, stringified arguments). omp's scanner consumes a recognized block and emits no call when the outer JSON/name cannot be recovered; EOF mid-call leaves a started call with empty arguments (see Scanning).

## Sources

- NousResearch Hermes-Function-Calling README (canonical prompt formats, call/result shapes, inference example): https://github.com/NousResearch/Hermes-Function-Calling
- vLLM tool-calling docs (`hermes` parser, auto tool choice): https://docs.vllm.ai/en/latest/features/tool_calling/
- [qwen3.md](qwen3.md) — Qwen3's adoption of this convention, shared vLLM parser behavior, and the `qwen3`/`hermes` dialect split
- omp implementation on `main` @ `4324de2` — every omp-specific claim above is cited `file:line` inline
