# MiniMax owned tool-calling format (`<minimax:tool_call>`)

OMP's `minimax` dialect is the prompt-driven, in-band tool protocol for MiniMax-family models. Calls are ordinary assistant text: one `<minimax:tool_call>` envelope contains one or more `<invoke>` elements. OMP executes the parsed calls and returns a `<function_results>` block in the next user turn. The format carries no tool-call ids, so calls and results are correlated by order.

This reference describes OMP's implemented converter, not MiniMax's provider-native structured tool API. It is verified against `packages/ai/src/dialect/minimax.ts`, the shared XML scanner in `packages/ai/src/dialect/anthropic.ts`, prompt assembly in `packages/ai/src/dialect/catalog.ts`, and the streaming projection in `packages/ai/src/dialect/owned-stream.ts`.

## Selection and request conversion

Set the format explicitly in `~/.omp/agent/config.yml` or a project/overlay config:

```yaml
tools:
  format: minimax
```

`tools.format: minimax` forces this owned dialect for the session. In `auto` mode, OMP keeps provider-native tool calling unless the selected model explicitly has `supportsTools: false`; for a MiniMax-family model id, that fallback resolves to `minimax`. See [`tools.format`](../settings.md#tools-and-approvals).

When an owned dialect is active, OMP:

1. removes the native structured `tools` field from the provider request;
2. appends an in-band tool catalog and the MiniMax format guide to the system prompt;
3. rewrites prior structured assistant calls and tool-result messages into this text protocol; and
4. scans the model's text stream back into structured tool-call events.

## Tool definitions and prompt injection

The injected prompt begins with `# Tools`, says calls are text rather than native provider tool messages, and lists the available functions inside `<tools></tools>`. Each line is a compact OpenAI-style function object containing the normalized wire schema:

```text
<tools>
{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"count":{"type":"number"}},"required":["path"]}}}
</tools>
```

The catalog is followed by the MiniMax-specific guide from `packages/ai/src/dialect/minimax.md`. Its contract requires a listed function name, literal string/scalar bodies, JSON lists/objects, one envelope for a batch, and no model-authored result blocks.

## Tool-call envelope

A single call is:

```text
<minimax:tool_call>
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
</minimax:tool_call>
```

Exact structure:

| Element | Meaning |
| --- | --- |
| `<minimax:tool_call>…</minimax:tool_call>` | Required model-output envelope in the prompt contract. |
| `<invoke name="TOOL">…</invoke>` | One call. `name` must be a listed tool. |
| `<parameter name="ARG">VALUE</parameter>` | One named argument. Arguments occur directly inside the invoke. |

The renderer XML-escapes tool and argument names in attributes. Parameter bodies are deliberately **not** XML-escaped: this protocol is delimiter-matched rather than parsed as XML. For example, a string body is `a & b < c`, not `a &amp; b &lt; c`. A literal `</parameter>` is the one reserved sequence because it closes that argument.

The scanner is more tolerant than the prompt contract. It accepts the namespaced wrapper above, an unprefixed `<tool_call>` wrapper, or a bare `<invoke>` outside a wrapper. Models should still emit the canonical `<minimax:tool_call>` form so behavior does not depend on recovery paths.

## Argument encoding and coercion

Encoding uses the selected tool's schema:

| Declared/value kind | Rendered parameter body | Parsed value |
| --- | --- | --- |
| Schema-declared string whose runtime value is a string | Verbatim text, including leading/trailing spaces and newlines | Verbatim string |
| Number, boolean, `null`, array, or object | JSON | Parsed JSON value |
| Value without a matching string schema | JSON, including quotes around a string | Parsed JSON when valid |

Example:

```text
<invoke name="write"><parameter name="path">notes/a & b.txt</parameter><parameter name="options">{"append":false,"tags":["x","y"]}</parameter></invoke>
```

The scanner resolves string arguments from the supplied tool schemas. A parameter attribute can override that decision:

- `string="true"` (and any value except `false`, `0`, or `no`) forces verbatim string handling.
- `string="false"`, `string="0"`, or `string="no"` forces JSON parsing even for a schema-declared string.

For a non-string parameter, surrounding whitespace is trimmed only for the JSON parse. OMP uses its repair-capable JSON parser; if parsing still fails, the original body is retained as a string rather than dropping the argument. Empty bodies also remain empty strings. A parameter with no usable `name` is ignored.

## Multiple and parallel calls

Parallel calls are sibling `<invoke>` elements inside one envelope, in emitted order:

```text
<minimax:tool_call>
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
</minimax:tool_call>
```

The scanner mints an internal id for each invoke because the wire format has no id. OMP can dispatch the resulting calls as a batch. Tool results must be returned in the same order; the result protocol has no call id with which to repair reordering.

## Tool-result envelope

OMP batches consecutive tool results into one `<function_results>` block. Success and failure use different records:

```text
<function_results>
<result>
<tool_name>read</tool_name>
<stdout>file contents</stdout>
</result>
<error>
<tool_name>read</tool_name>
<stderr>ENOENT: file not found</stderr>
</error>
</function_results>
```

For every result:

- success is `<result>` with `<stdout>`;
- `isError: true` is `<error>` with `<stderr>`;
- `<tool_name>` is XML-text escaped;
- stdout/stderr is inserted verbatim; and
- there is no call id, so the model reads records in call order.

OMP places this text in a synthesized `user` message. Text blocks from one tool result are concatenated; image result blocks remain image blocks after the rendered text. The model must never emit `<function_results>` or `<tool_response>` itself.

## Thinking and visible text

OMP renders a preserved reasoning block as:

```text
<thinking>
reasoning text
</thinking>
```

In the normal owned-tool stream, thinking parsing is enabled. The MiniMax scanner recognizes `<thinking>`, `<think>`, and `<scratchpad>` (including the supported prefixed forms), emits separate thinking events, and keeps the content out of visible assistant text. If `parseThinking` is disabled for a direct scanner consumer, those tags remain visible text. An unterminated thinking block is closed logically on stream flush and its accumulated content is retained.

Visible prose may precede the tool envelope. Text outside calls remains assistant text; non-call text inside the wrapper is discarded by the scanner.

## Streaming, malformed output, and recovery

The scanner is incremental and chunk-boundary safe: opening/closing tags and parameter bodies may arrive in separate provider deltas. Its observable lifecycle is:

1. a non-empty `<invoke name="…">` emits `toolStart` immediately;
2. each named parameter body emits keyed `toolArgDelta` events as text chunks arrive; and
3. the matching `</invoke>` performs final coercion and emits `toolEnd` with the complete arguments and exact raw invoke block.

Important failure behavior:

- **Missing call name:** no tool lifecycle is emitted for that invoke.
- **Missing parameter name:** that parameter is ignored.
- **Malformed JSON:** falls back to the original parameter text.
- **Very large parameter:** input is capped at 1,000,000 JavaScript string code units; overflow is replaced by the accepted prefix plus an explicit truncation marker.
- **Incomplete invoke:** flush resets scanner-local call state and emits no `toolEnd`. However, OMP's stream projector has already materialized a call from `toolStart`; on a normally stopped response it retains that partial call, marks the turn as tool use, and may dispatch it. Already streamed argument text remains uncoerced, and a call with no argument text has `{}`. A provider `length` stop remains `length` rather than becoming runnable tool use.
- **Incomplete wrapper after complete invokes:** already closed invokes remain valid; the wrapper close is not required to emit their `toolEnd` events.
- **Incomplete thinking:** retained as thinking and logically ended at flush.

OMP also guards against a model fabricating tool output after its call. For this dialect, the first `<function_results>` or `<tool_response>` boundary stops projection. With the default `tools.abortOnFabricatedResult: true`, generation is aborted immediately; when disabled, OMP drains the provider stream but discards the fabricated continuation.

## End-to-end example

Injected tool definition (abbreviated to the relevant catalog line):

```text
<tools>
{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"},"units":{"type":"string"}},"required":["city"]}}}
</tools>
```

Assistant call:

```text
I'll check both cities.
<minimax:tool_call>
<invoke name="get_weather"><parameter name="city">Tokyo</parameter><parameter name="units">celsius</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter><parameter name="units">celsius</parameter></invoke>
</minimax:tool_call>
```

Next user turn produced by OMP:

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>{"temperature":28,"condition":"clear"}</stdout>
</result>
<result>
<tool_name>get_weather</tool_name>
<stdout>{"temperature":14,"condition":"rain"}</stdout>
</result>
</function_results>
```

The assistant can then answer normally or emit another complete MiniMax call envelope.

## Parsing notes and gotchas

- **Not real XML.** Do not entity-escape parameter bodies or run them through an XML DOM parser; matching is based on protocol delimiters.
- **One envelope, many invokes.** Parallelism is sibling calls inside `<minimax:tool_call>`, not JSON `tool_calls` and not one envelope per required batch.
- **Schema determines strings.** Without the tool schema, even a JavaScript string renderer value is JSON-quoted; supply tool definitions to renderer/scanner APIs for round trips.
- **No ids on the wire.** OMP-generated ids are internal. Preserve call/result order.
- **Errors are first-class records.** Use `<error>/<stderr>`, not a successful `<result>` containing an out-of-band error flag.
- **Canonical wrapper vs accepted recovery syntax.** The parser accepts bare invokes and `<tool_call>`, but the injected contract requires `<minimax:tool_call>`.
- **Complete the invoke before stopping.** A natural-language promise to call a tool is not a call; the closing `</invoke>` is what finalizes coercion and the normal lifecycle.

## Sources

- `packages/ai/src/dialect/minimax.md` — injected MiniMax format guide.
- `packages/ai/src/dialect/minimax.ts` — call, result, thinking, and transcript renderers plus scanner configuration.
- `packages/ai/src/dialect/anthropic.ts` — shared incremental invoke/parameter scanner and coercion behavior.
- `packages/ai/src/dialect/catalog.ts` and `prompt-template.md` — tool catalog and system-prompt injection.
- `packages/ai/src/dialect/history.ts` and `owned-stream.ts` — history conversion, streamed projection, incomplete-call behavior, and fabricated-result boundary.
- `packages/catalog/src/identity/dialect.ts` and `packages/coding-agent/src/sdk.ts` — MiniMax family affinity and `tools.format` resolution.
- `packages/ai/test/inband-tools.test.ts` — prompt rendering, call round trips, chunked argument deltas, raw blocks, MiniMax wrapper recovery, and result rendering.
