import { describe, expect, test } from "bun:test";
import { defaultLiveModelFor } from "@oh-my-pi/pi-catalog/compat/providers";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgLiveGoogleModel, resolveLiveModel } from "@oh-my-pi/pi-coding-agent/live/settings";
import { LIVE_MODEL } from "@oh-my-pi/pi-coding-agent/live/protocol";

describe("Gemini Live settings", () => {
	test("resolves empty and whitespace overrides through the catalog accessor", () => {
		const catalogDefault = defaultLiveModelFor("google");
		if (catalogDefault === undefined) throw new Error("Missing Google catalog Live model");

		const settings = Settings.isolated({ "live.provider": "google" });
		expect(resolveLiveModel(settings)).toBe(catalogDefault);

		cfgLiveGoogleModel.set(settings, "  \t  ");
		expect(resolveLiveModel(settings)).toBe(catalogDefault);
	});

	test("trims an explicit override before selecting the Live model", () => {
		const settings = Settings.isolated({ "live.provider": "google" });
		cfgLiveGoogleModel.set(settings, "  user-selected-live-model  ");

		expect(resolveLiveModel(settings)).toBe("user-selected-live-model");
	});

	test("a Google model override cannot change a Codex Live session's model", () => {
		const settings = Settings.isolated({ "live.provider": "openai-codex" });
		cfgLiveGoogleModel.set(settings, "google-only-live-model");

		expect(resolveLiveModel(settings)).toBe(LIVE_MODEL);
	});
});
