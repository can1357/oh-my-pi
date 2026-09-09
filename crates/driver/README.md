# omp-driver

`omp-driver` is OMP's journal-first coding-agent composition boundary. It
assembles `omp-agent`, `omp-session`, inference, project-environment tools,
convars, subagent spawning, and live-session routing without depending on CLI,
TUI, or desktop presentation crates.

The crate sits above `omp-envd`, `omp-env`, and `omp-serve` and below
`omp-app`. Driver code composes the session; app code selects a command or
presentation adapter.

## Structure

- `headless::kernel` constructs the production kernel, `.oms` session,
  inference route, environment authority, and session-owned `task`/`hub`
  tools reused by chat, print, RPC, and ACP.
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

`omp-driver` may construct `omp_envd::ProjectEnvironment` and supply the
higher-layer bridges it needs, but the filesystem/process/document/tool host
and Python extension-host/worker implementation remain in `omp-envd`.
Environment requests use `omp-env` clients. Neither boundary is reimplemented
in the driver.

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
