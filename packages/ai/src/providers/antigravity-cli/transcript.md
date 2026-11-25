{{#if checkpoint}}
<conversation-checkpoint>
The following labelled messages replay the earlier conversation, including its images and tool results. They are history, not requests to repeat completed tool calls. Continue from the new input after this checkpoint.
{{/if}}
{{#if omittedHistory}}
[Older conversation history omitted: Antigravity CLI replay text limit.]
{{/if}}
{{#if omittedImages}}
[One or more images omitted: provider image limit.]
{{/if}}
