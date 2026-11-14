<!--
Copyright 2026 Google LLC.
SPDX-License-Identifier: Apache-2.0
-->

# Claude Code integration

Use Claude Code 2.1.271 or later for `omitClaudeMd` support. Older versions
must not be treated as verified Goldfish isolation environments.

## Invocation and resources

```sh
claude plugin marketplace add google/elephant-goldfish-model
claude plugin install egm@egm
```

Enable the installed plugin with `claude plugin enable egm@egm`.
Start messages with `/egm:egm-brainstorm`, `/egm:egm-draft`, or `/egm:egm-review`.
Skills retain `disable-model-invocation: true`: their absence from automatic
skill discovery is expected. The `Skill` tool refuses these skills, so to run
another EGM skill (for example `egm-review-loop` or `egm-resolve` during review
Stages 7 and 9), read its `SKILL.md` and follow it in the same thread. Do not
use the `Skill` tool for EGM skills. Keep drafting and orchestration in the
main context.
Claude Code has no artifact comments. To request draft revisions, edit
`design_draft.md` directly or add `<!-- -->` comments in it, or give the notes
in chat; the model reads the draft again before each revision.
Write briefs, drafts, and reports to the user's working directory. The
per-session scratchpad is not the artifact directory: it belongs to one
session, and the deliverables must outlive it.
If the user's prompt or agent instructions file (`CLAUDE.md` or `AGENTS.md`)
has a line `EGM artifact directory: <path>`, write them to that folder instead.
Resolve a relative path against the working directory. If a path from an
instructions file resolves outside the working directory, after following
symbolic links, ask the user to confirm it before creating the folder or
writing there. If they decline or no one can confirm, use the working directory
and say why. Create the folder if it does not exist.
In Claude Code, `egm:egm-synthesizer` may spawn reviewers (nesting is allowed
up to 3 levels by default), or the main context may dispatch reviewers directly.
In Claude Cowork, subagents cannot spawn further subagents, so dispatch
reviewers directly from the main context instead of launching a synthesizer
child. In both cases the main context collects findings and writes the report.
Keep review stages 5, 6, 7, 8, and 9 sequential. Parallelize only reviewers
within the current stage. Wait for every reviewer in that stage, write its
report, and complete required remediation before dispatching the next stage.
Uninterrupted mode skips human checkpoints, not these stage dependencies.

Claude substitutes `${CLAUDE_PLUGIN_ROOT}` in plugin skill and agent bodies. Use that
resolved absolute root for `agents/`, `resources/`, and `docs/`; use the invoked
skill's directory for its `references/`. This standalone guide is read as a file,
so placeholders here are explanatory: use the root already resolved in the
invoked skill. Never guess a cache version or search another installed copy.
Review targets and generated artifacts belong to the user's workspace, not the
plugin cache. Pass absolute resource and target paths to each reviewer.

Personas and standards live in the plugin cache, outside the project. EGM
does not install a permission-approval hook. Approve resource reads through
Claude Code's normal permission prompts; current versions can surface background
reviewer prompts in the parent session. For headless runs, the user must grant
read access to the resolved plugin's `agents/`, `docs/`, `resources/`, and
`skills/` folders using Claude Code's permission settings. Keep write access
limited to the project, the intended output directory, and the session or
private scratch directory used for temporary files. A `mktemp -d` path can't be
named in a rule in advance, so a headless run can't use one without a rule for
its parent folder. Do not disable permission
checks or grant access to every installed plugin. A reviewer that cannot read
its persona or standard must report the limitation and stop; it has not reviewed.

For example, after resolving the actual installed plugin directory, add only
its resource folders to user-approved read rules in `/permissions`:

```text
Read(//absolute/plugin/path/agents/**)
Read(//absolute/plugin/path/docs/**)
Read(//absolute/plugin/path/resources/**)
Read(//absolute/plugin/path/skills/**)
```

On Windows, write the absolute path either with a leading `//` and a lower-case
drive letter without the colon, or as a native path:

- `Read(//c/Users/<you>/.claude/plugins/cache/egm/egm/<version>/agents/**)`
- `Read(C:\Users\<you>\.claude\plugins\cache\egm\egm\<version>\agents\**)`

The form `//C:/Users/...` does not match, and the reads are still denied.

A marketplace install lives in a version folder:
`.../plugins/cache/<marketplace>/egm/<version>/`. A rule that names one version
stops matching after an update. Replacing only the version segment with `*` keeps
matching across versions and still covers only this plugin's folders. For example,
on Windows:

```text
Read(//c/Users/<you>/.claude/plugins/cache/egm/egm/*/agents/**)
Read(//c/Users/<you>/.claude/plugins/cache/egm/egm/*/docs/**)
Read(//c/Users/<you>/.claude/plugins/cache/egm/egm/*/resources/**)
Read(//c/Users/<you>/.claude/plugins/cache/egm/egm/*/skills/**)
```

