import { describe, expect, test } from "bun:test";
import { resolveTtsBackend } from "@oh-my-pi/pi-coding-agent/tools/tts";

describe("resolveTtsBackend", () => {
	test("honors an explicit deepinfra preference regardless of codec or xAI credentials", () => {
		expect(resolveTtsBackend({ preference: "deepinfra", wantsMp3: true, hasXaiCreds: true })).toBe("deepinfra");
		expect(resolveTtsBackend({ preference: "deepinfra", wantsMp3: false, hasXaiCreds: false })).toBe("deepinfra");
	});

	test("auto still routes .mp3 to xAI when credentials exist (deepinfra does not perturb auto)", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
	});

	test("auto still prefers local otherwise", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: false, hasXaiCreds: true })).toBe("local");
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: false })).toBe("local");
	});
});
