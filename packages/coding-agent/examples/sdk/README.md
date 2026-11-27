# SDK Examples

Programmatic usage of omp-coding-agent via `createAgentSession()`.

## Examples

| File                       | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `01-minimal.ts`            | Simplest usage with all defaults                        |
| `02-custom-model.ts`       | Select model and thinking level                         |
| `03-custom-prompt.ts`      | Replace or modify system prompt                         |
| `04-skills.ts`             | Discover, filter, or replace skills                     |
| `06-extensions.ts`         | Load extensions and register tools                      |
| `06-hooks.ts`              | Log and block events with extension factories           |
| `07-context-files.ts`      | AGENTS.md context files                                 |
| `08-prompt-templates.ts`   | File-based prompt templates                             |
| `08-slash-commands.ts`     | Migrate file-based slash commands to prompt templates   |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config                        |
| `11-sessions.ts`           | In-memory, persistent, continue, and list sessions      |
| `12-redis-sessions.ts`     | Store sessions in Redis or Valkey                       |
| `13-sql-sessions.ts`       | Store sessions in PostgreSQL, MySQL, SQLite, or MariaDB |

## Running

```bash
cd packages/coding-agent
bun examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	AuthStorage,
	createAgentSession,
	createTools,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";

// Auth and models setup
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

// Minimal
const { session: minimalSession } = await createAgentSession({ authStorage, modelRegistry });

// Custom model
const model = getBundledModel("anthropic", "claude-opus-4-5");
const { session: customModelSession } = await createAgentSession({
	model,
	thinkingLevel: ThinkingLevel.High,
	authStorage,
	modelRegistry,
});

// Modify prompt
const { session: promptSession } = await createAgentSession({
	systemPrompt: defaultPrompt => [...defaultPrompt, "Be concise."],
	authStorage,
	modelRegistry,
});

// Read-only tools
const { session: readOnlySession } = await createAgentSession({
	toolNames: ["read", "grep", "glob"],
	authStorage,
	modelRegistry,
});

// In-memory
const { session: inMemorySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});

// Full control
const customAuth = await AuthStorage.create("/my/app/agent.db");
customAuth.keys.setRuntime("anthropic", Bun.env.MY_KEY!);
const customRegistry = new ModelRegistry(customAuth, "/my/app/models.yml");

const { session: controlledSession } = await createAgentSession({
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
minimalSession.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await minimalSession.prompt("Hello");
```

## Resolve preview workflow (AST edit apply/discard)

`ast_edit` now always returns a preview. To finalize, run the `resolve` or `reject` command with the reason as its argument.

- `resolve "<reason>"` → apply the pending preview
- `reject "<reason>"` → discard the pending preview

While the `bash` tool is active these run as bash tool commands; otherwise `createAgentSession()` / `createTools()` present them as top-level tools whenever a deferrable tool (e.g. `ast_edit`) is present.

```typescript
const tools = await createTools(toolSession, ["ast_edit"]); // resolve is included

const resolveTool = tools.find(t => t.name === "resolve")!;

await resolveTool.execute("call-1", {
	reason: "Preview matches expected replacements",
});
```

## Options

| Option                     | Default                       | Description                                |
| -------------------------- | ----------------------------- | ------------------------------------------ |
| `authStorage`              | `discoverAuthStorage()`       | Credential storage                         |
| `modelRegistry`            | From `<agentDir>/models.yml`  | Model registry                             |
| `cwd`                      | `process.cwd()`               | Working directory                          |
| `agentDir`                 | `~/.omp/agent`                | Config directory                           |
| `model`                    | From settings/first available | Model to use                               |
| `thinkingLevel`            | From settings/"off"           | off, low, medium, high                     |
| `systemPrompt`             | Discovered                    | Strings or `(default) => modified strings` |
| `toolNames`                | All built-in tools            | Filter which tools to include              |
| `customTools`              | `[]`                          | Additional inline custom tools             |
| `extensions`               | `[]`                          | Inline extensions merged with discovery    |
| `additionalExtensionPaths` | `[]`                          | Merge with extension discovery             |
| `skills`                   | Discovered                    | Skills for prompt                          |
| `contextFiles`             | Discovered                    | AGENTS.md files                            |
| `slashCommands`            | Discovered                    | File commands                              |
| `sessionManager`           | `SessionManager.create(cwd)`  | Persistence                                |
| `settingsManager`          | From agentDir                 | Settings overrides                         |

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
