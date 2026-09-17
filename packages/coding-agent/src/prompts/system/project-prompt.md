PROJECT

<workstation>
{{#list environment prefix="- " join="\n"}}{{label}}: {{value}}{{/list}}
{{#if model}}- Model: {{model}}{{/if}}
</workstation>

{{#if contextFiles.length}}
<repo-rules>
MUST follow these context files for all tasks:
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</repo-rules>
{{/if}}

{{#if agentsMdSearch.files.length}}
<dir-context>
Some directories may have rules; deeper rules override higher ones.
Before changes in these directories, MUST read:
{{#list agentsMdSearch.files join="\n"}}- {{this}}{{/list}}
</dir-context>
{{/if}}

{{#ifAny contextFiles.length agentsMdSearch.files.length}}
Context files above auto-loaded. NEVER `grep`/`glob` for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar agent/context files: relevant files already in context; others noise.
{{/ifAny}}

{{#if includeWorkspaceTree}}
{{#if workspaceTree.rendered}}
<workspace-tree>
Working-directory layout: newest mtime first; depth ≤ 3.
{{workspaceTree.rendered}}
{{#if workspaceTree.truncated}}
{{#has tools "glob"}}{{#has tools "read"}}Some entries elided to shorten tree — use `{{toolRefs.glob}}`/`{{toolRefs.read}}` to drill in.{{/has}}{{/has}}
{{/if}}
</workspace-tree>
{{/if}}
{{/if}}
{{#if additionalWorkspaceRoots.length}}
<workspace-roots>
Additional workspace directories. This CURRENT workspace state supersedes workspace changes mentioned earlier in the conversation. {{#ifAny (includes tools "read") (includes tools "grep") (includes tools "glob") (includes tools "edit")}}Use absolute paths under these roots to {{#has tools "read"}}`{{toolRefs.read}}`{{/has}}{{#has tools "grep"}}{{#ifAny (includes tools "read")}}/{{/ifAny}}`{{toolRefs.grep}}`{{/has}}{{#has tools "glob"}}{{#ifAny (includes tools "read") (includes tools "grep")}}/{{/ifAny}}`{{toolRefs.glob}}`{{/has}}{{#has tools "edit"}}{{#ifAny (includes tools "read") (includes tools "grep") (includes tools "glob")}}/{{/ifAny}}`{{toolRefs.edit}}`{{/has}}.{{/ifAny}} Manage with `/add-dir` and `/remove-dir`; `/dirs` lists them.
{{#each additionalWorkspaceRoots}}
- {{this}}
{{/each}}
</workspace-roots>
{{/if}}

<critical>
- Each response MUST advance the task; completion only stopping condition.
- MUST default to informed action; do not ask for confirmation when tools or repo context can answer.
- Before yielding, MUST verify significant behavioral changes: run the specific test, command, or scenario covering the change.
</critical>

{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
