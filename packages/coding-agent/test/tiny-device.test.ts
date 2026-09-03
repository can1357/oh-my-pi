import { describe, expect, it } from "bun:test";
import {
	normalizeTinyModelDevice,
	resolveTinyModelDevicePreference,
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
	type TinyOnnxDevice,
	tinyMlxSupported,
	tinyModelDeviceLoadOrder,
	tinyModelDeviceSettingToEnv,
} from "@oh-my-pi/pi-coding-agent/tiny/device";

describe("tiny model device selection", () => {
	it("defaults to CPU-only inference on every platform", () => {
		const preference = resolveTinyModelDevicePreference(undefined);

		expect(preference.device).toBe("cpu");
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(["cpu"]);
	});

	it("routes mlx and its metal alias to the MLX backend while ONNX workers stay CPU-only", () => {
		expect(normalizeTinyModelDevice("metal")).toBe("mlx");
		expect(normalizeTinyModelDevice("MLX")).toBe("mlx");
		// STT/TTS only speak ONNX: `mlx` must never reach transformers.js as a device.
		expect(tinyModelDeviceLoadOrder(resolveTinyModelDevicePreference("mlx"))).toEqual(["cpu"]);
		expect(tinyModelDeviceLoadOrder(resolveTinyModelDevicePreference("metal"))).toEqual(["cpu"]);
	});

	it("keeps webgpu off the macOS worker but usable elsewhere", () => {
		const expectedOrder: readonly TinyOnnxDevice[] = process.platform === "darwin" ? ["cpu"] : ["webgpu", "cpu"];
		expect(tinyModelDeviceLoadOrder(resolveTinyModelDevicePreference("webgpu"))).toEqual(expectedOrder);
	});

	it("only offers MLX on Apple silicon", () => {
		expect(tinyMlxSupported("darwin", "arm64")).toBe(true);
		expect(tinyMlxSupported("darwin", "x64")).toBe(false);
		expect(tinyMlxSupported("linux", "arm64")).toBe(false);
	});

	it("keeps explicit CPU runs CPU-only", () => {
		const preference = resolveTinyModelDevicePreference(" cpu ");

		expect(preference.device).toBe("cpu");
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(["cpu"]);
	});

	it("rejects unknown ONNX execution providers", () => {
		expect(() => resolveTinyModelDevicePreference("neural-magic")).toThrow("Unsupported PI_TINY_DEVICE");
	});
});

describe("tiny model device setting → PI_TINY_DEVICE mapping", () => {
	it("returns undefined for the default sentinel so the worker keeps its CPU default", () => {
		expect(tinyModelDeviceSettingToEnv(TINY_MODEL_DEVICE_DEFAULT)).toBeUndefined();
		expect(tinyModelDeviceSettingToEnv(undefined)).toBeUndefined();
		expect(tinyModelDeviceSettingToEnv("")).toBeUndefined();
	});

	it("forwards a concrete device value verbatim for the worker to validate", () => {
		expect(tinyModelDeviceSettingToEnv("metal")).toBe("metal");
		expect(tinyModelDeviceSettingToEnv("cuda")).toBe("cuda");
	});

	it("keeps submenu options aligned with the accepted values", () => {
		expect(TINY_MODEL_DEVICE_SETTING_OPTIONS.map(option => option.value)).toEqual([
			...TINY_MODEL_DEVICE_SETTING_VALUES,
		]);
	});
});
