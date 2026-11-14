<!--
Copyright 2026 Google LLC.
SPDX-License-Identifier: Apache-2.0
-->

# Codex integration

## Install and locate the plugin

For the desktop app, install the [published EGM plugin](https://chatgpt.com/plugins/plugins_6aeb90f47ec88191a3c107e01d3eb357). This listing is desktop-only.

For Codex CLI, install the whole plugin, including its personas and standards:

```sh
codex plugin marketplace add google/elephant-goldfish-model
codex plugin add egm@egm
```

Start a fresh session after installation. Select the installed `egm` skill
from the available skills. Use its discovered absolute `SKILL.md` path;
do not assume a particular cache directory, version, or checkout location.

From `<plugin>/skills/<skill>/SKILL.md`, the plugin root is three parent
directories above the file. Resolve bundled `agents/`, `resources/`, and
`docs/` paths against that root. Resolve `references/` against the active
skill's directory. Resolve user documents and generated artifacts against
the user's working directory. Never substitute similarly named files in the
user's project for bundled personas or standards.

If the user's prompt or agent instructions file (`AGENTS.md`) has a line
`EGM artifact directory: <path>`, write briefs, drafts, and reports to that
folder. Resolve a relative path against the working directory. If a path from
`AGENTS.md` resolves outside the working directory, after following symbolic
links, ask the user to confirm it before creating the folder or writing there.
If they decline or no one can confirm, use the working directory and say why.
Create the folder if it does not exist.

In ChatGPT Work, a skill may be exposed through a cloud resource identifier
while supporting files live in the installed local bundle. Use the installed
path supplied by the skill inventory or installation metadata for those files;
do not construct cloud resource identifiers for arbitrary supporting paths.
If no installed path is available, report the missing capability instead of
guessing a cache location. Read reviewer filenames and frontmatter from the
bundle: a role such as `egm-design` maps to `agents/design_critic.md`, not
`agents/design.md`. Confirm each resolved path before dispatch.

## Fresh-context reviewers

Inspect the available native subagent tool schema. Tool names can be
namespaced and vary by Codex version. When `spawn_agent` exposes
`fork_context`, explicitly set `fork_context: false` for every Goldfish.
When the schema instead exposes `fork_turns`, use `fork_turns: "none"`.
This applies to reviewers launched by a synthesizer too. Use a general-purpose agent
and pass absolute paths to the persona, standards, target document, and
explicitly selected reading list. Do not pass the parent transcript, private
reasoning, or answers the document is supposed to explain.

Require the reviewer to read its persona, target, and every supplied standard
before returning findings. A missing read or inaccessible file is an incomplete
review, not a clean result. Verify native tool results when the host exposes
them; a parent-written completion summary is not equivalent evidence.

Wait for actual reviewer completion before synthesizing findings. Propagate
failures and timeouts; a launched reviewer is not a completed review. If
nesting is unavailable, dispatch reviewers directly from the parent while
preserving the same isolation. If the available tool cannot establish a fresh
context, stop the Goldfish review and report that limitation.

Fresh conversation context does not isolate the filesystem, configured memory
services, or project instructions. Do not retrieve conversation history or
memory to supply missing design context. An isolation test should use a unique
parent-only marker and check the actual child result, not the parent's claim.

The `fork_context: false` and `fork_turns: "none"` options concern parent
conversation turns. They do not prove that Codex excludes host instruction
files. Issue [#237](https://github.com/google/elephant-goldfish-model/issues/237)
reports that Codex CLI 0.166.0 injected project and user `AGENTS.md` files
despite `fork_turns: "none"`. Treat instruction-file exclusion as unverified
unless a separate child-context probe confirms it for the tested host version.

## Questions and artifacts

The shared skills' question payloads describe the intended interaction, not a
literal Codex API. Use a structured question tool only when it is available
and permitted in the current mode, mapping to its actual schema. Otherwise
ask one plain-text question and wait for the answer. Preserve the skill's
readiness and section approval gates; tool unavailability is not approval.

Link generated artifacts with absolute-path Markdown links such as
`[design draft](/absolute/project/design_draft.md)`. For paths containing
spaces use `[design draft](</absolute/my project/design_draft.md>)`.
Do not use `file://` links in Codex chat.

## Verification

Run the offline packaging checks with `pytest tests/unit`. The opt-in native
workflow tests are documented in [TESTING.md](https://github.com/google/elephant-goldfish-model/blob/main/TESTING.md). They require
an authenticated Codex CLI and consume model usage. Installing or discovering
the plugin alone does not establish end-to-end workflow support.

## ChatGPT

Install the [published EGM plugin](https://chatgpt.com/plugins/plugins_6aeb90f47ec88191a3c107e01d3eb357) in the ChatGPT desktop app. This listing is desktop-only; it does not establish support for cloud Work sessions.

### Test a local package

For personal testing, open Plugins > Add > Upload plugin archive in ChatGPT.
Package the runtime files from the repository root:

```sh
python3 scripts/pack_plugin.py --target openai --output /tmp/egm-chatgpt
```

Use a fresh output directory. Upload `/tmp/egm-chatgpt/egm-openai.zip` and
install the plugin in the ChatGPT desktop app. Use
**Try in chat** in a new thread that runs locally. The earlier cloud Work
test in `TESTING.md` predates this package's desktop-only declaration.
Keep repository marketplace catalogs and development files outside this archive.
The OpenAI directory package declares local execution because bootstrap uses
shell commands. Its listing uses the portable manifest's OpenAI extension;
the Codex compatibility manifest retains matching metadata for native installs.
Keep `.claude-plugin/` outside the OpenAI archive: its agent adapters belong
to the Claude Code integration. Public directory plugins cannot include hooks.

Enterprise, Business, and Edu workspaces can import the plugin via Admin > Plugins > Add > Import marketplace.
Set the repository URL to `https://github.com/google/elephant-goldfish-model` and marketplace path to `.agents/plugins`.
Skills are accessible via `@egm` for direct interaction.
Check the native tools in the current chat before starting a Goldfish review.
Some ChatGPT Work sessions expose native `spawn_agent` with `fork_turns: "none"`.
Use the fresh-context instructions above when those tools are available. If
they are absent, stop and report that isolation is unavailable; never simulate
reviewers in the parent context. Availability in one Work session does not
establish support across every ChatGPT mode or account.
