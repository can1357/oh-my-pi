# Gemma 4 tool-calling format (token-delimited `call:NAME{…}`)

Tool-calling convention of Google's **Gemma 4** open-weights family (`google/gemma-4-*-it`). It is a clean break from the prompt-engineered Pythonic `tool_code` form used by Gemma 3 and hosted Gemini (see `gemini.md`): Gemma 4 introduces **dedicated special tokens** and a compact **token-delimited brace syntax**. Calls and responses each get their own paired markers, and every string value is wrapped in a `<|"|>` token rather than ASCII quotes. The model emits one call as `<|tool_call>call:NAME{key:value,…}<tool_call|>`; the developer parses it, runs the tool, and appends `<|tool_response>response:NAME{output:…}<tool_response|>`.

Verified against the OMP `gemma` dialect (`packages/ai/src/dialect/gemma.ts`): the streaming scanner that parses these blocks and the `renderAssistantToolCalls` / `renderToolResults` / `renderTranscript` renderers that produce them. The example streams below match that implementation; the worked model id is `google/gemma-4-E2B-it`.

## Special tokens

Gemma 4 wraps each structural element in a paired token. Note the **asymmetric pipe placement** — an opener carries the pipe on the left (`<|x>`) and its closer carries it on the right (`<x|>`):

| Open | Close | Purpose |
|---|---|---|
| `<bos>` | — | Beginning of sequence |
| `<\|turn>` | `<turn\|>` | One conversation turn; the role name is the first line of the body |
| `<\|tool_call>` | `<tool_call\|>` | One tool **call** emitted by the model |
| `<\|tool_response>` | `<tool_response\|>` | One tool **result** fed back to the model |
| `<\|channel>` | `<channel\|>` | Reasoning channel; `<\|channel>thought` opens the model's chain-of-thought (closed by `<channel\|>`) before the visible reply |
| `<\|"\|>` | `<\|"\|>` | String-literal delimiter (same token on both ends) |
| `<eos>` | — | End of sequence |

Because the string delimiter is a token (`<|"|>`), values may contain raw ASCII quotes and commas without escaping — only a literal `<|"|>` token sequence cannot appear inside a string.

Thinking variants emit reasoning in a dedicated channel — `<|channel>thought\n…<channel|>` at the start of the model turn, before any reply text or tool call. The `gemma` scanner routes that channel to thinking events (keeping it out of the visible reply) and still parses tool calls that follow it; `renderThinking` round-trips a thought back to the same `<|channel>thought\n…<channel|>` block. With `parseThinking: false` the channel is left in the visible text instead.

## Roles / turn structure

Each turn is `<|turn>{role}\n{body}<turn|>`, and turns are concatenated with no separator between them. Roles are `system`, `user`, `model` (a `developer` message renders as `system`). With a generation prompt the stream ends at `<|turn>model\n` and the model continues. Tool calls and the tool responses that follow them are emitted inside one `model` turn — the response block immediately follows the call block in the re-rendered history.

## Tool definitions

The owned `gemma` prompt **does** carry each tool's normalized wire schema. `renderInbandToolPrompt` serializes one compact OpenAI-style object per line inside `<tools></tools>`, followed by the Gemma format guide:

```text
<tools>
{"type":"function","function":{"name":"get_current_temperature","description":"Gets the current temperature for a given location.","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city name, e.g. San Francisco"}},"required":["location"]}}}
</tools>
```

`renderToolInventory` is a separate verbose inventory used by the system prompt and `/dump`. It emits one `## functions` TypeScript `namespace functions { … }` block. Tool descriptions are `//` comments above `type NAME = (_: PARAMS);` declarations; configured examples appear as JSDoc-style `// @example` entries whose calls use Python keyword-argument syntax. It does not emit per-tool Markdown sections or native Gemma `<|tool_call>` examples.

## Tool-call format

The model emits one call per `<|tool_call>…<tool_call|>` block. The body is `call:NAME{ARGS}`, where `ARGS` is a comma-separated list of `key:value` pairs:

```text
<|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|>
```

Value grammar inside `{…}`:

| Value kind | Encoding | Example |
|---|---|---|
| string | `<\|"\|>text<\|"\|>` | `location:<\|"\|>London<\|"\|>` |
| int / float | bare | `count:42` |
| bool | bare | `flag:true` |
| null | bare | `unit:null` |
| list | `[v,v,…]` | `tags:[<\|"\|>a<\|"\|>,<\|"\|>b<\|"\|>]` |
| nested object | `{k:v,…}` | `config:{theme:<\|"\|>dark<\|"\|>}` |

