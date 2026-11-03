// Type-checked copy of block 1 under "## Quick start" in docs/extensions.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
// ---- documented snippet below, verbatim ----
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	pi.setLabel("Safety + Utilities");

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
	});

	pi.on("tool_call", async event => {
		if (event.toolName !== "bash") return;
		// Custom tools share this event, so `input` is not narrowed by the name; read fields defensively.
		const command = String(event.input.command ?? "");
		if (command.includes("rm -rf")) {
			return { block: true, reason: "Blocked by extension policy" };
		}
	});

	pi.registerTool({
		name: "hello_extension",
		label: "Hello Extension",
		description: "Return a greeting",
		parameters: z.object({ name: z.string() }),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}` }],
				details: { greeted: params.name },
			};
		},
	});

	pi.registerCommand("hello-ext", {
		description: "Show queue state",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
		},
	});
}
