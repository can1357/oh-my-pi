import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { verdaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://inference.verda.com/v1";

function spec(id: string, overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "verda",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...overrides,
	};
}

function rosterFetch(ids: string[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(
			JSON.stringify({
				object: "list",
				data: ids.map(id => ({ id, object: "model", created: 0, owned_by: "verda" })),
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as FetchImpl;
}

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("Verda provider support", () => {
	test("Kimi K3.1 Pro resolves as K3 revision 3.1 with the low/high/max ladder", () => {
		const model = buildModel(spec("kimi-k3-1-pro", { reasoning: true, input: ["text", "image"] }));
		expect(model.identity).toMatchObject({ class: "kimi", family: "k3", revision: "3.1.0" });
		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		expect(model.compat?.reasoningContentField).toBe("reasoning_content");
		expect(model.compat?.requiresReasoningContentForToolCalls).toBe(true);
	});

	test("DeepSeek V4.1 Flash 1017 resolves as Flash 4.1, turns off with `none`, and keeps images", () => {
		const model = buildModel(spec("deepseek-4-1-flash-1017"));
		expect(model.identity).toMatchObject({ class: "deepseek", family: "flash", revision: "4.1.0" });
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.requiresEffort).not.toBe(true);
		expect(model.compat?.reasoningDisableMode).toBe("none-effort");
		expect(model.compat?.stripImageInput).not.toBe(true);
		expect(model.input).toContain("image");
	});

	test("live discovery is the project's roster and merges the documented rows", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-verda-"));
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const { models } = await resolveProviderModels(
			{
				...verdaModelManagerOptions({ apiKey: "verda-key", fetch: rosterFetch(["kimi-k3-1-pro"], calls) }),
				cacheDbPath: path.join(tempDir, "models.db"),
			},
			"online",
		);

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer verda-key" }]);
		expect(models.map(model => model.id)).toEqual(["kimi-k3-1-pro"]);

		const bundled = getBundledModels("verda").find(model => model.id === "kimi-k3-1-pro");
		const kimi = models.find(model => model.id === "kimi-k3-1-pro");
		expect(bundled).toBeDefined();
		expect(kimi?.name).toBe(bundled?.name);
		expect(kimi?.cost).toEqual(bundled?.cost);
		expect(kimi?.contextWindow).toBe(bundled?.contextWindow);
		expect(kimi?.maxTokens).toBe(bundled?.maxTokens);
	});

	test("a second project key never reads the first project's cached roster", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-verda-"));
		const cacheDbPath = path.join(tempDir, "shared.db");
		const projectA = await resolveProviderModels(
			{ ...verdaModelManagerOptions({ apiKey: "key-a", fetch: rosterFetch(["kimi-k3-1-pro"]) }), cacheDbPath },
			"online",
		);
		expect(projectA.models.map(model => model.id)).toEqual(["kimi-k3-1-pro"]);

		const calls: Array<{ url: string; authorization: string | null }> = [];
		const projectB = await resolveProviderModels(
			{
				...verdaModelManagerOptions({ apiKey: "key-b", fetch: rosterFetch(["deepseek-4-1-flash-1017"], calls) }),
				cacheDbPath,
			},
			"online-if-uncached",
		);
		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer key-b" }]);
		expect(projectB.models.map(model => model.id)).toEqual(["deepseek-4-1-flash-1017"]);
	});
});
