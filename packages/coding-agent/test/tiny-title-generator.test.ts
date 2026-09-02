import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { StoppingCriteria, TextGenerationPipeline } from "@huggingface/transformers";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { getDefault, getEnumValues, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { TinyTitleDownloadProgressComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tiny-title-download-progress";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { RefCountedWorkerHandle } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "@oh-my-pi/pi-coding-agent/tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "@oh-my-pi/pi-coding-agent/tiny/dtype";
import {
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "@oh-my-pi/pi-coding-agent/tiny/models";
import {
	createTinyTitleSubprocess,
	TinyTitleClient,
	tinyTitleClient,
} from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import type { Subprocess } from "bun";
import { buildCompletionPrompt } from "../src/tiny/completion-prompt";
import { createStopOnTextCriteria, type TransformersRuntime } from "../src/tiny/worker";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>, tinyModel: string) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	} as never;
}

type TinyWorkerSpawnOptions = Bun.SpawnOptions.SpawnOptions<"ignore", "ignore", "ignore">;

type TinyWorkerSpawnCall = {
	options: TinyWorkerSpawnOptions & { cmd: string[] };
};

function createTinyWorkerSpawnMock(calls: TinyWorkerSpawnCall[]) {
	function mockSpawn(options: TinyWorkerSpawnOptions & { cmd: string[] }): Subprocess<"ignore", "ignore", "ignore">;
	function mockSpawn(cmd: string[], options?: TinyWorkerSpawnOptions): Subprocess<"ignore", "ignore", "ignore">;
	function mockSpawn(
		first: string[] | (TinyWorkerSpawnOptions & { cmd: string[] }),
		second?: TinyWorkerSpawnOptions,
	): Subprocess<"ignore", "ignore", "ignore"> {
		const options = Array.isArray(first) ? { ...second, cmd: first } : first;
		calls.push({ options });
		return {
			pid: 12345,
			send: () => undefined,
			kill: () => true,
			unref: () => undefined,
			exited: Promise.resolve(0),
		} as unknown as Subprocess<"ignore", "ignore", "ignore">;
	}

	return mockSpawn;
}

function mockOnlineTitle(title: string | null) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: title ? [{ type: "text", text: `<title>${title}</title>` }] : [{ type: "text", text: "" }],
	} as never);
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("tiny title generator routing", () => {
	it("keeps online-only behavior when Tiny Model is Online", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "online"),
		);

		expect(title).toBe("Online Title");
		expect(local).not.toHaveBeenCalled();
		expect(online).toHaveBeenCalledTimes(1);
	});

	it("uses the local client for selected local models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing");
		expect(online).not.toHaveBeenCalled();
	});

	it("passes the resolved TITLE_SYSTEM.md prompt to the local client", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing", { systemPrompt: customPrompt });
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT fall back to online when local returns null (issue #3187)", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue(null);
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate fallback",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBeNull();
		expect(local).toHaveBeenCalledTimes(1);
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT fall back to online when local throws", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(tinyTitleClient, "generate").mockRejectedValue(new Error("worker crashed"));
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate crash",
			createRegistry(model),
			createSettings(model, "lfm2-700m"),
		);

		expect(title).toBeNull();
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT call the local worker or online path for an unknown tinyModel key", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Late Local");
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate unknown",
			createRegistry(model),
			createSettings(model, "ollama:gpt-oss"),
		);

		expect(title).toBeNull();
		expect(local).not.toHaveBeenCalled();
		expect(online).not.toHaveBeenCalled();
	});
});

interface FakeTinyWorker {
	handle: RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>;
	sent: TinyTitleWorkerInbound[];
	refCount: number;
	emit(message: TinyTitleWorkerOutbound): void;
}

