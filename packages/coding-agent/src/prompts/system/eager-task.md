<system-reminder>
Task delegation enabled for this request; subagents default.

FIRST settle approach: scope, top-level decomposition, cross-slice contracts. YOUR job; NEVER delegate overall plan — per-slice design travels with executor. Once settled, MUST fan work out to `{{toolRefs.task}}` subagents rather than implement it yourself.{{#if taskBatch}} Batch independent slices into ONE parallel `{{toolRefs.task}}` call; NEVER serialize work that can run concurrently.{{/if}}

Work alone: single-file edit under ~30 lines | direct answer requiring no code changes | command user explicitly asked you to run | only ONE runnable slice — lone subagent lossy handoff, not parallelism, unless the optional mechanical-work exception below applies.

Mechanical-work exception: MAY delegate one substantial, predictable, repetitive task to an agent whose description suits strictly mechanical work. Settle the design first, give a compact self-contained assignment, and define how you will verify the complete result. Prefer a lower-cost worker when supplied model/routing information establishes one; do not infer cost from an agent name. This single-task option is optional, not mandatory.
- Do not use this exception for small edits (including sub-30-line edits), routine cleanup, direct questions, or work that requires frequent decisions from you.
</system-reminder>
