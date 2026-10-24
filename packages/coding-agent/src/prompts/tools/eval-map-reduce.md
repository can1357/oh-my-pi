<map-reduce>
Bulk per-chunk semantic work (label/extract/summarize every slice of a long input): slice in-kernel → one `completion` per slice (smol tier) → `wait` on the handles → aggregate in code.{{#if spawns}} NEVER verbalize per-chunk fan-out as subagent batches.{{/if}}
Large source → load it inside the kernel (`read(path)`, paginated by offset/limit), NEVER via the outer `read` tool's `:raw`/whole-file form — that spends this turn's context on the source instead of leaving it a kernel-only handle.
{{#if py}}
```
text = read("local://paste-1.md")
chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
handles = [completion(f"One word — BUG|FEATURE|QUESTION:\n{c}", model="smol") for c in chunks]
labels = wait(handles)
display({l: labels.count(l) for l in set(labels)})
```
{{else}}{{#if js}}
```
const text = await read("local://paste-1.md");
const codePoints = Array.from(text);
const chunks = Array.from({length: Math.ceil(codePoints.length/4000)}, (_, i) => codePoints.slice(i*4000, (i+1)*4000).join(""));
const handles = chunks.map(c => completion(`One word — BUG|FEATURE|QUESTION:\n${c}`, {model: "smol"}));
const labels = await wait(handles);
display(Object.fromEntries([...new Set(labels)].map(l => [l, labels.filter(x => x === l).length])));
```
{{/if}}{{/if}}
</map-reduce>
