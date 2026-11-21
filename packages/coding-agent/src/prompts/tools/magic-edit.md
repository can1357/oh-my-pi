Edit by description.
Per file: `# path`, then one `- ` bullet per change, multiple files batch.
- Bullet: site (line #, class/fn identifier nearby, short substr) + op (what to do?)
- Check the returned diffs; resend a failed file, more exact.

<example>
# src/jobs.ts
- `drain()` > swap `const batch …` and `const lim …`.
- del export `stop(…)`
# src/server.ts
- rep `retrunVal` → `returnVal`.
- ln 88 > del `if OPTIONS` block @ `handle()`
</example>