The OMP parser is the streaming `GemmaInbandScanner` (`packages/ai/src/dialect/gemma.ts`), not a flat regex. For each `<|tool_call>` block it:

1. finds the matching `<tool_call|>` close, skipping any `<|"|>…<|"|>` string span so a `<tool_call|>` sequence that appears inside a string value does not end the block early;
2. matches the `call:NAME{` head, then takes the brace body up to its depth-matched `}`;
3. splits that body into `key:value` pairs at top-level commas — bracket depth (`[]`, `{}`) and `<|"|>` string spans are skipped — and decodes each value per the grammar above, so nested lists and objects parse correctly (a single-level regex would not).
Calls are emitted only after the complete close marker arrives; there are no partial-argument events. If the stream is flushed with an unterminated tool block, OMP drops that incomplete block. A syntactically closed block with a missing final argument brace is still parsed from the available body.

## Multiple / parallel tool calls

Parallel calls are consecutive `<|tool_call>…<tool_call|>` blocks (one call each), returned in order. The application returns one `<|tool_response>` per call in the same order.

## Tool-result format

Each result is `<|tool_response>response:NAME{output:VALUE}<tool_response|>`. `renderToolResults` always wraps the result under a single `output` key, and `JSON.parse`s the tool's text first — so JSON output becomes a nested object/array in the brace syntax, while a plain string is wrapped in `<|"|>…<|"|>`:

```text
<|tool_response>response:get_current_weather{output:{temperature:15,weather:<|"|>sunny<|"|>}}<tool_response|>
<|tool_response>response:read{output:<|"|>FILE<|"|>}<tool_response|>
```

The Gemma wire form has no dedicated success/error field. OMP renders `isError` results in the same `response:NAME{output:…}` shape as successful results, so any failure indication must be present in the result text itself.

## End-to-end example

`renderTranscript` output for a weather query. The system turn also carries the `<tools>` catalog and format guide (see *Tool definitions*, abbreviated here); the model's call merges with its tool response into one `model` turn (response right after the call), and the final answer is the next `model` turn. Turns are emitted back-to-back with no separator — only the `\n` after each role is literal:

```text
<bos><|turn>system
You are a helpful assistant.<turn|><|turn>user
Hey, what's the weather in Tokyo right now?<turn|><|turn>model
<|tool_call>call:get_current_weather{location:<|"|>Tokyo, JP<|"|>}<tool_call|><|tool_response>response:get_current_weather{output:{temperature:15,weather:<|"|>sunny<|"|>}}<tool_response|><turn|><|turn>model
The current weather in Tokyo is 15 degrees Celsius and sunny.<turn|>
```

## Parsing notes & gotchas

- **String delimiter is a token, not a quote.** Inside `<|"|>…<|"|>` the bytes `"` and `,` are literal data — the example `<|"|>The city and state, e.g. "San Francisco, CA"…<|"|>` contains both. Split arguments on `,`/`}` only **outside** a `<|"|>…<|"|>` span.
- **Asymmetric pipes.** The closer is `<tool_call|>`, not `</tool_call>` or `<|tool_call>`. Matching the wrong pipe side will never close the block.
- **One call per block.** Unlike a JSON `tool_calls[]` array, parallelism is "more blocks", not "more entries in one block".
- **Bare scalars.** A value not wrapped in `<|"|>` is `true`/`false` → bool, `null`/`none` → null, numeric → number, otherwise a bare string (e.g. an unquoted enum or type name like `STRING`).
- **Tool-call ids are synthesized.** The format carries no id; after receiving a complete closed block, OMP parses it and emits adjacent `toolStart`/`toolEnd` events with a newly minted id. Rendered responses are correlated by surrounding message order/name.
- **Not Gemma 3 / hosted Gemini.** Those use the Pythonic `tool_code` / `default_api` form in `gemini.md`. Gemma 4 replaced it with this token syntax; the two are not interchangeable.
- **Gemma 3 automatic-selection caveat.** OMP's current family affinity maps Gemma 3 and Gemma 4 model IDs to `gemma`. If a Gemma 3 model is marked `supportsTools: false`, `tools.format=auto` therefore chooses this Gemma 4 grammar even though Gemma 3 requires the Pythonic convention in `gemini.md`; set `tools.format=gemini` explicitly.

## Sources

- OMP `gemma` dialect implementation: `packages/ai/src/dialect/gemma.ts` (scanner + renderers), `packages/ai/src/dialect/catalog.ts` + `packages/ai/src/dialect/prompt-template.md` (tool catalog), `packages/ai/src/dialect/gemma.md` (format guide).
- Function calling with Gemma 4: https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
- Gemma 4 prompt formatting: https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
