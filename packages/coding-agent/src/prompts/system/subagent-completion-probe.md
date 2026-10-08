<progress-check>
Side question from the orchestrator; your work continues after this reply.
{{#if inflight.length}}
You were interrupted mid-response; these tool calls were still being written and are not in the transcript above:
{{#each inflight}}
- `{{name}}`{{#if path}} ({{path}}){{/if}}: {{chars}} characters of arguments so far
{{/each}}
Count that work as done so far.
{{/if}}
Estimate how much of your assigned task is complete. Anchor on the phase you are in:
- 0–15%: reading the task and exploring code
- 15–30%: plan settled, first edits starting
- 30–75%: implementing; scale by deliverables finished vs. remaining
- 75–90%: all deliverables written; running tests, fixing failures
- 90–99%: tests pass; final review and summary left
{{#if previous}}
Your previous estimate, {{previous.ago}} ago, was {{previous.percent}}%. Update it from what happened since; lower it if you uncovered more work.
{{/if}}
Reply with ONLY a whole-number percentage, e.g. `40%`. No other text.
NEVER use tools.
</progress-check>
