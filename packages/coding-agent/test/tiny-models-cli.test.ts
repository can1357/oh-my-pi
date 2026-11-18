import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { resolveModels, runTinyModelsCommand } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { tinyModelBackendRefusal, tinyModelSupportsBackend } from "@oh-my-pi/pi-coding-agent/tiny/backend-policy";
import { TINY_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { mlxLaunch, tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tiny-models download model resolution", () => {
	it("excludes ONNX-blocked models from `all` so the bulk prefetch stays green", () => {
		const unsupported = TINY_LOCAL_MODELS.filter(spec => !tinyModelSupportsBackend(spec.key, "onnx")).map(
			spec => spec.key,
		);
		// Guard: keep this regression meaningful — at least one registry entry must be load-blocked.
		expect(unsupported.length).toBeGreaterThan(0);

		const all = resolveModels("all", false);
		for (const key of unsupported) expect(all).not.toContain(key);

		const usable = TINY_LOCAL_MODELS.filter(spec => tinyModelSupportsBackend(spec.key, "onnx")).map(spec => spec.key);
		for (const key of usable) expect(all).toContain(key);
	});

	it("keeps every loadable model in `all` when the MLX backend is active", () => {
		const mlxBlocked = TINY_LOCAL_MODELS.filter(spec => !tinyModelSupportsBackend(spec.key, "mlx")).map(
			spec => spec.key,
		);
		const onnxBlocked = TINY_LOCAL_MODELS.filter(spec => !tinyModelSupportsBackend(spec.key, "onnx")).map(
			spec => spec.key,
		);
		// Guard: keep this regression meaningful — the registry must exercise both directions.
		expect(mlxBlocked.length).toBeGreaterThan(0);
		expect(onnxBlocked.length).toBeGreaterThan(0);

		const all = resolveModels("all", true);
		// MLX-blocked models still run on ONNX CPU, so they are prefetched.
		for (const key of mlxBlocked) expect(all).toContain(key);
		// ONNX-blocked models are the ones MLX exists for.
		for (const key of onnxBlocked) expect(all).toContain(key);
		// Only a model no backend can load is skipped.
		for (const key of [...mlxBlocked, ...onnxBlocked]) {
			if (!(mlxBlocked.includes(key) && onnxBlocked.includes(key))) continue;
			expect(all).not.toContain(key);
		}
	});

	it("still resolves an explicitly requested unsupported model (only `all` is filtered)", () => {
		const blocked = TINY_LOCAL_MODELS.find(spec => !tinyModelSupportsBackend(spec.key, "onnx"));
		expect(blocked).toBeDefined();
		if (!blocked) return;
		expect(resolveModels(blocked.key, false)).toEqual([blocked.key]);
	});

	it("includes worker error details in JSON failures", async () => {
		const output: string[] = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(tinyTitleClient, "downloadModel").mockResolvedValue({
			ok: false,
			error: "Error: runtime install failed\n    at worker",
		});

		await expect(
			runTinyModelsCommand({ action: "download", model: "lfm2.5-350m", flags: { json: true } }),
		).rejects.toThrow("One or more tiny title models failed to download");

		expect(JSON.parse(output.join(""))).toEqual({
			results: [{ model: "lfm2.5-350m", ok: false, error: "Error: runtime install failed\n    at worker" }],
		});
	});

	it("includes worker error details in text failures", async () => {
		const output: string[] = [];
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(tinyTitleClient, "downloadModel").mockResolvedValue({
			ok: false,
			error: "Error: runtime install failed\n    at worker",
		});

		try {
			await expect(runTinyModelsCommand({ action: "download", model: "lfm2.5-350m", flags: {} })).rejects.toThrow(
				"One or more tiny title models failed to download",
			);
		} finally {
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}

		expect(output.join("")).toContain("Failed to download LFM2.5 350M: runtime install failed.");
	});

	it("prints actionable CUDA provider diagnostics from worker errors", async () => {
		const output: string[] = [];
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const diagnostic = [
			"Error: Failed to load ONNX Runtime CUDA execution provider",
			"ONNX Runtime CUDA diagnostics:",
			"  PI_TINY_DEVICE=cuda requested CUDAExecutionProvider",
			"  side runtime: /home/user/.omp/cache/tiny-title-runtime/transformers-test/node_modules",
			"  cause: libcudnn.so.9: cannot open shared object file",
		].join("\n");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(tinyTitleClient, "downloadModel").mockResolvedValue({
			ok: false,
			error: diagnostic,
		});

		try {
			await expect(runTinyModelsCommand({ action: "download", model: "lfm2.5-350m", flags: {} })).rejects.toThrow(
				"One or more tiny title models failed to download",
			);
		} finally {
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}

		const text = output.join("");
		expect(text).toContain("Failed to download LFM2.5 350M:");
		expect(text).toContain("PI_TINY_DEVICE=cuda");
		expect(text).toContain("libcudnn.so.9");
		expect(text).toContain("tiny-title-runtime");
	});
});

describe("mlx backend model gate", () => {
	it("refuses a model the pinned mlx-lm cannot load", () => {
		expect(() => mlxLaunch("lfm3-1.7b", () => {})).toThrow(/unavailable on MLX/);
	});

	it("builds a launch for a model mlx-lm can load", () => {
		expect(mlxLaunch("lfm2-1.2b", () => {}).backend).toBe("mlx");
	});
});

describe("tiny backend policy", () => {
	it("pins the reviewed refusals for the restricted models", () => {
		// qwen3-1.7b: ONNX cannot run its RotaryEmbedding cache updates, MLX can.
		expect(tinyModelBackendRefusal("qwen3-1.7b", "onnx")).toMatch(/RotaryEmbedding/);
		expect(tinyModelBackendRefusal("qwen3-1.7b", "mlx")).toBeUndefined();
		// lfm3-1.7b: the pinned mlx-lm has no lfm3 architecture, ONNX runs it.
		expect(tinyModelBackendRefusal("lfm3-1.7b", "mlx")).toMatch(/lfm3/);
		expect(tinyModelBackendRefusal("lfm3-1.7b", "onnx")).toBeUndefined();
		// An unrestricted model is loadable by both backends.
		expect(tinyModelBackendRefusal("lfm2-1.2b", "onnx")).toBeUndefined();
		expect(tinyModelBackendRefusal("lfm2-1.2b", "mlx")).toBeUndefined();
	});
});
