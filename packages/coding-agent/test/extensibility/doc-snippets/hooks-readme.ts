// Type-checked copy of a snippet in packages/coding-agent/examples/hooks/README.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
// ---- documented snippet below, verbatim ----
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI) {
	// Subscribe to events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && String(event.input.command ?? "").includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
