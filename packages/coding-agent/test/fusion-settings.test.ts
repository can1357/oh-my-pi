import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings-schema";

describe("fusion settings schema", () => {
	it("defaults fusion off, with a pi/smol sidekick and escalate mode", () => {
		expect(SETTINGS_SCHEMA["fusion.enabled"].default).toBe(false);
		expect(SETTINGS_SCHEMA["fusion.sidekickModel"].default).toBe("pi/smol");
		expect(SETTINGS_SCHEMA["fusion.mode"].default).toBe("escalate");
		// Phase 3 main-model downgrade is opt-in: empty selector disables it.
		expect(SETTINGS_SCHEMA["fusion.compactModel"].default).toBe("");
		expect(SETTINGS_SCHEMA["fusion.sidekickRequestBudget"].default).toBe(40);
		expect(SETTINGS_SCHEMA["fusion.showSavings"].default).toBe(true);
		// Dynamic routing and the tier pool are opt-in.
		expect(SETTINGS_SCHEMA["fusion.dynamicRouting"].default).toBe(false);
		expect(SETTINGS_SCHEMA["fusion.modelPool"].default).toEqual([]);
		// Decoupled sidekick tier routing and failure-streak escalation are opt-in.
		expect(SETTINGS_SCHEMA["fusion.sidekickStrongModel"].default).toBe("");
		expect(SETTINGS_SCHEMA["fusion.escalateFailureStreak"].default).toBe(3);
	});

	it("exposes off/delegate/escalate modes", () => {
		expect(SETTINGS_SCHEMA["fusion.mode"].values).toEqual(["off", "delegate", "escalate"]);
	});

	it("gates the fusion sub-settings on fusionEnabled", () => {
		for (const key of [
			"fusion.mode",
			"fusion.sidekickModel",
			"fusion.compactModel",
			"fusion.sidekickRequestBudget",
			"fusion.showSavings",
			"fusion.dynamicRouting",
			"fusion.sidekickStrongModel",
			"fusion.escalateFailureStreak",
		] as const) {
			expect(SETTINGS_SCHEMA[key].ui?.condition).toBe("fusionEnabled");
		}
	});
});
