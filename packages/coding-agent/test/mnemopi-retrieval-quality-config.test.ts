import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";

function retrievalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, "/tmp/mnemopi-retrieval-quality-test") as unknown as Record<string, unknown>;
}

describe("Mnemopi retrieval-quality config", () => {
	it("exposes none/log/bm25 length-normalization modes with the Phase-1 control as the initial default", () => {
		expect(retrievalConfig().recallLengthNormalization).toBe("none");
		expect(retrievalConfig({ "mnemopi.recallLengthNormalization": "log" }).recallLengthNormalization).toBe("log");
		expect(retrievalConfig({ "mnemopi.recallLengthNormalization": "bm25" }).recallLengthNormalization).toBe("bm25");
	});

	it("defaults retention chunks to the empirically selected 6000-character cap", () => {
		expect(retrievalConfig().retentionChunkMaxChars).toBe(6000);
		expect(retrievalConfig({ "mnemopi.retentionChunkMaxChars": 6000 }).retentionChunkMaxChars).toBe(6000);
		expect(retrievalConfig({ "mnemopi.retentionChunkMaxChars": -10 }).retentionChunkMaxChars).toBe(0);
	});

	it("keeps the calibrated score floor disabled until holdout approval", () => {
		expect(retrievalConfig().recallScoreFloor).toBe(0);
		expect(retrievalConfig({ "mnemopi.recallScoreFloor": 0.0125 }).recallScoreFloor).toBe(0.0125);
		expect(retrievalConfig({ "mnemopi.recallScoreFloor": -1 }).recallScoreFloor).toBe(0);
	});
});
