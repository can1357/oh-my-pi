import { afterEach, expect, it, spyOn, vi } from "bun:test";
import * as agentsHubDepsModule from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { ModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/model-browser";
import type { AgentsHubDeps, PropertyKind } from "../../../src/ui/overlays/pickers/agents-hub";
import { attachTerminal, createInteractiveModeContext } from "../../helpers/interactive-mode-context";

afterEach(() => {
	vi.restoreAllMocks();
});

function hubDeps(saved: [PropertyKind, string, string | undefined][]): AgentsHubDeps {
	return {
		browserSource: {
			revision: 0,
			modelProviderOrder: [],
			knownRoleIds: [],
			mruOrder: [],
			modelPerf: new Map(),
			getModelRole: () => undefined,
		} as unknown as ModelBrowserSource,
		loadAgents: async () => [
			{ name: "planner", description: "Plans", systemPrompt: "", source: "user", disabled: false, model: ["@plan"] },
		],
		getAvailableModels: () => [],
		effectiveModelPatterns: agent => agent.model ?? [],
		resolvePatterns: () => undefined,
		effectivePrewalkPattern: () => undefined,
		effectiveAdvisorPattern: () => undefined,
		setAgentDisabled: () => {},
		setAgentOverride: (property, name, value) => saved.push([property, name, value]),
		generateAgent: async () => "",
		saveAgent: async () => "",
	};
}

// Regression for #20552: opening the model pattern input swaps the hub's root
// from a picker to a card, which left keyboard focus on the detached picker —
// typed keys, Enter and Esc all went nowhere.
it("keeps typing into the /agents model pattern input after the hub rebuilds its root", async () => {
	const saved: [PropertyKind, string, string | undefined][] = [];
	spyOn(agentsHubDepsModule, "createAgentsHubDeps").mockReturnValue(hubDeps(saved));
	const ctx = createInteractiveModeContext();
	const term = attachTerminal(ctx, { columns: 120, rows: 30 });
	await new SelectorController(ctx).showAgentsDashboard();

	term.press("enter"); // planner's strip, on its model chip
	term.press("enter"); // model strip: pick model…, pattern…
	term.press("right");
	term.press("enter"); // pattern input
	term.type("@smol");
	expect(term.fullscreen()?.join("\n")).toContain("planner model pattern: > @smol");

	term.press("enter");
	expect(saved).toEqual([["model", "planner", "@smol"]]);
	term.press("escape");
	expect(ctx.shell.overlays.open()).toBe(false);
	term.dispose();
});
