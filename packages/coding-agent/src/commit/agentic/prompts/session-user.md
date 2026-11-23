{{#if amend}}
Propose conventional commit replacing the last commit's message.
Diff = last commit's parent vs staged index: the last commit's changes plus what is staged now. Describe all of it.
{{else}}
Propose conventional commit for staged changes.
{{/if}}

{{#if user_context}}
User context:
{{user_context}}
{{/if}}

{{#if changelog_targets}}
For changelog targets: MUST call propose_changelog.
{{changelog_targets}}
{{/if}}

{{#if existing_changelog_entries}}
## Existing Unreleased Changelog Entries
May remove listed entries via propose_changelog `deletions`.
{{#if amend}}
The commit being amended may have added some of these entries already: NEVER propose them again.
{{/if}}
{{#each existing_changelog_entries}}
### {{path}}
{{#each sections}}
{{name}}:
{{#list items prefix="- " join="\n"}}{{this}}{{/list}}
{{/each}}
{{/each}}
{{/if}}

{{#if amend}}
Inspect the amended commit's changes: git_* tools (staged=true covers the whole commit). Deeper per-file summaries: call analyze_files. Finish: propose_commit.
{{else}}
Inspect staged changes: git_* tools. Deeper per-file summaries: call analyze_files. Finish: propose_commit | split_commit.
{{/if}}
