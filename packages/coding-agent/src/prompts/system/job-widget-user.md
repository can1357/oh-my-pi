<job>
{{#if command}}
Background bash job. Command:
```
{{command}}
```
{{/if}}
{{#if task}}
Background subagent. Its assignment (excerpt):
```
{{task}}
```
{{/if}}
{{#if intent}}
Why it was started: {{intent}}
{{/if}}
{{#if watch}}
What the subagent says to watch: {{watch}}
{{/if}}
{{#if stage}}
Its current stage: {{stage}}
{{/if}}
</job>

<sources>
{{#each sources}}
## `{{id}}` — {{label}}
{{lines}} lines so far ({{size}}).{{#if omitted}} {{omitted}} not shown: the middle, and repeats of a line that differ only in numbers.{{/if}}
```
{{#each head}}
{{this}}
{{/each}}
{{#if tail.length}}
{{#if omitted}}
[…]
{{/if}}
{{#each tail}}
{{this}}
{{/each}}
{{/if}}
```
{{/each}}
</sources>
{{#if previous}}

A spec is already in place, but {{previous.reason}}. Write a replacement that matches the lines above:
```json
{{previous.spec}}
```
{{/if}}
{{#if rejected}}

Your previous answer was rejected:
```json
{{rejected.answer}}
```
Problems:
{{#each rejected.errors}}
- {{this}}
{{/each}}
Fix every problem and call `respond` again.
{{/if}}