function createFakeTinyWorker(): FakeTinyWorker {
	const sent: TinyTitleWorkerInbound[] = [];
	let onMessage: ((message: TinyTitleWorkerOutbound) => void) | undefined;
	const worker: FakeTinyWorker = {
		sent,
		refCount: 0,
		emit(message) {
			onMessage?.(message);
		},
		handle: {
			send(message) {
				sent.push(message);
			},
			onMessage(handler) {
				onMessage = handler;
				return () => {
					onMessage = undefined;
				};
			},
			onError() {
				return () => {};
			},
			async terminate() {},
			ref() {
				worker.refCount++;
			},
			unref() {
				worker.refCount--;
			},
		},
	};
	return worker;
}

describe("tiny memory completion prompts", () => {
	it("renders extraction instructions as a system turn separate from user input", () => {
		const applyChatTemplate = vi.fn(() => "rendered prompt");
		const tokenizer = { apply_chat_template: applyChatTemplate };

		expect(buildCompletionPrompt(tokenizer as never, "actual user input", " extraction instructions ")).toBe(
			"rendered prompt",
		);
		expect(applyChatTemplate).toHaveBeenCalledWith(
			[
				{ role: "system", content: "extraction instructions" },
				{ role: "user", content: "actual user input" },
			],
			{
				add_generation_prompt: true,
				tokenize: false,
				enable_thinking: false,
			},
		);
	});

	it("carries the extraction system prompt over the worker protocol", async () => {
		const worker = createFakeTinyWorker();
		const client = new TinyTitleClient(() => worker.handle);

		const completion = client.complete("lfm2-1.2b", "actual user input", {
			maxTokens: 64,
			systemPrompt: "extraction instructions",
		});
		const request = worker.sent.find(message => message.type === "complete");
		expect(request).toEqual({
			type: "complete",
			id: expect.any(String),
			modelKey: "lfm2-1.2b",
			prompt: "actual user input",
			maxTokens: 64,
			systemPrompt: "extraction instructions",
		});
		worker.emit({ type: "completion", id: request?.id ?? "", text: "extracted fact" });

		expect(await completion).toBe("extracted fact");
		await client.terminate();
	});
});

describe("tiny title prewarm", () => {
	it("spawns one idle worker that the first generate reuses (issue #6462)", async () => {
		const workers: FakeTinyWorker[] = [];
		let spawnCount = 0;
		const client = new TinyTitleClient(() => {
			spawnCount++;
			const worker = createFakeTinyWorker();
			workers.push(worker);
			return worker.handle;
		});

		client.prewarm("lfm2-350m");

		expect(spawnCount).toBe(1);
		// No pending request registered, so the prewarmed worker is never
		// referenced and never blocks process exit.
		expect(workers[0]?.refCount).toBe(0);
		// A no-op ping warms the transport without loading a model.
		expect(workers[0]?.sent).toEqual([{ type: "ping", id: expect.any(String) }]);

		const generated = client.generate("lfm2-350m", "Investigate routing");
		// The first submit reuses the prewarmed worker — no second spawn.
		expect(spawnCount).toBe(1);

		const request = workers[0]?.sent.find(message => message.type === "generate");
		expect(request?.type).toBe("generate");
		workers[0]?.emit({ type: "title", id: request?.id ?? "", title: "Routing" });

		expect(await generated).toBe("Routing");
		await client.terminate();
	});

	it("does not spawn a worker for the online default", () => {
		let spawnCount = 0;
		const client = new TinyTitleClient(() => {
			spawnCount++;
			return createFakeTinyWorker().handle;
		});

		client.prewarm("online");

		expect(spawnCount).toBe(0);
	});
});

describe("tiny title subprocess", () => {
	it("does not inherit worker output into the interactive terminal", async () => {
		const calls: TinyWorkerSpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createTinyWorkerSpawnMock(calls));

		const worker = createTinyTitleSubprocess();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.stdout).toBe("ignore");
		expect(calls[0]?.options.stderr).not.toBe("inherit");
		expect(calls[0]?.options.stderr).not.toBe("pipe");
		await worker.proc.exited;
	});
});

