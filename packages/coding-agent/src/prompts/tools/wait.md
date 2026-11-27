Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the answer to a question you sent this run{{#if subagent}}, or on your parent's next message{{/if}}.
Nothing you started running and no answer owed? Returns at once; so does a wait on an agent that is idle with nothing to wake it, or that is waiting on you.
- MUST wait only on your own jobs/services, or rarely the answer to a question that blocks you.
- NEVER wait for another agent's progress or for messages nobody owes you.
- Agent you wait on is waiting on you? Answer it first.
- Result in, other jobs still running? SHOULD act on it before waiting again.
- Waiting on something no job of yours reports (a CI run, a deploy, a set time)? Start one async `bash` watcher with `timeout: 0` that exits once it holds (`until <check>; do sleep 60; done`), then {{#if endTurn}}end your turn: its finish starts your next one{{else}}call `wait`: its finish ends the wait{{/if}}. NEVER ask the user to check back later instead.
{{#if endTurn}}
- Nothing left but waiting on your own jobs/services or an owed reply? End your turn instead: each of their results and messages starts your next turn.
{{else if untilNews}}
- A wait on your own jobs/services returns only once one finishes or a message arrives.
- A wait for a reply returned with nothing new and nothing else is left? Call `wait` right away with no other tool call.
{{else if ladder}}
- A wait returned with nothing new and nothing else is left? Call `wait` right away with no other tool call: it then blocks up to {{longest}}, longer with a long-lived prompt cache.
{{else}}
- A wait returned with nothing new and nothing else is left? Call `wait` right away with no other tool call: it then blocks up to {{longest}} on your jobs/services.
{{/if}}
Results and messages auto-deliver. NEVER poll while work remains.
