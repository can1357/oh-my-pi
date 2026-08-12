import { describe, expect, it } from "bun:test";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../../src/lib/elevenlabs-http";
import { resolveLiveTtsVoice, resolveTtsBackend } from "../../src/tts/backend";

describe("resolveTtsBackend", () => {
	it("honors an explicit local preference verbatim", () => {
		expect(resolveTtsBackend({ preference: "local", wantsMp3: true, hasXaiCreds: true })).toBe("local");
	});

	it("honors an explicit xai preference verbatim", () => {
		expect(resolveTtsBackend({ preference: "xai", wantsMp3: false, hasXaiCreds: false })).toBe("xai");
	});

	it("honors an explicit elevenlabs preference verbatim, even without credentials known to the caller", () => {
		expect(resolveTtsBackend({ preference: "elevenlabs", wantsMp3: false, hasXaiCreds: false })).toBe("elevenlabs");
	});

	it("auto never selects elevenlabs — it must be selected explicitly", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: true })).not.toBe("elevenlabs");
	});

	it("auto falls back to xai for mp3 when xai credentials exist", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
	});

	it("auto falls back to local when no cloud credentials exist", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: false })).toBe("local");
	});

	it("auto prefers local over xai when mp3 was not requested", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: false, hasXaiCreds: true })).toBe("local");
	});
});

describe("resolveLiveTtsVoice", () => {
	it("uses the dedicated ElevenLabs voice instead of a Kokoro voice", () => {
		expect(
			resolveLiveTtsVoice("elevenlabs", {
				localVoice: "af_heart",
				elevenLabsVoiceId: "custom-elevenlabs-voice",
			}),
		).toBe("custom-elevenlabs-voice");
	});

	it("falls back to the valid ElevenLabs default independently of the local voice", () => {
		expect(resolveLiveTtsVoice("elevenlabs", { localVoice: "af_heart" })).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
	});

	it("keeps the configured Kokoro voice for local playback", () => {
		expect(resolveLiveTtsVoice("local", { localVoice: "bf_emma" })).toBe("bf_emma");
	});
});
