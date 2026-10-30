<vibe-turn session="{{id}}" cli="{{cli}}" turn="{{turn}}" status="{{status}}" duration="{{duration}}"{{#if model}} model="{{model}}"{{/if}}>
<activity tool-calls="{{toolCount}}" requests="{{requests}}">
{{#each trace}}
- {{this}}
{{/each}}
{{#if traceOverflow}}
- … {{traceOverflow}} earlier tool call(s) not shown
{{/if}}
</activity>
<response{{#if responseTruncated}} truncated="true" full-output="agent://{{id}}"{{/if}}>
{{response}}
</response>
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if alive}}
Session `{{id}}` is idle and retains this conversation — continue it with vibe_send. Transcript: history://{{id}}
{{/if}}
</vibe-turn>
