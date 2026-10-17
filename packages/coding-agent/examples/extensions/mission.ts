import type { ExtensionAPI, ExtensionContext, ModeRequest, ModeResult } from "@oh-my-pi/pi-coding-agent";

function report(ctx: ExtensionContext, result: ModeResult): void {
	ctx.ui.notify(
		result.ok ? `Modes: ${JSON.stringify(result.state)}` : `${result.code}: ${result.message}`,
		result.ok ? "info" : "error",
	);
}

export default function mission(pi: ExtensionAPI): void {
	pi.registerCommand("mission", {
		description: "Enter built-in plan mode, then submit your mission separately",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /mission <request>", "warning");
				return;
			}
			const result = await ctx.modes.set({ mode: "plan", action: "enter" });
			if (!result.ok) {
				report(ctx, result);
				return;
			}
			pi.sendUserMessage(args);
		},
	});
	pi.registerCommand("mission-exit", {
		description: "Leave planning without approving, executing, or deleting the draft",
		handler: async (_args, ctx) => report(ctx, await ctx.modes.set({ mode: "plan", action: "exit" })),
	});
	pi.registerCommand("mission-modes", {
		description: 'Query modes, or pass a typed transition as JSON: {"mode":"vibe","action":"enter"}',
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify(JSON.stringify(ctx.modes.getState()), "info");
				return;
			}
			let request: ModeRequest;
			try {
				request = JSON.parse(args) as ModeRequest;
			} catch {
				ctx.ui.notify("Expected a mode transition JSON object.", "error");
				return;
			}
			report(ctx, await ctx.modes.set(request));
		},
	});
	pi.on("mode_changed", (event, ctx) => {
		ctx.ui.setStatus(
			"mission",
			`plan:${event.state.plan.status} vibe:${event.state.vibe.status} goal:${event.state.goal.status} loop:${event.state.loop.status}`,
		);
	});
	pi.on("session_start", (_event, ctx) => {
		const state = ctx.modes.getState();
		ctx.ui.setStatus(
			"mission",
			`plan:${state.plan.status} vibe:${state.vibe.status} goal:${state.goal.status} loop:${state.loop.status}`,
		);
	});
}
