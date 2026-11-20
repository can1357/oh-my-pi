## Commit Request

The user ran `/commit`{{#if instructions}} with: {{instructions}}{{/if}}

Commit the changes you and your subagents made, nothing else. Other agents and the user edit this worktree concurrently.

### Draft

Every changed line of the repository, attributed from your edit journal:

```
{{summary}}
```
{{#if recent.length}}

### Recent subjects

{{#each recent}}
- {{this}}
{{/each}}
{{/if}}

<instruction>
- Use the eval `commit` namespace; `d = await commit.draft()` rebuilds this draft (pass `agents=` when the user named a scope). When Review is empty and Selected matches your work, commit in that same cell.
- Resolve each `?` item: `await d.show()` lists them; `take`/`drop` by path, unit, or grep. Files a generator, formatter, or script you ran rewrote are yours.
- Split unrelated work into separate commits with `only()`; draft again after each commit.
- Follow the repository's commit conventions for the subject and body.
- Do not run tests, builds, or other verification; the user asked for a commit.
</instruction>

<critical>
NEVER use `git add`, `git commit`, `git stash`, `git reset`, `git checkout`, or `git restore` for this commit.
</critical>
