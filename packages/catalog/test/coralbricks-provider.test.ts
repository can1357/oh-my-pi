import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	CORALBRICKS_BASE_URL,
	coralbricksModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const DISCOVERY_URL = `${CORALBRICKS_BASE_URL}/models`;

/**
 * A Coral `/v1/models` row shaped as the gateway returns it (2026-10-08):
 * OpenAI list fields plus Coral's own per-million pricing block and the
 * capability flags its docs declare authoritative.
 */
function coralRow(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		id: "glm-5.3-fast",
		object: "model",
		owned_by: "coralbricks",
		context_length: 1048576,
		created: 1789000000,
		pricing: {
			cache_write_multiple: 0.3,
			cache_write_per_m: 1.68,
			cached_input_per_m: 0,
			input_per_m: 1.12,
			output_per_m: 4.4,
		},
		supports_chat: true,
		supports_image_input: false,
		supports_tools: true,
		...overrides,
	};
}

function catalogFixture(): Response {
	return Response.json({
		object: "list",
		data: [
			coralRow({}),
			coralRow({
				id: "deepseek-v4.1-flash-fast",
				pricing: { cached_input_per_m: 0, cache_write_per_m: 0.09, input_per_m: 0.3, output_per_m: 1.2 },
				supports_image_input: true,
			}),
			// A row the bundled catalog has never seen: neutral defaults, no
			// capabilities invented from the live response.
			coralRow({
				id: "coral-unknown-model",
				pricing: { input_per_m: 0.75, output_per_m: 2.4 },
				supports_tools: false,
			}),
			// Non-chat surfaces and id-less rows are dropped.
			coralRow({ id: "coral-embed", supports_chat: false }),
			{ object: "model", context_length: 8192 },
		],
	});
}

