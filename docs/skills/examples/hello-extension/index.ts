// @ts-nocheck — example file; install @oh-my-pi/pi-coding-agent before running
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function helloExtension(pi: ExtensionAPI) {
	// Show a greeting whenever a session starts.
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("Hello from hello-extension!", "info");
	});

	// Register a /hello slash command that sends a greeting into the conversation.
	pi.registerCommand("hello", {
		description: "Send a greeting into the conversation",
		handler: async (args, ctx) => {
			const name = args.trim() || "there";
			pi.sendMessage(
				{
					customType: "hello-extension",
					content: `Hello, ${name}!`,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify("Message sent!", "info");
		},
	});
}
