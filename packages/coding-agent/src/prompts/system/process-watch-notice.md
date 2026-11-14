<system-notice>
A check on the background jobs running now found:
{{#each jobs}}
- Job {{this.jobId}} `{{this.command}}` (running {{this.age}}{{#if this.quiet}}, nothing new written for {{this.quiet}}{{/if}}) {{#if this.stalled}}looks stalled: it has written nothing for longer than such a command should take, or waits on something that will not come.{{/if}}{{#if this.failing}}looks to be failing: its output shows errors while it keeps running.{{/if}}{{#if this.ready}}looks up and ready: a server or watcher, which you may be waiting on as if it would end.{{/if}}{{#if this.lastOutput}}
  Last output:
  {{this.lastOutput}}{{/if}}
{{/each}}
{{#if hostStrain}}
The host shows {{hostStrain}}, which may be starving the stalled job. Consider moving heavy work off this host or freeing resources (disk space, memory held by other work you started); do not kill jobs to do it.
{{/if}}
Check on it now: read its output (`proc://<job id>`), stop it, or carry on if you know it should still run.
</system-notice>
