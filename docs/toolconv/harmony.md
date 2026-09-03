# OpenAI Harmony response format

Harmony is the response format OpenAI trained its open-weight `gpt-oss` models on (`gpt-oss-20b`, `gpt-oss-120b`, released August 2025). It defines the conversation envelope, the multi-channel reasoning/answer separation, and the function-calling wire syntax. The models will not work correctly if prompted without it. The format deliberately mirrors the OpenAI *Responses* API (roles, channels, recipients) rather than the older Chat Completions shape.

Tokens are produced with the `o200k_harmony` encoding (the `o200k_base` BPE vocab plus a block of Harmony special tokens; see the table below). The reference renderer/parser is the Rust crate `openai-harmony` (Python bindings: `pip install openai-harmony`; encoding name `HarmonyEncodingName.HARMONY_GPT_OSS`).

You only deal with raw Harmony if you build your own inference loop. Served through an OpenAI-compatible endpoint the server handles it for you:

- **Ollama / LM Studio / HuggingFace**: Harmony is applied internally; you send normal OpenAI-style JSON.
- **vLLM**: `vllm serve openai/gpt-oss-120b --enable-auto-tool-choice --tool-call-parser openai --reasoning-parser openai_gptoss`. Note the tool-call parser flag is `openai` (not `harmony`). vLLM also exposes a Harmony-native path through the `/v1/responses` endpoint.
- **SGLang**: `python3 -m sglang.launch_server --model-path openai/gpt-oss-20b --reasoning-parser gpt-oss --tool-call-parser gpt-oss` (in NVIDIA Dynamo disaggregated mode: `--dyn-tool-call-parser harmony --dyn-reasoning-parser gpt_oss`).

The chat template shipped with the gpt-oss weights renders these same token sequences from the standard `messages`/`tools` arrays.

## Special tokens

All Harmony control tokens have the literal form `<|type|>` (ASCII pipes `|`, U+007C — no unicode variants). They are real single tokens in `o200k_harmony`, not text that is BPE-split. The structurally meaningful ones:

| Token (verbatim) | Token ID | Purpose |
| :--------------- | :------- | :------ |
| `<\|start\|>`     | `200006` | Begins a message; immediately followed by the header (role, optional recipient/channel/content-type). |
| `<\|end\|>`       | `200007` | Ends a fully-formed message. |
| `<\|message\|>`   | `200008` | Header → content transition. Everything after it (until a stop/end token) is the message body. |
| `<\|channel\|>`   | `200005` | Introduces the channel field of the header (`analysis` / `commentary` / `final`). |
| `<\|constrain\|>` | `200003` | Marks the content-type / constrained-decoding format in a tool-call header (e.g. `<\|constrain\|>json`). |
| `<\|return\|>`    | `200002` | Stop token: the model finished its final answer. Decode-time only (see normalization note). |
| `<\|call\|>`      | `200012` | Stop token: the model is emitting a tool call and wants it executed. |

`<|return|>` and `<|call|>` are the two valid generation stop tokens — halt inference on either.

The encoding also defines (same `o200k_harmony` block, IDs `199998`–`200013`) `<|startoftext|>` (199998), `<|endoftext|>` (199999), and reserved slots `<|reserved_200000|>`, `<|reserved_200001|>`, `<|reserved_200004|>`, `<|reserved_200009|>`–`<|reserved_200011|>`, `<|reserved_200013|>`, plus a bulk reserved range `<|reserved_200014|>`…`<|reserved_201088|>`. The renderer additionally knows the names `<|refusal|>`, `<|untrusted|>`, `<|end_untrusted|>`, `<|meta_end|>` but they are not part of the committed gpt-oss vocabulary and do not appear in normal traffic.

## Roles / channels / turn structure

**Message envelope.** Every message is:

```text
<|start|>{header}<|message|>{content}<|end|>
```

`{header}` always begins with the role and may carry an optional recipient (`to=...`), channel, and content-type. A completed message ends with `<|end|>`; an assistant message being generated ends instead with a stop token (`<|return|>` or `<|call|>`).

