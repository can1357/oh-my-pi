# Generic XML owned tool-calling format (`<invoke>` / `<tool_response>`)

OMP's `xml` dialect is a generic, prompt-driven in-band protocol. The model writes one `<invoke>` element per tool call directly in assistant text; OMP parses those calls and returns one ordered `<tool_response>` block per result in the next user turn. Neither side carries tool-call ids, and result blocks do not carry tool names, so ordering is the correlation mechanism.

This reference describes the converter implemented by `packages/ai/src/dialect/xml.ts`. The ordinary `tools.format: xml` path uses the shared Anthropic-style invoke scanner. The exported scanner API can instead select DeepSeek's pipe-wrapped DSML tagset; that scanner-only option is documented separately below.

## Selection and request conversion

Select the dialect in `~/.omp/agent/config.yml`, project config, or an overlay:

```yaml
tools:
  format: xml
```

`tools.format: xml` forces the generic XML owned dialect for the session. `auto` does **not** choose generic XML as its unknown-family fallback: when a model has `supportsTools: false`, the resolver chooses the known model-family dialect or GLM if there is no specific affinity. Use `xml` explicitly when this grammar is required. See [`tools.format`](../settings.md#tools-and-approvals).

When selected, OMP removes native structured tools from the provider request, appends the in-band tool catalog and XML guide to the system prompt, converts prior structured calls/results to text, and scans assistant text back into structured tool-call events.

## Tool definitions and prompt injection

OMP injects the shared `# Tools` prompt. Available functions appear inside `<tools></tools>` as one compact OpenAI-style function object per line, using each tool's normalized wire schema:

```text
<tools>
{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"count":{"type":"number"}},"required":["path"]}}}
</tools>
```

The XML-specific guide from `packages/ai/src/dialect/xml.md` follows the catalog. It requires listed function names, literal string bodies, JSON non-string values, ordered results, and complete calls before the model stops. Calls are text, never native `tool_calls` JSON.

## Canonical call format

One call is one invoke:

```text
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
```

| Element | Meaning |
| --- | --- |
| `<invoke name="TOOL">…</invoke>` | One tool call. The prompt contract requires a listed tool name. |
| `<parameter name="ARG">VALUE</parameter>` | One named argument. |
| `<tool_calls>…</tool_calls>` | Optional model-emitted wrapper accepted by the guide/scanner; OMP's renderer does not add it. |

`renderAssistantToolCalls` emits consecutive invokes separated by newlines, with no outer wrapper. The default scanner also accepts `<function_calls>` as a wrapper alias, `antml:`-prefixed variants of the Anthropic tags, and a bare invoke. Its accepted input is deliberately wider than the canonical renderer output.

Tool and parameter names are XML-escaped when OMP renders attributes. Parameter bodies are not XML-escaped because the format is delimiter-matched, not parsed by an XML DOM. Write `a & b < c`, not `a &amp; b &lt; c`; only a literal `</parameter>` conflicts with the body's close delimiter.

## Argument encoding and coercion

The renderer uses the supplied tool schema to decide whether a value is a literal string:

| Declared/value kind | Rendered body | Default scanner result |
| --- | --- | --- |
| Schema-declared string whose runtime value is a string | Verbatim, whitespace preserved | Verbatim string |
| Number, boolean, `null`, array, or object | JSON | Parsed JSON value |
| Runtime string not identified as a string argument | JSON string, including quotes | Parsed string |

Example:

```text
<invoke name="write"><parameter name="path">notes/a & b.txt</parameter><parameter name="options">{"append":false,"tags":["draft","xml"]}</parameter></invoke>
```

The default scanner accepts a `string` override on each parameter:

- `string="true"` (or any value other than `false`, `0`, or `no`) forces the raw body to remain a string.
- `string="false"`, `string="0"`, or `string="no"` forces JSON parsing even when the schema declares a string.

Non-string bodies are trimmed for parsing and passed through OMP's repair-capable JSON parser. If repair fails, the original body is retained as a string. Empty bodies remain empty strings. A parameter without a usable name is discarded.

## Multiple and parallel calls

OMP renders a batch as consecutive invokes:

```text
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
```

The model may optionally wrap the batch:

```text
<tool_calls>
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
</tool_calls>
```

The scanner mints one internal call id per invoke; there is no id in the XML. OMP can dispatch the calls as a batch. Results must preserve call order because `<tool_response>` has neither id nor name.

## Tool-result format

OMP returns each result in its own block:

```text
<tool_response>
file contents
</tool_response>
<tool_response>
ENOENT: file not found
</tool_response>
```

Consecutive result blocks are newline-separated and placed in one synthesized `user` message. Result text is inserted verbatim. Image blocks from tool results are retained after the rendered text in that message.

The generic XML protocol has **no success/error marker**. `renderToolResults` intentionally renders `isError: true` in the same `<tool_response>` shape as success; the error must be intelligible from its text. The model must never generate `<tool_response>` itself.

## Thinking and visible text

OMP renders preserved thinking as:

```text
<thinking>
reasoning text
</thinking>
```

For the normal owned-tool stream, `parseThinking` is enabled. With the default Anthropic tagset, `<thinking>`, `<think>`, and `<scratchpad>` (including supported prefixed forms) become separate thinking events and do not appear in visible text. A direct scanner consumer that leaves `parseThinking` false sees those tags as text. An unterminated thinking block is logically closed on flush and retains its content.

Visible prose may appear before or between unwrapped invokes. Inside a recognized `<tool_calls>` or `<function_calls>` wrapper, non-call text is discarded.

## Scanner tagsets

`XmlInbandScanner` delegates to one of two scanners according to `InbandScannerOptions.xmlTagset`:

| `xmlTagset` | Scanner | Accepted call grammar | Argument rule |
| --- | --- | --- | --- |
| omitted or `anthropic` | `AnthropicInbandScanner` | Plain/`antml:` `<invoke>/<parameter>`, optionally inside `<tool_calls>` or `<function_calls>` | Tool schema determines strings; `string` attribute can override |
| `dsml` | `DeepSeekInbandScanner` | Pipe-wrapped DSML envelope and invokes (plus that scanner's DeepSeek token grammar) | Parameters default to strings; only `string="false"` requests JSON coercion |

A direct API consumer can request DSML parsing:

```ts
import { createInbandScanner } from "@oh-my-pi/pi-ai/dialect";

const scanner = createInbandScanner("xml", {
  xmlTagset: "dsml",
  parseThinking: true,
});
```

DSML accepts fullwidth-pipe tags:

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="read">
<｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>
<｜DSML｜parameter name="count" string="false">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

It also accepts ASCII-pipe equivalents such as `<|DSML|tool_calls>`. In DSML mode, `string="false"` parses repaired JSON; invalid JSON falls back to the raw string. DSML thinking uses `<think>…</think>` and is parsed by default unless `parseThinking: false`.

`xmlTagset` changes **only scanner selection**. The `xml` definition's call, result, thinking, and transcript renderers always emit the generic plain-XML forms described above. The normal `tools.format: xml` owned-stream path does not pass `xmlTagset`, so it uses the Anthropic tagset. OMP currently uses the DSML selector for stream-markup healing of leaked DSML output, not to change the `tools.format: xml` renderer.

## Streaming, malformed output, and recovery

### Default Anthropic tagset

Parsing is incremental and safe across provider chunk boundaries. For every non-empty `<invoke name="…">`, the scanner:

1. emits `toolStart` as soon as the opening invoke tag is complete;
2. emits keyed `toolArgDelta` events while parameter bodies stream; and
3. performs final coercion and emits `toolEnd` only after the matching `</invoke>`.

The completed event includes the exact raw invoke block for diagnostics. Wrapper text is not part of that raw block.

Failure behavior is explicit:

- an invoke with a missing/blank name emits no tool lifecycle;
- a parameter with a missing/blank name is ignored;
- malformed JSON falls back to the original text;
- parameter content is capped at 1,000,000 JavaScript string code units, with an explicit truncation marker appended on overflow;
- an incomplete parameter or invoke emits no `toolEnd` when flushed; and
- complete invokes remain valid even when the outer wrapper never closes.

OMP's stream projector creates a canonical call at `toolStart`, before `toolEnd`. Therefore, on a normally stopped provider response, an unterminated invoke can remain as a partial runnable call: streamed argument text stays uncoerced, or arguments are `{}` if none arrived. A provider `length` stop remains non-runnable `length`. This behavior applies to the ordinary owned `xml` path and is important when diagnosing model output that stops mid-tag.

### DSML tagset

The DSML scanner also streams each parameter as keyed deltas and emits `toolEnd` only at `</｜DSML｜invoke>` or its ASCII equivalent. An incomplete DSML parameter resets the partial call on flush without a completed event. Because `xmlTagset: dsml` is a direct scanner option rather than the normal owned-renderer path, callers consuming those events own the handling of an unmatched `toolStart`.

### Fabricated results

For the generic XML dialect, the first model-authored `<tool_response>` is treated as a fabricated-result boundary. OMP preserves calls/text before it and stops projection there. The default `tools.abortOnFabricatedResult: true` aborts provider generation; disabling the setting drains but discards the fabricated continuation.

## End-to-end example

Injected catalog line:

```text
<tools>
{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"number"}},"required":["city"]}}}
</tools>
```

Assistant call batch:

```text
I'll compare both cities.
<invoke name="get_weather"><parameter name="city">Tokyo</parameter><parameter name="days">2</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter><parameter name="days">2</parameter></invoke>
```

Next user turn produced by OMP:

```text
<tool_response>
{"forecast":["clear","rain"]}
</tool_response>
<tool_response>
{"forecast":["rain","cloudy"]}
</tool_response>
```

The assistant then answers normally or emits another sequence of invokes.

## Parsing notes and gotchas

- **Not real XML.** Parameter bodies are delimiter-matched and intentionally unescaped. An XML parser/entity decoder changes their values.
- **Renderer and scanner acceptance differ.** OMP renders bare consecutive invokes; the default scanner additionally accepts two wrappers and `antml:` variants.
- **No call ids or result names.** Preserve call/result order across a parallel batch.
- **Errors are text only.** Generic `<tool_response>` does not encode `isError`.
- **Schema context matters.** Supply tools to renderer/scanner APIs so schema-declared strings remain literal rather than JSON-quoted/coerced.
- **`xmlTagset` is scanner-only.** Selecting DSML does not make the XML renderer emit DSML.
- **A close tag finalizes the call.** `toolStart` and argument deltas stream early, but only `</invoke>` produces the final coerced argument object and `toolEnd`.

## Sources

- `packages/ai/src/dialect/xml.md` — injected generic XML format guide.
- `packages/ai/src/dialect/xml.ts` — renderer definitions and Anthropic/DSML scanner selection.
- `packages/ai/src/dialect/anthropic.ts` — default incremental invoke/parameter scanner, coercion, thinking, and incomplete-call behavior.
- `packages/ai/src/dialect/deepseek.ts` — DSML envelope scanner and `string="false"` coercion.
- `packages/ai/src/dialect/catalog.ts` and `prompt-template.md` — tool catalog and system-prompt injection.
- `packages/ai/src/dialect/rendering.ts`, `history.ts`, and `owned-stream.ts` — result rendering, history conversion, projection, and fabricated-result handling.
- `packages/ai/src/utils/stream-markup-healing.ts` — current DSML scanner integration.
- `packages/coding-agent/src/sdk.ts` — `tools.format` resolution.
- `packages/ai/test/inband-tools.test.ts` and `dialect-thinking.test.ts` — round trips, chunked argument deltas, raw blocks, result rendering, and thinking behavior.
