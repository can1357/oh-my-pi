/**
 * Hooks Configuration
 *
 * Hooks intercept agent events for logging, blocking, or modification.
 * Note: "hooks" is now called "extensions" in the API.
 */
import { createAgentSession, type ExtensionFactory, SessionManager } from "@oh-my-pi/pi-coding-agent";

// Logging hook (now called extension)
const loggingHook: ExtensionFactory = api => {
	api.on("agent_start", async () => {
		console.log("[Hook] Agent starting");
	});

	api.on("tool_call", async event => {
		console.log(`[Hook] Tool: ${event.toolName}`);
		return undefined; // Don't block
	});

	api.on("agent_end", async event => {
		console.log(`[Hook] Done, ${event.messages.length} messages`);
	});
};

// Blocking extension (returns { block: true, reason: "..." })
const safetyHook: ExtensionFactory = api => {
	api.on("tool_call", async event => {
		if (event.toolName === "bash") {
			const cmd = (event.input as { command?: string }).command ?? "";
			if (cmd.includes("rm -rf")) {
				return { block: true, reason: "Dangerous command blocked" };
			}
		}
		return undefined;
	});
};

// Use inline extensions (hooks is now extensions)
const { session } = await createAgentSession({
	extensions: [loggingHook, safetyHook],
	sessionManager: SessionManager.inMemory(),
});

session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("List files in the current directory.");
console.log();

// Disable all extensions:
// extensions: []

// Merge with discovered extensions:
// const discovered = await discoverExtensions();
// extensions: [...discovered.extensions.map(e => e.factory), myHook]

// Add paths without replacing discovery:
// additionalExtensionPaths: ["/extra/extensions"]
