import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	zaiModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { removeWithRetries } from "../../utils/src/temp";

// Z.AI GLM coding-plan token costs all showed as "Free" (issue #5598): the `zai`
// provider descriptor sourced the stencil.so `zai-coding-plan` key, which reports
// all-$0 subscription rates. The `zai` (pay-as-you-go) key carries the real
// per-token rates for the identical GLM ids, matching how other subscription
// providers surface comparison pricing in `/models`.
describe("zai GLM pricing sources the PAYG stencil.so key (issue #5598)", () => {
	test("mapped zai models carry the PAYG per-token costs, not the coding-plan $0 rates", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
			"zai-coding-plan": {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
		};

		const zai = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "zai",
		);
		const glm52 = zai.find(model => model.id === "glm-5.2");
		expect(glm52).toBeDefined();
		expect(glm52?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
	});
});

describe("zai API routing", () => {
	test("routes GLM-5.3-Flash through the native API without moving supported Anthropic models", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						tool_call: true,
					},
					"glm-5.3-flash": {
						name: "GLM-5.3-Flash",
						tool_call: true,
					},
				},
			},
		};

		const models = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS);
		const glm52 = models.find(model => model.provider === "zai" && model.id === "glm-5.2");
		const glm53Flash = models.find(model => model.provider === "zai" && model.id === "glm-5.3-flash");

		expect(glm52).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
		});
		expect(glm53Flash).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		});
	});
});

describe("zai model discovery", () => {
	test("surfaces newly listed GLM ids on their route while keeping bundled-only SKUs and metadata", async () => {
		const requests: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
				const headers = new Headers(init?.headers);
				requests.push(`${String(input)} ${headers.get("authorization")}`);
				return Response.json({
					object: "list",
					data: ["glm-5.3", "glm-5.3-flash", "glm-5.4"].map(id => ({ id, object: "model", owned_by: "z-ai" })),
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-zai-discovery-"));
		try {
			const { models } = await resolveProviderModels(
				{
					...zaiModelManagerOptions({ apiKey: "zai-key", fetch: fetchImpl }),
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);
			const byId = new Map(models.map(model => [model.id, model]));

			expect(requests).toEqual(["https://api.z.ai/api/coding/paas/v4/models Bearer zai-key"]);
			expect(byId.get("glm-5.4")).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://api.z.ai/api/anthropic",
				reasoning: true,
			});
			expect(byId.get("glm-5.3-flash")).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
			});
			// The id-only listing must not erase bundled limits and PAYG pricing.
			const bundled = getBundledModel("zai", "glm-5.3");
			expect(byId.get("glm-5.3")).toMatchObject({
				name: bundled.name,
				contextWindow: bundled.contextWindow,
				cost: bundled.cost,
			});
			// Live SKUs the listing omits stay selectable.
			expect(byId.has("glm-5v-turbo")).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
