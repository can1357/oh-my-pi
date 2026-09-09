import { describe, expect, it } from "bun:test";
import {
	normalizeTinyModelDtype,
	resolveTinyModelDtypeOverride,
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
	tinyModelDtypeSettingToEnv,
} from "@oh-my-pi/pi-coding-agent/tiny/dtype";

describe("tiny model dtype selection", () => {
	it("returns undefined when unset so callers keep the per-model spec dtype", () => {
		expect(resolveTinyModelDtypeOverride(undefined)).toBeUndefined();
		expect(resolveTinyModelDtypeOverride("")).toBeUndefined();
		expect(resolveTinyModelDtypeOverride("   ")).toBeUndefined();
	});

	it("canonicalizes a valid precision regardless of case/whitespace", () => {
		expect(resolveTinyModelDtypeOverride("  FP16 ")).toBe("fp16");
		expect(resolveTinyModelDtypeOverride("q4f16")).toBe("q4f16");
		expect(normalizeTinyModelDtype("Q8")).toBe("q8");
	});

	it("rejects an unsupported precision", () => {
		expect(() => resolveTinyModelDtypeOverride("int4")).toThrow("Unsupported PI_TINY_DTYPE");
	});
});

describe("tiny model dtype setting → PI_TINY_DTYPE mapping", () => {
	it("returns undefined for the default sentinel so the worker keeps each model's spec dtype", () => {
		expect(tinyModelDtypeSettingToEnv(TINY_MODEL_DTYPE_DEFAULT)).toBeUndefined();
		expect(tinyModelDtypeSettingToEnv(undefined)).toBeUndefined();
		expect(tinyModelDtypeSettingToEnv("")).toBeUndefined();
	});

	it("forwards a concrete precision verbatim for the worker to validate", () => {
		expect(tinyModelDtypeSettingToEnv("fp16")).toBe("fp16");
		expect(tinyModelDtypeSettingToEnv("q8")).toBe("q8");
	});

	it("keeps every non-default setting value resolvable by the worker", () => {
		for (const value of TINY_MODEL_DTYPE_SETTING_VALUES) {
			if (value === TINY_MODEL_DTYPE_DEFAULT) continue;
			expect(normalizeTinyModelDtype(tinyModelDtypeSettingToEnv(value))).toBe(value);
		}
	});

	it("keeps submenu options aligned with the accepted values", () => {
		expect(TINY_MODEL_DTYPE_SETTING_OPTIONS.map(option => option.value)).toEqual([
			...TINY_MODEL_DTYPE_SETTING_VALUES,
		]);
	});
});
