// Type-checked copy of block 3 under "## Key Patterns" in packages/coding-agent/examples/extensions/README.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

declare const pi: ExtensionAPI;
// ---- documented snippet below, verbatim ----
pi.on("session_start", async (_event, ctx) => {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "my_tool") {
			const details = entry.message.details;
			// Reconstruct state from details
		}
	}
});
