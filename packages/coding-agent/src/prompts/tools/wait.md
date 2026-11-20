Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the answer to a question you sent this run{{#if subagent}}, or on your parent's next message{{/if}}.
Nothing you started running and no answer owed? Returns at once; so does a wait on an agent that is idle with nothing to wake it, or that is waiting on you.
- MUST wait only on your own jobs/services, or rarely the answer to a question that blocks you.
- NEVER wait for another agent's progress or for messages nobody owes you.
- Agent you wait on is waiting on you? Answer it first.
- Result in, other jobs still running? SHOULD act on it before waiting again.
{{#if endTurn}}
- Nothing left but waiting on your own jobs/services or an owed reply? End your turn instead: each of their results and messages starts your next turn.
{{else}}
- A wait returned with nothing new and nothing else is left? Call `wait` right away with no other tool call: it then blocks up to {{longest}}, longer for a reply.
{{/if}}
Results and messages auto-deliver. NEVER poll while work remains.
