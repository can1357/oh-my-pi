## Code Review Request

### Mode

{{mode}}

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#if prDiffUrl}}
Index is the file's 1-based position in the full PR diff; excluded files leave gaps. Assign each file with its exact Diff URL below.

{{#table files headers="Index|File|+/-|Type|Diff URL"}}
{{diffIndex}} | {{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}} | `{{diffUrl}}`
{{/table}}
{{else}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{/if}}
{{else}}
_No files to review._
{{/if}}

{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

Use the `task` tool with a `tasks` array. Set `agent: "reviewer"` inside every `tasks[]` item (`tasks[].agent`), never at the top level or omitted.
{{#when agentCount "==" 1}}Create exactly **1 reviewer task**.{{else}}Spawn **{{agentCount}} reviewer agents** in parallel.{{/when}}
{{#if multiAgent}}
Group files by locality, e.g.:
- Same directory/module → same agent
- Related functionality → same agent
- Tests with their implementation files → same agent
{{/if}}

### Reviewer Instructions

Reviewer MUST:
1. Focus ONLY on assigned files
2. {{#if skipDiff}}{{#if prDiffUrl}}MUST read assigned PR file diffs using the exact Diff URL in the Changed Files table or `{{prDiffUrl}}/all`; NEVER use local `git diff`/`git show` for PR diff content{{else}}{{#if diffInstruction}}{{diffInstruction}}{{else}}MUST run `git diff`/`git show` for assigned files{{/if}}{{/if}}{{else}}MUST use diff hunks below (NEVER re-run git diff){{/if}}
3. {{#if suppliedPatch}}NEVER read local workspace files for file context; the supplied diff may not match the checkout{{else}}{{#if prDiffUrl}}MUST NOT read local workspace files for PR file context; use the fetched PR diff, the exact Diff URL in the Changed Files table, or `{{prDiffUrl}}/all` only{{else}}{{#if contextInstruction}}{{contextInstruction}}{{else}}MAY read full file context as needed via `read`{{/if}}{{/if}}{{/if}}
4. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool

{{#if skipDiff}}
### Diff Previews

_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### Additional Instructions

{{additionalInstructions}}
{{/if}}