describe("CoralBricks built-in provider", () => {
	test("maps live rows with Coral's pricing and capability fields and drops non-chat rows", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requests.push({ url: input.toString(), authorization: headers.get("Authorization") });
			return catalogFixture();
		};

		const options = coralbricksModelManagerOptions({ apiKey: "cb-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		// `/v1/models` is key-protected, so discovery must authenticate.
		expect(requests).toEqual([{ url: DISCOVERY_URL, authorization: "Bearer cb-test-key" }]);
		expect(models?.map(item => item.id)).toEqual(["coral-unknown-model", "deepseek-v4.1-flash-fast", "glm-5.3-fast"]);

		// Legacy rows without reasoning metadata keep the bundled fallback;
		// the endpoint still publishes no output cap.
		const glm = models?.find(item => item.id === "glm-5.3-fast");
		expect(glm?.maxTokens).toBe(131072);
		expect(glm?.reasoning).toBe(true);

		// Unknown ids stay neutral: no invented reasoning or output cap, and
		// the live tools flag maps through.
		const unknown = models?.find(item => item.id === "coral-unknown-model");
		expect(unknown?.reasoning).toBe(false);
		expect(unknown?.maxTokens).toBeNull();
		expect(unknown?.cost).toEqual({ input: 0.75, output: 2.4, cacheRead: 0, cacheWrite: 0 });
		expect(unknown?.supportsTools).toBe(false);
	});

	test("uses live reasoning metadata for new models and overrides stale bundled controls through cache reload", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "coral-reasoning-"));
		let fetches = 0;
		const options = {
			...coralbricksModelManagerOptions({
				apiKey: "cb-test-key",
				fetch: async () => {
					fetches++;
					return Response.json({
						data: [
							coralRow({
								id: "coral-future-reasoner",
								supports_reasoning: true,
								reasoning: {
									supported_efforts: ["max", "low", "low", "none", "unknown", 7],
									default_effort: "max",
									mandatory: true,
									disable: null,
								},
							}),
							coralRow({
								supports_reasoning: true,
								reasoning: {
									supported_efforts: ["high", "low"],
									default_effort: "high",
									mandatory: false,
									disable: { reasoning_effort: "none" },
								},
							}),
							coralRow({ id: "deepseek-v4.1-flash-fast", supports_reasoning: false }),
						],
					});
				},
			}),
			cacheDbPath: path.join(tempDir, "models.db"),
		};
		try {
			for (const strategy of ["online", "offline"] as const) {
				const { models } = await resolveProviderModels(options, strategy);
				const future = models.find(model => model.id === "coral-future-reasoner");
				expect(future?.reasoning).toBe(true);
				expect(future?.thinking?.efforts).toEqual([Effort.Low, Effort.Max]);
				expect(future?.thinking?.defaultLevel).toBe(Effort.Max);
				expect(future?.thinking?.requiresEffort).toBe(true);
				const glm = models.find(model => model.id === "glm-5.3-fast");
				expect(glm?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
				expect(glm?.thinking?.defaultLevel).toBe(Effort.High);
				expect(glm?.thinking?.requiresEffort).toBe(false);
				expect(glm?.compat?.reasoningDisableMode).toBe("none-effort");
				const disabled = models.find(model => model.id === "deepseek-v4.1-flash-fast");
				expect(disabled?.reasoning).toBe(false);
				expect(disabled?.thinking).toBeUndefined();
			}
			expect(fetches).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("does not invent a dial for an advertised empty or unrecognized ladder through a failed-refresh reload, while missing metadata keeps the fallback", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "coral-empty-ladder-"));
		let fail = false;
		const options = {
			...coralbricksModelManagerOptions({
				apiKey: "cb-test-key",
				fetch: async () =>
					fail
						? new Response("upstream down", { status: 503 })
						: Response.json({
								data: [
									coralRow({ supports_reasoning: true, reasoning: { supported_efforts: [] } }),
									coralRow({
										id: "coral-unknown-efforts",
										supports_reasoning: true,
										reasoning: { supported_efforts: ["turbo", null] },
									}),
									coralRow({
										id: "deepseek-v4.1-flash-fast",
										supports_reasoning: "true",
										reasoning: { supported_efforts: "high" },
									}),
								],
							}),
			}),
			cacheDbPath: path.join(tempDir, "models.db"),
		};
		try {
			// The second pass fails, so the cached snapshot is merged back over
			// the bundled rows, which still carry the reviewed GLM ladder.
			for (const failing of [false, true]) {
				fail = failing;
				const { models, stale } = await resolveProviderModels(options, "online");
				expect(stale).toBe(failing);
				expect(models.find(model => model.id === "glm-5.3-fast")?.thinking).toBeUndefined();
				expect(models.find(model => model.id === "coral-unknown-efforts")?.thinking).toBeUndefined();
				expect(models.find(model => model.id === "deepseek-v4.1-flash-fast")?.thinking?.efforts).toEqual([
					Effort.Low,
					Effort.High,
					Effort.Max,
				]);
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("keeps live effort ladders through the generator's thinking re-bake", async () => {
		// A keyed `gen:models` bakes discovery rows through
		// `applyGeneratedModelPolicies`; a row that trusts only its explicit
		// thinking must keep the live ladder instead of being re-derived away.
		const options = coralbricksModelManagerOptions({
			apiKey: "cb-test-key",
			fetch: async () =>
				Response.json({
					data: [
						coralRow({
							supports_reasoning: true,
							reasoning: { supported_efforts: ["low", "high"], default_effort: "high", mandatory: true },
						}),
					],
				}),
		});
		const specs = (await options.fetchDynamicModels?.())?.map(model => toModelSpec(buildModel(model))) ?? [];
		applyGeneratedModelPolicies(specs);
		expect(specs[0]?.thinking).toMatchObject({
			efforts: [Effort.Low, Effort.High],
			defaultLevel: Effort.High,
			requiresEffort: true,
		});
	});

	test("gates discovery on credentials because /v1/models is key-protected", () => {
		expect(coralbricksModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
		expect(coralbricksModelManagerOptions({ apiKey: "cb-test-key" }).fetchDynamicModels).toBeDefined();
	});

	test("keeps live modality removal and zero prices authoritative through the production manager merge", async () => {
		// Coral documents `supports_image_input` as authoritative and answers
		// unsupported content with `400 unsupported_content_type`, so a live
		// text-only row must strip the bundled row's image support instead of
		// OR-merging it back. Its `pricing` block is the live tariff, so an
		// explicit `0` (dropped cache-write charge) must not revert to the
		// bundled rate.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-coralbricks-refresh-"));
		const dbPath = path.join(tempDir, "models.db");
		const bundledVisionModel: ModelSpec<"openai-completions"> = {
			id: "deepseek-v4.1-flash-fast",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: "coralbricks",
			baseUrl: CORALBRICKS_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0.09 },
			contextWindow: 1048576,
			maxTokens: 131072,
		};
		const fetchMock = async (): Promise<Response> =>
			Response.json({
				object: "list",
				data: [
					coralRow({
						id: "deepseek-v4.1-flash-fast",
						pricing: { cached_input_per_m: 0, cache_write_per_m: 0, input_per_m: 0.3, output_per_m: 1.2 },
						supports_image_input: false,
					}),
				],
			});

		try {
			const { models } = await resolveProviderModels<"openai-completions">(
				{
					...coralbricksModelManagerOptions({ apiKey: "cb-test-key", fetch: fetchMock }),
					staticModels: [bundledVisionModel],
					cacheDbPath: dbPath,
				},
				"online",
			);

			const model = models.find(item => item.id === "deepseek-v4.1-flash-fast");
			expect(model?.input).toEqual(["text"]);
			expect(model?.cost).toMatchObject({ input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 });
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