**Roles** (five). The instruction hierarchy used to resolve conflicts is `system` > `developer` > `user` > `assistant` > `tool`.

| Role | Purpose |
| :--- | :------ |
| `system` | Identity, knowledge cutoff / current date, reasoning effort, valid-channels declaration, built-in tools. NOT the user-facing "system prompt". |
| `developer` | The conventional "system prompt": instructions + the `# Tools` function declarations + (optional) structured-output schema. |
| `user` | End-user input. |
| `assistant` | Model output. Carries a channel and, for tool calls, a recipient. |
| `tool` | Output of an executed tool. The message's *author/role is the tool's own name* (e.g. `functions.get_current_weather`), not the literal word `tool`. |

**Channels** (assistant output only; the channel is mandatory on every assistant message):

| Channel | Purpose |
| :------ | :------ |
| `analysis` | Raw chain-of-thought (reasoning). Not held to the same safety bar as `final`; do not show to end users. Built-in `python`/`browser` calls usually go here. |
| `commentary` | Function tool calls, and user-visible "preambles" (action plans) before calling multiple tools. |
| `final` | The user-facing answer. |

**Reasoning effort** is set in the system message as `Reasoning: high` (or `medium` / `low`; default is medium). The model emits CoT into `analysis` and the answer into `final`.

**CoT carry-over rule.** On the next turn, drop prior `analysis` messages *if* the last assistant turn ended in a `final` message. The exception is an in-progress tool-calling turn: the `analysis` that preceded a tool call MUST be fed back in alongside the tool result so the model can continue its reasoning (the `openai-harmony` renderer does this via `RenderConversationConfig { auto_drop_analysis: true }`).

## Tool definitions

Function tools are advertised in the **developer** message under a `# Tools` section, inside a TypeScript-style `namespace functions { ... }`. (Built-in `browser`/`python` tools are instead declared in the **system** message under their own `# Tools` / `## browser` / `## python` headings.) The renderer converts each JSON Schema into a TS type with these rules:

- No-arg function → `type name = () => any;`
- With args → the single parameter is named `_` and its object type is inlined: `type name = (_: { ... }) => any;`
- Return type is always `any`.
- A property `description` becomes a `//` comment on the line *above* the field; a JSON Schema `title` renders as `// TITLE` followed by a `//` blank-comment line; `examples` render as `// Examples:` then `// - "value"` lines.
- Optional (non-`required`) fields get a trailing `?`. A `default` renders as a trailing `// default: <value>` comment; an `enum` becomes a `"a" | "b"` union; `oneOf` becomes a multi-line `|` union; JSON `integer` maps to TS `number`.
- One blank line separates function definitions; the block closes with `} // namespace functions`.

If the developer message has no instruction text, the `# Instructions` heading is omitted and the message is just the `# Tools` block. When any function is defined, the system message gains the routing line `Calls to these tools must go to the commentary channel: 'functions'.`

Verbatim developer-message example (instructions + two functions), exactly as the renderer emits it:

```text
<|start|>developer<|message|># Instructions

Use a friendly tone.

# Tools

## functions

namespace functions {

// Gets the location of the user.
type get_location = () => any;

// Gets the current weather in the provided location.
type get_current_weather = (_: {
// The city and state, e.g. San Francisco, CA
location: string,
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

// Gets the current weather in the provided list of locations.
type get_multiple_weathers = (_: {
// List of city and state, e.g. ["San Francisco, CA", "New York, NY"]
locations: string[],
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

} // namespace functions<|end|>
```

## Tool-call format

A function call is an **assistant** message on the **commentary** channel, addressed to the tool via recipient `to=functions.<name>`, with the JSON arguments as the body, terminated by the `<|call|>` stop token.

The recipient may appear in the *role section* or the *channel section* of the header — both are valid Harmony and the parser accepts either. The model commonly emits it in the channel section. The pi renderer omits the optional content-type marker:

