import { describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import * as modelsModule from "@oh-my-pi/pi-catalog/models";
import { yoloAutoModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Fixture mirrors the live `https://yolo-auto.com/v1/models` surface: an
 * OpenAI-style `data` array of public model ids. The docs only advertise
 * `deepseek-flash-v4`; the extra id proves discovery surfaces whatever the wire
 * returns, not just bundled ids.
 */
function yoloAutoModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [
					{ id: "deepseek-flash-v4", object: "model", created: 0, owned_by: "yolo-auto" },
					{ id: "future-model", object: "model", created: 0, owned_by: "yolo-auto" },
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("Yolo-Auto provider discovery", () => {
	test("discovers /v1/models with the bundled reference's reasoning, vision, and compat", async () => {
		const { calls, authorizations, fetch } = yoloAutoModelsFetch();
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual(["https://yolo-auto.com/v1/models"]);
		expect(authorizations).toEqual(["Bearer yolo-test-key"]);

		const flash = models?.find(model => model.id === "deepseek-flash-v4");
		expect(flash).toMatchObject({
			provider: "yolo-auto",
			api: "openai-completions",
			baseUrl: "https://yolo-auto.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: null,
		});
		// The documented wire surface flows from the bundled reference into
		// discovered models: generic chat-template thinking, effort steering, and
		// no developer role / store param.
		expect(flash?.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
			thinkingFormat: "chat-template",
		});
		// The documented effort mapping is retained through credentialed discovery — selecting an effort must reach the request.
		expect(flash?.thinking).toMatchObject({
			mode: "effort",
			efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
			effortMap: {
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "max",
				max: "max",
			},
		});
	});

	test("surfaces wire ids that have no bundled reference", async () => {
		const { fetch } = yoloAutoModelsFetch();
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		expect(models?.some(model => model.id === "future-model")).toBe(true);
	});

	test("inherits reasoning and context for models other providers already bundle", async () => {
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-flash-v4", object: "model" },
						{ id: "deepseek-v4-pro", object: "model" },
					],
				}),
				{ status: 200 },
			);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		const flash = models?.find(model => model.id === "deepseek-v4-pro");

		expect(flash).toMatchObject({
			provider: "yolo-auto",
			baseUrl: "https://yolo-auto.com/v1",
			reasoning: true,
			contextWindow: 1048576,
		});
		expect(flash?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("overlays flat-rate cost and no-store surface on foreign references", async () => {
		// gpt-4o has no yolo-auto bundled reference, so the global index
		// supplies OpenAI's token pricing and store-capable surface. The
		// provider-wide constraints must win: Yolo is flat-rate and its
		// documented surface rejects the `store` param.
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-flash-v4", object: "model" },
						{ id: "gpt-4o", object: "model" },
					],
				}),
				{ status: 200 },
			);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		const gpt4o = models?.find(model => model.id === "gpt-4o");

		expect(gpt4o).toMatchObject({
			provider: "yolo-auto",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
	});

	test("returns null when /v1/models rejects the key", async () => {
		const fetch: FetchImpl = async () => new Response("Unauthorized", { status: 401 });
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-bogus", fetch }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});

	test("serves no dynamic models without an API key", () => {
		expect(yoloAutoModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});

	test("marks live discovery authoritative so retired bundled ids cannot linger", () => {
		// The runtime merge path reads this flag from the manager options, not
		// the catalog descriptor — without it a successful /v1/models response
		// merges over the bundled seed instead of replacing it.
		expect(yoloAutoModelManagerOptions({ apiKey: "yolo-test-key" }).dynamicModelsAuthoritative).toBe(true);
	});

	test("prunes the bundled id when a live catalog omits it", async () => {
		// Regression: a provider-side retirement of deepseek-flash-v4 must not leave
		// the bundled seed selectable. With the authoritative option the
		// production manager replaces the static rows with the wire catalog.
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ data: [{ id: "live-only", object: "model" }] }), { status: 200 });
		const manager = createModelManager(yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }));
		const { models } = await manager.refresh("online");

		expect(models.map(model => model.id)).toEqual(["live-only"]);
		// Even a reference-less wire id keeps the provider-wide flat-rate cost
		// and no-store surface — the generic compat defaults would otherwise
		// resolve `supportsStore: true` and the endpoint rejects the field.
		expect(models[0]).toMatchObject({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
	});

	test("prefers curated metadata over a stale previous bundle", async () => {
		// A credentialed `gen:models` run bakes live discovery into
		// models.json; that previous bundle row must not shadow later
		// corrections to YOLO_AUTO_STATIC_MODELS. Simulate a stale bundle row
		// (262K context, no template dialect) and require the curated surface.
		const originalGetBundledModels = modelsModule.getBundledModels;
		vi.spyOn(modelsModule, "getBundledModels").mockImplementation((provider => {
			if (provider === "yolo-auto") {
				return [
					buildModel({
						id: "deepseek-flash-v4",
						name: "DeepSeek Flash V4 (stale bundle)",
						api: "openai-completions",
						provider: "yolo-auto",
						baseUrl: "https://yolo-auto.com/v1",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 262_144,
						maxTokens: null,
					}),
				];
			}
			return originalGetBundledModels(provider);
		}) as typeof modelsModule.getBundledModels);
		try {
			const fetch: FetchImpl = async () =>
				new Response(JSON.stringify({ data: [{ id: "deepseek-flash-v4", object: "model" }] }), { status: 200 });
			const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
			const flash = models?.find(model => model.id === "deepseek-flash-v4");

			expect(flash).toMatchObject({
				contextWindow: 131072,
				compat: { thinkingFormat: "chat-template" },
			});
		} finally {
			vi.restoreAllMocks();
		}
	});
});
