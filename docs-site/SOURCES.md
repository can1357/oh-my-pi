# Page → source map

Maintenance metadata for the docs site. Each docs page lists the repo sources it was
grounded in. **When one of these sources changes, re-check the mapped page.** Not
published — this file lives outside `src/content/`.

Format: `page → sources` (repo-relative paths).

## Getting Started

- `getting-started/installation.md` → `README.md`, `packages/coding-agent/src/commands/install.ts`, `commands/update.ts`, `commands/setup.ts`, `commands/completions.ts`
- `getting-started/quickstart.md` → `README.md`, `packages/coding-agent/src/cli/args.ts`
- `getting-started/first-session.md` → `README.md`, `docs/keybindings.md`, `docs/session-operations-export-share-fork-resume.md`

## Configuration

- `configuration/settings.md` → `docs/settings.md`, `docs/config-usage.md`
- `configuration/environment-variables.md` → `docs/environment-variables.md`
- `configuration/keybindings.md` → `docs/keybindings.md`
- `configuration/themes.md` → `docs/theme.md`
- `configuration/context-files.md` → `docs/context-files.md`, `docs/rulebook-matching-pipeline.md`
- `configuration/system-prompt.md` → `docs/system-prompt-customization.md`
- `configuration/approvals.md` → `docs/approval-mode.md`, `docs/secrets.md`

## Models

- `models/providers.md` → `docs/providers.md`, `docs/adding-a-provider.md`, `docs/provider-endpoint-constraints.md`, `docs/auth-broker-gateway.md`
- `models/model-roles.md` → `docs/models.md`, `docs/settings.md` (Models/Thinking groups), `README.md`
- `models/local-models.md` → `docs/local-models.md`

## Features

