import { describe, expect, test } from "bun:test";
import type { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import { emptyFusionUsage } from "../../src/session/fusion-usage";
import { handleFusionCommand, handleFusionPoolArgs } from "../../src/slash-commands/helpers/fusion";
import { handleFusionCommandTui, showFusionMenu } from "../../src/slash-commands/helpers/fusion-tui";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

/**
 * Minimal in-memory runtime following the okf.test.ts convention: the handler
 * is called directly with a cast runtime; settings are a Map; the model
 * registry advertises no models (so selector resolution warns, never throws).
 */
function makeRuntime(initial: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(initial));
	const outputs: string[] = [];
	const settings = {
		get: (key: string) => store.get(key),
		set: (key: string, value: unknown) => {
			store.set(key, value);
		},
	} as unknown as Settings;
	const session = {
		settings,
		modelRegistry: { getAvailable: () => [] },
		getFusionSidekickId: () => undefined,
		getFusionUsageSplit: () => ({
			total: emptyFusionUsage(),
			frontier: emptyFusionUsage(),
			sidekick: emptyFusionUsage(),
		}),
	} as unknown as AgentSession;
	const runtime = {
		session,
		sessionManager: {},
		settings,
		cwd: ".",
		output: (text: string) => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: () => Promise.resolve(),
	} as unknown as SlashCommandRuntime;
	return { runtime, store, outputs };
}

function runFusion(args: string, initial?: Record<string, unknown>) {
	const harness = makeRuntime(initial);
	const result = handleFusionCommand({ name: "fusion", args, text: `/fusion ${args}` }, harness.runtime);
	return { ...harness, result };
}

function makeTuiContext(initial: Record<string, unknown> = {}) {
	const { runtime, store, outputs } = makeRuntime(initial);
	const repaint = {
		invalidations: 0,
		topBorderUpdates: 0,
		renderRequests: 0,
	};
	const ctx = {
		session: runtime.session,
		sessionManager: { getCwd: () => "." },
		settings: runtime.settings,
		statusLine: {
			invalidate: () => {
				repaint.invalidations++;
			},
		},
		updateEditorTopBorder: () => {
			repaint.topBorderUpdates++;
		},
		ui: {
			requestRender: () => {
				repaint.renderRequests++;
			},
		},
		editor: { setText: () => {} },
		showStatus: (text: string) => {
			outputs.push(text);
		},
		refreshSlashCommandState: () => Promise.resolve(),
		ensureFusionSidekick: () => Promise.resolve(),
		reconcileFusionSidekickModel: () => Promise.resolve(""),
	} as unknown as InteractiveModeContext;
	return { ctx, store, outputs, repaint };
}

