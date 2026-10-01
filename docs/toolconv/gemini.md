# Gemini Pythonic tool-calling format (`tool_code` / `default_api`)

Pythonic text convention handled by OMP's **`gemini` owned dialect**, used for prompt-driven **Gemma 3** tool calling and seen in malformed hosted **Gemini** output. Calls are Python-like expressions such as `default_api.<function_name>(<kwargs>)`, optionally wrapped in `print(...)`, inside a fenced ```` ```tool_code ```` block; results return in ```` ```tool_outputs ```` blocks. This is not the hosted Gemini native API protocol, which uses structured `functionCall` / `functionResponse` parts.

The OMP behavior below follows `packages/ai/src/dialect/gemini.ts`, the shared rendering helpers, and the owned history/stream converters. The external guides and malformed-call reports listed under *Sources* provide background on the text convention.

## "Special" tokens

OMP matches these markers as literal decoded text; its scanner does not inspect tokenizer IDs. The surrounding model chat template may have its own control tokens. The payload markers are:

| Marker (verbatim) | Role |
|---|---|
| ` ```tool_code ` | Opens a fenced block of Python-like calls for the app to parse, not execute as Python. Closed by ` ``` `. |
| ` ```tool_outputs ` | Opens a fenced block carrying the executed results back to the model. Closed by a bare ` ``` `. |
| `default_api` | Synthetic module namespace the hosted stack bundles un-namespaced tools into. Calls read `default_api.<name>(...)`. |
| `print(...)` | Conventional wrapper around the call in the hosted-Gemini form (the model is trained to "print" the call). Semantically irrelevant — the runtime parses the call, it does not execute Python. |

There is **no** per-call id in this text convention. Native Gemini thought summaries use parts marked `thought: true`; a `thoughtSignature` is opaque replay metadata and does not itself identify a thinking part.

> **OMP dialect note:** the `gemini` dialect adds a fenced ` ```thinking ` block for in-band reasoning. Its opener requires a newline, and parsing is enabled unless `parseThinking: false`. The thinking close-matcher preserves nested language-tagged Markdown fences; a bare nested backtick fence is indistinguishable from the outer closer. Unterminated thinking is ended on flush. This is an OMP convention, not the native Gemini API format.

## Roles / turn structure

The Pythonic payload is independent of the envelope, and the envelope differs by deployment:

- **Hosted Gemini** uses `contents[]` (`role: "user" | "model"`). Native tools are structured parts; when this text convention is used instead, its blocks live in turn text.
- **Gemma 3** (open weights) uses the Gemma chat template (`<start_of_turn>user … <end_of_turn>` / `<start_of_turn>model`); the tool prompt is prepended to the first user turn and the blocks live inside model/user turns.

This document specifies the **payload** (the two fenced blocks + the Python call form); the surrounding turn tokens belong to whichever template hosts it.

## Tool definitions

Tools are advertised in the prompt as a JSON-Schema catalog. Gemma 3's official guide ships **two** interchangeable system-prompt templates that differ only in how the model is told to answer:

1. **Pythonic** (the one this spec targets):
   > You have access to functions. If you decide to invoke any of the function(s), you MUST put it in the format of `[func_name1(params_name1=params_value1, params_name2=params_value2...), func_name2(params)]`
   > You SHOULD NOT include any other text in the response if you call a function

2. **JSON** (the sibling convention — see `qwen3.md` for the closely related Hermes shape):
   > … you MUST put it in the format of `{"name": function name, "parameters": dictionary of argument name and its value}`

OMP's owned prompt advertises tools as one compact OpenAI-style JSON object per line inside `<tools>` (`{"type":"function","function":{name,description,parameters}}`), using each tool's normalized wire schema, followed by the Gemini format guide. Native Gemini requests instead use `functionDeclarations`. OMP's text renderer emits `default_api.NAME(...)` without `print`; its scanner also accepts the wrapped and bare variants below.

## Tool-call format

One call is a Python call expression. Hosted Gemini commonly emits a `print()` of a `default_api` method:

````text
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```
````

All of the following are accepted equivalents seen in the wild and across Gemma/Gemini variants; a robust parser normalizes them to `{name, arguments}`:

