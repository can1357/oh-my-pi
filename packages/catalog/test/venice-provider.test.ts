import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import {
	KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
	veniceModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";
import { buildGeneratedModel } from "../scripts/generate-models";

describe("Venice provider catalog", () => {
	it("caps Kimi K2.7 Code during runtime discovery", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "kimi-k2-7-code",
							name: "kimi-k2-7-code",
							context_length: 256_000,
							max_completion_tokens: 262_144,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = veniceModelManagerOptions({ apiKey: "venice-test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "kimi-k2-7-code");

		expect(requestedUrls).toEqual(["https://api.venice.ai/api/v1/models"]);
		expect(model).toBeDefined();
		expect(model?.maxTokens).toBe(KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS);
	});

	it("drops a discovery providerDefault when materializing a bundled catalog row", () => {
		const built = buildGeneratedModel({
			id: "zai-org-glm-5-2",
			name: "GLM 5.2",
			api: "openai-completions",
			provider: "venice",
			baseUrl: "https://api.venice.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 8192,
			providerDefault: true,
		});

		expect("providerDefault" in built).toBe(false);
	});

	it("lets a live untagged model clear a stale providerDefault left on the bundled row", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-default-"));
		try {
			const fetchImpl: FetchImpl = async () =>
				new Response(
					JSON.stringify({
						data: [veniceDiscoveryRow("llama-3.3-70b"), veniceDiscoveryRow("zai-org-glm-5-2", ["default"])],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			const manager = createModelManager({
				...veniceModelManagerOptions({ apiKey: "venice-test-key", fetch: fetchImpl }),
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: [veniceStaticModel("llama-3.3-70b", true), veniceStaticModel("zai-org-glm-5-2", false)],
			});

			const resolved = await manager.refresh("online");

			expect(resolved.models.find(model => model.id === "llama-3.3-70b")?.providerDefault).toBe(false);
			expect(resolved.models.find(model => model.id === "zai-org-glm-5-2")?.providerDefault).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an authoritative tag offline but clears it after a failed refresh", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-default-"));
		try {
			let available = true;
			const fetchImpl: FetchImpl = async () =>
				available
					? new Response(
							JSON.stringify({
								data: [veniceDiscoveryRow("venice-tagged", ["default"]), veniceDiscoveryRow("zai-org-glm-5-2")],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						)
					: new Response("unavailable", { status: 503 });
			const manager = createModelManager({
				...veniceModelManagerOptions({ apiKey: "venice-test-key", fetch: fetchImpl }),
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: [veniceStaticModel("zai-org-glm-5-2")],
			});

			await manager.refresh("online");
			const offline = await manager.refresh("offline");
			expect(offline.stale).toBe(false);
			expect(offline.models.find(model => model.id === "venice-tagged")?.providerDefault).toBe(true);

			available = false;
			const failed = await manager.refresh("online");
			expect(failed.stale).toBe(true);
			expect(failed.models.some(model => model.providerDefault === true)).toBe(false);
			expect(failed.models.some(model => model.id === "zai-org-glm-5-2")).toBe(true);

			const failedCache = await manager.refresh("offline");
			expect(failedCache.stale).toBe(true);
			expect(failedCache.models.some(model => model.providerDefault === true)).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

function veniceDiscoveryRow(id: string, traits?: readonly string[]) {
	return {
		id,
		name: id,
		context_length: 128_000,
		max_completion_tokens: 8192,
		...(traits ? { model_spec: { traits } } : {}),
	};
}

function veniceStaticModel(id: string, providerDefault?: boolean): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "venice",
		baseUrl: "https://api.venice.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...(providerDefault === undefined ? {} : { providerDefault }),
	});
}
