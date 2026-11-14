# 0065. Discovery of Copilot instructions, `.github/instructions` rules, and an explicit import of `~/.ssh/config`

Status: Proposed 2026-11-14; review findings resolved (EGM not required for gap 7)
Date: 2026-11-13 (revised 2026-11-14)
Area: runtime

Research: [docs/research/config-discovery.md](../research/config-discovery.md) (Gap 7 of the upstream gap closure). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2 355a324e4c`. Citations: `upstream:` is the OMPv1 pin; bare paths are omp2. Source was read, not built or run. Gap 7 is a data and small mechanical gap, so the brief exempts it from the Elephant-Goldfish review; the first-round findings recorded in `docs/adr/STATUS.md` were resolved against source by the author (see "What the review changed"). The design is not owner-approved.

## Context

### What OMPv1 does

- One provider, `github`, priority 30 (`upstream:packages/coding-agent/src/discovery/github.ts:40-42`), serves context files, instructions, rules, prompts and skills (`upstream:packages/coding-agent/src/discovery/github.ts:302-340`). Prompts and skills are out of scope here.
- **Project context file.** `<cwd>/.github/copilot-instructions.md` only (`upstream:packages/coding-agent/src/discovery/github.ts:52`). `getProjectPath` joins the source directory to `ctx.cwd` and never walks up (`upstream:packages/coding-agent/src/discovery/helpers.ts:127-135`; the docs say "no ancestor walk-up" at `upstream:docs/context-files.md:76` and `upstream:docs/context-files.md:83`).
- **Same-directory shadowing.** Context files dedupe on one key per scope: one user slot, and one project slot per depth, with depth clamped to at least 0 so a file inside `.github/` counts as the depth of the directory that holds `.github/` (`upstream:packages/coding-agent/src/capability/context-file.ts:36-46`). Within a slot the higher-priority provider wins (`upstream:docs/context-files.md:113-142`). Priorities: `native` 100, `claude` 80, `codex` 70, `gemini` 60, `opencode` 55, `github` 30, `agents-md` and `claude-md` 10 (`upstream:docs/context-files.md:117-135`). So a `.github/copilot-instructions.md` shadows an `AGENTS.md` in the same directory, and loses to `.claude/CLAUDE.md`, `.gemini/GEMINI.md` and `.omp/AGENTS.md` (worked example: `upstream:docs/context-files.md:148-163`).
- **User context file.** `~/.copilot/copilot-instructions.md`, relocatable with `COPILOT_HOME` (`upstream:packages/coding-agent/src/discovery/github.ts:69-81`, `upstream:packages/coding-agent/src/discovery/helpers.ts:143-146`). Foreign user sources, `github` among them, are opt-in (`upstream:docs/context-files.md:59-67`). It competes for the single user slot at priority 30, below every other user provider.
- **Custom directories.** `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` adds user `AGENTS.md` files and `.github/instructions` trees (`upstream:packages/coding-agent/src/discovery/github.ts:83-97`, `upstream:packages/coding-agent/src/discovery/github.ts:185-187`, `upstream:packages/coding-agent/src/discovery/github.ts:266-270`).
- **Rules.** `<cwd>/.github/instructions` is scanned recursively for `*.md` (`upstream:packages/coding-agent/src/discovery/github.ts:167-183`); the loader uses a gitignore-aware glob that skips hidden files (`upstream:packages/coding-agent/src/discovery/helpers.ts:594-637`). Only names ending `.instructions.md` count, and the suffix is stripped for the rule name (`upstream:packages/coding-agent/src/discovery/github.ts:199-211`). A frontmatter `enabled: false` drops the rule (`upstream:packages/coding-agent/src/discovery/helpers.ts:271-281`). `applyTo` is a string or list, each item split on commas, trimmed, empties dropped (`upstream:packages/coding-agent/src/discovery/github.ts:221-227`, `upstream:packages/coding-agent/src/discovery/helpers.ts:190-195`). Then exactly one of three outcomes (`upstream:packages/coding-agent/src/discovery/github.ts:204-219`):
  - a glob of `*`, `**` or `**/*` makes the rule always-apply and clears `globs` (`upstream:packages/coding-agent/src/discovery/github.ts:213-215`, `upstream:packages/coding-agent/src/discovery/github.ts:229-232`);
  - other globs replace `globs`, force `alwaysApply: false`, and keep the frontmatter `description` or generate `GitHub Copilot instructions for <globs>` (`upstream:packages/coding-agent/src/discovery/github.ts:217-218`, `upstream:packages/coding-agent/src/discovery/github.ts:234-237`);
  - a missing `applyTo` adds the warning `Missing applyTo in <path>; loaded without GitHub glob scoping.`, clears `globs`, forces `alwaysApply: false`, and generates `GitHub Copilot instructions without applyTo metadata` when there is no description (`upstream:packages/coding-agent/src/discovery/github.ts:205-207`, `upstream:packages/coding-agent/src/discovery/github.ts:217-218`, `upstream:packages/coding-agent/src/discovery/github.ts:235`).
- A GitHub instruction with a `condition` stays a stream rule whatever `applyTo` says (`upstream:docs/rulebook-matching-pipeline.md:150-159`). `globs` are advisory in the rulebook and a path gate for stream rules (`upstream:docs/rulebook-matching-pipeline.md:242-248`, `upstream:docs/rulebook-matching-pipeline.md:322`), compiled with `Bun.Glob` (`upstream:packages/coding-agent/src/export/ttsr.ts:617-627`). The `github` rule provider ranks after `cline` (`upstream:docs/context-files.md:126-128`).
- **SSH.** `ssh-config` lists only concrete `Host` aliases from `~/.ssh/config` and `/etc/ssh/ssh_config`, priority 3, first definition wins (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:1-10`, `upstream:packages/coding-agent/src/discovery/ssh-config.ts:96-110`). It handles two keywords only, `Host` and `Include`, with no block tracking (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:74-93`): negated and wildcard names are skipped (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:80-82`), `Include` nests at most 16 deep (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:23-24`, `upstream:packages/coding-agent/src/discovery/ssh-config.ts:84-88`), relative includes resolve against `~/.ssh` or `/etc/ssh`, absolute includes go anywhere, globs expand sorted and follow symlinks (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:52-65`), and a visited set stops cycles (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:68-70`). Quoting, `=` separators and trailing `#` comments are parsed (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:25-49`). The test fixture follows a symlink out of `~/.ssh` (`upstream:packages/coding-agent/test/discovery/ssh-config.test.ts:31-71`). The entry carries the alias only because upstream hands the name to the system `ssh`, which resolves `HostName`, `User`, `ProxyJump` and the rest itself (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:5-8`).

### What omp2 has

- **Context files.** `PROJECT_CONTEXT_PROVIDERS` is `native`, `claude`, `gemini`, `agents-md`, `claude-md` and `USER_CONTEXT_PROVIDERS` is `native`, `claude`, `codex`, `gemini`, `opencode` (`crates/driver/src/discovery/rules.rs:150-170`). The user loop keeps the first file found (`crates/driver/src/discovery/rules.rs:177-195`). The project loop walks the ancestors from the project root (`crates/driver/src/discovery/rules.rs:196-200`, `crates/driver/src/discovery/rules.rs:735-770`), admits `claude` and `gemini` at depth 0 only (`crates/driver/src/discovery/rules.rs:208`), and keeps one file per depth, the first provider in table order winning (`crates/driver/src/discovery/rules.rs:223`). Reads are capped at 1 MiB and contained in the repository (`crates/driver/src/discovery/rules.rs:110`, `crates/driver/src/discovery/rules.rs:116-122`). No Copilot entry exists.
- **Rules.** First-wins on name with a collision warning (`crates/driver/src/discovery/rules.rs:378-392`), sources in the order native, agents, Claude plugins, cursor, windsurf, cline (`crates/driver/src/discovery/rules.rs:401-562`). `rules_in_dir` reads one directory "without recursion" and names a rule by `file_stem` (`crates/driver/src/discovery/rules.rs:1012-1080`), so `a.instructions.md` would be named `a.instructions`. Frontmatter is `RuleHeader`: `description`, `globs`, `alwaysApply`, `condition`, `scope`, `interruptMode`, `agents`, without `deny_unknown_fields` (`crates/driver/src/discovery/rules.rs:789-803`), so an `applyTo` key is ignored today. `OneOrMany::into_vec(true)` splits a single string on commas but not list items (`crates/driver/src/discovery/rules.rs:893-918`). There is no `enabled` key.
- **How rules reach the model.** A stream rule (a `condition` that compiles) leaves the prompt buckets (`crates/driver/src/discovery/rules.rs:640-644`); `alwaysApply` rules are injected whole; rules with a description are listed with their `globs`; a rule with neither is reachable only through `rule://` (`crates/driver/src/discovery/rules.rs:630-669`). Stream rules carry `globs` into `RulePattern` (`crates/driver/src/discovery/rules.rs:590-612`), where the Director compiles them with `globset::Glob::new` and uses them as a path gate (`crates/agent/src/directors/stream_rules.rs:250-253`, `crates/agent/src/directors/stream_rules.rs:447-468`). So in omp2, as upstream, `globs` are advisory in the rulebook and enforced only for stream rules.
- **Discovery call sites.** `ContextFiles::discover(project_root, home, config_root)` and `ActiveRules::discover(project_root, home, config_root, plugins)` take no console context (`crates/driver/src/discovery/rules.rs:175`, `crates/driver/src/discovery/rules.rs:372-377`). Production reaches them in two places: `discover_prompt_material` (`crates/driver/src/headless/kernel.rs:4013-4040`), called from `compose_kernel` (`crates/driver/src/headless/kernel.rs:2564-2565`), and `StreamRuleInspector::discover`, which already holds `con` (`crates/driver/src/rules/stream.rs:204-222`) and serves `omp rules` (`crates/app/src/rules_cmd.rs:33-40`). Every session kind composes through `compose_kernel`, subagents included (`crates/driver/src/subagent/spawn.rs:933`, `crates/driver/src/subagent/revive.rs:303`, `crates/driver/src/subagent/workpool_runtime.rs:338`). `rule://` serves the kernel's discovered set through `RuleScope` (`crates/driver/src/headless/kernel.rs:2566-2573`), and the chat, ACP and session runners reuse that scope (`crates/app/src/chat_cmd.rs:1377`, `crates/app/src/acp_mode.rs:78`, `crates/app/src/session_runner.rs:166`). Skills discovery already reads source toggles from the console context (`crates/driver/src/discovery/skills.rs:143-170`, `crates/driver/src/settings.rs:38-102`).
- **Trust.** Context files and rules are data the model reads, never authority, and sit outside the workspace-trust digest (`crates/ext/README.md:115-117`). A convar without the `PROJECT` flag cannot be set from a repository cfg (`docs/adr/0012-convars.md:77`; `crates/app/src/lib.rs:136-143`).
- **SSH.** `omp-ssh` is a native client with its own `hosts.toml`; a host needs `address`, `user`, a `SHA256:` `host_key` and an `auth` policy, with `port` and `timeout_secs` defaulted (`crates/ssh/src/lib.rs:57-90`). Auth is the agent or one key path (`crates/ssh/src/lib.rs:92-105`); the key file is permission-checked and loaded with no passphrase only at connect time (`crates/ssh/src/lib.rs:659-665`, `crates/ssh/src/lib.rs:1074-1088`). `HostStore::load` with `Containment::Unconfined` is the user-scope writer and `upsert` validates and writes atomically (`crates/ssh/src/lib.rs:174-191`, `crates/ssh/src/lib.rs:226-233`). A project alias never shadows a user alias, and the project file is read only in a trusted workspace (`crates/ssh/src/lib.rs:157-170`). `known_host_fingerprint` reads a pin from a `known_hosts` file (`crates/ssh/src/lib.rs:397-421`); `validate_configured_host` checks alias and host (`crates/ssh/src/lib.rs:385-393`, `crates/ssh/src/lib.rs:423-447`). `omp-exec-ssh` never shells out to `ssh` (`crates/exec-ssh/README.md:1-6`). The `omp ssh` command has `list`, `add`, `remove`, `probe`, `exec` (`crates/app/src/ssh_cmd.rs:33-85`) and is compiled unconditionally: `omp-ssh` is a plain dependency of `omp-app` (`crates/app/Cargo.toml:99`, `crates/app/src/lib.rs:87`, `crates/app/src/cli.rs:1208`), while `cap-ssh` only forwards to `omp-envd` (`crates/app/Cargo.toml:36`, `crates/envd/Cargo.toml:17`) and is default-on (`crates/app/Cargo.toml:24-32`).

### Rules that bind

- Additive only: no existing provider order, convar, command, schema or `hosts.toml` field changes. A new `omp ssh` subcommand and new convars are additions.
- ADR 0049: vendor integrations live in extensions. Reading a Copilot instruction file is a file-format read, like `.cursorrules` (O6).
- Untrusted repository text never gains authority. SSH hosts are authority, so the import is user-initiated and writes user scope only.
- Deterministic: discovery, rule construction and the SSH import are rules in native code; no model is involved.
- Errors follow ADR 0035 and `AGENTS.md`: `thiserror` enums with typed fields, no string payloads; refusals are data, not errors.
- Behaviour lands behind default-off convars. No `cap-*` feature is added: the work adds no dependency weight (`.claude/skills/omp-slice-plan/SKILL.md`, "Gating").

## Decision

**D1. One gate for both Copilot sources, read where a console context exists.** Declare `sv_discover_copilot: bool`, default `false`, flags `archive | session`, no `PROJECT` flag, in `crates/driver/src/settings.rs` beside the `sv_skills_enable_*` toggles. Add `pub struct DiscoverySources { pub copilot: bool }` in `crates/driver/src/discovery/rules.rs` with `Default` (all off) and `from_con(&omp_con::Ctx)`. `ContextFiles::discover` and `ActiveRules::discover` each gain a final `sources: &DiscoverySources` parameter; with `copilot: false` their output MUST equal today's. The gate MUST reach all four discovery call sites:
1. `ContextFiles::discover` in `discover_prompt_material` (`crates/driver/src/headless/kernel.rs:4028`);
2. `ActiveRules::discover` in `discover_prompt_material` (`crates/driver/src/headless/kernel.rs:4033`);
3. the `discover_prompt_material` call in `compose_kernel` (`crates/driver/src/headless/kernel.rs:2565`), which builds `DiscoverySources::from_con(&ctx)` from the `ctx` it receives (`crates/driver/src/headless/kernel.rs:2461`) and passes it in; `discover_prompt_material` gains the same parameter. Subagents inherit the value through their seeded context (ADR 0013), so a parent and its children agree;
4. `ActiveRules::discover` in `StreamRuleInspector::discover` (`crates/driver/src/rules/stream.rs:215`), from the `con` it already takes, so `omp rules list` shows the same rule set a session gets.

Every other caller is a test and passes `&DiscoverySources::default()`: `crates/driver/src/discovery/rules.rs:1278`, `:1305`, `:1317`, `:1351`, `:1400`, `:1431`, `:1472`, `:1533`, `:1599`, `:1669`, `:1772`; `crates/driver/src/rules/stream.rs:440`; `crates/driver/src/v1_import/agents_tests.rs:146`; `crates/driver/src/v1_import/assets/tests.rs:274`; `crates/app/src/rules_cmd.rs:336`; and the `discover_prompt_material` test callers `crates/driver/src/headless/kernel.rs:5487`, `:5498`, `:5506` and `crates/driver/src/subagent/spawn.rs:2061`. One entry point per function, every caller updated in the same change; no wrapper keeps the old signature (`AGENTS.md`, no compat shims).

**D2. Copilot context files, ranked as upstream ranks them.** With `copilot: true`:
- the project table gains `("github", ".github/copilot-instructions.md")` between `gemini` and `agents-md`, so the order is `native`, `claude`, `gemini`, `github`, `agents-md`, `claude-md`, matching upstream priorities 100, 80, 60, 30, 10, 10;
- `github` is admitted at depth 0 only, the project root, added to the existing `claude | gemini` depth-0 rule (`crates/driver/src/discovery/rules.rs:208`). This is upstream's "cwd only, no ancestor walk";
- same-directory shadowing follows the existing one-file-per-depth rule (`crates/driver/src/discovery/rules.rs:223`): at depth 0 a Copilot file shadows `AGENTS.md` and `CLAUDE.md` and loses to `.omp/AGENTS.md`, `.claude/CLAUDE.md` and `.gemini/GEMINI.md`. Ancestor depths are unchanged because `github` never claims them. No warning is emitted for a shadowed file, as upstream emits none;
- the user table gains `("github", ".copilot/copilot-instructions.md")` after `opencode`, upstream's order (30 below 55), so it loads only when no other user file exists;
- reads go through the same reader: `project_containment` for the project file, `Containment::Unconfined` for the user file, 1 MiB cap, empty files skipped.

With `copilot: false` no Copilot path is opened. `COPILOT_HOME` and `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` are not read: an environment variable that points discovery at arbitrary directories is a prompt-injection path for any parent process that sets it.

**D3. `.github/instructions` rules, built as upstream builds them.** With `copilot: true`, `ActiveRules::discover` appends a `github` provider after `cline` (after `crates/driver/src/discovery/rules.rs:562`), so every existing rule wins a name collision. It MUST:
- scan `<project_root>/.github/instructions` only, recursively, with `omp_walker` (`crates/walker/src/lib.rs:511-539`; precedent `crates/driver/src/rules/stream.rs:345`): hidden entries skipped, `.gitignore` honoured, symlinks not followed, a fixed lexicographic path order, depth at most 16 and at most 512 files, with a `Warning` naming the directory when a bound cuts the walk. Each candidate is canonicalized and refused with the existing "resolves outside its discovery root" warning unless it stays inside the canonical instructions directory (as `crates/driver/src/discovery/rules.rs:1060-1068`);
- admit only file names ending `.instructions.md` and name the rule by the file name with that suffix removed; a later file with the same name is skipped with the existing collision warning;
- read through `load_rule` (`Containment::Within` the instructions directory, 1 MiB cap) with a provider-local header `InstructionHeader { #[serde(flatten)] rule: RuleHeader, apply_to: OneOrMany }` (serde name `applyTo`). `RuleHeader` itself is not changed, so `applyTo` keeps having no effect in `.omp/rules` and the other sources;
- normalise `applyTo` by splitting every item, string or list element, on commas, trimming and dropping empties;
- then apply exactly one outcome, mapped onto `Rule`:

  | `applyTo` | `Rule.always_apply` | `Rule.globs` | `Rule.description` | Warning |
  |---|---|---|---|---|
  | contains `*`, `**` or `**/*` | `true` | empty | frontmatter value | none |
  | other globs | `false` | the `applyTo` globs (frontmatter `globs` discarded) | frontmatter value, else `GitHub Copilot instructions for <globs joined by ", ">` | none |
  | missing or empty | `false` | empty (frontmatter `globs` discarded) | frontmatter value, else `GitHub Copilot instructions without applyTo metadata` | `Missing applyTo in <path>; loaded without GitHub glob scoping.` |

- keep `condition`, `scope`, `interruptMode` and `agents` from the frontmatter. A rule whose `condition` compiles is a stream rule and leaves the prompt buckets (`crates/driver/src/discovery/rules.rs:640-644`), with the `applyTo` globs as its path gate (`crates/driver/src/discovery/rules.rs:590-612`), matching `upstream:docs/rulebook-matching-pipeline.md:159`;
- set `provider: "github"`, `level: Level::Project`.

Because every non-always rule gets a description, each GitHub instruction is either injected whole or listed in the rulebook with its globs and readable at `rule://<name>`, never silently unreachable. The rulebook lists globs for the model to act on; omp2 does not enforce them outside stream rules, which is upstream's semantics (`upstream:docs/rulebook-matching-pipeline.md:322`). A frontmatter `enabled: false` is not honoured, because no omp2 rule source honours it (`crates/driver/src/discovery/rules.rs:789-803`); see O7.

