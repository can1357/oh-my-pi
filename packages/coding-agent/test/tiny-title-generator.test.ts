import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import * as ai from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { isSubcommand } from "@pk-nerdsaver-ai/pi-coding-agent/cli-commands";
import { getDefault, getEnumValues, getUi } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings-schema";
import { TinyTitleDownloadProgressComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tiny-title-download-progress";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/dtype";
import {
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/models";
import { createTinyTitleSubprocess, tinyTitleClient } from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-client";
import { generateSessionTitle } from "@pk-nerdsaver-ai/pi-coding-agent/utils/title-generator";
import type { Subprocess } from "bun";

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
		const options = Array.isArray(first) ? { ...(second ?? {}), cmd: first } : first;
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
		content: title
			? [
					{
						type: "toolCall",
						id: "call-title",
						name: "set_title",
						arguments: { title },
					},
				]
			: [{ type: "text", text: "" }],
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

describe("tiny title subprocess", () => {
	it("does not inherit worker output into the interactive terminal", async () => {
		const calls: TinyWorkerSpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createTinyWorkerSpawnMock(calls));

		const worker = createTinyTitleSubprocess();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.stdout).toBe("ignore");
		expect(calls[0]?.options.stderr).toBe("ignore");
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
