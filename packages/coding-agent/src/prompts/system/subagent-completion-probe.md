<progress-check>
Status request from the orchestrator; the task continues after this reply.
{{#if inflight.length}}
Tool calls not yet in the transcript, still being written (count them as done):
{{#each inflight}}
- `{{name}}`{{#if path}} ({{path}}){{/if}}: {{chars}} characters of arguments so far
{{/each}}
{{/if}}
Rate how complete the assigned task is, judged by its deliverables in the transcript:
- 0–15%: task read, code explored, nothing changed yet
- 15–30%: approach chosen, first edits made
- 30–75%: deliverables in progress; scale by finished vs. remaining
- 75–90%: all deliverables written; tests running or failures being fixed
- 90–99%: tests pass; only review and the final report remain
{{#if previous}}
The rating {{previous.ago}} ago was {{previous.percent}}%{{#if previous.stage}} ("{{previous.stage}}"){{/if}}. Update it from the work done since; lower it if more work turned up.
{{/if}}
Reply with ONLY one line of JSON, no code fence, no other text:
{"pct": 40, "stage": "benchmarking the streaming decoder", "watch": "BENCH lines in bg_2 pipe:1, tok_s_stream higher is better, target 70% of roofline"}
- `pct`: whole-number completion, 0–100.
- `stage`: the task's current work item, as a short label (≤ 80 chars).
- `watch`: optional (≤ 200 chars). Include it only when some output shows the task's progress as it runs: which job or output (e.g. `bg_2`, its `pipe:1`, a tool's results), which lines or metric, whether higher or lower is better, and the target if there is one. Omit it otherwise.
NEVER use tools.
</progress-check>
