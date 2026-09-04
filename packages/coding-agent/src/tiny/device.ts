import type { DeviceType } from "@huggingface/transformers";
import { $env } from "@oh-my-pi/pi-utils";

/** ONNX Runtime execution provider accepted by transformers.js pipelines. */
export type TinyOnnxDevice = DeviceType;
/** `PI_TINY_DEVICE` value selecting the mlx-lm Python backend (Apple silicon). */
export const MLX_DEVICE = "mlx";
export type TinyModelDevice = TinyOnnxDevice | typeof MLX_DEVICE;

export interface TinyModelDevicePreference {
	device: TinyModelDevice;
	raw: string | undefined;
}

const CPU_DEVICE: TinyOnnxDevice = "cpu";
const CPU_ONLY_ORDER: readonly TinyOnnxDevice[] = [CPU_DEVICE];
const DARWIN_WEBGPU_UNSAFE_ORDER: readonly TinyOnnxDevice[] = [CPU_DEVICE];

const DEVICE_VALUES: Record<TinyModelDevice, true> = {
	auto: true,
	gpu: true,
	cpu: true,
	wasm: true,
	webgpu: true,
	cuda: true,
	dml: true,
	coreml: true,
	webnn: true,
	"webnn-npu": true,
	"webnn-gpu": true,
	"webnn-cpu": true,
	[MLX_DEVICE]: true,
};

function usesDarwinWorkerWebGpu(device: TinyModelDevice): boolean {
	return process.platform === "darwin" && (device === "gpu" || device === "webgpu" || device === "auto");
}

/** Whether the mlx-lm backend can run here: MLX ships Metal wheels for Apple silicon only. */
export function tinyMlxSupported(platform = process.platform, arch = process.arch): boolean {
	return platform === "darwin" && arch === "arm64";
}

export function normalizeTinyModelDevice(value: string | undefined): TinyModelDevice | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "metal") return MLX_DEVICE;
	if (raw in DEVICE_VALUES) return raw as TinyModelDevice;
	throw new Error(
		`Unsupported PI_TINY_DEVICE=${JSON.stringify(value)}. Use cpu, gpu, mlx, metal, webgpu, auto, cuda, dml, coreml, wasm, webnn, webnn-gpu, webnn-cpu, or webnn-npu.`,
	);
}

export function resolveTinyModelDevicePreference(
	value: string | undefined = $env.PI_TINY_DEVICE,
): TinyModelDevicePreference {
	return {
		device: normalizeTinyModelDevice(value) ?? CPU_DEVICE,
		raw: value,
	};
}

/**
 * ONNX execution providers to try, in order, for the requested device. `mlx`
 * is not an ONNX provider: workers that only speak ONNX (STT/TTS, or the tiny
 * worker after an MLX bootstrap failure) run CPU-only for it.
 */
export function tinyModelDeviceLoadOrder(preference: TinyModelDevicePreference): readonly TinyOnnxDevice[] {
	if (preference.device === CPU_DEVICE || preference.device === MLX_DEVICE) return CPU_ONLY_ORDER;
	if (usesDarwinWorkerWebGpu(preference.device)) return DARWIN_WEBGPU_UNSAFE_ORDER;
	return [preference.device, CPU_DEVICE];
}

/** Sentinel `providers.tinyModelDevice` value meaning "use the built-in CPU default". */
export const TINY_MODEL_DEVICE_DEFAULT = "default";

/** Accepted values for the `providers.tinyModelDevice` setting (validation + UI). */
export const TINY_MODEL_DEVICE_SETTING_VALUES = [
	TINY_MODEL_DEVICE_DEFAULT,
	"gpu",
	"cpu",
	MLX_DEVICE,
	"metal",
	"webgpu",
	"cuda",
	"dml",
	"coreml",
	"auto",
	"wasm",
	"webnn",
	"webnn-gpu",
	"webnn-cpu",
	"webnn-npu",
] as const;

/** Submenu metadata for the `providers.tinyModelDevice` setting. */
export const TINY_MODEL_DEVICE_SETTING_OPTIONS = [
	{ value: "default", label: "Default", description: "CPU-only inference" },
	{ value: "gpu", label: "GPU", description: "Accelerated provider (WebGPU/Metal, CUDA, or DirectML)" },
	{ value: "cpu", label: "CPU", description: "CPU-only inference" },
	{ value: MLX_DEVICE, label: "MLX", description: "Apple silicon GPU via mlx-lm (Python subprocess; macOS arm64)" },
	{ value: "metal", label: "Metal", description: "Alias for MLX" },
	{ value: "webgpu", label: "WebGPU", description: "WebGPU/Metal backend" },
	{ value: "cuda", label: "CUDA", description: "NVIDIA CUDA (Linux x64)" },
	{ value: "dml", label: "DirectML", description: "DirectML backend (Windows)" },
	{ value: "coreml", label: "CoreML", description: "Apple CoreML (opt-in; can fail to load)" },
	{ value: "auto", label: "Auto", description: "Let ONNX Runtime choose a provider" },
	{ value: "wasm", label: "WASM", description: "WebAssembly backend" },
	{ value: "webnn", label: "WebNN", description: "WebNN backend" },
	{ value: "webnn-gpu", label: "WebNN GPU", description: "WebNN GPU device" },
	{ value: "webnn-cpu", label: "WebNN CPU", description: "WebNN CPU device" },
	{ value: "webnn-npu", label: "WebNN NPU", description: "WebNN NPU device" },
] as const satisfies ReadonlyArray<{
	value: (typeof TINY_MODEL_DEVICE_SETTING_VALUES)[number];
	label: string;
	description: string;
}>;

/**
 * Map a `providers.tinyModelDevice` setting value onto a `PI_TINY_DEVICE` env
 * value for the worker. Returns `undefined` for the default sentinel so the
 * worker keeps its built-in CPU default; the worker still validates the
 * forwarded value via {@link normalizeTinyModelDevice}.
 */
export function tinyModelDeviceSettingToEnv(value: string | undefined): string | undefined {
	if (!value || value === TINY_MODEL_DEVICE_DEFAULT) return undefined;
	return value;
}
