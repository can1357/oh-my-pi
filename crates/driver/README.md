# omp-driver

`omp-driver` is OMP's journal-first coding-agent composition boundary. It
assembles `omp-agent`, `omp-session`, inference, project-environment tools,
convars, subagent spawning, and live-session routing without depending on CLI,
TUI, or desktop presentation crates.

The crate sits above `omp-envd`, `omp-env`, and `omp-serve` and below
`omp-app`. Driver code composes the session; app code selects a command or
presentation adapter.

## Structure

- `verification` provides a pure required-check policy and tri-state assessment.
  It rejects empty required inventories and ambiguous observations, binds results
  to supplied input/policy identities, and keeps missing evidence inconclusive.
  This is the first verification slice: no snapshot capture, evidence validation,
  check execution, durable receipt or commit gate is connected to it yet.
- `headless::kernel` constructs the production kernel, `.oms` session,
  inference route, environment authority, and session-owned `task`/`hub`
  tools reused by chat, print, RPC, and ACP.
- `plugin_hooks` runs installed plugins' Claude-format hooks as one
  in-process host on the kernel's generic hook gate, each command in the
  environment's in-process shell. Which Claude Code event runs at which
  lifecycle point is tabulated in `crates/ext/README.md`; `SessionEnd` runs at
  `session_shutdown`, which every launch mode reaches when its session ends
  (quit, a finished run, a switch) and waits on for at most
  `omp_agent::SESSION_SHUTDOWN_BUDGET`. Every switch also moves the host onto
  the next session (`LifecycleHooks::session_switched`), including a switch
  away from an ACP session `session/close` already ended.
- `sessions` is the disposable process-local routing index for live kernel
  mailboxes and detached DOM snapshots.
- `subagent` seeds child convars and composes child kernels through the same
  headless path.
- `registry` assembles catalog, credential, inference, and service
  authorities.
- `discovery` retains credential-blind model configuration and role selection,
  plus the prompt material the kernel journals as `prompt-facts`: `skills`
  (`SKILL.md`, `skill://`), `rules` (context files such as `AGENTS.md` /
  `CLAUDE.md` walked up from the project, and `.omp/rules` / `RULES.md` /
  `.cursor/rules` / `.clinerules` rule documents served as `rule://`), and
  `prompts` (Markdown prompt templates that become `/name` slash commands with
  `$1` / `$ARGUMENTS` substitution). `--no-context-files`, `--no-rules`,
  `--no-prompt-templates`, and `--prompt-template <path>` are their seams.
  Project files (context files, whole-file rules, `.omp/SYSTEM.md`,
  `.omp/secrets.yml`, the `.omp/*.cfg` overlay) are read through
  `omp_core::project_file`: regular files under a size cap that resolve inside
  the repository. A refused context file or rule is skipped with a
  `Warning`; the cfg overlay is skipped as a whole and its write path
  (`ConfigFileLock::acquire_project`) refuses symlink targets, including a
  symlinked `.cfg.lock`. User cfgs and user `SYSTEM.md` go through the same
  reader `Unconfined`: they may be symlinks, but never FIFOs or devices.
- A rule's `agents:` frontmatter scopes it to agent classes (`main` for the
  top-level session, the spawned class such as `task` or `scout` for a
  subagent): case-insensitive globs, a list or a comma-separated string. A
  `!` prefix negates an entry — positives define the admitted set (every
  agent when there are none) and negations subtract from it, so
  `agents: [!reviewer]` reaches every agent but `reviewer` and
  `agents: [review-*, !review-bot]` every `review-*` class but `review-bot`.
  An excluded rule is kept out of the prompt, out of `rule://` listings and
  completion, and `rule://<name>` refuses it. A child session journals the
  class and recursion depth it runs at, so resuming it (from the main chat's
  `/resume` or with `--resume`) keeps the child's rules and applies its class
  configuration (`subagent.cfg`, `<agent>.cfg`, its journaled depth) through
  the spawn path, beneath the child's journaled convars; a class whose cfg is
  gone resumes on the default subagent configuration with a notice. The main
  session's own convar writes are parked meanwhile: they seed the child's
  inherited layer beneath its class, are never journaled into the child, and
  return on switching back. The `task` tool follows the presented session: a
  resumed child at the recursion ceiling is not advertised `task`, exactly as
  a child spawned at that depth is not.
