Propose conventional commit for staged changes.

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
{{#each existing_changelog_entries}}
### {{path}}
{{#each sections}}
{{name}}:
{{#list items prefix="- " join="\n"}}{{this}}{{/list}}
{{/each}}
{{/each}}
{{/if}}

Inspect staged changes: git_* tools. Deeper per-file summaries: call analyze_files. Finish: propose_commit | split_commit.
