import type { DataType } from "@huggingface/transformers";
import { $env } from "@oh-my-pi/pi-utils";

/** ONNX quantization / precision for local tiny models (transformers.js `dtype`). */
export type TinyModelDtype = DataType;

const DTYPE_VALUES: Record<TinyModelDtype, true> = {
	auto: true,
	fp32: true,
	fp16: true,
	q8: true,
	int8: true,
	uint8: true,
	q4: true,
	bnb4: true,
	q4f16: true,
	q2: true,
	q2f16: true,
	q1: true,
	q1f16: true,
};

/**
 * Validate and canonicalize a `PI_TINY_DTYPE` value. Returns `undefined` when
 * unset/blank so callers fall back to the per-model spec dtype, and throws on an
 * unrecognized value so a misconfiguration fails loudly instead of silently
 * loading a different precision than requested.
 */
export function normalizeTinyModelDtype(value: string | undefined): TinyModelDtype | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw in DTYPE_VALUES) return raw as TinyModelDtype;
	throw new Error(
		`Unsupported PI_TINY_DTYPE=${JSON.stringify(value)}. Use auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16, q2, q2f16, q1, or q1f16.`,
	);
}

/**
 * Resolve the `PI_TINY_DTYPE` override. `undefined` means "use the per-model spec
 * dtype" (currently `q4` for every shipped model); a concrete value overrides the
 * precision for whichever local tiny model loads.
 */
export function resolveTinyModelDtypeOverride(
	value: string | undefined = $env.PI_TINY_DTYPE,
): TinyModelDtype | undefined {
	return normalizeTinyModelDtype(value);
}

/** Sentinel `providers.tinyModelDtype` value meaning "use each model's shipped dtype". */
export const TINY_MODEL_DTYPE_DEFAULT = "default";

/** Accepted values for the `providers.tinyModelDtype` setting (validation + UI). */
export const TINY_MODEL_DTYPE_SETTING_VALUES = [
	TINY_MODEL_DTYPE_DEFAULT,
	"q4",
	"q4f16",
	"q8",
	"fp16",
	"fp32",
	"int8",
	"uint8",
	"bnb4",
	"q2",
	"q2f16",
	"q1",
	"q1f16",
	"auto",
] as const;

/** Submenu metadata for the `providers.tinyModelDtype` setting. */
export const TINY_MODEL_DTYPE_SETTING_OPTIONS = [
	{ value: "default", label: "Default", description: "Each model's shipped dtype (currently q4)" },
	{ value: "q4", label: "q4", description: "4-bit weights; smallest and fastest" },
	{ value: "q4f16", label: "q4f16", description: "4-bit weights with fp16 activations" },
	{ value: "q8", label: "q8", description: "8-bit quantization" },
	{ value: "fp16", label: "fp16", description: "16-bit float; higher fidelity, larger" },
	{ value: "fp32", label: "fp32", description: "Full precision; largest and slowest" },
	{ value: "int8", label: "int8", description: "Signed 8-bit integer" },
	{ value: "uint8", label: "uint8", description: "Unsigned 8-bit integer" },
	{ value: "bnb4", label: "bnb4", description: "bitsandbytes 4-bit" },
	{ value: "q2", label: "q2", description: "2-bit weights" },
	{ value: "q2f16", label: "q2f16", description: "2-bit weights with fp16 activations" },
	{ value: "q1", label: "q1", description: "1-bit weights" },
	{ value: "q1f16", label: "q1f16", description: "1-bit weights with fp16 activations" },
	{ value: "auto", label: "Auto", description: "Let transformers.js choose per device" },
] as const satisfies ReadonlyArray<{
	value: (typeof TINY_MODEL_DTYPE_SETTING_VALUES)[number];
	label: string;
	description: string;
}>;

/**
 * Map a `providers.tinyModelDtype` setting value onto a `PI_TINY_DTYPE` env value
 * for the worker. Returns `undefined` for the default sentinel so the worker keeps
 * each model's shipped dtype; the worker still validates the forwarded value via
 * {@link normalizeTinyModelDtype}.
 */
export function tinyModelDtypeSettingToEnv(value: string | undefined): string | undefined {
	if (!value || value === TINY_MODEL_DTYPE_DEFAULT) return undefined;
	return value;
}
