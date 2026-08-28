Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
{{#if spawns}}Eval `agent()` children use independent kernels.{{/if}}

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step.

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, kwargs.{{/if}}{{#if jl}} Julia: sync, kwargs.{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `schema` overrides agent/session schemas; `schemaMode`/`schema_mode`: "permissive" | "strict". Effective schemas return parsed data. `isolated` requests a worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }, parsed `data` when structured.
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle }).{{/if}}
{{/if}}
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>

<map-reduce>
Bulk per-chunk semantic work (label/extract/summarize every slice of a long input): slice in-kernel → `completion` per slice (smol tier) via `parallel` → aggregate in code.{{#if spawns}} NEVER verbalize per-chunk fan-out as subagent batches.{{/if}}
Large source → load it inside the kernel (`read(path)`, paginated by offset/limit), NEVER via the outer `read` tool's `:raw`/whole-file form — that spends this turn's context on the source instead of leaving it a kernel-only handle.
{{#if py}}
```
text = read("local://paste-1.md")
chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
labels = parallel([lambda c=c: completion(f"One word — BUG|FEATURE|QUESTION:\n{c}", model="smol") for c in chunks])
display({l: labels.count(l) for l in set(labels)})
```
{{else}}{{#if js}}
```
const text = await read("local://paste-1.md");
const codePoints = Array.from(text);
const chunks = Array.from({length: Math.ceil(codePoints.length/4000)}, (_, i) => codePoints.slice(i*4000, (i+1)*4000).join(""));
const labels = await parallel(chunks.map(c => () => completion(`One word — BUG|FEATURE|QUESTION:\n${c}`, {model: "smol"})));
display(Object.fromEntries([...new Set(labels)].map(l => [l, labels.filter(x => x === l).length])));
```
{{else}}{{#if rb}}
```
text = read("local://paste-1.md")
chunks = (0...text.length).step(4000).map { |i| text[i, 4000] }
labels = parallel(chunks.map { |c| -> { completion("One word — BUG|FEATURE|QUESTION:\n#{c}", model: "smol") } })
display(labels.each_with_object(Hash.new(0)) { |l, h| h[l] += 1 })
```
{{else}}{{#if jl}}
```
text = read("local://paste-1.md")
chunks = [join(c) for c in Iterators.partition(collect(text), 4000)]
labels = parallel([() -> completion("One word — BUG|FEATURE|QUESTION:\n$c", model="smol") for c in chunks])
display(Dict(l => count(==(l), labels) for l in unique(labels)))
```
{{/if}}{{/if}}{{/if}}{{/if}}
</map-reduce>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>

{{#if autoBackgroundEnabled}}Long-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
