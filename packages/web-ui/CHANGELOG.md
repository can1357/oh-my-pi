# Changelog

## [Unreleased]

## [3.5.1337] - 2026-01-03

## [3.4.1337] - 2026-01-03

## [3.3.1337] - 2026-01-03

## [3.1.1337] - 2026-01-03

## [3.0.1337] - 2026-01-03

## [2.3.1337] - 2026-01-03

## [2.2.1337] - 2026-01-03

## [2.1.1337] - 2026-01-03

## [2.0.1337] - 2026-01-03

## [1.500.0] - 2026-01-03

## [1.341.0] - 2026-01-03

## [1.338.0] - 2026-01-03

## [1.337.1] - 2026-01-02

### Changed

- Forked to @oh-my-pi scope with unified versioning across all packages
- Added repository field for npm provenance

## [1.337.0] - 2026-01-02

Initial release under @oh-my-pi scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent class moved to `@oh-my-pi/pi-agent-core`**: The `Agent` class, `AgentState`, and related types are no longer exported from this package. Import them from `@oh-my-pi/pi-agent-core` instead.

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, `AgentTransport` interface, and related types have been removed. The `Agent` class now uses `streamFn` for custom streaming.

- **`AppMessage` renamed to `AgentMessage`**: Now imported from `@oh-my-pi/pi-agent-core`. Custom message types use declaration merging on `CustomAgentMessages` interface.

- **`UserMessageWithAttachments` is now a custom message type**: Has `role: "user-with-attachments"` instead of `role: "user"`. Use `isUserMessageWithAttachments()` type guard.

- **`CustomMessages` interface removed**: Use declaration merging on `CustomAgentMessages` from `@oh-my-pi/pi-agent-core` instead.

- **`agent.appendMessage()` removed**: Use `agent.queueMessage()` instead.

- **Agent event types changed**: `AgentInterface` now handles new event types from `@oh-my-pi/pi-agent-core`: `message_start`, `message_end`, `message_update`, `turn_start`, `turn_end`, `agent_start`, `agent_end`.

### Added

- **`defaultConvertToLlm`**: Default message transformer that handles `UserMessageWithAttachments` and `ArtifactMessage`. Apps can extend this for custom message types.

- **`convertAttachments`**: Utility to convert `Attachment[]` to LLM content blocks (images and extracted document text).

- **`isUserMessageWithAttachments` / `isArtifactMessage`**: Type guard functions for custom message types.

- **`createStreamFn`**: Creates a stream function with CORS proxy support. Reads proxy settings on each call for dynamic configuration.

- **Default `streamFn` and `getApiKey`**: `AgentInterface` now sets sensible defaults if not provided:

  - `streamFn`: Uses `createStreamFn` with proxy settings from storage
  - `getApiKey`: Reads from `providerKeys` storage

- **Proxy utilities exported**: `applyProxyIfNeeded`, `shouldUseProxyForProvider`, `isCorsError`, `createStreamFn`

### Removed

- `Agent` class (moved to `@oh-my-pi/pi-agent-core`)
- `ProviderTransport` class
- `AppTransport` class
- `AgentTransport` interface
- `AgentRunConfig` type
- `ProxyAssistantMessageEvent` type
- `test-sessions.ts` example file

### Migration Guide

**Before (0.30.x):**

```typescript
import { Agent, ProviderTransport, type AppMessage } from '@oh-my-pi/pi-web-ui';

const agent = new Agent({
  transport: new ProviderTransport(),
  messageTransformer: (messages: AppMessage[]) => messages.filter(...)
});
```

**After:**

```typescript
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { defaultConvertToLlm } from "@oh-my-pi/pi-web-ui";

const agent = new Agent({
	convertToLlm: (messages: AgentMessage[]) => {
		// Extend defaultConvertToLlm for custom types
		return defaultConvertToLlm(messages);
	},
});
// AgentInterface will set streamFn and getApiKey defaults automatically
```

**Custom message types:**

```typescript
// Before: declaration merging on CustomMessages
declare module "@oh-my-pi/pi-web-ui" {
	interface CustomMessages {
		"my-message": MyMessage;
	}
}

// After: declaration merging on CustomAgentMessages
declare module "@oh-my-pi/pi-agent-core" {
	interface CustomAgentMessages {
		"my-message": MyMessage;
	}
}
```
