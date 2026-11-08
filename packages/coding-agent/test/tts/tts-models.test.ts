import { describe, expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	TTS_LOCAL_VOICE_VALUES,
	getTtsLocalModelSpec,
	resolveTtsSpeakerId,
	resolveTtsVoice,
} from "../../src/tts/models";

describe("Kokoro Chinese local TTS", () => {
	test("registers the sherpa model and its Chinese voices", () => {
		const spec = getTtsLocalModelSpec("kokoro-zh");
		expect(spec?.engine).toBe("sherpa");
		expect(spec?.voices.map(voice => voice.id)).toContain("zf_001");
		expect(resolveTtsVoice("kokoro-zh", "af_heart")).toBe("zf_001");
		expect(resolveTtsVoice("kokoro", "zf_001")).toBe("af_heart");
		expect(resolveTtsSpeakerId("kokoro-zh", "zf_001")).toBe(3);
		expect(resolveTtsSpeakerId("kokoro-zh", "zm_010")).toBe(59);
		expect(TTS_LOCAL_VOICE_VALUES).toContain("zf_002");
		expect(TTS_LOCAL_VOICE_VALUES).toContain("zm_015");
	});

	test("publishes the model in the bundled catalog under the tts role", () => {
		expect(getBundledModel("local", "kokoro-zh")?.kind).toBe("tts");
	});
});
