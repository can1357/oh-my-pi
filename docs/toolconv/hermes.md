# Hermes tool-calling format

Tool-calling convention originated by NousResearch's **Hermes 2 Pro** (Llama-3-based open models) and carried on by the **Hermes 3** line, plus a long tail of community fine-tunes. The envelope is **ChatML**: every turn is `<|im_start|>{role}\n{body}<|im_end|>\n`. Available tools are advertised in the system turn inside a `<tools>…</tools>` block as OpenAI-style JSON tool objects; the model emits each call as a `<tool_call>\n{json}\n</tool_call>` block whose `arguments` is a **nested JSON object** (not a stringified JSON); tool results are fed back inside a **dedicated `<|im_start|>tool` turn** as `<tool_response>…</tool_response>` wrapping a `{"name": …, "content": …}` object — the result carries the function name, so results are self-describing as to the function called, but remain order-bound because the wire format has no unique call ID. Qwen3 adopted this convention with two tweaks (results folded into `user` turns with bare content, and the `FunctionCall` schema line dropped) — see [qwen3.md](qwen3.md). Hermes 3 adds an optional GOAP `<scratch_pad>` reasoning framework in front of calls; the classic Hermes 2 Pro function-calling spec has **no** dedicated thinking channel, although the omp scanner also recognizes `<think>…</think>` from R1-style fine-tunes (see the omp section).

The classic format examples below come from the NousResearch `Hermes-Function-Calling` README. OMP's current implementation is `packages/ai/src/dialect/hermes.ts`; its owned prompt and provider-history behavior differ from the classic template as described below.

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

The `hermes` dialect is registered in `packages/ai/src/dialect/factory.ts` and implemented in `packages/ai/src/dialect/hermes.ts`. With tools present, owned mode appends a format guide/catalog to the system prompt, omits native tools and `tool_choice`, rewrites call/result history into text, and projects assistant output back into canonical pi events. `qwen3` is a separate selectable dialect despite sharing the basic JSON-in-`<tool_call>` shape.

### Selection

Set `tools.format` to `hermes` to force this dialect (`cfgToolsFormat`, `packages/coding-agent/src/session/context-settings.ts`). `PI_DIALECT=hermes` is a fallback when the agent's configured resolver returns no owned dialect (`resolveOwnedDialectFromEnv`, `packages/agent/src/agent-loop.ts`); it does not override an explicit owned setting.

The default `auto` uses native calls unless `supportsTools === false`, then chooses the model-class dialect with a GLM fallback (`resolveDialect`, `packages/coding-agent/src/sdk.ts`). No class maps automatically to `hermes`: `preferredDialect` in `packages/catalog/src/identity/dialect.ts` never returns it. Other selectable owned values are `glm`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `qwen3`, `gemini`, `gemma`, and `minimax`; `native` leaves tools provider-native unless an environment fallback selects an owned dialect.

### Prompt and catalog

`renderInbandToolPrompt` in `packages/ai/src/dialect/catalog.ts` uses `prompt-template.md`: a `# Tools` header, one compact OpenAI-style tool JSON object per line in `<tools>`, then `hermes.md`'s format guide. Tool schemas are normalized with `toolWireSchema`. The guide requires an object-valued `arguments`, normal JSON string escaping rather than HTML escaping, complete calls before stopping, and no model-authored `<tool_response>`. This is OMP's prompt, not the classic 2 Pro prose/`FunctionCall` schema.

### Rendering

The dialect writes:

- calls as `<tool_call>\n{single-line JSON}\n</tool_call>` with nested `arguments`; parallel calls are newline-separated;
- results as `<tool_response>\n{bare result text}\n</tool_response>`, without the classic `{"name": …, "content": …}` wrapper or a separate error bit;
- lower-level `renderTranscript` output as ChatML, with `developer` mapped to `system` and consecutive results coalesced into one **`tool`** turn. Assistant thinking precedes prose and calls. Thinking renders through `renderDelimitedThinking` as `<think>\n{text}\n</think>`, unwrapping nested/repeated surrounding think blocks. No generation prompt is appended.

Provider-request history uses **`encodeInbandToolHistory`**, not that transcript renderer (`packages/ai/src/dialect/history.ts`). Assistant turns with calls become prose plus call blocks and lose their thinking/image blocks; call-free assistant turns stay unchanged. Result runs become one synthetic **`user`** message containing the bare response blocks, with result images retained after the text. Thus the dedicated `tool` role above describes the transcript renderer, not the owned request path.

