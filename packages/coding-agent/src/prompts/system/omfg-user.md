<omfg>
The user is frustrated about recurring agent behavior.
Author ONE Time Traveling Stream Rule (TTSR) that would have caught the offending behavior earlier in this conversation.

TTSR mechanics:
- A rule is a markdown file with YAML frontmatter.
- `condition` is one or more JavaScript regex patterns tested against assistant streamed output.
- `scope` is a comma-separated allowlist. If present, only listed streams are checked.
- `text` = assistant prose only. `thinking` = hidden reasoning summaries. `tool` = every tool's arguments.
- `tool:<name>(<glob>)` = one tool, only when path-like args match the glob. Examples: `tool:write(*.rb)`, `tool:edit(*.ts)`.
- SHOULD use file-specific tool scopes for code complaints. Ruby code generated through `write` → `tool:write(*.rb)`, not bare `tool` or `text`.
- Tool arguments may be serialized while streaming. Conditions for code containing quotes SHOULD tolerate JSON escaping.
- When `condition` matches within `scope`, the stream is interrupted and the markdown body is injected as correction guidance.

Output contract:
- Emit exactly one JSON object and nothing else.
- JSON fields: `name`, `description`, `condition`, `scope`, `body`.
- `name` MUST be kebab-case.
- `description` MUST be a one-line summary.
- `condition` MUST be a string or string array of JavaScript regex patterns.
- `condition` MUST match the specific offending assistant output visible earlier in this conversation.
- Escape regex backslashes for JSON exactly once: use `"\\beval\\s*\\("`, NEVER `"\\\\beval\\\\s*\\\\("`.
- Keep `condition` precise; NEVER use broad catch-alls.
- `scope` MUST be a string or string array.
- Keep `scope` as narrow as the complaint allows. NEVER use `tool, text` unless the same bad behavior occurred in both tool arguments and assistant prose.
- `body` MUST be markdown guidance explaining the right behavior concisely.
- The caller assembles YAML frontmatter. NEVER emit markdown frontmatter or a fenced code block around the JSON.

Example shape:
{
  "name": "ts-no-any",
  "description": "Never use `any` in TypeScript — use `unknown`, a generic, or the real type",
  "condition": ": any|as any",
  "scope": ["tool:edit(*.ts)", "tool:edit(*.tsx)", "tool:write(*.ts)", "tool:write(*.tsx)"],
  "body": "Never use `: any` or `as any`. Use `unknown`, a domain type, a generic, or a type guard."
}

Complaint:
{{complaint}}

{{#if feedback}}
Failed attempts or requested amendments so far:
{{feedback}}

Latest candidate JSON:
{{previousRule}}

Regenerate one corrected rule. Fix the listed validation failures or user amendment. NEVER repeat failed scopes or conditions.
{{/if}}
</omfg>
