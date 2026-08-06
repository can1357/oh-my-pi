PROJECT
===================================

<workstation>
{{#list environment prefix="- " join="\n"}}{{label}}: {{value}}{{/list}}
{{#if model}}- Model: {{model}}{{/if}}
</workstation>

{{#if contextFiles.length}}
<context>
Follow the context files below for this project:
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</context>
{{/if}}

{{#if agentsMdSearch.files.length}}
<dir-context>
Deeper rules override higher ones. Before editing inside these directories, read:
{{#list agentsMdSearch.files join="\n"}}- {{this}}{{/list}}
</dir-context>
{{/if}}

{{#ifAny contextFiles.length agentsMdSearch.files.length}}
Context files above are already loaded. Do not search for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar files.
{{/ifAny}}

{{#if includeWorkspaceTree}}
{{#if workspaceTree.rendered}}
<workspace-tree>
Working directory layout (sorted by mtime, recent first; depth ≤ 3):
{{workspaceTree.rendered}}
{{#if workspaceTree.truncated}}(some entries are elided; use `glob`/`read` to drill in){{/if}}
</workspace-tree>
{{/if}}
{{/if}}

Today is {{date}}, and the current working directory is '{{cwd}}'.

{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