describe("providers.tinyModel schema", () => {
	it("keeps enum values and UI options in sync with the tiny model registry", () => {
		expect(getEnumValues("providers.tinyModel")).toEqual([...TINY_TITLE_MODEL_VALUES]);
		expect(getUi("providers.tinyModel")?.options).toEqual(TINY_TITLE_MODEL_OPTIONS);
		expect(getDefault("providers.tinyModel")).toBe(ONLINE_TINY_TITLE_MODEL_KEY);
	});
});

describe("tiny model acceleration schema", () => {
	it("keeps the device setting in sync with the device module constants", () => {
		expect(getEnumValues("providers.tinyModelDevice")).toEqual([...TINY_MODEL_DEVICE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDevice")?.options).toEqual(TINY_MODEL_DEVICE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDevice")).toBe(TINY_MODEL_DEVICE_DEFAULT);
	});

	it("keeps the precision setting in sync with the dtype module constants", () => {
		expect(getEnumValues("providers.tinyModelDtype")).toEqual([...TINY_MODEL_DTYPE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDtype")?.options).toEqual(TINY_MODEL_DTYPE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDtype")).toBe(TINY_MODEL_DTYPE_DEFAULT);
	});
});

describe("tiny title download progress UI", () => {
	it("renders progress updates and completion state", () => {
		const component = new TinyTitleDownloadProgressComponent("lfm2-700m");
		component.update({
			modelKey: "lfm2-700m",
			status: "progress_total",
			name: "onnx-community/LFM2-700M-ONNX",
			progress: 50,
			loaded: 50,
			total: 100,
			files: {},
		});
		expect(component.render(80).join("\n")).toContain("LFM2 700M");
		expect(component.isComplete()).toBe(false);
		component.update({ modelKey: "lfm2-700m", status: "ready", task: "text-generation", model: "repo" });
		expect(component.isComplete()).toBe(true);
	});
});

describe("tiny-models CLI", () => {
	it("registers tiny-models as a top-level subcommand", () => {
		expect(isSubcommand("tiny-models")).toBe(true);
	});
});

describe("local title stop criteria", () => {
	/** Minimal stand-ins: the criteria only needs a StoppingCriteria base to extend
	 *  and a tokenizer that can decode a token window. */
	const transformers = { StoppingCriteria: class {} } as unknown as TransformersRuntime;
	const tokenizer = {
		decode: (ids: number[]) => ids.map(id => (id === 1 ? "</title>" : "x")).join(""),
	} as unknown as TextGenerationPipeline["tokenizer"];
	/** `_call(inputIds, scores)`; the criteria ignores scores. */
	const call = (criteria: StoppingCriteria, inputIds: number[][]): boolean[] =>
		criteria._call(
			inputIds,
			inputIds.map(() => []),
		);

	it("ignores a stop string that appears only in the prompt", () => {
		const criteria = createStopOnTextCriteria(transformers, tokenizer, "</title>");
		// Token 1 decodes to the stop string and sits inside the prompt.
		const prompt = [1, 0, 0];
		expect(call(criteria, [[...prompt, 0]])).toEqual([false]);
		expect(call(criteria, [[...prompt, 0, 0]])).toEqual([false]);
	});

	it("stops once the stop string is generated", () => {
		const criteria = createStopOnTextCriteria(transformers, tokenizer, "</title>");
		const prompt = [1, 0, 0];
		expect(call(criteria, [[...prompt, 0]])).toEqual([false]);
		expect(call(criteria, [[...prompt, 0, 1]])).toEqual([true]);
	});

	it("tracks each batch entry independently", () => {
		const criteria = createStopOnTextCriteria(transformers, tokenizer, "</title>");
		expect(
			call(criteria, [
				[1, 0],
				[0, 0],
			]),
		).toEqual([false, false]);
		expect(
			call(criteria, [
				[1, 0, 0],
				[0, 0, 1],
			]),
		).toEqual([false, true]);
	});
});
