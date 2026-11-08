import { describe, expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getSttModelSpec } from "../src/stt/models";

describe("X-ASR streaming dictation tier", () => {
	test("registers the 960 ms online model with terminal padding", () => {
		const spec = getSttModelSpec("x-asr-960ms-zh-en");
		if (spec?.engine !== "sherpa") throw new Error("x-asr must be a sherpa model");
		expect(spec.mode).toBe("online");
		expect("tailPaddingSeconds" in spec ? spec.tailPaddingSeconds : undefined).toBe(1.5);
		expect(spec.files).toEqual({
			encoder: "encoder.int8.onnx",
			decoder: "decoder.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		});
	});

	test("publishes the model in the bundled catalog under the stt role", () => {
		expect(getBundledModel("local", "x-asr-960ms-zh-en")?.kind).toBe("stt");
	});
});
