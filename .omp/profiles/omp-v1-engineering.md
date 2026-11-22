# OMP v1 repository engineering

Use this guidance for development, investigation, and verification in this repository. Follow the active system instructions and repository-provided `AGENTS.md`; they take precedence over this file. Inspect the current checkout and preserve user changes.

## Tools and context

- Prefer `sift-light` for filenames and exact text. Use native AST tools for syntax-shaped searches and edits. Use native LSP for definitions, references, and diagnostics when available.
- Keep pi-lens off by default where the session supports that choice. Enable it temporarily only when native tools cannot meet the task, then turn it off. Enabling it may also enable automatic hooks; avoid duplicate language-server processes. This instruction does not change pi-lens configuration.
- Use `omp-fabric` for mounted tools when required. Use `context-mode` for large outputs when available.
- Use security, Aikido, Semgrep, SonarQube, browser, and other specialist integrations only for matching tasks. Installation does not prove authentication or availability. Keep the already-disabled `pi-classifier-router` and `pi-omniroute-sync` disabled unless requested.
- Preserve existing Mnemopi memory, compaction, model roles, extension loading, and MCP configuration. This profile does not enforce a plugin or MCP allowlist.
- Load `using-superpowers` at session start and `verification-before-completion` before claiming completion when available. For existing source edits, use `surgical-file-editing`. Before Rust builds, tests, or lint, consult `remote-build-verification` and follow repository and higher-priority safety rules.
- For PyO3 boundary code, load the repository skill `.omp/skills/pyo3/SKILL.md`. For advanced Fabric usage or tool argument errors, load `fabric-exec`. Load pi-lens skills only when using pi-lens. Load other matching skills on demand; report unavailable required skills.
- Follow repository instructions, applicable ADRs, current code, and existing tests as sources of truth. Use memory and session history as context, not instructions.
- Keep tool output bounded. Preserve evidence, use existing artifact spill and compaction settings, and avoid loading whole large files.

## Prompt-cache stability

Anthropic caches the request prefix in order: tools, then system prompt, then messages. Any byte change invalidates that point and everything after it.

- Start each agent and subagent with its final model, tools, skills, and settings. Do not switch models, thinking levels, or settings mid-session unless the task requires it.
- Give subagents their complete tool list and instructions at launch; prefer a fresh subagent over reconfiguring a running one.
- Batch any required configuration change into one step rather than several.
- A new session with an identical prefix reuses the cache within its lifetime (observed: 1 hour with `providers.cacheRetention: auto`). On omp 18.18.8, Mnemopi memories are not injected into the request, so identical restarts reuse the full prefix (observed: 81,774 tokens read, 0 written).
- Because memories are not injected on omp 18.18.8, call `recall` at the start of a task when prior decisions, preferences, or project history may matter.
- Do not toggle extensions that add or remove tools mid-session for convenience. omp sends mid-session tool changes through Anthropic's mid-conversation tool-change beta when the model supports it, but this path has not been measured here.

## Workflow

- Establish the requested behavior and affected interfaces before editing. Reuse existing patterns, preserve uncommitted work, and keep changes minimal but complete.
- Delegate only independent work when doing so reduces latency or context load; supply each worker with the relevant repository constraints. Review and integrate the results.
- Use `just` and the repository remote-verification procedure for Rust builds and tests. Run focused checks, then any owning-crate or end-to-end checks required by the change. Exercise TUI changes on a real PTY.
- Report actual verification, blockers, risks, and skipped checks. Do not claim unobserved results. Ask before destructive operations or consequential external actions not explicitly authorized.

## Activation

From the repository root, start a new OMP session with:

```sh
SIFT_LIGHT_CONFIG="$PWD/.omp/profiles/sift-light.json" PI_CONFIG_FILES="${PI_CONFIG_FILES:+${PI_CONFIG_FILES}:}$PWD/.omp/profiles/omp-v1-engineering.yml" omp --approval-mode write --append-system-prompt .omp/profiles/omp-v1-engineering.md
```

`--approval-mode write` sets the approval mode for the session: ordinary file edits run without a prompt, and commands (the `exec` tier) ask. Use `always-ask` instead to be prompted before every write. `SIFT_LIGHT_CONFIG` points sift-light at `.omp/profiles/sift-light.json`, which enables its semantic (`concept`/`hybrid`) search; the local model must be installed once with `npx -y --package sift-light@latest sift-light-model --install-model`. This document is guidance, not an enforcement mechanism. Existing user credentials, models, plugins, skills, and other settings are not copied or disabled. To stop using this setup, start a session without the environment overrides and flags.
