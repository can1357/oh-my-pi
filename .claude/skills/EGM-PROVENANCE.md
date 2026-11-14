# Elephant-Goldfish Model vendoring provenance

Source: <https://github.com/google/elephant-goldfish-model>
Inspected source commit: `964a4f1ecd333961375c35cb37ed09364dab5e4e`
Retrieved: 2026-11-14
License: Apache-2.0; unchanged upstream [LICENSE](LICENSE).
The upstream commit has no `NOTICE`; [NOTICE](NOTICE) is an explicitly local
vendoring notice, not invented upstream legal text.

## Copied scope and layout

All 59 copied files are byte-identical to the pinned source. No upstream
instructions, personas or standards were edited. This package includes:

| Upstream path | Repository destination | Why copied |
|---|---|---|
| `skills/egm-brainstorm/` | `.claude/skills/egm-brainstorm/` | Requested brainstorm skill, metadata, icon and source test descriptions |
| `skills/egm-draft/` | `.claude/skills/egm-draft/` | Requested draft skill and its design-document reference |
| `skills/egm-resolve/` | `.claude/skills/egm-resolve/` | Requested finding-resolution skill |
| `skills/egm-review/` | `.claude/skills/egm-review/` | Requested staged review skill |
| `skills/egm-review-loop/` | `.claude/skills/egm-review-loop/` | Requested fresh-context review driver |
| `skills/egm-bootstrap/` | `.claude/skills/egm-bootstrap/` | Requested bootstrap skill, templates and worker schema |
| `skills/egm-drift-report/` | `.claude/skills/egm-drift-report/` | Requested drift-report skill |
| `agents/*.md` | `.claude/agents/*.md` | All ten canonical reviewer/orchestrator personas used by the skills |
| `resources/execution_instructions.md` | `.claude/resources/execution_instructions.md` | Referenced execution constraints |
| `resources/document_standards/*.md` | `.claude/resources/document_standards/*.md` | Five referenced review standards |
| `docs/{codex,claude,harnesses}.md` | `.claude/docs/{codex,claude,harnesses}.md` | Referenced host integration and isolation guidance |
| `TESTING.md` | `.claude/TESTING.md` | Playbook linked from all seven skill test descriptions |
| `LICENSE` | `.claude/skills/LICENSE` | License beside the vendored skills |

No upstream repository `AGENTS.md`, plugin manifest, executable hook, website,
package manifest/lockfile or test runner was imported. The small per-skill
`TEST.md` and `test_scenarios.yaml` files are upstream descriptions, not evidence
that these workflows were run in OMP2. Root `resources/README.md` was not needed
by execution and was excluded with the broader upstream documentation index.

The bundle root is **`.claude/`**, preserving the upstream `skills/`, `agents/`,
`resources/`, `docs/` relationship. Thus each `egm-*/SKILL.md` link to
`../../docs/codex.md` resolves correctly. Bare upstream paths such as
`agents/design_critic.md` are rooted at `.claude/`, not the project root.
Skill-local `references/` stays relative to that skill directory.

In an actual plugin installation, Claude resolves `${CLAUDE_PLUGIN_ROOT}`.
This is project-local vendoring, not a plugin installation: that variable is
**not guaranteed to exist or be substituted**. A manual invocation must use
the discovered absolute `.claude/` bundle path for bundled resources. Do not
guess an unrelated installed plugin root. No settings/environment hooks were
added to manufacture the variable or install the plugin automatically.

## Operational boundary

Vendoring does not invoke these workflows or make their author-approval gates
global project rules. Follow the selected workflow only when invoked; user
instructions and the repository's `AGENTS.md` remain authoritative. Repo-native
ADR and research formats remain the formats for committed OMP2 artifacts.
The independently authored OMP2 skills beside these files retain their own
license and instructions; this vendored Apache license does not cover them.

These are EGM's **canonical personas**, not its Claude-specific plugin adapters.
Putting a read-only instruction in a prompt is not OS/tool permission enforcement.
Explicitly restrict fresh reviewer tools at the host boundary and verify the
host supports the required isolation before claiming a Goldfish review. Do not
claim the plugin adapter's `omitClaudeMd`, tool allowlists or registered agent
behavior from these copied prompt files. No skill discovery, reviewer isolation,
Claude variable substitution or end-to-end workflow execution is certified by
this vendoring change. Upstream docs describe other hosts/versions, including
OMP1; those statements are not evidence of OMP2 integration.

## Integrity fingerprints

SHA-256 over each unchanged skill entry point:

| Skill | SHA-256 |
|---|---|
| `egm-bootstrap/SKILL.md` | `e09ab29c45907a6cc3993a8cdf49f5672478f661f07241531ae907e39617a84f` |
| `egm-brainstorm/SKILL.md` | `a660b44e3cfdd23da8e8ecff2ff1aa01accb96ad2a823b67c90f89fc188ec7e8` |
| `egm-draft/SKILL.md` | `2c107ecd3751635df1eedef261c7e14a79e7bb9429d20753c3f0df5834e1dbec` |
| `egm-drift-report/SKILL.md` | `c000ffe2e77a9fe74ee6915b314e1547337c95c79a19014c44fd976dc6511476` |
| `egm-resolve/SKILL.md` | `fe12b8712f88b51780d817e6c8f0ac5e7a29961ee111d0fd19bfc2f738d2f531` |
| `egm-review/SKILL.md` | `a17ee3b983bcd77000099bedf014db84a7a6e6f3245c712acd84a4f119b6b58c` |
| `egm-review-loop/SKILL.md` | `844b174055d32a7394f1096964a289987272109fff531a080fc9c3c9acef26fa` |

License SHA-256:
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.

Aggregate copied-file manifest SHA-256:
`3d12cec49d24c644e1592cbd74df9cc7544b961dad3832df7b24c99c138becfb`.
The unchanged test playbook SHA-256 is
`856b0490809db8f3192fd6af0234caae3682786c52ea9e1ec6d6093ef4315bde`.
To reproduce, enumerate exactly the 59 destination files in the scope table
(excluding this provenance and local NOTICE), calculate each file's SHA-256,
make one UTF-8 record `path-relative-to-.claude + NUL + lowercase-hash + LF`,
sort records lexicographically by path, concatenate and SHA-256 the result.
Do not include unrelated OMP2 skills when checking this fingerprint.

Validation executed: source/destination byte comparison for all 59 copied files;
seven `../../docs/codex.md` and seven `../../TESTING.md` links resolved; skill frontmatter and bundled
persona/standard paths inspected. Upstream packaging suites and live model
workflows were not run. Updating requires a new pinned upstream commit,
intentional source-scope review and recomputed fingerprints; no floating update
or always-running service is introduced.
