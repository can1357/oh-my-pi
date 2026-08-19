import { describe, expect, test, vi } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import {
	buildColabCommand,
	type ColabModelLaunchResult,
	getColabAcceleratorProfile,
	type HuggingFaceTreeEntry,
	handleColabModelSlashCommand,
	parseColabModelCommandArgs,
	parseHuggingFaceModelReference,
	selectAutomaticColabAccelerators,
	selectGgufArtifact,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/colab-model";
import type { SlashCommandRuntime } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/types";

const QWEN_FILES: HuggingFaceTreeEntry[] = [
	{ type: "file", path: "Qwen3.8-27B-Q4_K_M.gguf", size: 17_100_000_000 },
	{ type: "file", path: "Qwen3.8-27B-Q6_K.gguf", size: 22_900_000_000 },
	{ type: "file", path: "Qwen3.8-27B-Q8_0.gguf", size: 29_500_000_000 },
	{ type: "file", path: "mmproj-Qwen3.8-27B-F16.gguf", size: 900_000_000 },
	{ type: "file", path: "Qwen3.8-27B-MTP-Q8_0.gguf", size: 800_000_000 },
];

function launchResult(overrides: Partial<ColabModelLaunchResult> = {}): ColabModelLaunchResult {
	return {
		accelerator: "A100",
		apiBaseUrl: "http://127.0.0.1:18081/v1",
		contextWindow: 32_768,
		maxTokens: 8_192,
		modelId: "/content/models/Qwen3.8-27B-Q6_K.gguf",
		modelName: "Qwen3.8-27B-Q6_K",
		quantization: "Q6_K",
		repoId: "unsloth/Qwen3.8-27B-GGUF",
		sessionName: "ompk-colab-model",
		...overrides,
	};
}

describe("Hugging Face Colab model references", () => {
	test("parses repository ids and explicit revisions", () => {
		expect(parseHuggingFaceModelReference("unsloth/Qwen3.8-27B-GGUF")).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "main",
		});
		expect(parseHuggingFaceModelReference("unsloth/Qwen3.8-27B-GGUF@release")).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "release",
		});
	});

	test("parses repository and direct GGUF URLs", () => {
		expect(parseHuggingFaceModelReference("https://huggingface.co/unsloth/Qwen3.8-27B-GGUF")).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "main",
		});
		expect(
			parseHuggingFaceModelReference(
				"https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-Q6_K.gguf?download=true",
			),
		).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "main",
			file: "Qwen3.8-27B-Q6_K.gguf",
		});
	});

	test("rejects non-Hugging Face and non-GGUF file URLs", () => {
		expect(() => parseHuggingFaceModelReference("https://example.com/owner/model")).toThrow("huggingface.co");
		expect(() =>
			parseHuggingFaceModelReference("https://huggingface.co/owner/model/blob/main/model.safetensors"),
		).toThrow(".gguf");
	});
});

describe("/colab-model arguments", () => {
	test("accepts explicit cheap and premium GPU selections", () => {
		expect(parseColabModelCommandArgs("--gpu T4 owner/model")).toEqual({
			accelerator: "T4",
			modelReference: "owner/model",
		});
		expect(parseColabModelCommandArgs("owner/model --gpu=l4")).toEqual({
			accelerator: "L4",
			modelReference: "owner/model",
		});
		expect(parseColabModelCommandArgs("--gpu H100 owner/model")).toEqual({
			accelerator: "H100",
			modelReference: "owner/model",
		});
	});

	test("rejects unknown GPUs and options", () => {
		expect(() => parseColabModelCommandArgs("--gpu V100 owner/model")).toThrow("Unsupported Colab GPU");
		expect(() => parseColabModelCommandArgs("--cheap owner/model")).toThrow("Unknown /colab-model option");
	});
});