```text
<|start|>assistant<|channel|>commentary to=functions.get_current_weather<|message|>{"location":"San Francisco, CA"}<|call|>
```

Some Harmony serializers include an explicit JSON content type and place the recipient in the role section instead:

```text
<|start|>assistant to=functions.get_current_weather<|channel|>commentary <|constrain|>json<|message|>{"location":"San Francisco, CA"}<|call|>
```

The arguments body is a raw JSON object. The optional `<|constrain|>json` content-type signals JSON (and is the hook for constrained/grammar-based decoding); the content-type may also be a bare word such as `code` (seen with built-in tools). Built-in tools differ only in channel and recipient: they typically render on `analysis`, with recipient `browser.search` / `browser.open` / `browser.find` or always `python`.

### OMP `harmony` dialect behavior

OMP emits the first form above: no `<|constrain|>` marker, recipient in the channel section, and compact JSON arguments. It synthesizes a call id on receipt because Harmony carries none. The stateful scanner accepts the recipient in either header section, strips a leading `functions.` from the exposed tool name, and treats any nonempty recipient other than `assistant` as a tool call (including built-ins such as `browser.search`).

Arguments are accumulated until `<|call|>`, `<|end|>`, or `<|return|>` and parsed with JSON repair. Empty arguments, or input that still cannot be parsed after repair, become `{}` rather than a scanner error. The scanner emits `toolStart` when the header completes and `toolEnd` only at the message terminator; `analysis` body chunks stream as thinking deltas, while ordinary assistant `commentary`/`final` bodies stream as text. Non-assistant messages, including tool-result envelopes, are skipped by this output scanner.

An important owned-scanner edge case differs from canonical Harmony. After a recipient-bearing header reaches `<\|message\|>`, OMP has already emitted `toolStart`. If the ordinary streaming path drains the body bytes and the stream then ends without `<\|call\|>`, `<\|end\|>`, or `<\|return\|>`, `flush()` emits no `toolEnd` and does not retract the start. The Harmony scanner emits no argument deltas, so the retained canonical call still has `{}` even if unterminated body text was seen. On a normal stop, OMP changes the turn to `toolUse` and may dispatch that empty call. This is permissive and unsafe recovery behavior, not a valid Harmony terminator rule.

## Multiple / parallel tool calls

Harmony has no special "parallel" wrapper. Multiple calls are just multiple consecutive messages. The model may first emit an optional **preamble** — a *user-visible* assistant message on the `commentary` channel (unlike `analysis`, this is meant to be shown) — then one tool-call message per function. Each individual call still ends with its own `<|call|>` stop token, so a host that stops on `<|call|>` collects calls one at a time, executes, feeds the result back, and resumes:

```text
<|channel|>analysis<|message|>{reasoning}<|end|><|start|>assistant<|channel|>commentary<|message|>**Action plan**:
1. Generate an HTML file
2. Generate a JavaScript for the Node.js server
3. Start the server
---
Will start executing the plan step by step<|end|><|start|>assistant<|channel|>commentary to=functions.generate_file<|message|>{"template": "basic_html", "path": "index.html"}<|call|>
```

## Tool-result format

The executed tool's output is fed back as a message whose **author/role is the tool's name**, addressed back to the assistant (`to=assistant`), on the **commentary** channel, ending with `<|end|>`. This is the canonical (recommended) form:

```text
<|start|>functions.get_current_weather to=assistant<|channel|>commentary<|message|>{"sunny": true, "temperature": 20}<|end|>
```

The header ordering is `{toolname} to=assistant<|channel|>commentary`. Built-in tool results follow the same shape (e.g. `<|start|>browser.search to=assistant<|channel|>commentary<|message|>{"result": "https://openai.com/"}<|end|>`). The minimal form the renderer accepts when channel/recipient are not set on the message is just `<|start|>{toolname}<|message|>{output}<|end|>`, but emitting the full `to=assistant<|channel|>commentary` header is what the reference parser round-trips and is recommended. After appending the result, restart generation by emitting the next `<|start|>assistant`.

