import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { WatchdogConfigDoc } from "../../src/advisor/config";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { Settings } from "../../src/config/settings";
import { type AdvisorConfigDeps, AdvisorConfigOverlayComponent } from "../../src/modes/components/advisor-config";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";

interface OverlayHarness {
	overlay: AdvisorConfigOverlayComponent;
	saved: WatchdogConfigDoc[];
	notifications: string[];
}

function createOverlay(doc: WatchdogConfigDoc): OverlayHarness {
	// These fields are not used on the list/detail screens exercised here.
	const deps: AdvisorConfigDeps = {
		modelRegistry: {} as ModelRegistry,
		settings: {} as Settings,
		scopedModels: [],
		availableToolNames: ["read", "grep", "glob"],
	};
	const tui = { terminal: { rows: 40, columns: 140 } } as TUI;
	const saved: WatchdogConfigDoc[] = [];
	const notifications: string[] = [];
	const overlay = new AdvisorConfigOverlayComponent(tui, deps, "project", structuredClone(doc), {
		loadDoc: async () => structuredClone(doc),
		save: async (_scope, next) => {
			saved.push(structuredClone(next));
		},
		close: () => {},
		requestRender: () => {},
		notify: message => notifications.push(message),
	});
	return { overlay, saved, notifications };
}

async function saveFromList(harness: OverlayHarness, expectedCount: number): Promise<void> {
	// One advisor, then Add, Shared instructions, Scope, Save & apply.
	for (let i = 0; i < 4; i++) harness.overlay.handleInput("\x1b[B");
	harness.overlay.handleInput("\r");
	await vi.waitFor(() => expect(harness.saved).toHaveLength(expectedCount));
	expect(harness.notifications).toEqual([]);
}

describe("advisor config subagent control", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected built-in dark theme to exist");
		setThemeInstance(theme);
	});

	it.each([true, false])("does not discard a default advisor with subagents=%s when saved", async subagents => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "default", subagents }] };
		const harness = createOverlay(doc);
		expect(harness.overlay.render(140).join("\n")).toContain("Subagents:");
		await saveFromList(harness, 1);
		expect(harness.saved[0]).toEqual(doc);
	});

	it("cycles inherit, on, off, inherit and preserves note budgets", async () => {
		const harness = createOverlay({
			maxNotesPerUpdate: 3,
			advisors: [{ name: "reviewer", maxNotesPerUpdate: 2 }],
		});
		expect(harness.overlay.render(140).join("\n")).toContain("inherit (per-agent)");
		const values = [true, false, undefined];
		for (const [index, value] of values.entries()) {
			harness.overlay.handleInput("\r");
			// Name, Enabled, Subagents.
			harness.overlay.handleInput("\x1b[B");
			harness.overlay.handleInput("\x1b[B");
			harness.overlay.handleInput("\r");
			harness.overlay.handleInput("\x1b");
			await saveFromList(harness, index + 1);
			expect(harness.saved[index].advisors[0].subagents).toBe(value);
			expect(harness.saved[index].advisors[0].maxNotesPerUpdate).toBe(2);
			expect(harness.saved[index].maxNotesPerUpdate).toBe(3);
		}
	});

	it("continues to remove only the synthetic roster while retaining shared settings", async () => {
		const harness = createOverlay({
			instructions: "Shared guidance",
			maxNotesPerUpdate: 3,
			advisors: [{ name: "default" }],
		});
		await saveFromList(harness, 1);
		expect(harness.saved[0]).toEqual({ instructions: "Shared guidance", maxNotesPerUpdate: 3, advisors: [] });
	});
});
