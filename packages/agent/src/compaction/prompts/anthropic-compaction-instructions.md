The conversation above is the complete history to summarize. The API replaces every message in this request with your summary; no message you leave out survives.

{{#if extraContext}}
{{extraContext}}

{{/if}}
{{basePrompt}}
{{#if customInstructions}}

Additional focus: {{customInstructions}}
{{/if}}

You MUST NOT call any tools while writing the summary; respond with the summary text only.