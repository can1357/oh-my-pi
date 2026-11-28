<map-reduce>
Per-chunk work over a long input, by kind: fixed labels / yes-no / scores → {{#ifAll py js}}`judge_batch` (Py) / `judgeBatch` (JS){{else}}{{#if py}}`judge_batch`{{else}}`judgeBatch`{{/if}}{{/ifAll}} over the chunks (typed `choice`/`bool`/`score` questions), never `completion`. Free-form extract/summarize (this map): slice in-kernel → one `completion` per slice (smol tier, `schema`) → `wait` on the handles → aggregate in code.{{#if spawns}} NEVER verbalize per-chunk fan-out as subagent batches.{{/if}}
Large source → load it inside the kernel (`read(path)`, paginated by offset/limit), NEVER via the outer `read` tool's `:raw`/whole-file form — that spends this turn's context on the source instead of leaving it a kernel-only handle.
{{#if py}}
```
import re
text = read("local://paste-1.md")
chunks = [""]
for line in re.split(r"(?<=\n)", text):
    if chunks[-1] and len(chunks[-1]) + len(line) > 4000: chunks.append("")
    chunks[-1] += line
SCHEMA = {"type": "object", "properties": {"lines": {"type": "array", "items": {"type": "string"}}}, "required": ["lines"]}
handles = [completion(f"Every TODO or decision line in this text, verbatim; empty list if none:\n{c}", model="smol", schema=SCHEMA) for c in chunks]
found = wait(handles)
print("\n".join(l for r in found for l in r["lines"]))
```
{{else}}{{#if js}}
```
const text = await read("local://paste-1.md");
const chunks = [""];
for (const line of text.split(/(?<=\n)/)) {
  if (chunks.at(-1) && chunks.at(-1).length + line.length > 4000) chunks.push("");
  chunks[chunks.length - 1] += line;
}
const schema = {type: "object", properties: {lines: {type: "array", items: {type: "string"}}}, required: ["lines"]};
const handles = await Promise.all(chunks.map(c => completion(`Every TODO or decision line in this text, verbatim; empty list if none:\n${c}`, {model: "smol", schema})));
const found = await wait(handles);
print(found.flatMap(r => r.lines).join("\n"));
```
{{/if}}{{/if}}
</map-reduce>