- `print(default_api.NAME(KWARGS))` — the wrapped form seen in hosted Gemini reports.
- `default_api.NAME(KWARGS)` — `print`/namespace are optional sugar.
- `NAME(KWARGS)` — bare call (Gemma 3 Pythonic prompt).
- `result = NAME(KWARGS)` — assignment form (Gemma 3 docs use `result = convert(...)`).

Argument values are **Python literals**, not JSON:

| Python literal | Example | Decoded |
|---|---|---|
| string | `'London'` or `"London"` | `"London"` |
| int / float | `42`, `3.14` | `42`, `3.14` |
| bool | `True` / `False` | `true` / `false` |
| null | `None` | `null` |
| list | `["a", "b"]` | `["a","b"]` |
| dict | `{"k": 1}` | `{"k":1}` |

Strings use Python escaping (`\n`, `\t`, `\\`, `\'`, `\"`); hosted Gemini emits single quotes (`location='London'`), Gemma examples use double quotes — both are valid. Arguments are keyword form (`name=value`); positional arguments are not used because the runtime maps to a named schema.

## Multiple / parallel tool calls

Two encodings occur inside a single `tool_code` block:

- **OMP / Gemma 3 Pythonic form** — a Python **list** of call expressions. OMP renders this form for two or more calls:
  ````text
  ```tool_code
  [default_api.get_current_temperature(location="London"), default_api.get_temperature_date(location="London", date="2024-10-01")]
  ```
  ````
- **Hosted Gemini variant** — one `print(default_api...)` **statement per line**:
  ````text
  ```tool_code
  print(default_api.get_current_temperature(location="London"))
  print(default_api.get_temperature_date(location="London", date="2024-10-01"))
  ```
  ````

The OMP scanner extracts calls in source order from either form, skipping strings and Python comments. It records the final identifier before each matching call parenthesis, ignores the `print` wrapper, and skips over a recovered call's argument body. It does not evaluate Python expressions. Each parsed call gets a synthesized `ptc_…` id; the text convention itself has no id.

## Tool-result format

Executed results are returned to the model in ```` ```tool_outputs ```` blocks. OMP renders one complete block per result, in call order; it does not encode `isError` separately. Gemma 3 docs also show assignment-style values (`result = 92.3`), while opaque output can be returned as text/JSON:

````text
```tool_outputs
{"temperature": 26.1, "location": "London", "unit": "celsius"}
```
````

The model then continues with either a natural-language answer or another `tool_code` block.

## End-to-end example

````text
<user>
What's the temperature in London?

<model>
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```

<user>
```tool_outputs
{"temperature": 11.4, "location": "London", "unit": "celsius"}
```

<model>
It's currently 11.4°C in London.
````

## OpenAI-compatible / native API mapping

- Hosted Gemini's native API returns structured `functionCall` parts (`{name, args, id?}`). OMP preserves a supplied unique id or synthesizes one, retains `thoughtSignature`, and echoes call/result ids only when the model's `compat.supportsFunctionPartId` permits them. `convertMessages` in `packages/ai/src/providers/google-shared.ts` uses the originating call's name for `functionResponse` and preserves valid same-model/provider signatures. Native result payloads use `{output: text}` or `{error: text}`, unlike the text dialect's untyped `tool_outputs` blocks.
- When parsed out of an OpenAI-compatible shim, each recovered call becomes `tool_calls[i] = {id (server-minted), type:"function", function:{name, arguments:<JSON string>}}` — the Python kwargs are re-serialized to a JSON string at that boundary.
- Feed results back as the deployment's tool/`functionResponse` turn (hosted) or a `tool_outputs` block in the next user turn (prompt-driven).

## Parsing notes & gotchas

