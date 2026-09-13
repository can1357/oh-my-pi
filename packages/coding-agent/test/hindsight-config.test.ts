import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

function load(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
	return loadHindsightConfig(Settings.isolated(overrides as never), env);
}

describe("loadHindsightConfig retainStrategy", () => {
	it("treats empty and whitespace retainStrategy as unset", () => {
		expect(load({ "hindsight.retainStrategy": "" }).retainStrategy).toBeNull();
		expect(load({ "hindsight.retainStrategy": "   " }).retainStrategy).toBeNull();
		expect(load({}, { HINDSIGHT_RETAIN_STRATEGY: "  " }).retainStrategy).toBeNull();
	});

	it("prefers HINDSIGHT_RETAIN_STRATEGY over settings", () => {
		expect(
			load({ "hindsight.retainStrategy": "coding" }, { HINDSIGHT_RETAIN_STRATEGY: "personal_chat" }).retainStrategy,
		).toBe("personal_chat");
	});
});