OMP always renders the full canonical result header shown above and passes `result.text` through verbatim. Harmony has no dedicated error bit, so `isError` is not represented separately; a failure must be described in the result payload.

## End-to-end example

Complete multi-turn weather exchange: system + developer prompt → user question → assistant analysis CoT → assistant commentary tool call → tool result → assistant final answer. This is a single contiguous token stream (newlines inside headers are only between top-level messages for readability; in practice messages are concatenated with no separator).

```text
<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: 2025-06-28

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
Calls to these tools must go to the commentary channel: 'functions'.<|end|><|start|>developer<|message|># Instructions

Use a friendly tone.

# Tools

## functions

namespace functions {

// Gets the current weather in the provided location.
type get_current_weather = (_: {
// The city and state, e.g. San Francisco, CA
location: string,
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

} // namespace functions<|end|><|start|>user<|message|>What is the weather like in SF?<|end|><|start|>assistant<|channel|>analysis<|message|>User wants the weather in San Francisco. Use get_current_weather.<|end|><|start|>assistant<|channel|>commentary to=functions.get_current_weather<|message|>{"location":"San Francisco, CA"}<|call|><|start|>functions.get_current_weather to=assistant<|channel|>commentary<|message|>{"sunny": true, "temperature": 20}<|end|><|start|>assistant<|channel|>final<|message|>It's sunny and about 20°C in San Francisco right now.<|return|>
```

Turn boundaries:

- The host stops generation at `<|call|>`, parses the `commentary` call, runs `get_current_weather`, and appends the `functions.get_current_weather to=assistant` result message.
- It then appends `<|start|>assistant` and resumes. The preceding `analysis` message is kept (the turn ended in a tool call, not a `final`), so the model can continue its reasoning.
- Generation stops at `<|return|>`. When this turn is persisted into history for a *later* turn, normalize the trailing `<|return|>` to `<|end|>` (see next note).

**`<|return|>` normalization.** `<|return|>` is a decode-time stop token only. When you store the assistant's reply into history for the next turn, replace the trailing `<|return|>` with `<|end|>` so every stored message is a well-formed `<|start|>{header}<|message|>{content}<|end|>`. (For supervised training targets, ending the example with `<|return|>` is correct.)

## OpenAI-compatible API mapping

When a server (vLLM/SGLang/Ollama) bridges Harmony to Chat Completions JSON:

- **`finish_reason`**: `tool_calls` when generation stopped on `<|call|>`; `stop` when it stopped on `<|return|>`.
- **`message.tool_calls[]`**: one entry per `commentary` `to=functions.*` call. `function.name` is the recipient with the `functions.` namespace stripped (`get_current_weather`). `function.arguments` is a **JSON string** (the verbatim `<|message|>` body), matching OpenAI semantics — not a parsed object.
- **`tool_call_id`**: Harmony has no native call ID. The server synthesizes one (e.g. `call_abc123`) and is responsible for correlating the follow-up `role:"tool"` message back to the Harmony tool-result envelope (recipient `to=functions.<name>` / call order).
- **Tool result messages** (`{"role":"tool","tool_call_id":...,"content":...}`) are rendered into `<|start|>{toolname} to=assistant<|channel|>commentary<|message|>{content}<|end|>`. The server maps `tool_call_id` → the original function name to build the `{toolname}` author.
- **Reasoning**: `analysis`-channel text is surfaced as `reasoning_content` (vLLM/SGLang) or as a `reasoning`/`thinking` field, and is generally not echoed back on subsequent requests. `final`-channel text is the normal `message.content`. `commentary` preambles, if surfaced, also map to assistant content.
- **OMP transcript rendering:** `developer`, `user`, and other non-assistant roles map directly to Harmony envelopes. Assistant messages emit, in order, a complete `analysis` message for thinking, a complete `final` message for visible text, then one `commentary` call message per tool call. Thus visible text accompanying a tool call is rendered as `final`, not as a commentary preamble. Tool-result runs become consecutive canonical tool-author envelopes.
- **Native server/chat-template compilation:** on the native vLLM/SGLang path, request `tools` / `tool_choice` are compiled by the server's chat template into the developer-message `namespace functions { ... }` block; the system message gains the commentary-routing line.
- **OMP owned-dialect advertisement:** when OMP's `harmony` dialect is selected, OMP removes native provider tools and appends its generic compact `<tools>` JSON catalog plus the Harmony format guide to the system prompt. This path does not use the canonical developer-message namespace as its tool advertisement.

