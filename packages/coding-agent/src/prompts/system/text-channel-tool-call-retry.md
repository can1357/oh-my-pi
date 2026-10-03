Your previous reply wrote tool call(s) as literal text in the message body (a
function=NAME envelope with parameter=NAME pairs) instead of emitting them
through the native function-calling interface. Text is not a call: nothing in
that markup was executed.
{{#if toolNames}}The following calls did not run:
{{#each toolNames}}- {{this}}
{{/each}}{{/if}}{{#if incomplete}}An incomplete call envelope was also present (cut in transit); emit that call complete this time.
{{/if}}Re-emit each intended call now through the native function-calling
interface, with arguments as a JSON object matching the tool schema. No prose,
no transcription. If the markup was quoted or explanatory rather than an
intended call, ignore this note and answer normally.
Attempt #{{retryCount}}/{{maxRetries}}