- `models.toml` `compat` (on a provider, a model, or a `modelOverrides` entry)
  sets wire-policy properties such as `supportsDeveloperRole = false` for a
  gateway that rejects the `developer` message role. `discovery::models`
  derives a wire policy from the base the row would otherwise use, plus the
  provider's `compat`, plus the model's, and the overlay carries it
  (`CatalogOverlayBuilder::with_wire_policy`). For a configured provider the
  provider record and its discovery defaults carry it, so every discovered row
  inherits it; for a bundled provider its models are patched and its provider
  record replaced. Each key is checked alone: v1 imports copy v1-only keys
  here, and a refusal would stop the whole catalog composing, so a key this
  build does not understand, or whose value it cannot compile, is skipped with
  a `tracing` warning.
- `v1_import` is the one-shot v1 (TypeScript `omp`) migrator behind
  `omp config import-v1` and the automatic first run. Imported API keys go
  through the control-plane write, which stores them under the kind their
  provider's routes lease (`bearer` for a bearer-token provider). Every
  production composition re-stores, before any request, static secrets stored
  under a kind their provider's routes do not lease, where a write would move
  them: only between `api-key` and `bearer`, only for a provider whose
  bundled routes send both alike, so removing a `models.toml` auth never
  changes how a stored secret is sent. Rows are re-encrypted, since the kind
  is authenticated with the ciphertext, each on its own: a row it cannot
  decrypt is logged with its account and waits for a later launch, and
  composition never fails for it. Its `sessions` step and
  the `/resume @v1` picker convert v1 transcripts into `.oms` journals. The
  imported journal is the only record of an import: its `<meta>` provenance
  (`import-format omp1`, `import-source-id`, `import-source`) is written before
  any transcript entry, and `ImportedIndex` derives from it which v1 sessions
  already have a journal, so the picker marks those rows (picking one reopens
  the journal) and a bulk re-run reports them skipped instead of converting
  again; deleting the journal makes the session importable again. v1's
  `artifact://<N>` URIs stay verbatim in journaled text: the importer copies
  each file of the session's artifact directory into the bucket's project blob
  store and journals its v1 id and `sha256` digest as
  `<meta><foreign-artifact>`, and `omp-envd`'s `artifact://` resolver maps a
  numeric id through that mapping for the session reading it. A referenced id
  with no v1 file is reported, not fatal.
  Imported OAuth accounts keep their v1 account identities but reconstruct
  native principal identity from catalog-selected JWT evidence or retained
  email metadata. An existing native principal is not imported again, and
  later native login reuses the imported account rather than duplicating it.

`omp-driver` may construct `omp_envd::ProjectEnvironment` and supply the
higher-layer bridges it needs, but the filesystem/process/document/tool host
and Python extension-host/worker implementation remain in `omp-envd`.
Environment requests use `omp-env` clients. Neither boundary is reimplemented
in the driver.

`EnvToolExecutor` accepts both settled `CallOutcome` verdicts and detached
`ToolTerminal` descriptors. It verifies and adopts the original descriptor
artifact into the active session CAS, preserving the job identifier, owner
generation, metadata, and expected settlement artifact. The dispatcher records
the same detached journal shape as native execution, rather than reporting a
normal success or fabricating a second job. Malformed descriptors, stale
invocation/session identities, and already-settled job snapshots are rejected.
An unfinished invocation is cancelled on stream drop; a terminal verdict
disarms that guard, leaving detached resource cleanup with its environment owner.

## Philosophy

There is one headless production composition that every presentation reuses.
CLI parsing, terminal interaction, display policy, and presentation-protocol
adaptation stay in `omp-app`; reusable session state and authority wiring stay
here. This keeps print, RPC, ACP, and TUI modes from growing separate agent
stacks and
prevents presentation code from acquiring environment-host internals.

## Development

Run `just setup-python` once before commands that link embedded Python. Use
`just check-pkg omp-driver` and `just test-pkg omp-driver`. For joined session
behavior, use `just e2e` or an exact narrower E2E recipe from `just --list`.
Local model engines are opt-in through `local-all` or the individual
`local-*` features.
