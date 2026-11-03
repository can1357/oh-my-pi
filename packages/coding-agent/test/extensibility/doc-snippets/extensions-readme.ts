// Type-checked copy of a snippet in packages/coding-agent/examples/extensions/README.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
// ---- documented snippet below, verbatim ----
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
