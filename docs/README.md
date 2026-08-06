# oh-my-pk documentation

Canonical documentation home: **https://oh-my-pk.pkking.computer/docs**

This directory is the complete source for user guides, configuration reference,
tool reference, integration surfaces, and architecture notes. The product host
links here for the full Markdown set; the same documents are also embedded in
the CLI for `omp://docs` and `/help <question>`.

## Start here

- [Install identity](install-id.md)
- [Settings and `config.yml`](settings.md)
- [Environment variables](environment-variables.md)
- [Models and `models.yml`](models.md)
- [Providers and credentials](providers.md)
- [Context files](context-files.md)
- [Keybindings](keybindings.md)
- [Themes](theme.md)
- [Built-in help](help.md)

## Daily workflows

- [Sessions](session.md)
- [Session operations: export, share, fork, resume](session-operations-export-share-fork-resume.md)
- [Session switching and recent listing](session-switching-and-recent-listing.md)
- [Approval modes](approval-mode.md)
- [Compaction](compaction.md)
- [Memory](memory.md)
- [Advisor and watchdog](advisor-watchdog.md)
- [Cost and performance tuning](cost-performance-tuning.md)
- [Ethereal workspaces](ethereal-workspaces.md)
- [Session tree](tree.md)

## Tool reference

- [read](tools/read.md)
- [write](tools/write.md)
- [edit](tools/edit.md)
- [ast_edit](tools/ast-edit.md)
- [ast_grep](tools/ast-grep.md)
- [search](tools/search.md)
- [find](tools/find.md)
- [bash](tools/bash.md)
- [eval](tools/eval.md)
- [lsp](tools/lsp.md)
- [debug](tools/debug.md)
- [browser](tools/browser.md)
- [github](tools/github.md)
- [web_search](tools/web_search.md)
- [task](tools/task.md)
- [search_tool_bm25](tools/search_tool_bm25.md)
- [Context layer](tools/context-layer.md)

## Collaboration and orchestration

- [Collab sessions and browser client](collab.md)
- [Capture to agent](capture-to-agent.md)
- [Task agent discovery](task-agent-discovery.md)
- [Task contract orchestration](task-contract-orchestration.md)
- [Multi-agent fork collaboration](multi-agent-fork-collaboration.md)
- [Prime Agent control-plane adaptation](prime-agent-control-plane-adaptation.md)
- [Environments cloud](environments-cloud.md)
- [Fork boundaries](fork-boundaries.md)

## Extensions and integrations

- [Extensions](extensions.md)
- [Extension loading](extension-loading.md)
- [Marketplace](marketplace.md)
- [Custom tools](custom-tools.md)
- [Skills](skills.md)
- [Hooks](hooks.md)
- [MCP configuration](mcp-config.md)
- [MCP server and tool authoring](mcp-server-tool-authoring.md)
- [Auth broker and gateway](auth-broker-gateway.md)
- [RPC](rpc.md)
- [SDK](sdk.md)
- [Adding a provider](adding-a-provider.md)

## Architecture and internals

- [Native architecture](natives-architecture.md)
- [Native binding contract](natives-binding-contract.md)
- [Provider streaming internals](provider-streaming-internals.md)
- [Provider endpoint constraints](provider-endpoint-constraints.md)
- [TUI](tui.md)
- [TUI core renderer](tui-core-renderer.md)
- [MCP protocol transports](mcp-protocol-transports.md)
- [MCP runtime lifecycle](mcp-runtime-lifecycle.md)
- [Porting from Pi](porting-from-pi-mono.md)
- [Porting to natives](porting-to-natives.md)

## Operations

- [Fork releases](RELEASING-FORK.md)
- [macOS signing and notarization](macos-signing-notarization.md)
- [Config usage](config-usage.md)
- [Local models](local-models.md)
- [Handoff generation pipeline](handoff-generation-pipeline.md)
- [Blob artifact architecture](blob-artifact-architecture.md)
- [Filesystem scan cache architecture](fs-scan-cache-architecture.md)