## Parsing notes & gotchas

- **Two stop tokens.** Always stop on both `<|return|>` and `<|call|>`. Stopping only on `<|return|>` will run past tool calls; stopping only on `<|end|>` is wrong for assistant generation.
- **Recipient position varies.** `to=functions.<name>` may be in the role section (`<|start|>assistant to=...<|channel|>commentary`) or the channel section (`<|channel|>commentary to=...`). A parser must accept both.
- **Channel is mandatory** on assistant messages; the system message even reminds the model ("Channel must be included for every message."). Missing-channel output is malformed.
- **Tool author, not `tool`.** The tool-result message's role is the tool's *name* (`functions.get_current_weather`), not the literal string `tool`. Splitting `functions.x` into namespace + function is the parser's job.
- **CoT dropping is conditional.** Drop `analysis` only when the previous assistant turn ended on `final`. Dropping the `analysis` that immediately precedes a `<|call|>` breaks multi-step tool reasoning.
- **`arguments` is a string.** Do not double-encode. The body after `<|message|>` is already serialized JSON; pass it through as the `arguments` string.
- **Content-type variants.** `<|constrain|>json` is optional. If present, it is metadata, not a guarantee of valid JSON. Enforce JSON validity with constrained decoding / your own grammar — the prompt format alone does not guarantee schema adherence (same caveat applies to structured-output `# Response Formats`).
- **Streaming.** Use a stateful parser (the library ships `StreamableParser`) so partial UTF-8 and the header/channel/recipient/content-type fields are reconstructed incrementally; a naive substring scan mishandles multi-byte splits and the optional header fields. `parse_messages_from_completion_tokens` takes `strict=True|False` — `strict=False` tolerates some malformed headers. Do not pass the trailing stop token into the parser.
- **Encoding.** Use `o200k_harmony` (the `o200k_base` ranks plus the Harmony specials above). Treat the `<|...|>` tokens as atomic special tokens during both encode and decode; encoding them as ordinary text yields different ranks and corrupts the stream.

## Sources

- OpenAI Cookbook — OpenAI harmony response format: https://cookbook.openai.com/articles/openai-harmony
- openai/harmony renderer (README): https://github.com/openai/harmony
- openai/harmony canonical format guide: https://raw.githubusercontent.com/openai/harmony/main/docs/format.md
- openai/harmony special-token registry (`o200k_harmony` IDs): https://raw.githubusercontent.com/openai/harmony/main/src/tiktoken_ext/public_encodings.rs
- openai/harmony renderer/parser tests and schema→TS logic: https://raw.githubusercontent.com/openai/harmony/main/src/tests.rs , https://raw.githubusercontent.com/openai/harmony/main/src/encoding.rs
- openai/harmony test fixtures (verbatim rendered streams): `test-data/test_render_functions_with_parameters.txt`, `test-data/test_does_not_drop_if_ongoing_analysis.txt`, `test-data/test_tool_response_parsing.txt`, `test-data/test_streamable_parser.txt`, `test-data/test_browser_and_function_tool.txt` (https://github.com/openai/harmony/tree/main/test-data)
- vLLM tool calling / gpt-oss parser flags: https://docs.vllm.ai/en/latest/features/tool_calling/
- SGLang gpt-oss usage (`--tool-call-parser gpt-oss`): https://docs.sglang.io/basic_usage/gpt_oss.html
