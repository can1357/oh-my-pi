import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

function load(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
	return loadHindsightConfig(Settings.isolated(overrides as never), env);
}

describe("loadHindsightConfig retainUpdateMode", () => {
	it("prefers HINDSIGHT_RETAIN_UPDATE_MODE over settings", () => {
		expect(
			load({ "hindsight.retainUpdateMode": "replace" }, { HINDSIGHT_RETAIN_UPDATE_MODE: "append" }).retainUpdateMode,
		).toBe("append");
	});

	it("falls back to replace when retainUpdateMode is invalid", () => {
		expect(load({ "hindsight.retainUpdateMode": "upsert" }).retainUpdateMode).toBe("replace");
	});
});
