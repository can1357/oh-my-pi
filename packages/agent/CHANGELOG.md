# Changelog

## [Unreleased]

## [4.4.8] - 2026-01-12

## [4.4.6] - 2026-01-11

## [4.4.5] - 2026-01-11

## [4.4.4] - 2026-01-11

## [4.3.2] - 2026-01-11

## [4.3.1] - 2026-01-11

## [4.3.0] - 2026-01-11
### Added

- Added `cursorExecHandlers` and `cursorOnToolResult` options for local tool execution with cursor-based streaming
- Added `emitExternalEvent` method to allow external event injection into the agent state

## [4.2.3] - 2026-01-11

## [4.2.2] - 2026-01-11

## [4.2.1] - 2026-01-11

## [4.2.0] - 2026-01-10

## [4.1.0] - 2026-01-10

## [4.0.1] - 2026-01-10

## [4.0.0] - 2026-01-10
### Added

- Added `popLastSteer()` and `popLastFollowUp()` methods to remove and return the last queued message (LIFO) for dequeue operations
- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level
- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`

## [3.37.1] - 2026-01-10

## [3.37.0] - 2026-01-10

## [3.36.0] - 2026-01-10

## [3.35.0] - 2026-01-09

## [3.34.0] - 2026-01-09

## [3.33.0] - 2026-01-08

### Fixed

- Ensured aborted assistant responses always include an error message for callers.
- Filtered thinking blocks from Cerebras request context to keep multi-turn prompts compatible.

## [3.32.0] - 2026-01-08

## [3.31.0] - 2026-01-08

## [3.30.0] - 2026-01-07

## [3.25.0] - 2026-01-07

## [3.24.0] - 2026-01-07

## [3.21.0] - 2026-01-06

### Changed

- Switched from local `@oh-my-pi/pi-ai` to upstream `@oh-my-pi/pi-ai` package

### Added

- Added `sessionId` option for provider caching (e.g., OpenAI Codex session-based prompt caching)
- Added `sessionId` getter/setter on Agent class for runtime session switching

## [3.20.1] - 2026-01-06

## [3.20.0] - 2026-01-06

### Breaking Changes

- Replaced `queueMessage`/`queueMode` with steering + follow-up queues: use `steer`, `setSteeringMode`, and `getSteeringMode` for mid-run interruptions, and `followUp`, `setFollowUpMode`, and `getFollowUpMode` for post-turn messages
- Agent loop callbacks now use `getSteeringMessages` and `getFollowUpMessages` instead of `getQueuedMessages`

### Added

- Added follow-up message queue support so new user messages can continue a run after the agent would otherwise stop
- Added `RenderResultOptions.spinnerFrame` for animated tool-result rendering

### Changed

- `prompt()` and `continue()` now throw when the agent is already streaming; use steering or follow-up queues instead

## [3.15.1] - 2026-01-05

## [3.15.0] - 2026-01-05

## [3.14.0] - 2026-01-04

## [3.13.1337] - 2026-01-04

## [3.9.1337] - 2026-01-04

## [3.8.1337] - 2026-01-04

## [3.7.1337] - 2026-01-04

## [3.6.1337] - 2026-01-03

## [3.5.1337] - 2026-01-03

## [3.4.1337] - 2026-01-03

### Added

- Added `popMessage()` method to Agent class for removing and retrieving the last message
- Added abort signal checks during response streaming for faster interruption handling

### Fixed

- Fixed abort handling to properly return aborted message state when stream is interrupted mid-response

## [3.3.1337] - 2026-01-03

## [3.1.1337] - 2026-01-03

## [3.0.1337] - 2026-01-03

## [2.3.1337] - 2026-01-03

## [2.2.1337] - 2026-01-03

## [2.1.1337] - 2026-01-03

## [2.0.1337] - 2026-01-03

## [1.500.0] - 2026-01-03

## [1.341.0] - 2026-01-03

### Added

- Added `interruptMode` option to control when queued messages interrupt tool execution.
- Implemented "immediate" mode (default) to check queue after each tool and interrupt remaining tools.
- Implemented "wait" mode to defer queue processing until the entire turn completes.
- Added getter and setter methods for `interruptMode` on Agent class.

## [1.338.0] - 2026-01-03

## [1.337.1] - 2026-01-02

### Changed

- Forked to @oh-my-pi scope with unified versioning across all packages

## [1.337.0] - 2026-01-02

Initial release under @oh-my-pi scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:

  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@oh-my-pi/pi-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@oh-my-pi/pi-agent` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).