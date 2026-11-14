# Harnesses

EGM is one set of skills and personas. This repository serves as the
plugin source for each supported harness. No harness gets a fork of the skill
text.

## Install

| Harness | Install |
| --- | --- |
| ChatGPT desktop | Install the [published EGM plugin](https://chatgpt.com/plugins/plugins_6aeb90f47ec88191a3c107e01d3eb357) (desktop-only listing); see [packaging](codex.md#test-a-local-package) for personal testing |
| Codex desktop | Install the [published EGM plugin](https://chatgpt.com/plugins/plugins_6aeb90f47ec88191a3c107e01d3eb357) (desktop-only listing) |
| Antigravity CLI | `agy plugin install https://github.com/google/elephant-goldfish-model` |
| Antigravity App | Run `/plugin` or see [installation instructions](#antigravity-app-and-antigravity-for-ides) |
| Antigravity for IDEs | Run `/plugin` or see [installation instructions](#antigravity-app-and-antigravity-for-ides) |
| Antigravity IDE (standalone) | Not supported; see [installation instructions](#antigravity-app-and-antigravity-for-ides) |
| Claude Code | `claude plugin marketplace add google/elephant-goldfish-model && claude plugin install egm@egm` |
| Claude Cowork | Install from claude.ai/plugins or the Cowork plugin panel via marketplace `google/elephant-goldfish-model` |
| Codex CLI | `codex plugin marketplace add google/elephant-goldfish-model && codex plugin add egm@egm` |
| ChatGPT workspace import | Admin > Plugins > Add > Import marketplace, repo URL `https://github.com/google/elephant-goldfish-model`, path `.agents/plugins`; cloud review limits still apply |
| omp | `omp plugin marketplace add google/elephant-goldfish-model && omp plugin install egm@egm` |
| Muse | `git clone https://github.com/google/elephant-goldfish-model.git && muse plugins install ./elephant-goldfish-model --scope user && muse plugins approve egm` |

Install the whole plugin. Skill-only installers that copy `skills/` alone
break EGM, because the skills read `agents/` and
`resources/document_standards/` at run time.

### Antigravity App and Antigravity for IDEs

- **Antigravity App**: Run `/plugin`, ask the agent `Install https://github.com/google/elephant-goldfish-model`, or manually install into `~/.gemini/config/plugins/egm/` using the commands below.
- **Antigravity for IDEs (Extension for Visual Studio Code)**: Run `/plugin`, ask the agent `Install https://github.com/google/elephant-goldfish-model`, or manually install into `~/.gemini/config/plugins/egm/` using the commands below.
- **Antigravity IDE (Standalone)**: Not supported at this time. Although the plugin and skills load from `~/.gemini/config/plugins/egm/`, standalone Antigravity IDE (tested on macOS and Linux) does not expose the fresh-context subagent tool (`invoke_subagent`) required for Goldfish reviews (`/egm-brainstorm` and `/egm-review`).

The Antigravity App and Antigravity for IDEs share the global plugin directory
`~/.gemini/config/plugins/<name>/`. For a fresh manual installation without the
`agy` CLI, copy the full runtime bundle into `~/.gemini/config/plugins/egm/`
(copying into an existing plugin directory can leave obsolete files behind, so
remove `~/.gemini/config/plugins/egm` first when updating):

```sh
git clone https://github.com/google/elephant-goldfish-model.git
cd elephant-goldfish-model
mkdir -p ~/.gemini/config/plugins/egm
cp -R plugin.json README.md LICENSE skills agents resources docs assets ~/.gemini/config/plugins/egm/
```

Reload the window (or restart the Antigravity App), then confirm that `egm`
appears in the plugin list and that its skills (`egm-brainstorm`, `egm-draft`,
`egm-review`) are available. The command form for these skills in the
Antigravity App and Antigravity for IDEs has not been verified.

## Manifests

Root `plugin.json` is the canonical source for plugin identity, version,
description, and publisher metadata. It follows the portable Agent Plugins
1.0.0 format; the `$schema` key is omitted because omp routes manifests that
declare it to a strict validator that rejects `disable-model-invocation`.
Update shared values there first, then update the compatibility
manifests; unit tests reject metadata drift. Keep platform-specific fields in
their existing manifests until installation tests justify removing them.

Marketplace files are discovery catalogs pointing to this package, not copies
of its skills. In particular, `.agents/plugins/` contains the Codex catalog,
while `agents/` contains reviewer personas. All hosts share the same `skills/`,
`agents/`, and `resources/` content.

| Harness | Manifest | Skills | Subagents |
| --- | --- | --- | --- |
| Antigravity | `plugin.json` | `skills/` (default) | `agents/` (default) |
| Claude Code | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | `skills/` (default) | Claude adapters and orchestrators listed in `plugin.json` `agents` |
| Claude Cowork | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | `skills/` (default) | Subagents run inside Cowork; hooks n/a |
| Codex | `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` | `skills` path | Not shipped; general-purpose subagent reads the persona file |
| ChatGPT | `plugin.json`, `.codex-plugin/plugin.json`; `.agents/plugins/marketplace.json` for workspace import | `skills` path | Detect native tools in the current session; general-purpose agent reads the persona |
| omp | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (Claude-compatible fallback) | `skills/` (default) | Personas from `agents/`/`.claude-plugin/agents/` register as native `task` agents |
| Muse | `.claude-plugin/plugin.json` (Claude-compatible fallback) | `skills/` (default) | 10 adapters import as agents; tool projections unsupported |

Persona prompts live in `agents/`, the directory Antigravity
scans for subagents. Each persona has `name` and `description` frontmatter, so
harnesses that load `agents/*.md` register them as named subagents
(`egm-design`, `egm-zoom-out`, and so on).

When you add a reviewer persona, add a Claude adapter under
`.claude-plugin/agents/` and list it in `.claude-plugin/plugin.json`.
The adapter reads the shared persona and sets Claude's read-only tools and
context isolation. This avoids imposing Claude tool names on other hosts.
In Claude Code, `/plugin` > Errors will report that the default `agents/` folder is ignored because the manifest sets `"agents"`; this warning is expected and harmless (see [Claude integration](claude.md#claude-code-warning-default-agents-folder-is-ignored)).

## Delegation

Skills say "spawn a subagent" and name a persona. Each harness maps that
phrase to its own tool:

| Harness | Subagent tool | Named personas | Nesting |
| --- | --- | --- | --- |
| Antigravity | `invoke_subagent` | Yes | Yes |
| Claude Code | Agent (Task) tool | Yes | Up to 3 levels by default |
| Claude Cowork | Cowork subagents | Yes | Subagents run inside Cowork |
| Codex | Native spawn/wait tools; inspect the available schema | No | Detect at runtime; direct dispatch fallback |
| ChatGPT | Native spawn/wait tools when exposed by the current Work session | No | Detect at runtime; direct dispatch fallback |
| omp | `task` tool | Yes | Yes |
| Muse | Native subagents; inspect the available schema | Named spawn rejected in 1.4.14; general-purpose fallback verified | Detect at runtime; direct dispatch fallback |

Where a harness has no named persona, the skill spawns a general-purpose
subagent and tells it to read `agents/<file>.md` first. If a harness cannot
nest subagents, use direct dispatch instead of the synthesizer.

A Goldfish review needs a fresh context. If a harness has no subagent tool,
the review skills stop instead of running in the same context. Check actual
tool availability rather than inferring it from the product name. This applies
to standalone Antigravity IDE and to ChatGPT modes that do not expose native
fresh-context delegation.

Fresh conversation context does not mean that the host omits its instruction
files. Codex's `fork_context: false` and `fork_turns: "none"` isolate parent
turns; they do not establish that project or user instructions are excluded.
Keep stable workspace conventions in instruction files. State review
assumptions that the Goldfish must challenge as explicit review criteria.

## Artifact Directory

Skills write briefs, drafts, and reports to the working directory, or to the
harness's artifact directory if it has one. In Claude Code, Claude Cowork,
Codex, and ChatGPT, you can name another folder. Add this line to your prompt,
or to an agent instructions file that your harness loads (`CLAUDE.md` or
`AGENTS.md`, in the project or at user level):

```text
EGM artifact directory: .dev/docs
```

A relative path is relative to the working directory. If a path set in an
instructions file resolves outside the working directory, after following
symbolic links, EGM asks you to confirm it before creating the folder or
writing there. If you decline or no one can confirm, as in a headless run, the
files go to the working directory. The answer isn't saved, so a new session
asks again. A path in your prompt needs no confirmation. Design docs and other
project files do not move. Claude Code reads a project `AGENTS.md` only when
the project has no `CLAUDE.md`.

Commit approved specifications in `docs/designs/` and project rules in
`AGENTS.md`. Teammates and agents then use the same committed files. Add
`.dev/docs` to `.gitignore` only to keep scratch drafts out of git before
approval.

## Support Status & Contributing Other Harnesses

**Antigravity CLI**, **Claude Code**, and **Codex** pass automated installation
and end-to-end workflow fixtures. Reviewer isolation evidence is narrower:
parent-turn isolation and host-instruction exclusion are separate results.

Claude reviewer adapters set `omitClaudeMd: true`; see the
[Claude integration](claude.md#reviewer-isolation). For Codex, issue [#237](https://github.com/google/elephant-goldfish-model/issues/237)
reports that Codex CLI 0.166.0 supplied project and user `AGENTS.md` files
despite `fork_turns: "none"`. For Antigravity CLI, the same issue reports
project `AGENTS.md` and `GEMINI.md` in reviewer context. These are reported
host-instruction leaks, not evidence that parent conversation turns leaked.
The Codex test and recorded Antigravity run check parent-turn isolation only;
neither verifies instruction-file exclusion. No host-specific exclusion
control is verified here for Codex or Antigravity.

**Claude Cowork** ([#105](https://github.com/google/elephant-goldfish-model/issues/105)) and **ChatGPT Work** ([#106](https://github.com/google/elephant-goldfish-model/issues/106)) have working installation paths with open cloud trace verification gaps. The README's prefix guidance covers only Antigravity (agy CLI), Claude Code, and Codex. For ChatGPT workspace imports, the skills are reached through `@egm` (see [ChatGPT](codex.md#chatgpt)); the command form in Claude Cowork is not recorded yet.

**omp** ([#186](https://github.com/google/elephant-goldfish-model/issues/186)) has a working installation path. Skills are invoked as `/skill:egm-<command>` (omp registers one command per skill; it has no `/egm-*` namespace). Community-verified on omp v18.12.6: all seven skills discover and resolve, and all nine reviewer personas register as subagents. End-to-end workflow fixtures are not yet automated for omp.

**Muse** (1.4.14) has a working installation path. `muse plugins validate` reports the plugin valid with all seven skills and all ten agent adapters supported; every agent tool projection is unsupported, so Claude tool allowlists do not restrict Muse reviewers. Install from a local path; `marketplace add` on this repository discovers zero plugins because Muse reads the Codex catalog first. End-to-end workflow fixtures passed on 2026-10-30 (brainstorm, draft, and uninterrupted review with 15 fresh-context reviewers); named `egm/egm-*` agents cannot be spawned in this runtime, so reviewers used the general-purpose fallback reading the installed persona first. See the [Muse guide](https://github.com/google/elephant-goldfish-model/blob/main/docs/muse.md). No skill routes a Muse session to that guide yet ([#252](https://github.com/google/elephant-goldfish-model/issues/252)), so point the session at it.

**Windsurf** (renamed Devin Desktop on 2026-06-02; [#376](https://github.com/google/elephant-goldfish-model/issues/376)) has experimental workspace routing. The rule and workflow files resolve the shared `skills/*/SKILL.md`, `agents/*.md`, and `resources/document_standards/*.md` files directly. They do not copy skill text. Goldfish reviews stop if fresh-context, read-only subagent delegation is unavailable, and reviewers launch on the host's read-only subagent profile. Devin CLI 3000.12.43 runs on 2026-11-10 passed routing, human pauses, read-only reviewers, and parent-marker isolation with every file write denied, so no workflow ran to a final artifact. Devin Desktop and the Devin CLI run the same agent, Devin Local, which replaced Cascade. The Devin Desktop IDE remains untested. The CLI does not list `.windsurf/workflows/` as slash commands; `/egm-*` requests route through the rule. Denying a permission prompt ends the host's turn without a message; send a follow-up message to continue. See the [design](https://github.com/google/elephant-goldfish-model/blob/main/docs/designs/windsurf_support.md#recorded-cli-evidence-2026-11-10) for the evidence.

See the [harness test record](https://github.com/google/elephant-goldfish-model/blob/main/TESTING.md#harness-test-record) for tested surfaces and limits.

We welcome contributors who want to help verify and expand harness support.

### Contributing Support for New Harnesses

A harness counts as supported after `/egm-brainstorm`, `/egm-draft`, and
`/egm-review` run end to end through its plugin install. When contributing
support for another harness:

1. Add the appropriate manifest or configuration file to the repository root
   (e.g., matching the harness's plugin/extension standard).
2. Document install steps, manifest mapping, and delegation mechanics in this guide
   (`docs/harnesses.md`).
3. Verify that `/egm-brainstorm`, `/egm-draft`, and `/egm-review` run end to end,
   and attach verification notes or execution transcripts in your Pull Request description
   (as outlined in the [Pull Request Template](https://github.com/google/elephant-goldfish-model/blob/main/.github/PULL_REQUEST_TEMPLATE.md)).
