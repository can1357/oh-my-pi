Conversation with a coding agent (most recent last; may be clipped):

{{#if turns}}{{#list turns join="\n"}}{{#when this.role "==" "user"}}User{{else}}Assistant{{/when}}: {{this.text}}{{/list}}
{{/if}}

Predict the single next message the human user is most likely to type.
Rules:
- Reply with the message text only: no quotes, no labels, no markdown, no explanation.
- Write it in the same language as the conversation (Chinese conversation -> Chinese).
- One short line, at most ~15 words / 60 characters. It must read like something the user would type themselves (a follow-up request, question, or next step).
- If no next message is obvious, reply exactly: NO_SUGGESTION
