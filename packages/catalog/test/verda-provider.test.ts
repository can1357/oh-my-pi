import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { verdaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function bareSpec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "verda",
		baseUrl: "https://inference.verda.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("Verda provider support", () => {
	test("Kimi K3.1 Pro keeps the K3 low/high/max ladder with max as default", () => {
		const model = getBundledModel<"openai-completions">("verda", "kimi-k3-1-pro");
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.contextWindow).toBe(1048576);
		expect(model?.maxTokens).toBe(131072);
		expect(model?.thinking?.mode).toBe("effort");
		expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model?.thinking?.defaultLevel).toBe(Effort.Max);
		expect(model?.compat?.reasoningContentField).toBe("reasoning_content");
		expect(model?.compat?.requiresReasoningContentForToolCalls).toBe(true);
	});

	test("DeepSeek V4.1 Flash 1017 reasons on low/high/max, turns off with `none`, and keeps images", () => {
		const model = buildModel(bareSpec("deepseek-4-1-flash-1017"));
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.requiresEffort).not.toBe(true);
		expect(model.compat?.reasoningDisableMode).toBe("none-effort");
		expect(model.compat?.stripImageInput).not.toBe(true);
		expect(model.input).toContain("image");
	});

	test("live discovery is the project's roster and merges the documented rows", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-verda-"));
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: "kimi-k3-1-pro", object: "model", created: 0, owned_by: "verda" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as FetchImpl;

		const { models } = await resolveProviderModels(
			{
				...verdaModelManagerOptions({ apiKey: "verda-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "models.db"),
			},
			"online",
		);

		expect(requests).toEqual([{ url: "https://inference.verda.com/v1/models", authorization: "Bearer verda-key" }]);
		expect(models.map(model => model.id)).toEqual(["kimi-k3-1-pro"]);

		const bundled = getBundledModels("verda").find(model => model.id === "kimi-k3-1-pro");
		const kimi = models.find(model => model.id === "kimi-k3-1-pro");
		expect(bundled).toBeDefined();
		expect(kimi?.name).toBe(bundled?.name);
		expect(kimi?.cost).toEqual(bundled?.cost);
		expect(kimi?.contextWindow).toBe(bundled?.contextWindow);
		expect(kimi?.maxTokens).toBe(bundled?.maxTokens);
	});
});
