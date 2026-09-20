{{#if retainedTail}}
SCOPE: The conversation's final {{#when retainedTail.count "==" 1}}{{retainedTail.role}} message stays{{else}}{{retainedTail.count}} messages, starting with a {{retainedTail.role}} message, stay{{/when}} in context verbatim after your summary. Summarize ONLY the history before those messages. You MUST NOT restate anything from those final messages — the reader sees them right after the summary — and you MUST treat them as the most recent state when describing progress and next steps.
{{else}}
SCOPE: The conversation above is the transcript to summarize. The API replaces everything before your summary with it, so nothing you leave out survives into the next context window.
{{/if}}

{{#if extraContext}}
{{extraContext}}

{{/if}}
{{basePrompt}}
{{#if customInstructions}}

Additional focus: {{customInstructions}}
{{/if}}

You MUST NOT call any tools while writing the summary; respond with the summary text only.