### Scanning

`HermesInbandScanner` recognizes literal `<tool_call>`/`</tool_call>` and optionally `<think>`/`</think>`, holding back partial marker suffixes across chunks. It mints `ptc_…` ids and emits `toolStart` as soon as `parseStreamingJson` recovers a nonempty string `name`; that can be an incomplete name string. It emits no argument deltas. At `</tool_call>`, `parseJsonWithRepair` parses the body, reparses stringified `arguments`, and normalizes missing/non-object arguments to `{}`. A successful `toolEnd` preserves the raw block and replaces the projected name/arguments with the final parsed values.

If a block is unparseable or lacks a nonempty name at close, it is consumed without `toolEnd`. If a partial name already produced `toolStart`, that projected call is not retracted. EOF mid-call similarly emits no `toolEnd`; a normal stop can retain and dispatch the started call with empty arguments (`InbandStreamProjector`, `packages/ai/src/dialect/owned-stream.ts`).

The owned stream discards output from a fabricated `<tool_response>` onward. `tools.abortOnFabricatedResult` defaults to `true` (`packages/coding-agent/src/tools/settings.ts`) and aborts the provider at that boundary; disabling it drains the stream but still discards the continuation. If the provider unexpectedly emits named native calls, they are forwarded; the first native/in-band call channel wins, avoiding duplicate dispatch.

### Thinking parsing default

The direct scanner defaults thinking parsing **off**: its constructor uses `options.parseThinking === true`. Without that option, `<think>` remains visible text and calls inside it can still be scanned. `<scratch_pad>` is never a thinking delimiter for this scanner.

The owned projector always passes `parseThinking: true`, so agent use routes `<think>` contents to thinking events and does not scan calls inside that span. A direct scanner only emits an EOF `thinkingEnd` when there is buffered text to consume; if the last feed already drained the buffer inside thinking, `flush()` emits none. The owned projector closes any remaining thinking block when finishing the message.

## Parsing notes & gotchas

- **Arguments object vs string:** on the wire `arguments` is a nested JSON object; the OpenAI layer hands it back as a JSON string. Code that reads the raw stream must parse an object; code that reads the API must `json.loads` the string. Do not double-encode. (omp's scanner tolerates the stringified form for robustness; its renderer never emits it.)
- **`<tools>` is not a control token.** Only `<|im_start|>`/`<|im_end|>` delimit turns; everything else is substring matching on decoded text.
- **Regex/streaming parse:** the vLLM `hermes` parser keys on the literal `<tool_call>`/`</tool_call>` substrings and JSON-decodes the body, buffering from `<tool_call>` until it can incrementally parse `name` then `arguments` — full detail in [qwen3.md](qwen3.md) §Parsing notes.
- **Result binding:** classic Hermes 2 Pro includes the function name as metadata in the `{"name": …, "content": …}` nesting under a `tool` turn, but call/result binding remains positional because names need not be unique. Qwen3 also relies on ordering, with bare content under a `user` turn.
- **No classic thinking channel:** Hermes 2 Pro defines none. OMP leaves `<scratch_pad>` markup in visible text; R1-style `<think>` is handled only when thinking parsing is enabled.
- **Transcript vs request history:** `renderTranscript` renders thinking for every stored assistant turn. Owned provider history strips thinking from assistant turns containing calls, while leaving call-free turns unchanged.
- **Robustness:** malformed closed blocks may produce no `toolEnd`, and incomplete blocks may leave an already-started call with empty arguments. Parsing tolerances are not schema validation.

## Sources

- NousResearch Hermes-Function-Calling README (canonical prompt formats, call/result shapes, inference example): https://github.com/NousResearch/Hermes-Function-Calling
- vLLM tool-calling docs (`hermes` parser, auto tool choice): https://docs.vllm.ai/en/latest/features/tool_calling/
- [qwen3.md](qwen3.md) — Qwen3's adoption of this convention, shared vLLM parser behavior, and the `qwen3`/`hermes` dialect split
- OMP implementation: `packages/ai/src/dialect/hermes.ts`, `factory.ts`, `rendering.ts`, `catalog.ts`, `history.ts`, `owned-stream.ts`; JSON parsing: `packages/utils/src/json-parse.ts`; selection: `packages/catalog/src/identity/dialect.ts`, `packages/coding-agent/src/sdk.ts` (`resolveDialect`), `packages/agent/src/agent-loop.ts` (`resolveOwnedDialectFromEnv`).