- **Python-like literals, not a Python interpreter.** `True`/`False`/`None`, single-quoted strings, and trailing commas are accepted. OMP also accepts JSON `true`/`false`/`null`. Unsupported expressions remain raw strings rather than being evaluated.
- **Strip the wrapper.** Normalize away `print(...)`, a `default_api.` (or any `module.`) prefix, and an `LHS =` assignment before reading the call name. `print` is never a tool name.
- **Skip string contents when scanning.** A call like `search(pattern="foo(")` contains a `(` inside a string; a naive `\w+\(` scan mis-detects `foo` as a callee. Track string state and only treat top-level `(` as a call opener.
- **Fence ambiguity.** A `tool_code` body terminates at the first ` ``` ` substring, even inside an argument string or mid-line. This is separate from the fence-aware thinking close-matcher.
- **Text vs native calls.** Malformed hosted responses may expose the text convention. OMP's owned stream also forwards named native tool calls if a provider emits them despite native tools being absent; the first native/in-band call channel wins, preventing double dispatch.
- **OMP streaming behavior.** The scanner buffers the entire `tool_code` body and emits tool events only after the closing fence; it does not stream partial arguments. An unterminated block is discarded on flush rather than exposed as text. Positional arguments and malformed keyword segments are skipped. In addition to ordinary quoted strings, the literal decoder accepts Python raw/byte/unicode prefixes, triple quotes, octal escapes, and `\x`/`\u`/`\U` escapes.
- **Transcript rendering.** `renderTranscript` wraps history in `<bos>` and Gemma-style `<start_of_turn>user|model` turns. `developer` text is prepended to the next user turn, or emitted as its own user turn before an intervening assistant/result; consecutive results become one user turn. Thinking precedes visible text and calls. Currently even an assistant without calls gets an empty `tool_code` list (`[]`); the renderer does not append a generation prompt.
- **Owned request history.** `encodeInbandToolHistory` is separate from `renderTranscript`: assistant turns with calls become prose plus a fenced call block, dropping their thinking/image blocks; call-free assistant turns remain unchanged. Consecutive results become one synthetic user message, with result images retained after the text.
- **Fabricated results.** The owned stream discards assistant output from ` ```tool_outputs ` onward. `tools.abortOnFabricatedResult` defaults to `true` and aborts the provider there; disabling it drains the provider but still discards that continuation.
- **Variant divergence.** Gemma **4** uses the token-delimited brace syntax (`<|tool_call>call:NAME{…}<tool_call|>`) documented in [gemma.md](gemma.md), not this Pythonic text dialect.
- **Gemma 3 automatic-selection caveat.** OMP's current family affinity maps every recognized Gemma version—including Gemma 3—to the `gemma` dialect. Therefore, when a Gemma 3 model is marked `supportsTools: false` and falls back from native tools, `tools.format=auto` selects the incompatible Gemma 4 grammar. Set `tools.format=gemini` explicitly for the Pythonic Gemma 3 convention documented here.

## Selection

Set `tools.format` to `gemini` to force this owned dialect. The default `auto` uses native tools unless `supportsTools === false`, then selects the model-class dialect (unknown classes fall back to GLM). `preferredDialect` maps the Gemini class to `gemini` and the Gemma class to `gemma`, without a Gemma-version split. `PI_DIALECT=gemini` is a fallback when the agent's configured resolver returns no owned dialect; an explicit owned setting takes precedence.

With tools present, owned mode appends the catalog/guide to the system prompt, rewrites call/result history, and omits native tools and `tool_choice` from the provider request.

## Sources

- OMP implementation: `packages/ai/src/dialect/gemini.ts`, `fenced-thinking.ts`, `rendering.ts`, `catalog.ts`, `history.ts`, `owned-stream.ts`; selection: `packages/catalog/src/identity/dialect.ts`, `packages/coding-agent/src/sdk.ts` (`resolveDialect`), `packages/agent/src/agent-loop.ts` (`resolveOwnedDialectFromEnv`); native mapping: `packages/ai/src/providers/google-shared.ts`.
- Gemma 3 function calling (two recommended prompts): https://ai.google.dev/gemma/docs/capabilities/function-calling
- Simon Willison, "Function calling with Gemma": https://simonwillison.net/2025/Mar/26/function-calling-with-gemma/
- Philipp Schmid, "Google Gemma 3 Function Calling Example": https://www.philschmid.de/gemma-function-calling
- Gemini 3 thought signatures + functionCall ids: https://ai.google.dev/gemini-api/docs/gemini-3
- `default_api` / `tool_code` leak evidence: https://github.com/google/adk-go/issues/492 · https://github.com/google-gemini/cookbook/issues/929 · https://github.com/firebase/genkit/issues/2628 · https://discuss.ai.google.dev/t/gemini-2-flash-api-returns-raw-markdown-instead-of-function-call/71964
