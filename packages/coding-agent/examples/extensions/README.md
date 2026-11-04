# Extension Examples

Example extensions for omp. The lifecycle, git and compaction examples live in [`../hooks/`](../hooks/).

## Usage

```bash
# Load an extension with --extension flag
omp --extension examples/extensions/hello.ts

# Or copy to extensions directory for auto-discovery
cp examples/extensions/hello.ts ~/.omp/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension                         | Description                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `../hooks/permission-gate.ts`     | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `../hooks/protected-paths.ts`     | Blocks writes to protected paths (.env, .git/, node_modules/)                |
| `../hooks/confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, branch)          |
| `../hooks/dirty-repo-guard.ts`    | Prevents session changes with uncommitted git changes                        |

### Custom Tools

| Extension           | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| `hello.ts`          | Minimal custom tool example                                           |
| `api-demo.ts`       | Uses the extension logger, the injected schema builder and pi modules |
| `reload-runtime.ts` | `ctx.reload()` from a command, and a tool that queues a reload        |

### Commands & UI

| Extension                 | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| `plan-mode.ts`            | Claude Code-style plan mode for read-only exploration with `/plan` command     |
| `tools.ts`                | Interactive `/tools` command to enable/disable tools with session persistence  |
| `../hooks/handoff.ts`     | Transfer context to a new focused session via `/handoff <goal>`                |
| `../hooks/qna.ts`         | Extracts questions from last response into editor via `ctx.ui.setEditorText()` |
| `../hooks/status-line.ts` | Shows turn progress in footer via `ctx.ui.setStatus()` with themed colors      |
| `thinking-note.ts`        | Adds display-only supplemental UI below assistant thinking blocks              |

### Git Integration

| Extension                         | Description                                                               |
| --------------------------------- | ------------------------------------------------------------------------- |
| `../hooks/git-checkpoint.ts`      | Creates git stash checkpoints at each turn for code restoration on branch |
| `../hooks/auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message      |

### System Prompt & Compaction

| Extension                       | Description                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `pirate.ts`                     | Returns `systemPrompt` from `before_agent_start` to modify the system prompt |
| `../hooks/custom-compaction.ts` | Custom compaction that summarizes entire conversation                        |

### External Dependencies

| Extension                  | Description                                                               |
| -------------------------- | ------------------------------------------------------------------------- |
| `chalk-logger.ts`          | Uses chalk from parent node_modules (demonstrates jiti module resolution) |
| `with-deps/`               | Extension with its own package.json and dependencies                      |
| `../hooks/file-trigger.ts` | Watches a trigger file and injects contents into conversation             |

## Writing Extensions

See [docs/extensions.md](../../../../docs/extensions.md) for full documentation.

```typescript check=extensions-readme
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	// Subscribe to lifecycle events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && String(event.input.command ?? "").includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom tools
	pi.registerTool({
		name: "greet",
		label: "Greeting",
		description: "Generate a greeting",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});

	// Register commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```

## Key Patterns

**Use `z.enum` for discriminated string tool args:**

```typescript
const z = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```

**State persistence via details:**

In the tool's `execute`, store state in the result's `details` for proper branching support:

```typescript
return {
	content: [{ type: "text", text: "Done" }],
	details: { todos: [...todos], nextId }, // Persisted in session
};
```

Reconstruct it on session events:

```typescript check=extensions-readme-reconstruct
pi.on("session_start", async (_event, ctx) => {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "my_tool") {
			const details = entry.message.details;
			// Reconstruct state from details
		}
	}
});
```
