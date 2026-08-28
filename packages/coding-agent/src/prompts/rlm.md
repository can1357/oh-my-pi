## RLM mode (Recursive Language Model)

Process oversized or decomposable input recursively instead of reading it all into context. Externalize the input into the eval sandbox, probe it, and delegate semantic work in chunks.

1. **Externalize the input.** Load the request's source into the eval kernel and expose it as a `context` variable rather than pasting the full text into context or downstream tool calls:
   - For a file or URL, read its content in the sandbox (`read(path)`, `write(path, content)`, or `tool.read`) and set `context = <that content>`. In JS, `read` is async — use `context = await read(path)`; omitting `await` binds a Promise, not the text.
   - For inline text, set `context = <the text>` directly. Do NOT echo the full text back into your reply.

2. **Probe before delegating.** Use `metadata(context)` to size it, `search(context, pattern)` to locate regions of interest, and `chunk(context, …)` to split it into manageable pieces of `by="lines"` or `by="tokens"`, `size=100`. Never scan the whole input linearly. `search()` returns at most 100 matches by default — if the result ends with `"… (truncated, more matches may exist)"`, pass a larger `limit` (JS: `{ limit }`; Python: `limit=`) or narrow the pattern. Each returned line is also capped at 1000 chars (`max_line_chars`, e.g. `{ max_line_chars }` / `max_line_chars=`): an oversized single line (minified JSON/base64) keeps a bounded window around the first match — `L<n>@<offset>: …<window>… (line truncated)` — instead of being copied whole, so the excerpt always shows where the match landed.
   - Python: `chunk(context, by="lines", size=100)` or `chunk(context, by="tokens", size=100)`
   - JS: `chunk(context, { by: "lines", size: 100 })` or `chunk(context, { by: "tokens", size: 100 })`

3. **Delegate semantic work.** Send each relevant chunk to `llm_query(chunk, instructions)` (or `llm_query_batched(prompts)` for independent chunks, in parallel). For sub-problems that are themselves large enough to recurse, use `rlm_query(prompt)` / `rlm_query_batched(prompts)` — if spawning is disabled or the session's recursion budget is already exhausted, that call is rejected; fall back to `llm_query`/`llm_query_batched` only in that case.

4. **Aggregate in code.** Merge, dedupe, summarize, and rank the per-chunk answers in the eval kernel before producing output. Do not ask the model to stitch raw chunks.

5. **Answer concisely.** Return only the final synthesized answer.

Recursion is bounded by the session's `task.maxRecursionDepth`; do not recurse beyond it.

{{#if externalized}}
**Inline payload externalized.** The user's inline request text ({{charCount}} chars) has been written to `{{inputUrl}}` — load it in the eval sandbox before probing/chunking it; do not ask the operator to repaste it:
- Python: `context = read("{{inputUrl}}")`
- JS: `context = await read("{{inputUrl}}")` (`read` is async in JS; omitting `await` binds a Promise, not the text)
{{else}}
User request: {{request}}
{{/if}}
