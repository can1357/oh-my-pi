<critical>
MUST continue until current branch CI green; NEVER stop after one fix attempt.
</critical>

<instruction>
SHOULD use `github` with `op: run_watch` and no other args, if available; else `gh` cli.
Workflow runs for current HEAD: source of truth after each push.
</instruction>

<procedure>
1. Watch workflow runs for current HEAD commit.
2. Failed run → inspect failing job output and logs.
3. Identify root cause; make minimal correct fix.
4. Run local verification if it reduces chance of another failed push.
{{#if headTag}}5. Push branch and tag `{{headTag}}` atomically: `git push --atomic "{{remote}}" "{{branch}}" "+refs/tags/{{headTag}}"`.{{else}}5. Push branch.{{/if}}
6. Watch workflow runs for new HEAD commit.
7. Repeat until workflow runs for latest HEAD commit succeed.
</procedure>

<caution>
Each push: fresh CI attempt; immediately re-watch new HEAD.
Insufficient watcher output → inspect underlying workflow or job context before code changes.
</caution>

{{#if headTag}}
<instruction>
Push branch/tag together: tag NEVER points at un-pushed or non-green commit. `--atomic`: branch/tag updates succeed or fail as one ref transaction; `+refs/tags/{{headTag}}`: force-moves tag to new HEAD. NEVER push branch first and retag later.
</instruction>
{{/if}}

<critical>
Complete only when workflow runs for latest HEAD commit succeed.
{{#if headTag}}Latest HEAD commit MUST carry tag `{{headTag}}`, pushed atomically with branch via `git push --atomic`.{{/if}}
</critical>