**D4. `~/.ssh/config` is imported, never discovered.** A new subcommand `omp ssh import-openssh` reads OpenSSH configuration and proposes user-scope `hosts.toml` entries. It MUST:
- refuse to run, with a typed error naming the convar, unless `sv_ssh_import_openssh: bool` is `true`. The convar defaults to `false`, has flags `archive` only and no `PROJECT` flag, and is declared in `crates/app/src/settings.rs`. The arm reads it from `crate::process_ctx` (`crates/app/src/lib.rs:143`);
- default to a dry run that prints every candidate host and every refusal; write only with `--write`;
- write only the user `hosts.toml` (`HostPaths::user`, `HostStore::load(.., Containment::Unconfined)`, `HostStore::upsert`), never the project file and never a workspace `.ssh/config`;
- be deterministic and offline: no network, no subprocess, no `ssh` binary, no agent socket.

**D5. What the import reads, and what it never reads.**
- Reads: `~/.ssh/config`; files it `Include`s whose path, after `~` expansion and resolution of a relative path against `~/.ssh`, lies lexically under `~/.ssh`; and, for pins only, `~/.ssh/known_hosts`, then `/etc/ssh/ssh_known_hosts`, which hold public keys. `/etc/ssh/ssh_config` is not read (a deviation from upstream; O8). An `Include` outside `~/.ssh` is refused with its file and line.
- Never reads: any `IdentityFile`, `CertificateFile` or other private-key or certificate content, `~/.ssh/id_*`, agent sockets, `authorized_keys`. An `IdentityFile` is recorded as a path; the import only `stat`s it.
- Every file read MUST be a regular file of at most 256 KiB (the `hosts.toml` bound, `crates/ssh/src/lib.rs:248`). On Unix it MUST be owned by the invoking user and not group- or world-writable; otherwise that file is refused, and when the refused file is `~/.ssh/config` itself the import stops with a typed error and writes nothing. A writable config lets another local account redirect a `HostName`, and the import must not turn that into user authority [INFERENCE]. Symlinks are followed, as the user scope is unconfined (`crates/ssh/src/lib.rs:174-180`) and dotfile managers link `~/.ssh/config`; the checks apply to the target.
- Output, refusals and logs MUST NOT echo the text of a line. A refusal carries the file, the line number, the keyword and a typed reason, so an `Include` that names a key file cannot print key material.

