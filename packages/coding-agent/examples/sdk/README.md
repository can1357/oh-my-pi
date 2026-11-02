# SDK Examples

Programmatic usage of omp-coding-agent via `createAgentSession()`.

## Examples

| File                       | Description                                         |
| -------------------------- | --------------------------------------------------- |
| `01-minimal.ts`            | Simplest usage with all defaults                    |
| `02-custom-model.ts`       | Select model and thinking level                     |
| `03-custom-prompt.ts`      | Replace or modify system prompt                     |
| `04-skills.ts`             | Discover, filter, or replace skills                 |
| `06-extensions.ts`         | Inline and file extensions, extension tools         |
| `06-hooks.ts`              | Logging, blocking, result modification (extensions) |
| `07-context-files.ts`      | AGENTS.md context files                             |
| `08-prompt-templates.ts`   | File-based prompt templates                         |
| `08-slash-commands.ts`     | File-based slash commands                           |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config                    |
| `11-sessions.ts`           | In-memory, persistent, continue, list sessions      |
| `12-redis-sessions.ts`     | Sessions stored in Redis or Valkey                  |
| `13-sql-sessions.ts`       | Sessions stored in PostgreSQL, MySQL or SQLite      |

## Running

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	discoverSkills,
	discoverExtensions,
	discoverContextFiles,
	discoverSlashCommands,
	buildSystemPrompt,
	ModelRegistry,
	SessionManager,
	Settings,
	BUILTIN_TOOLS,
	HIDDEN_TOOLS,
	createTools,
} from "@oh-my-pi/pi-coding-agent";

// Auth and models setup
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

// Minimal
const { session } = await createAgentSession({ authStorage, modelRegistry });

// Custom model
const model = getBundledModel("anthropic", "claude-opus-4-5");
const { session } = await createAgentSession({ model, thinkingLevel: "high", authStorage, modelRegistry });

// Modify prompt
const { session } = await createAgentSession({
	systemPrompt: defaultPrompt => [...defaultPrompt, "Be concise."],
	authStorage,
	modelRegistry,
});

// Read-only tools
const { session } = await createAgentSession({ toolNames: ["read", "grep", "find"], authStorage, modelRegistry });

// In-memory
const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});

// Full control
const customAuth = await AuthStorage.create("/my/app/agent.db");
customAuth.keys.setRuntime("anthropic", Bun.env.MY_KEY!);
const customRegistry = new ModelRegistry(customAuth);

const { session } = await createAgentSession({
	model,
	authStorage: customAuth,
	modelRegistry: customRegistry,
	systemPrompt: ["You are helpful."],
	toolNames: ["read", "bash"],
	customTools: [myTool],
	extensions: [myExtension],
	skills: [],
	contextFiles: [],
	slashCommands: [],
	sessionManager: SessionManager.inMemory(),
});

// Run prompts
session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await session.prompt("Hello");
```

## Resolve preview workflow (AST edit apply/discard)

`ast_edit` now always returns a preview. To finalize, write plain text to the appropriate virtual device with the `write` tool.

- `xd://resolve` → apply the pending preview; body = reason text
- `xd://reject` → discard the pending preview; body = reason text

`createAgentSession()` / `createTools()` auto-include `write` whenever a deferrable tool (e.g. `ast_edit`) is present, so the devices are always reachable.

```typescript
const tools = await createTools(toolSession, ["ast_edit"]); // write is auto-included
const writeTool = tools.find(t => t.name === "write")!;

await writeTool.execute("call-1", {
	path: "xd://resolve",
	content: "Preview matches expected replacements",
});
```

## Options

| Option                     | Default                          | Description                       |
| -------------------------- | -------------------------------- | --------------------------------- |
| `authStorage`              | `discoverAuthStorage()`          | Credential storage                |
| `modelRegistry`            | `new ModelRegistry(authStorage)` | Model registry                    |
| `cwd`                      | `process.cwd()`                  | Working directory                 |
| `agentDir`                 | `~/.omp/agent`                   | Config directory                  |
| `model`                    | From settings/first available    | Model to use                      |
| `thinkingLevel`            | From settings/"off"              | off, low, medium, high            |
| `systemPrompt`             | Discovered                       | String or `(default) => modified` |
| `toolNames`                | All built-in tools               | Filter which tools to include     |
| `customTools`              | `[]`                             | Extra tools for the session       |
| `extensions`               | Discovered                       | Inline extension factories        |
| `additionalExtensionPaths` | `[]`                             | Merge with discovery              |
| `skills`                   | Discovered                       | Skills for prompt                 |
| `contextFiles`             | Discovered                       | AGENTS.md files                   |
| `slashCommands`            | Discovered                       | File commands                     |
| `sessionManager`           | `SessionManager.create(cwd)`     | Persistence                       |
| `settings`                 | From agentDir                    | Settings overrides                |

## Events

```typescript
session.subscribe(event => {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			break;
		case "tool_execution_start":
			console.log(`Tool: ${event.toolName}`);
			break;
		case "tool_execution_end":
			console.log(`Result: ${event.result}`);
			break;
		case "agent_end":
			console.log("Done");
			break;
	}
});
```
