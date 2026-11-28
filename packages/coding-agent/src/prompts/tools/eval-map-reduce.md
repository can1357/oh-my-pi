<map-reduce>
Per-chunk work over a long input, by kind: fixed labels / yes-no / scores → {{#ifAll py js}}`judge_batch` (Py) / `judgeBatch` (JS){{else}}{{#if py}}`judge_batch`{{else}}`judgeBatch`{{/if}}{{/ifAll}} over the chunks (typed `choice`/`bool`/`score` questions), never `completion`. Free-form extract/summarize (this map): slice in-kernel → one `completion` per slice (smol tier, `schema`) → `wait` on the handles → aggregate in code.{{#if spawns}} NEVER verbalize per-chunk fan-out as subagent batches.{{/if}}
Large source → load it inside the kernel (`read(path)`, paginated by offset/limit), NEVER via the outer `read` tool's `:raw`/whole-file form — that spends this turn's context on the source instead of leaving it a kernel-only handle.
{{#if py}}
```
text = read("local://paste-1.md")
chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
SCHEMA = {"type": "object", "properties": {"lines": {"type": "array", "items": {"type": "string"}}}, "required": ["lines"]}
handles = [completion(f"Every TODO or decision line in this text, verbatim; empty list if none:\n{c}", model="smol", schema=SCHEMA) for c in chunks]
found = wait(handles)
print("\n".join(l for r in found for l in r["lines"]))
```
{{else}}{{#if js}}
```
const text = await read("local://paste-1.md");
const codePoints = Array.from(text);
const chunks = Array.from({length: Math.ceil(codePoints.length/4000)}, (_, i) => codePoints.slice(i*4000, (i+1)*4000).join(""));
const schema = {type: "object", properties: {lines: {type: "array", items: {type: "string"}}}, required: ["lines"]};
const handles = await Promise.all(chunks.map(c => completion(`Every TODO or decision line in this text, verbatim; empty list if none:\n${c}`, {model: "smol", schema})));
const found = await wait(handles);
print(found.flatMap(r => r.lines).join("\n"));
```
{{/if}}{{/if}}
</map-reduce>
