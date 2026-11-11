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

{{#if evalDocs}}
<helpers>
State persists across `eval` calls. Helper reference:

{{{evalDocs}}}
</helpers>

{{/if}}
<pool-workflow>
1. Scope the full independent work list before spawning.
2. Create ONE explicitly named pool per phase.
3. Push every known item in one cell; later discoveries MAY be pushed while the pool job is still running.
4. Continue useful local work. Results auto-deliver; NEVER poll.{{#has tools "wait"}} Completely blocked? Leave `eval` and call the `wait` tool (not kernel `wait()`).{{/has}}
5. Read every batch result; YOU verify and integrate.

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
{{#if evalTools}}- **Shared kernel state**: {{#ifAll py js}}`@tool` / `tool(fn)`{{else}}{{#if py}}`@tool`{{else}}`tool(fn)`{{/if}}{{/ifAll}} named in pool `tools` → shared caches, dedup sets, scoring, structured accumulation across workers; calls run in YOUR kernel, and a raised exception returns to the caller without killing it.
{{/if}}
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
