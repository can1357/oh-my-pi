<system-notice>
User message contains **workflowz** → deterministic multi-subagent workflow. Default to `workpool()` for 2+ independent items; use individual `agent()` handles only for dependency-coupled or schema-returning calls.

<when>
Use for broad research, reviews, migrations, adversarial coverage, and open-ended work lists. Quick lookup/single edit: direct; no agents. {{#if scoutAvailable}}Scout inline FIRST{{else}}Explore inline FIRST{{/if}} — scope files, call sites, and contracts before creating the pool.

Pool-first phases:
- **Understand**: queue subsystem readers → collect results → synthesize
- **Review**: queue one item per lens/file → collect results → verify survivors
- **Migrate**: discover sites → queue file-disjoint transforms → verify once
- **Research**: queue modalities/sources → deep-read hits → synthesize
- **Design**: queue independent proposals/judges → choose and integrate
</when>

<helpers>
State persists across `eval` calls. Every call provides:

- {{#if py}}`workpool(agent=None, *, name=None, context=None{{#if evalTools}}, tools=None{{/if}})`{{else}}`await workpool(agent?, { name?, context?{{#if evalTools}}, tools?{{/if}} })`{{/if}}: {{#if freshAgents}}pool of single-item agents, at most live `task.maxConcurrency` running at once (0 = unlimited). Items dispatch in push order: each gets a new agent while under the limit, else waits in a pool-wide FIFO queue until a running agent finishes. An agent leaves the pool after its one item and never takes another, so items share no conversation; the pool context and tools still reach every agent.{{else}}pool of keep-alive workers, at most live `task.maxConcurrency` of them (0 = unlimited). Items dispatch in push order: to the idle worker using the least of its context window, else to a new worker while under the limit, else onto a busy worker's queue, round-robin. A worker keeps its conversation across items, so a later item sees everything its worker did before; items queued on a busy worker reach it together as one batch when it frees up. Reuse happens only once items outnumber the limit or one arrives while a worker is idle.{{/if}} {{#if py}}`.push(*items)`{{else}}`.push(…items)`{{/if}} returns item ids; `.status()` reports counts/workers; `.peek()` returns a non-consuming batch snapshot; `.close()` drops queued work.{{#if js}}{{#if py}} JS: `await workpool(agent, { name, context{{#if evalTools}}, tools{{/if}} })`; every{{else}} Every{{/if}} pool method is async (`await pool.push(…items)`).{{/if}}
  - The pool name is its background job id and label. Push all items while it is active; its first full drain settles and closes that pool job. New phase/wave after drain → create a new named pool.
  - Results auto-deliver. Completely blocked? Leave `eval` and call the `wait` tool (not kernel `wait()`); NEVER poll.
- {{#if py}}`agent(prompt, *, agent=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None{{#if evalTools}}, tools=None{{/if}})`{{else}}`await agent(prompt, { agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?{{#if evalTools}}, tools?{{/if}} })`{{/if}}: immediate `AgentHandle`; use for a small fixed dependency graph or when the parent needs validated `schema` data. `.wait()` returns text/data; `.handle` is `agent://<id>`. Unwaited results auto-deliver.{{#if js}}{{#if py}} JS: `await agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}} })`; without `await`,{{else}} Without `await agent(…)`,{{/if}} `.id`/`.handle` are undefined; handle methods are async (`await h.wait()`).{{/if}}
- {{#if py}}`completion(prompt, *, model="default", system=None, schema=None)`{{else}}`await completion(prompt, { model?, system?, schema? })`{{/if}}: immediate `CompletionHandle` for a tool-free one-shot call. Tiers: `"smol"`, `"default"`, `"slow"`.{{#if js}}{{#if py}} JS: `await completion(prompt, { model, system, schema })`; handle{{else}} Handle{{/if}} methods are async (`await h.wait()`).{{/if}}
- `await judge(state, questions)`: typed `choice`/`bool`/`score` questions over one state → `{id: answer}` with probabilities. Cheaper than `completion()` for classification.
- {{#if py}}`judge_batch(states, questions, *, concurrency=32, retries=1, min_ok=1, intent=None)`{{else}}`await judgeBatch(states, questions, { concurrency?, retries?, minOk?, intent? })`{{/if}}: the same questions over many states, run by the host so it outlives the cell. Set nonempty `intent` for its progress/job label (default `"Judging"`). Returns a `JudgmentBatch` at once; per cell pull a bounded slice with {{#if py}}`await b.drain(timeout)` (or `async for k, item in b.drain_iter(timeout)`){{else}}`await b.drain({ timeout })` (or `for await (const [k, item] of b.drainIter({ timeout }))`){{/if}}, read `b.status()`/`b.results()`/`b.failed()`, and `b.close()` when done. Item failures are `item.error`, never exceptions; `b.id` is a background job id (results auto-deliver). Never loop `judge()` over a list.{{#if js}}{{#if py}} JS: `await judgeBatch(states, questions, { concurrency, retries, minOk, intent })`; `await b.drain({ timeout })` / `for await (const [k, item] of b.drainIter({ timeout }))`; every{{else}} Every{{/if}} batch method except `drainIter` is async.{{/if}}
- {{#if py}}`wait(handles, timeout=None, *, raise_errors=True)`{{else}}`await wait(handles, { timeout?, raiseErrors? })`{{/if}}: ordered barrier for agent/completion handles only; {{#if py}}`raise_errors=False`{{else}}`raiseErrors: false`{{/if}} keeps an error in its slot.{{#ifAll py js}} JS: `await wait(handles, { timeout, raiseErrors })`.{{/ifAll}}
{{#if evalTools}}- {{#if py}}`@tool`{{else}}`tool(fn, { name?, description?, parameters? })`{{/if}}: kernel-local tool exposed via `tools`. Use for shared caches, dedup sets, scoring, or structured accumulation across pool workers; calls execute in YOUR kernel and a raised exception returns to the caller without killing it.{{#ifAll py js}} JS: `tool(fn, { name, description, parameters })`.{{/ifAll}}
{{/if}}- `log(message)`: progress line. `phase(title)`: status-tree phase.
- `budget`: {{#if py}}`budget.total` / `budget.spent()` / `budget.remaining()`{{else}}`await budget.total()` / `await budget.spent()` / `await budget.remaining()`{{/if}}. User `+Nk` = advisory; `+Nk!` = hard.{{#ifAll py js}} JS: `await budget.total()` / `await budget.spent()` / `await budget.remaining()`.{{/ifAll}}
</helpers>

<pool-workflow>
1. Scope the full independent work list before spawning.
2. Create ONE explicitly named pool per phase.
3. Push every known item in one cell; later discoveries MAY be pushed while the pool job is still running.
4. Continue useful local work. Results auto-deliver.
5. Completely blocked? Leave `eval` and call the `wait` tool (not kernel `wait()`); never poll.
6. Read every batch result; YOU verify and integrate.

{{#if py}}
{{#if js}}
**Python:**
{{/if}}
```python
phase("Review")
review = workpool({{#if scoutAvailable}}"scout", {{/if}}name="review", context="Return evidence with exact paths; do not edit.")
review.push(*[
    "Review authentication correctness",
    "Review authorization boundaries",
    "Review cancellation and cleanup",
    "Review performance regressions",
])
print(review.name)   # background job id; results auto-deliver
```
{{/if}}
{{#if js}}
{{#if py}}
**JavaScript:**
{{/if}}
```js
phase("Review");
const review = await workpool({{#if scoutAvailable}}"scout", {{/if}}{
    name: "review",
    context: "Return evidence with exact paths; do not edit.",
});
await review.push(
    "Review authentication correctness",
    "Review authorization boundaries",
    "Review cancellation and cleanup",
    "Review performance regressions",
);
print(review.name); // background job id; results auto-deliver
```
{{/if}}
Need a snapshot without consuming/delivering results? `{{#unless py}}await {{/unless}}review.peek()`. Need activity counts? `{{#unless py}}await {{/unless}}review.status()`.{{#ifAll py js}} JS: `await` both.{{/ifAll}}
</pool-workflow>

<dependencies>
Use handles only when work item B requires A's exact output before B can be written:

{{#if py}}
```python
spec = agent("Extract the protocol", {{#if scoutAvailable}}agent="scout", {{/if}}schema=SPEC).wait()
impl = agent(f"Implement this protocol: {spec}")
result = impl.wait()
```
{{/if}}
{{#if js}}
```js
const specHandle = await agent("Extract the protocol", { {{#if scoutAvailable}}agent: "scout", {{/if}}schema: SPEC });
const spec = await specHandle.wait();
const impl = await agent(`Implement this protocol: ${JSON.stringify(spec)}`);
const result = await impl.wait();
```
{{/if}}
Fixed independent handles are acceptable when each result must be returned directly into the kernel as structured data. Otherwise use a pool.
</dependencies>

<patterns>
- **Adversarial verify**: pool one REFUTE task per claim/lens; retain only evidence-backed survivors.
- **Perspective-diverse review**: distinct correctness/security/perf/reproduction items; NEVER clone one vague prompt.
- **Judge panel**: pool proposals, then a second named pool scores them after the first pool settles.
- **Loop-until-dry**: push newly discovered items while the pool remains active; dedup against all SEEN.
- **Multi-modal sweep**: queue by-container/by-content/by-entity/by-time items.
- **Completeness critic**: final pool item asks what modality/file/claim remains unchecked.
- **No silent caps**: if sampling/top-N drops work, `log()` what was omitted.

Scale: `"find any bugs"` → small pool. `"thoroughly audit"` → broad pool + a separate adversarial verification pool.
</patterns>

<execution>
- Multi-phase work: capture in `todo`.
- Each pool item: self-contained target, change/read scope, acceptance.
- Same-file mutation? One worker owns it; serialize shared boundaries.
- Pool output is evidence, not truth. Read artifacts, gate findings, run final verification yourself.
- Continue until closed; a drained pool is a phase boundary, not task completion.
</execution>
</system-notice>
