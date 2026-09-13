import type { Settings } from "../config/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import codeModelToolPrompt from "../prompts/system/code-model-tool.md" with { type: "text" };
import { runCodeModelMenu } from "./model-menu";
import { installCodeModelSession } from "./session-mode";

export function createCodeModelExtension(settings: Settings): ExtensionFactory {
	return pi => {
		const session = installCodeModelSession(pi, settings);
		pi.registerTool({
			name: "code-model",
			label: "Code Phase Model",
			loadMode: "essential",
			approval: "exec",
			description: codeModelToolPrompt.trim(),
			parameters: pi.zod.object({
				action: pi.zod.enum(["start", "finish", "status"]).default("status"),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const action =
					params &&
					typeof params === "object" &&
					"action" in params &&
					(params.action === "start" || params.action === "finish" || params.action === "status")
						? params.action
						: "status";
				const result = await session.run(action, ctx, signal);
				return { content: [{ type: "text", text: result.message }], details: result };
			},
		});

		pi.registerCommand("code-model", {
			description:
				"Configure the coding provider, model, and effort; use start, finish, or status for phase control.",
			async handler(args, ctx) {
				const action = args.trim();
				if (action !== "start" && action !== "finish" && action !== "status") {
					await runCodeModelMenu(args, ctx, settings);
					return;
				}
				try {
					if (action !== "status" && !ctx.isIdle()) {
						throw new Error(
							"Wait for the active model call to settle; in-flight phase switches use the code-model tool.",
						);
					}
					const result = await session.run(action, ctx);
					if (action !== "finish") ctx.ui.notify(result.message, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}