describe("/fusion verbs", () => {
	test("on enables fusion and bumps mode off -> escalate", async () => {
		const { store, outputs, result } = runFusion("on", { "fusion.mode": "off" });
		await result;
		expect(store.get("fusion.enabled")).toBe(true);
		expect(store.get("fusion.mode")).toBe("escalate");
		expect(outputs.join(" ")).toContain("Fusion enabled");
	});

	test("on preserves a non-off mode", async () => {
		const { store } = runFusion("on", { "fusion.mode": "delegate" });
		await Promise.resolve();
		expect(store.get("fusion.mode")).toBe("delegate");
	});

	test("off disables fusion without touching mode", async () => {
		const { store, result } = runFusion("off", { "fusion.enabled": true, "fusion.mode": "escalate" });
		await result;
		expect(store.get("fusion.enabled")).toBe(false);
		expect(store.get("fusion.mode")).toBe("escalate");
	});

	test("toggle flips fusion.enabled", async () => {
		const { store, result } = runFusion("toggle", { "fusion.enabled": true, "fusion.mode": "escalate" });
		await result;
		expect(store.get("fusion.enabled")).toBe(false);
	});

	test("mode sets a valid value and rejects an invalid one", async () => {
		const valid = runFusion("mode delegate", { "fusion.mode": "escalate" });
		await valid.result;
		expect(valid.store.get("fusion.mode")).toBe("delegate");

		const invalid = runFusion("mode turbo", { "fusion.mode": "escalate" });
		await invalid.result;
		expect(invalid.store.get("fusion.mode")).toBe("escalate");
		expect(invalid.outputs.join(" ")).toContain("Usage: /fusion mode");
	});

	test("TUI mode changes repaint the live status-line footer", async () => {
		const { ctx, store, outputs, repaint } = makeTuiContext({
			"fusion.enabled": true,
			"fusion.mode": "escalate",
		});

		await handleFusionCommandTui({ name: "fusion", args: "mode delegate", text: "/fusion mode delegate" }, ctx);

		expect(store.get("fusion.mode")).toBe("delegate");
		expect(outputs.join(" ")).toContain('fusion.mode set to "delegate"');
		expect(repaint).toEqual({ invalidations: 1, topBorderUpdates: 1, renderRequests: 1 });
	});

	test("sidekick assigns the selector and warns when unresolvable", async () => {
		const { store, outputs, result } = runFusion("sidekick nonexistent/model");
		await result;
		expect(store.get("fusion.sidekickModel")).toBe("nonexistent/model");
		expect(outputs.join(" ")).toContain("does not resolve");
	});

	test("strong clear unsets the strong sidekick model", async () => {
		const { store, result } = runFusion("strong clear", { "fusion.sidekickStrongModel": "x/y" });
		await result;
		expect(store.get("fusion.sidekickStrongModel")).toBe("");
	});

	test("bare invocation prints status with mode and sidekick", async () => {
		const { outputs, result } = runFusion("", {
			"fusion.enabled": true,
			"fusion.mode": "escalate",
			"fusion.sidekickModel": "pi/smol",
			"fusion.modelPool": [],
		});
		await result;
		const text = outputs.join("\n");
		expect(text).toContain("Fusion is ON");
		expect(text).toContain("(degraded: sidekick unavailable)");
		expect(text).toContain("Mode:            escalate");
		expect(text).toContain("Sidekick model:  pi/smol");
		expect(text).toContain("Sidekick state:  unavailable (not spawned)");
	});
});

describe("/fusion pool", () => {
	test("set writes a tier entry and remove unassigns it", async () => {
		const first = runFusion("pool set 2 cheap/model", { "fusion.modelPool": [] });
		await first.result;
		expect(first.store.get("fusion.modelPool")).toEqual(["2=cheap/model"]);

		const second = runFusion("pool remove 2", { "fusion.modelPool": ["2=cheap/model"] });
		await second.result;
		expect(second.store.get("fusion.modelPool")).toEqual([]);
	});

	test("set rejects an out-of-range tier", async () => {
		const { store, outputs, result } = runFusion("pool set 9 x", { "fusion.modelPool": [] });
		await result;
		expect(store.get("fusion.modelPool")).toEqual([]);
		expect(outputs.join(" ")).toContain("Usage: /fusion pool set");
	});

	test("legacy /fusion-pool prefix keeps its own usage strings", async () => {
		const { runtime, outputs } = makeRuntime({ "fusion.modelPool": [] });
		await handleFusionPoolArgs("set", runtime, "/fusion-pool");
		expect(outputs.join(" ")).toContain("Usage: /fusion-pool set");
	});
});

describe("/fusion menu", () => {
	test("toggle item enables fusion and spawns the sidekick mid-session", async () => {
		const { runtime, store } = makeRuntime({ "fusion.enabled": false, "fusion.mode": "off" });
		const statuses: string[] = [];
		let ensureCalls = 0;
		// Selector script: pick the toggle once, then cancel the menu.
		const selections: (string | undefined)[] = ["Fusion: OFF", undefined];
		const { ctx } = makeTuiContext();
		Object.assign(ctx, {
			session: runtime.session,
			sessionManager: { getCwd: () => "." },
			settings: runtime.settings,
			showHookSelector: (_title: string, _items: unknown[]) => Promise.resolve(selections.shift()),
			showHookInput: () => Promise.resolve(undefined),
			showSettingsSelector: () => {},
			showStatus: (text: string) => {
				statuses.push(text);
			},
			editor: { setText: () => {} },
			refreshSlashCommandState: () => Promise.resolve(),
			ensureFusionSidekick: () => {
				ensureCalls++;
				return Promise.resolve();
			},
			reconcileFusionSidekickModel: () => Promise.resolve(""),
		});

		await showFusionMenu(ctx);
		expect(store.get("fusion.enabled")).toBe(true);
		expect(store.get("fusion.mode")).toBe("escalate");
		expect(ensureCalls).toBe(1);
		expect(statuses.join(" ")).toContain("Fusion enabled");
	});
});
