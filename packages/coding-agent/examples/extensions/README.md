# Extension Examples

Example extensions for pi-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.omp/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension                | Description                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `permission-gate.ts`     | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `protected-paths.ts`     | Blocks writes to protected paths (.env, .git/, node_modules/)                |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, branch)          |
| `dirty-repo-guard.ts`    | Prevents session changes with uncommitted git changes                        |

### Custom Tools

| Extension     | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `todo.ts`     | Todo list tool + `/todos` command with custom rendering and state persistence |
| `hello.ts`    | Minimal custom tool example                                                   |
| `question.ts` | Demonstrates `ctx.ui.select()` for asking the user questions                  |
| `subagent/`   | Delegate tasks to specialized subagents with isolated context windows         |

### Commands & UI

| Extension                      | Description                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `plan-mode.ts`                 | Claude Code-style plan mode for read-only exploration with `/plan` command     |
| `tools.ts`                     | Interactive `/tools` command to enable/disable tools with session persistence  |
| `handoff.ts`                   | Transfer context to a new focused session via `/handoff <goal>`                |
| `qna.ts`                       | Extracts questions from last response into editor via `ctx.ui.setEditorText()` |
| `status-line.ts`               | Shows turn progress in footer via `ctx.ui.setStatus()` with themed colors      |
| `thinking-note.ts`             | Adds display-only supplemental UI below assistant thinking blocks              |
| `translator-output-preview.ts` | Chinese editor prose → English main-model context → Chinese response display   |
| `snake.ts`                     | Snake game with custom UI, keyboard handling, and session persistence          |

### Bidirectional translator

This example requires a custom OMP build with `registerAssistantTextDisplay`,
fail-closed input rejection, and input draft restoration. It translates ordinary
Chinese editor prose before submission and translates English response prose
only for display. Install the extension independently under
`~/.omp/agent/extensions/translator/index.ts` alongside that matching build;
new OMP sessions then discover `/translator` automatically. Do not load the
example explicitly as well as installing it. For an isolated source checkout
test without saving or resuming any session:

```bash
bun --cwd="$HOME/oh-my-pi" packages/coding-agent/src/cli.ts \
  --no-session --no-extensions \
  --extension packages/coding-agent/examples/extensions/translator-output-preview.ts \
  --no-tools --no-lsp --no-title --no-skills --no-rules --hide-thinking
```

Choose a main model with working authentication, then run `/translator`.
Type Chinese in the original editor: the translator submits English to the
actual main model, which replies in English; the original response area displays
a Chinese translation. The user message and model history contain the submitted
English, not a hidden Chinese copy. Code fences, inline code, link destinations,
path tokens, and `[Image #N]` markers remain unchanged; image attachments are
passed through untouched. English-only prose bypasses input translation, even
when protected code or URLs contain Chinese. Slash/skill commands, `!` shell,
`$` Python, yield-queue shorthand, continuation shortcuts, and empty/image-only
submissions bypass translation, including command arguments. Extension/internal
input is not retranslated.

Both directions use the same independently selected translator, defaulting to
`google-antigravity/gemini-3.7-flash`. `/translator model provider/id` changes
that translator without changing the main model. Chinese input and English
response prose are sent to the selected translation provider. `/translator off`
disables both directions and cancels pending translations. `/translator original`
opens the latest completed English response in a read-only OMP view; interrupted
responses do not replace it. The English response source is never rewritten.

Input translation has a 20-second deadline. Esc during input translation cancels
only that translation, not an active main-model or response-translation request.
Failure, timeout, cancellation, changed session/mode/model, malformed protected
tokens, residual Chinese prose, or a translation introducing command syntax
rejects submission; the core restores the original draft and attachments without
overwriting newer drafts. There is no fallback submission of untranslated Chinese.
Output failure shows a notice with `/translator original` instead of replacing
the English source. Published terminal scrollback cannot be repainted; the
in-memory display cache does not survive a restart. The `--no-session` invocation
never saves the test conversation.

With the matching binary and extension already installed, `omp --no-session`
is sufficient for manual testing. Existing running OMP processes are not
upgraded in place. Preserve the display and fail-closed input interfaces when
merging upstream; an official binary without them is not compatible with this extension.

### Git Integration

| Extension                | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `git-checkpoint.ts`      | Creates git stash checkpoints at each turn for code restoration on branch |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message      |

### System Prompt & Compaction

| Extension              | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `pirate.ts`            | Demonstrates `systemPromptAppend` to dynamically modify system prompt |
| `custom-compaction.ts` | Custom compaction that summarizes entire conversation                 |

### External Dependencies

| Extension         | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `chalk-logger.ts` | Uses chalk from parent node_modules (demonstrates jiti module resolution) |
| `with-deps/`      | Extension with its own package.json and dependencies                      |
| `file-trigger.ts` | Watches a trigger file and injects contents into conversation             |

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	// Subscribe to lifecycle events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
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
		async execute(toolCallId, params, onUpdate, ctx, signal) {
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

```typescript
// Store state in tool result details for proper branching support
return {
	content: [{ type: "text", text: "Done" }],
	details: { todos: [...todos], nextId }, // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.toolName === "my_tool") {
			const details = entry.message.details;
			// Reconstruct state from details
		}
	}
});
```