describe("GGUF accelerator selection", () => {
	const reference = { repoId: "unsloth/Qwen3.8-27B-GGUF", revision: "main" };

	test("selects Q6_K for A100 and Q4_K_M for L4", () => {
		expect(selectGgufArtifact(QWEN_FILES, reference, "A100").primaryFile).toBe("Qwen3.8-27B-Q6_K.gguf");
		expect(selectGgufArtifact(QWEN_FILES, reference, "L4").primaryFile).toBe("Qwen3.8-27B-Q4_K_M.gguf");
	});

	test("uses cheaper viable GPUs before A100", () => {
		expect(selectAutomaticColabAccelerators(QWEN_FILES, reference)).toEqual(["L4", "A100"]);
		const smallFiles: HuggingFaceTreeEntry[] = [{ type: "file", path: "small-Q4_K_M.gguf", size: 8_000_000_000 }];
		expect(selectAutomaticColabAccelerators(smallFiles, reference)).toEqual(["T4", "L4", "A100"]);
	});

	test("uses native-only CUDA architectures for every supported GPU", () => {
		expect(getColabAcceleratorProfile("T4").cmakeArchitecture).toBe("75-real");
		expect(getColabAcceleratorProfile("L4").cmakeArchitecture).toBe("89-real");
		expect(getColabAcceleratorProfile("A100").cmakeArchitecture).toBe("80-real");
		expect(getColabAcceleratorProfile("H100").cmakeArchitecture).toBe("90-real");
		expect(getColabAcceleratorProfile("G4").cmakeArchitecture).toBe("120-real");
	});

	test("keeps every shard and uses the first shard as the llama.cpp model path", () => {
		const splitFiles: HuggingFaceTreeEntry[] = [
			{ type: "file", path: "model-Q6_K-00002-of-00003.gguf", size: 9_000_000_000 },
			{ type: "file", path: "model-Q6_K-00001-of-00003.gguf", size: 9_000_000_000 },
			{ type: "file", path: "model-Q6_K-00003-of-00003.gguf", size: 4_000_000_000 },
		];
		const artifact = selectGgufArtifact(splitFiles, reference, "A100");
		expect(artifact.primaryFile).toBe("model-Q6_K-00001-of-00003.gguf");
		expect(artifact.files).toEqual([
			"model-Q6_K-00001-of-00003.gguf",
			"model-Q6_K-00002-of-00003.gguf",
			"model-Q6_K-00003-of-00003.gguf",
		]);
		expect(artifact.totalSize).toBe(22_000_000_000);
	});

	test("honors an explicit GGUF URL even when it exceeds the automatic budget", () => {
		const artifact = selectGgufArtifact(QWEN_FILES, { ...reference, file: "Qwen3.8-27B-Q8_0.gguf" }, "L4");
		expect(artifact.primaryFile).toBe("Qwen3.8-27B-Q8_0.gguf");
		expect(artifact.quantization).toBe("Q8_0");
	});
});

describe("/colab-model command", () => {
	test("is registered as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("colab-model")).toBe(true);
	});

	test("uses WSL for the Colab CLI on Windows", () => {
		expect(buildColabCommand(["status", "--session", "test"], "win32")).toEqual([
			"wsl",
			"colab",
			"status",
			"--session",
			"test",
		]);
		expect(buildColabCommand(["sessions"], "linux")).toEqual(["colab", "sessions"]);
	});

	test("registers the warmed endpoint and selects the runtime model", async () => {
		const output = vi.fn();
		const registerProvider = vi.fn();
		const selectedModel = {
			provider: "llama.cpp",
			id: "/content/models/Qwen3.8-27B-Q6_K.gguf",
		} as Model<Api>;
		const find = vi.fn(() => selectedModel);
		const setModel = vi.fn(async () => {});
		const runtime = {
			output,
			notifyConfigChanged: vi.fn(async () => {}),
			notifyTitleChanged: vi.fn(async () => {}),
			session: {
				modelRegistry: { registerProvider, find },
				setModel,
			},
		} as unknown as SlashCommandRuntime;
		const launch = vi.fn(async () => launchResult());

		await handleColabModelSlashCommand("--gpu A100 unsloth/Qwen3.8-27B-GGUF", runtime, launch);
		expect(launch).toHaveBeenCalledWith("unsloth/Qwen3.8-27B-GGUF", expect.any(Function), { accelerator: "A100" });

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(registerProvider.mock.calls[0]?.[0]).toBe("llama.cpp");
		expect(registerProvider.mock.calls[0]?.[1]).toMatchObject({
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:18081/v1",
			models: [
				{
					id: "/content/models/Qwen3.8-27B-Q6_K.gguf",
					name: "Qwen3.8-27B-Q6_K · Colab A100",
					supportsTools: true,
				},
			],
		});
		expect(setModel).toHaveBeenCalledWith(selectedModel);
		expect(output).toHaveBeenLastCalledWith(expect.stringContaining("Colab model ready: llama.cpp/"));
	});

	test("reports usage without launching when the model reference is missing", async () => {
		const output = vi.fn();
		const launch = vi.fn(async () => launchResult());
		const runtime = { output } as unknown as SlashCommandRuntime;

		await handleColabModelSlashCommand(" ", runtime, launch);

		expect(launch).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: /colab-model"));
	});
});