**D6. How a host is resolved.**
- Parsing: `Keyword value`, `Keyword=value` and `Keyword = value`, keywords case-insensitive, double and single quotes, an unquoted `#` starting a trailing comment, CRLF tolerated (upstream's grammar, `upstream:packages/coding-agent/src/discovery/ssh-config.ts:25-49`). Lines are grouped into blocks: directives before the first `Host` or `Match` are global; each `Host` or `Match` line opens a block that runs to the next one.
- `Include` is followed in place, at global level only, at most 16 levels deep, with sorted glob expansion and a visited set of canonical paths. An `Include` inside a `Host` or `Match` block is refused, because conditional inclusion is not modelled.
- Candidates are the concrete names on `Host` lines in file order: names with `*`, `?`, `[` or a leading `!` are patterns, not candidates. `Host a b c` yields three candidates. The first occurrence of a name is its position.
- Each candidate resolves by walking every `Host` block in order whose pattern list matches it (OpenSSH pattern rules: `*` and `?` wildcards, `!` negation excluding the block), wildcard blocks such as `Host *` included; the first value seen for each keyword wins.
- `Match` blocks are never evaluated and their directives never apply. Each one is reported as ignored with its file and line, so the user sees which settings the import did not consider.
- Mapping to `HostConfig`: `address` = `HostName` (else the alias), `user` = `User`, `port` = `Port` (else 22), `timeout_secs` = 30, `auth` = `Key { path }` when exactly one `IdentityFile` resolves to an existing regular file whose mode has no group or other bits, else `Agent` with a note. Encrypted keys are not detected, because that needs reading the key; the existing load error surfaces at `omp ssh probe` (`crates/ssh/src/lib.rs:659-665`) and the dry run prints that hint.
- Tokens: `HostName` accepts `%h` and `%%`; `IdentityFile` accepts a leading `~`, `%d`, `%h`, `%u`, `%r` and `%%`. Any other `%` token or `${...}` makes the host refused.
- Pin: `known_host_fingerprint` (`crates/ssh/src/lib.rs:397-421`) on `HostKeyAlias` if set, else the resolved address, with the port, in the two files above. A `UserKnownHostsFile` inside `~/.ssh` replaces `~/.ssh/known_hosts`; one outside it refuses the host. `KnownHostsCommand` refuses the host. The help text says the pin trusts what the user's OpenSSH already accepted.
- Refused hosts, each with a typed reason: no `User`; no pin; `ProxyJump` or `ProxyCommand` other than `none`; `CertificateFile`; `KnownHostsCommand`; an unsupported token; an alias that fails `validate_configured_host`; an alias already in the user `hosts.toml` (the declared host is kept, as the v1 importer does, `crates/driver/src/v1_import/assets/ssh.rs:1-9`); and an alias the current workspace's project `hosts.toml` declares while that workspace is trusted, because a new user alias would shadow it (`crates/ssh/src/lib.rs:157-170`). `ProxyCommand`, `LocalCommand`, `RemoteCommand`, `PermitLocalCommand` and `Match exec` are never executed; the last three are reported as ignored.
- Errors: a new `OpensshImportError` (`thiserror`) for failures that stop the import (gate off, root config unreadable or refused, `hosts.toml` write failure via `#[source] SshError`); refusals are a data enum `RefusalReason` with strum-derived names, carried in `Refusal { file, line, alias, reason }`.

**D7. Parser placement.** A hand-written module `crates/ssh/src/openssh_config.rs` in `omp-ssh`, pure over a small file-reader seam so tests run on fixtures, modelled on upstream's 117-line file. No crate is added (O5).

## Rejected options

| Option | Why not |
|---|---|
| Rank the Copilot file after `CLAUDE.md` (the first draft) | With the gate on, a Copilot file in a directory that has `AGENTS.md` would never load, so opting in would do nothing there; and v1 users would see a different file win. The gate off already keeps every repository unchanged. |
| Load the Copilot file beside `AGENTS.md` instead of shadowing it | Not upstream behaviour; doubles guidance in repositories that keep both in sync. Kept as the alternative in O1. |
| Walk ancestors for `.github/copilot-instructions.md` | Upstream reads the cwd only; a parent repository's `.github` would leak into a nested project. |
| Add `applyTo` to `RuleHeader` | Changes the meaning of existing `.omp/rules`, `.cursor/rules` files that happen to carry the key. |
| Read `sv_discover_copilot` inside the discovery functions through a global | Discovery takes no context today; a global would let `omp rules` and a session disagree, the failure the first review named. |
| Auto-discover aliases only, as upstream does | The aliases could not connect: omp2 needs address, user and pin. |
| Shell out to `ssh -G` | Adds a runtime dependency and runs `ProxyCommand` or `Match exec`, which the native client never does. |
| Read `COPILOT_HOME`, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | See D2. |
| Read `.ssh/config` from a workspace | SSH hosts are authority. |
| A `cap-*` feature for any slice | No new dependency weight; `cap-*` gates build weight, a convar gates behaviour. |

## Slices

One PR each, on the gap 7 branch, tests written first and not edited to pass. Verification for every slice: `just test-pkg <pkg>` for each touched crate, `just lint`, and `omp-pre-pr` on the diff.

**S1. Gate, plumbing and Copilot context files (D1, D2).**
- Scope: `SV_DISCOVER_COPILOT` in `crates/driver/src/settings.rs`; `DiscoverySources` and the new parameter in `crates/driver/src/discovery/rules.rs`; the four call sites of D1 and every test caller; the two table rows and the depth-0 rule. `ActiveRules::discover` takes the parameter but adds nothing yet.
- Gate: `sv_discover_copilot`, default off.
- Tests (unit, `crates/driver/src/discovery/rules.rs`): `copilot_sources_off_reads_no_copilot_path`, `copilot_file_alone_is_injected_at_depth_zero`, `copilot_file_shadows_agents_md_in_the_same_directory`, `copilot_file_loses_to_claude_gemini_and_native_at_depth_zero`, `copilot_file_in_an_ancestor_is_not_read`, `copilot_file_symlinked_out_of_the_repository_is_refused` (as `crates/driver/src/discovery/rules.rs:1386-1400`), `user_copilot_file_loads_only_when_no_other_user_file_exists`; `discovery_sources_from_con_reads_sv_discover_copilot`.
- Tests (crate integration, `crates/driver/tests/copilot_discovery.rs`, modelled on `crates/driver/tests/workspace_trust_gates.rs:349`): `compose_kernel_journals_the_copilot_file_only_with_the_convar_on`, `child_kernel_inherits_sv_discover_copilot`.
- Acceptance: gate off, the existing tests at `crates/driver/src/discovery/rules.rs:1278` and `:1305` and `crates/driver/src/headless/kernel.rs:5487-5506` pass unchanged; gate on, the journaled prompt facts carry the Copilot file under D2's ranking.
- Depends on: none.

**S2. `.github/instructions` rules (D3).**
- Scope: the `github` rule provider, `InstructionHeader`, the recursive walk, the `applyTo` mapping, in `crates/driver/src/discovery/rules.rs`.
- Gate: `sv_discover_copilot` (from S1).
- Tests (unit, ported from `upstream:packages/coding-agent/test/discovery/github-copilot.test.ts:143-185`): `always_apply_spellings_inject_whole` (`*`, `**`, `**/*`), `comma_and_list_apply_to_globs_scope_the_rule`, `scoped_rule_without_description_gets_generated_description`, `missing_apply_to_warns_discards_globs_and_lists_the_rule`, `apply_to_overrides_frontmatter_always_apply`, `condition_rule_stays_a_stream_rule_with_apply_to_as_path_gate`, `nested_instruction_files_are_found`, `non_instructions_suffix_ignored`, `hidden_and_gitignored_files_skipped`, `symlink_out_of_instructions_dir_refused`, `name_collision_keeps_the_existing_rule_with_warning`, `apply_to_in_omp_rules_still_has_no_effect`, `github_rules_absent_with_convar_off`.
- Tests (app, `crates/app/src/rules_cmd.rs` tests): `omp_rules_list_shows_github_rules_only_with_the_convar_on` (call site 4).
- Tests (crate integration, `crates/driver/tests/copilot_discovery.rs`): `rulebook_lists_scoped_instruction_and_rule_url_serves_its_body`.
- Acceptance: gate off, every existing rules test passes unchanged; gate on, the three `applyTo` outcomes match the D3 table and `omp rules list` agrees with the session.
- Depends on: S1.

**S3. OpenSSH config parser and resolver, no wiring (D5, D6, D7).**
- Scope: `crates/ssh/src/openssh_config.rs`: parse, include, resolve, map, refuse; `RefusalReason`, `Refusal`, `OpensshImportError`.
- Gate: none; no caller until S4.
- Tests (unit, fixtures adapted from `upstream:packages/coding-agent/test/discovery/ssh-config.test.ts:31-71`): `concrete_aliases_in_config_order_following_include`, `include_depth_16_and_cycle_guard`, `glob_include_sorted`, `quoted_equals_and_trailing_comment_forms`, `include_outside_ssh_dir_refused`, `include_inside_host_block_refused`, `wildcard_host_blocks_supply_first_values`, `negated_pattern_excludes_block`, `match_block_ignored_and_reported`, `proxyjump_proxycommand_certificatefile_knownhostscommand_each_refused`, `proxy_none_is_not_a_refusal`, `unsupported_token_refused`, `multi_name_host_yields_each_alias`, `single_identity_file_maps_to_key_else_agent`, `group_writable_or_foreign_owned_config_refused` (Unix), `refusals_never_contain_line_text`, `identity_file_is_never_opened`.
- Acceptance: every outcome in D6 has a typed result; no fixture outside the declared paths is opened (asserted through the reader seam).
- Depends on: none (can land beside S1).

**S4. `omp ssh import-openssh` (D4).**
- Scope: the `ImportOpenssh { write: bool }` arm in `crates/app/src/ssh_cmd.rs`; `SV_SSH_IMPORT_OPENSSH` in `crates/app/src/settings.rs`; pins through `known_host_fingerprint`; writes through `HostStore::upsert`.
- Gate: `sv_ssh_import_openssh`, default off.
- Tests (`crates/app/src/ssh_cmd.rs` tests, beside `ssh_add_refuses_a_project_omp_linked_outside`): `import_refuses_with_convar_off`, `dry_run_writes_nothing`, `fixture_config_and_known_hosts_produce_expected_hosts_toml`, `second_run_changes_nothing`, `declared_user_host_is_not_overwritten`, `trusted_project_alias_is_skipped`, `project_hosts_toml_never_written`, `host_without_pin_is_skipped_with_reason`, `host_key_alias_selects_the_pin`.
- Acceptance: gate off, `omp ssh list|add|remove|probe|exec` tests pass unchanged and the new arm refuses; gate on, the fixture produces the expected file exactly, idempotently.
- Depends on: S3.

No slice adds an e2e proof. None changes a property P1-P14 owns (`crates/e2e/README.md`), and the joined path for discovery is `compose_kernel`, which the S1 and S2 driver integration tests drive, the owning seam per `AGENTS.md` "Testing & QA". No slice needs a golden-journal family: no journal kind or payload field changes, since context-file rows keep `origin`, `content`, `level`, `depth` (`crates/driver/src/discovery/rules.rs:234-246`) and rule rows keep their fields (`crates/driver/src/discovery/rules.rs:645-669`). No slice changes prompt template text, so no prompt golden moves.

## Upstream origin and license

A port draws from `upstream:packages/coding-agent/src/discovery/github.ts` (340 lines), the helpers it calls in `upstream:packages/coding-agent/src/discovery/helpers.ts`, `upstream:packages/coding-agent/src/capability/context-file.ts`, and `upstream:packages/coding-agent/src/discovery/ssh-config.ts` (117 lines), with their tests. TypeScript, rewritten in Rust. Upstream's `LICENSE` is MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`). Keep the notice for copied text and fixtures. The OpenSSH pattern and token rules in D6 are re-implemented from the documented config format, not from OpenSSH source.

## Consequences

- With `sv_discover_copilot` on, repositories with Copilot instructions get them in the prompt and the rulebook exactly as v1 did, from one gate that sessions, subagents and `omp rules` read alike.
- With it off, nothing changes; every discovery caller passes an explicit source set.
- No new authority: the text is contained and size-capped like `AGENTS.md`.
- SSH users with `sv_ssh_import_openssh` on get a dry-run-first import with an explicit list of what was refused or ignored. Hosts behind a jump host stay unsupported until the native client supports one.
- Cost: a signature change to two internal discovery functions and about twenty test callers in S1.

## Open questions for the owner

- **O1. Copilot file against `AGENTS.md` in the same directory.** Decided here as upstream: the Copilot file shadows it at depth 0. Alternative: load both. Recommendation: keep upstream parity; revisit with usage data.
- **O2. Glob dialect for stream-rule path gates.** omp2 compiles `globs` with `globset` defaults (`crates/agent/src/directors/stream_rules.rs:250-253`), upstream with `Bun.Glob` (`upstream:packages/coding-agent/src/export/ttsr.ts:617-627`). Whether `*` crosses `/` alike was not checked (UNVERIFIED). This affects only GitHub instructions that also carry a `condition`. Recommendation: accept the omp2 dialect and say so in the rule's generated description only if S2 finds a difference.
- **O3. A chat `/ssh` subcommand for the import?** Recommendation: CLI first.
- **O4. Tokens beyond D6's list** (`%p`, `%n`, `%C`). Recommendation: refuse until a user asks.
- **O5. Hand-written parser.** Decided hand-written; no crate was evaluated against `deny.toml`.
- **O6. Does ADR 0049 apply to a Copilot file?** Recommendation: no, it is a plain file format like `.cursorrules`; the owner may overrule.
- **O7. `enabled: false` frontmatter.** Upstream drops such rules (`upstream:packages/coding-agent/src/discovery/helpers.ts:279`); no omp2 rule source does. Recommendation: decide for all sources in a separate change, not for GitHub alone.
- **O8. `/etc/ssh/ssh_config` and `Match`.** Not read and not evaluated (D5, D6). Recommendation: keep; reconsider when the native client gains `ProxyJump`.

## What the review changed

Gap 7 is exempt from EGM review (brief, "Design review": "Skip it ... for gaps that are data or small mechanical additions (6, 7, 8, 15)"). No Goldfish round ran in this revision. The findings below are round 1's, as recorded in `docs/adr/STATUS.md` row 0065 on 2026-11-13; each was checked against source by the author.

### Round 1 (recorded 2026-11-13; resolved 2026-11-14)

- **Plumb `sv_discover_copilot` to all four discovery call sites. Confirmed.** Neither discovery function takes a console context (`crates/driver/src/discovery/rules.rs:175`, `:372-377`), and the draft named a convar without saying where it is read. The four sites are `crates/driver/src/headless/kernel.rs:4028`, `:4033`, the `compose_kernel` call at `:2565` (the only place a `Ctx`, `:2461`, meets discovery) and `crates/driver/src/rules/stream.rs:215` (`omp rules`, `crates/app/src/rules_cmd.rs:33`). Without the fourth, `omp rules list` and the session would disagree. Changed: D1 names the convar's declaration, flags, the `DiscoverySources` parameter, each production site and every test caller; S1 tests the session path and S2 the `omp rules` path.
- **Ancestor walk and same-directory shadowing. Confirmed.** Upstream reads `<cwd>/.github` only (`upstream:packages/coding-agent/src/discovery/helpers.ts:127-135`) and shadows by provider priority within a depth slot, clamped so `.github/` counts as its parent's depth (`upstream:packages/coding-agent/src/capability/context-file.ts:36-46`; `upstream:docs/context-files.md:117-163`). The draft appended the Copilot file after `CLAUDE.md`; under omp2's one-file-per-depth rule (`crates/driver/src/discovery/rules.rs:223`) it would then never load where an `AGENTS.md` sits beside it, and the draft did not restrict its depth. Changed: D2 ranks it between `gemini` and `agents-md`, depth 0 only, user file after `opencode`; the first-draft ranking moved to Rejected options; O1 rewritten; S1 tests shadowing in both directions and the ancestor case.
- **Rule construction and `applyTo`. Confirmed.** `rules_in_dir` does not recurse and names by `file_stem` (`crates/driver/src/discovery/rules.rs:1012-1080`), so it cannot be reused as the draft implied; `RuleHeader` has no `applyTo` (`:789-803`); list items are not comma-split (`:893-918`); and the draft missed that upstream discards frontmatter `globs` and `alwaysApply` once `applyTo` is evaluated and generates descriptions in both non-always cases (`upstream:packages/coding-agent/src/discovery/github.ts:204-237`). Without a description, omp2 would make such a rule reachable only by `rule://` (`crates/driver/src/discovery/rules.rs:630-669`). Changed: D3 specifies the walk, naming, a provider-local header, normalisation, the three-outcome table onto `Rule`, stream-rule handling and placement; O2 narrowed to the stream-rule path gate after tracing `globs` (`crates/agent/src/directors/stream_rules.rs:250-253`, `:447-468`); O7 added for `enabled`.
- **SSH import safety gaps. Confirmed.** The draft chose `IdentityFile` "if present and unencrypted", which needs reading the private key; said nothing about file ownership, permissions, size, what is never read, or echoing lines; limited includes to `~/.ssh` and `/etc/ssh` without saying how symlinks or blocks are handled; and ignored that `Host *` blocks supply values, which upstream never needed because it resolves nothing (`upstream:packages/coding-agent/src/discovery/ssh-config.ts:74-93`). Changed: D5 lists what is read and never read, the ownership, permission and size checks, and the no-echo rule; D6 defines blocks, global-only `Include`, wildcard resolution, `Match` as ignored and reported, token rules, the pin lookup with `HostKeyAlias` and `UserKnownHostsFile`, the refusal list including a trusted project alias, and typed errors; S3 and S4 test each.

### Corrected against this tree while resolving round 1

- **The SSH gate was not default-off.** The draft gated the import on `cap-ssh`, but `cap-ssh` is default-on (`crates/app/Cargo.toml:24-32`) and does not gate `omp ssh` at all (`crates/app/Cargo.toml:99`, `crates/app/src/lib.rs:87`). Changed: the default-off convar `sv_ssh_import_openssh` (D4); the import is also a dry run unless `--write`.
- **Placement after cline.** The research note placed the rule provider "after `cursor` and `windsurf`", the draft ADR after cline. The omp2 order runs `crates/driver/src/discovery/rules.rs:401-562` with cline last at `:542-562`, and upstream ranks `github` (30) below `cline` (40) (`upstream:docs/context-files.md:126-128`). D3 keeps "after cline"; the note is corrected.
- Accepted unchanged from the draft: no `COPILOT_HOME` or `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`; never read a workspace `.ssh/config`; never shell out to `ssh`; a declared user host is kept; the hand-written parser.

Review findings resolved by the author against source; not owner-approved.

## Acceptance tests

1. With `sv_discover_copilot` off, the existing discovery, kernel and rules-command tests pass unchanged and no Copilot path is opened (S1, S2).
2. With it on, a project-root `.github/copilot-instructions.md` is journaled in the prompt facts, shadows an `AGENTS.md` beside it, loses to `.omp/AGENTS.md`, `.claude/CLAUDE.md` and `.gemini/GEMINI.md`, and one in an ancestor directory is not read (S1).
3. A child kernel sees the same Copilot context as its parent (S1).
4. Each `applyTo` outcome produces the `always_apply`, `globs`, `description` and warning in the D3 table; a `condition` rule stays a stream rule gated by the `applyTo` globs (S2).
5. `omp rules list` and the session's rulebook contain the same GitHub rules for the same convar value (S2).
6. `applyTo` in `.omp/rules` still has no effect (S2).
7. The OpenSSH resolver yields, for the fixture, the expected candidates, values from wildcard blocks, and a typed reason for every refused or ignored directive; no refusal contains line text; no identity file is opened (S3).
8. With `sv_ssh_import_openssh` off the import refuses; on, a dry run writes nothing, `--write` writes exactly the expected user `hosts.toml`, a second run changes nothing, and neither a declared user host nor a trusted project's alias is overwritten or shadowed (S4).
9. No identifier, message or convar in the new code uses `pi` as a product name (grep check, every slice).

## Status in omp

**Status: Not started.** Nothing in this record is implemented.

- Reusable today: the provider tables and reader (`crates/driver/src/discovery/rules.rs:150-230`), `load_rule` and the collision admitter (`:378-392`, `:939-1010`), the stream-rule path gate (`crates/agent/src/directors/stream_rules.rs:447-468`), `omp_walker`, `HostStore`, `known_host_fingerprint`, `validate_configured_host` (`crates/ssh/src/lib.rs`), and the v1 `ssh.json` importer as a model (`crates/driver/src/v1_import/assets/ssh.rs`).
- Not yet implemented: `sv_discover_copilot`, `DiscoverySources`, the Copilot table rows, the `github` rule provider, `openssh_config.rs`, `sv_ssh_import_openssh`, `omp ssh import-openssh`.

## References

[docs/research/config-discovery.md](../research/config-discovery.md); ADR 0012 (convars, `PROJECT` flag); ADR 0013 (children seed from the parent); ADR 0024 (roster unchanged: no tool added); ADR 0035 (error discipline); ADR 0038 (stream rules as a Director); ADR 0049 (vendor integrations in extensions).