- `features/sessions.md` → `docs/session.md`, `docs/session-operations-export-share-fork-resume.md`, `docs/session-switching-and-recent-listing.md`, `docs/session-tree-plan.md`, `docs/handoff-generation-pipeline.md`
- `features/compaction.md` → `docs/compaction.md`, `docs/non-compaction-retry-policy.md`
- `features/memory.md` → `docs/memory.md`, `docs/mnemosyne-memory-backend.md`, `docs/tools/memory_edit.md`, `docs/tools/recall.md`, `docs/tools/retain.md`, `docs/tools/reflect.md`
- `features/tools.md` → `docs/tools/` (all)
- `features/code-execution.md` → `docs/bash-tool-runtime.md`, `docs/python-repl.md`, `docs/notebook-tool-runtime.md`, `docs/tools/bash.md`, `docs/tools/eval.md`
- `features/code-intelligence.md` → `docs/lsp-config.md`, `docs/tools/lsp.md`, `docs/tools/ast-grep.md`, `docs/tools/ast-edit.md`
- `features/debugging.md` → `docs/tools/debug.md`
- `features/subagents.md` → `docs/task-agent-discovery.md`, `docs/tools/task.md`, `docs/tools/hub.md`
- `features/advisor.md` → `docs/advisor-watchdog.md`
- `features/code-review.md` → `packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts`, `packages/coding-agent/src/prompts/review-request.md`, `packages/coding-agent/src/task/types.ts`, `docs/tools/github.md`
- `features/collab.md` → `docs/collab.md`, `packages/coding-agent/src/commands/join.ts`
- `features/web-search.md` → `docs/tools/web_search.md`, `packages/coding-agent/src/commands/web-search.ts`
- `features/browser.md` → `docs/tools/browser.md`
- `features/github.md` → `docs/tools/github.md`
- `features/merge-conflicts.md` → `docs/tools/read.md` (`:conflicts`), `docs/tools/write.md` (`conflict://`), `packages/coding-agent/src/tools/conflict-detect.ts`
- `features/atomic-commits.md` → `packages/coding-agent/src/commit/cli.ts`, `commit/pipeline.ts`, `commit/agentic/tools/split-commit.ts`, `packages/coding-agent/src/commands/commit.ts`
- `features/stream-rules.md` → `docs/ttsr-injection-lifecycle.md`, `docs/rulebook-matching-pipeline.md`, `packages/coding-agent/src/commands/ttsr.ts`, `docs/settings.md` (ttsr group)
- `features/magic-keywords.md` → `docs/magic-keywords.md`
- `features/vibe-mode.md` → `docs/vibe-mode.md`
- `features/editor-integration.md` → `packages/coding-agent/src/commands/acp.ts`, `packages/coding-agent/src/modes/acp/`, `README.md` (ACP sections), `docs/keybindings.md` (`app.editor.external`)
- `features/voice.md` → `docs/tools/tts.md`, `packages/coding-agent/src/commands/say.ts`, `docs/settings.md` (stt/tts groups)
- `features/computer-use.md` → `docs/computer-use.md`, `docs/tools/computer.md`
- `features/stats.md` → `docs/user-facing-packages.md`, `packages/stats/src/index.ts`
- `features/ssh.md` → `packages/coding-agent/src/ssh/`, `packages/coding-agent/src/commands/ssh.ts`, `packages/coding-agent/src/cli/ssh-cli.ts`, `packages/coding-agent/src/internal-urls/ssh-protocol.ts`, `docs/tools/read.md` (ssh://), `docs/tools/glob.md`
- `features/security.md` → `packages/coding-agent/src/security/`, `packages/coding-agent/src/tools/security-scan.ts`, `packages/coding-agent/src/slash-commands/builtin-registry.ts` (/security), `docs/tools/security_scan.md`
- `features/cleanse.md` → `packages/coding-agent/src/cleanse/`, `packages/coding-agent/src/commands/cleanse.ts`, `packages/coding-agent/src/cli/cleanse-cli.ts`
- `features/live-voice.md` → `packages/coding-agent/src/live/`, `packages/coding-agent/src/slash-commands/builtin-registry.ts` (/live), `docs/keybindings.md` (`app.live.toggle`)
- `features/autoresearch.md` → `packages/coding-agent/src/autoresearch/`, `docs/session.md` (autoresearch-control), `docs/environment-variables.md` (`OMP_AUTORESEARCH_DB_DIR`)
- `features/memory.md` → `docs/memory.md`, `docs/mnemosyne-memory-backend.md`, `docs/tools/memory_edit.md`, `docs/tools/recall.md`, `docs/tools/retain.md`, `docs/tools/reflect.md`, `packages/coding-agent/src/autolearn/` (managed skills)

## Extending

- `extending/extensions.md` → `docs/extensions.md`, `docs/extension-loading.md`, `docs/skills/authoring-extensions.md`
- `extending/skills.md` → `docs/skills.md`
- `extending/mcp.md` → `docs/mcp-config.md`, `docs/mcp-protocol-transports.md`, `docs/mcp-runtime-lifecycle.md`, `docs/mcp-server-tool-authoring.md`
- `extending/hooks.md` → `docs/hooks.md`, `docs/skills/authoring-hooks.md`
- `extending/custom-tools.md` → `docs/custom-tools.md`
- `extending/plugins.md` → `docs/marketplace.md`, `docs/skills/authoring-marketplaces.md`, `packages/coding-agent/src/commands/plugin.ts`
- `extending/sdk.md` → `docs/sdk.md`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-manager.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/config/model-registry.ts`, `packages/ai/src/auth-storage.ts`, `packages/coding-agent/src/extensibility/`, `packages/coding-agent/src/mcp/`, `packages/coding-agent/src/lsp/`, `packages/coding-agent/src/tools/`, `packages/agent/src/`
- `extending/rpc.md` → `docs/rpc.md`, `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`, `packages/coding-agent/src/modes/rpc/rpc-client.ts`, `packages/coding-agent/src/modes/rpc/rpc-frame.ts`, `python/omp-rpc/`
- `extending/rpc-vs-sdk.md` → `docs/rpc.md`, `docs/sdk.md`, `packages/coding-agent/src/modes/rpc/rpc-client.ts`, `packages/coding-agent/src/session/agent-session.ts`

## Reference

- `reference/cli.md` → `packages/coding-agent/src/cli-commands.ts`, `packages/coding-agent/src/commands/*.ts`, `packages/coding-agent/src/cli/args.ts`
- `reference/session-logs.md` → `packages/coding-agent/src/session/` (session-entries.ts, session-title-slot.ts, session-persistence.ts, blob-store.ts, session-storage.ts, session-manager.ts, session-paths.ts, session-loader.ts, session-migrations.ts, session-context.ts, session-listing.ts), `packages/coding-agent/src/secrets/obfuscator.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/cli/gc-cli.ts`, `packages/coding-agent/src/config/settings-schema.ts` (gc.*), `packages/utils/src/dirs.ts`, `packages/utils/src/json.ts`
- `reference/data-directory.md` → `packages/utils/src/dirs.ts`, `packages/utils/src/env.ts`, `packages/utils/src/logger.ts`, `packages/coding-agent/src/discovery/builtin.ts`, `packages/coding-agent/src/session/session-paths.ts`, `packages/coding-agent/src/cli/gc-cli.ts`, `packages/coding-agent/src/extensibility/plugins/marketplace/`, `packages/coding-agent/src/ssh/connection-manager.ts`, `packages/coding-agent/src/security/store.ts`, `packages/coding-agent/src/collab/guest.ts`, `packages/coding-agent/src/task/worktree.ts`, `packages/coding-agent/src/tools/gh.ts`, `packages/ai/src/stream.ts`, `packages/ai/src/auth-broker/discover.ts`, `packages/stats/src/`, `packages/coding-agent/src/debug/report-bundle.ts`, `packages/ai/src/utils/http-inspector.ts`, `packages/coding-agent/src/autoresearch/storage.ts`, `packages/coding-agent/scripts/omp`
- `reference/slash-commands.md` → `docs/slash-command-internals.md`, `packages/coding-agent/src/slash-commands/available-commands.ts`, `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `reference/configuration.md` → `docs/settings.md` (Settings catalog)
- `reference/settings/general.md` → `packages/coding-agent/src/config/settings-schema.ts` (General section), `docs/settings.md`
- `reference/settings/tasks.md` → `packages/coding-agent/src/config/settings-schema.ts` (Tasks section), `packages/coding-agent/src/task/`, `packages/coding-agent/src/goals/`, `packages/coding-agent/src/plan-mode/`, `packages/coding-agent/src/discovery/` (skills/commands sources)

## Guides

- `guides/steering-the-agent.md` → `configuration/context-files.md`, `configuration/system-prompt.md`, `features/stream-rules.md`, `features/magic-keywords.md`, `extending/skills.md`, `docs/rulebook-matching-pipeline.md`, `docs/ttsr-injection-lifecycle.md`, `docs/system-prompt-customization.md`, `packages/coding-agent/src/modes/turn-budget.ts`
- `guides/workflow-recipes.md` → `modes/*.md`, `features/*.md` (code-review, atomic-commits, github, subagents, security, cleanse, autoresearch), `packages/coding-agent/src/extensibility/custom-commands/bundled/review/`, `docs/tools/security_scan.md`
- `guides/multi-agent.md` → `packages/coding-agent/src/task/`, `packages/coding-agent/src/registry/`, `packages/coding-agent/src/vibe/`, `packages/coding-agent/src/advisor/`, `packages/coding-agent/src/collab/`, `packages/swarm-extension/README.md`, `docs/tools/task.md`, `docs/tools/hub.md`
- `guides/automation-headless.md` → `packages/coding-agent/src/modes/rpc/`, `packages/coding-agent/src/modes/print-mode.ts`, `packages/coding-agent/src/sdk.ts`, `python/omp-rpc/`, `python/robomp/`, `docs/rpc.md`, `extending/hooks.md`
- `guides/choosing-extension-points.md` → `extending/{skills,extensions,hooks,custom-tools,plugins,mcp,sdk}.md`, `docs/extension-loading.md`, `docs/custom-tools.md`, `docs/marketplace.md`, `docs/slash-command-internals.md`
- `guides/internal-urls.md` → `packages/coding-agent/src/internal-urls/`, `docs/tools/read.md`, `docs/blob-artifact-architecture.md`
- `guides/architecture.md` → `packages/*/README.md`, `crates/*/Cargo.toml`, `python/*/README.md`, `docs/user-facing-packages.md`, `docs/native-crates.md`

## Modes

- `modes/plan-mode.md` → `packages/coding-agent/src/plan-mode/`, `packages/coding-agent/src/modes/controllers/`
- `modes/goal-mode.md` → `packages/coding-agent/src/goals/`, `packages/coding-agent/src/modes/controllers/`
- `modes/loop-mode.md` → `packages/coding-agent/src/modes/loop-limit.ts`
- `modes/queue-mode.md` → `packages/coding-agent/src/modes/queue-input.ts`, `packages/coding-agent/src/slash-commands/builtin-registry.ts` (/queue)