Replace the example path; do not copy a guessed cache location. These read rules
also cover Grep and Glob on those files on a best-effort basis. Adding a directory
with `--add-dir` extends edit access too, so it is not a read-only substitute.

## Claude Code Warning: Default agents/ folder is ignored

In Claude Code (`/plugin` > Errors), you may see the following advisory warning:

```text
Default agents/ folder is ignored because the manifest sets "agents"
```

This specific advisory is expected with EGM's explicit adapter list. It does not
mean the registered adapters failed to load; investigate other errors separately.

EGM maintains two agent directories:
1. `agents/`: Contains canonical, harness-agnostic reviewer persona markdown prompts loaded by Antigravity and other harnesses.
2. `.claude-plugin/agents/`: Contains Claude Code adapters. Reviewer adapters use
   `omitClaudeMd: true` and `tools: [Read, Grep, Glob]`; the synthesizer and bootstrap
   orchestrator have their own tool lists, described below.

Because `.claude-plugin/plugin.json` explicitly lists the adapters in `"agents"`,
Claude Code skips auto-loading the root `agents/` folder. The shared personas do
not declare Claude's read-only tool restrictions. Auto-loading them instead would
lose the adapter-specific restrictions; available tools would still be subject to
the host's permissions. Registering both copies would also duplicate reviewer
names. Keep the explicit adapter list rather than removing it to silence this notice.

## Reviewer isolation

Spawn a new native Agent of the plugin's registered reviewer type for each
independent review, for example `egm:egm-zoom-out`. Do not fork the conversation
or resume a previous reviewer. Provide only the task, target, persona/standard
paths, and explicitly supplied Goldfish context; do not copy parent deliberation.

Claude adapters in `.claude-plugin/agents/` declare `tools: [Read, Grep, Glob]`,
`model: inherit`, and `omitClaudeMd: true`. Each adapter reads its canonical
persona from `agents/` through `${CLAUDE_PLUGIN_ROOT}`. Keep Claude tool names
out of shared persona frontmatter: other hosts can interpret `tools` themselves.
Reviewers cannot edit files or run shell commands, and no persistent `memory`
is configured. The synthesizer adapter declares
`tools: [Agent, Read, Grep, Glob, Write]` so it can spawn reviewers and write
reports but cannot run shell commands or use the session's MCP connectors.
A plugin subagent's `tools` field cannot restrict Write to specific paths, and
Claude Code ignores `hooks` and `permissionMode` in plugin subagents. The
adapter's rule to write only the requested report or brief is therefore an
instruction, not a host-enforced limit. Writes still follow the session's
permission rules. When you spawn `egm:egm-synthesizer`, name the artifact
directory you are using in its task. Otherwise it never sees a line from the
user's prompt, and it drops a folder outside the working directory that only
agent instructions name. It has no shell, so it checks that path as written and
does not follow symbolic links.
The bootstrap orchestrator adapter allows only `Agent`, `Bash`, `Read`, `Grep`,
`Glob`, `Write`, and `Edit` for local discovery and documentation. It routes
workers to the bootstrap `SKILL.md` so they return the JSON `subtree_index`
instead of prose. The parent handles fixes. Bash remains subject to normal
permission rules and is not a filesystem or network sandbox.
Reviewers cannot open URLs. Do not pass documentation URLs in
`GoldfishContext` to Claude reviewers: save the raw page as a file in the
workspace and pass that path instead.

Normal subagents exclude parent conversation history. `omitClaudeMd` additionally
excludes user/project/local instruction files, but managed policies still apply.
This is context and tool isolation, not filesystem isolation: reviewers can read
accessible files. Pass any required review constraints explicitly and keep
unrelated history, logs, and memory out of the review task.

For local testing, load a uniquely named copy with `claude --plugin-dir <copy>`
to avoid confusion with an already installed `egm` plugin. Validate it with
`claude plugin validate <copy>/.claude-plugin/plugin.json`.

## Claude Cowork

Claude Cowork uses the same `.claude-plugin` package as Claude Code.
Install the plugin from claude.ai/plugins or the Cowork plugin panel via marketplace `google/elephant-goldfish-model`.
For a candidate package, Customize > Plugins > Add plugin > Upload plugin
accepts a ZIP containing the Claude manifest, adapters, and shared runtime files.
Install it and choose **Try in chat**. Record whether the resulting task runs
locally or in the cloud; the tested desktop surface used cloud tasks.
Verify resource resolution and reviewer tools in the actual Cowork session.
Installation alone does not establish that Claude Code's subagent settings or
`${CLAUDE_PLUGIN_ROOT}` substitution work on that surface.
Local testing with `claude --plugin-dir` is supported in Claude Code only.

References: [plugin paths](https://code.claude.com/docs/en/plugins-reference),
[skill invocation](https://code.claude.com/docs/en/skills), and
[subagent context and tools](https://code.claude.com/docs/en/sub-agents).
