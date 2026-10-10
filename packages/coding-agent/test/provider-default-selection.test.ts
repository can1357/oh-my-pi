import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
import {
	AvailableModelsResponse_ModelDetailsSchema,
	AvailableModelsResponseSchema,
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsResponseSchema,
	ModelDetailsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fetchDevinModels } from "@oh-my-pi/pi-catalog/discovery/devin";
import {
	type ClientModelConfig,
	ClientModelConfigSchema,
	DefaultOverrideModelConfigSchema,
	GetCliModelConfigsResponseSchema,
	ModelFamilyMetadataEntrySchema,
	ModelFamilyMetadataSchema,
	ModelFamilyMetadataValueSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

/** One `GetCliModelConfigs` row; `effort` files it as a lane of a server-declared family. */
function devinConfig(
	uid: string,
	options: { disabled?: boolean; family?: string; effort?: string; familyDefault?: boolean } = {},
): ClientModelConfig {
	const { disabled = false, family, effort, familyDefault = false } = options;
	return create(ClientModelConfigSchema, {
		modelUid: uid,
		label: uid,
		disabled,
		maxTokens: 200_000,
		isDefaultModelInFamily: familyDefault,
		...(family === undefined
			? {}
			: {
					modelFamilyMetadata: create(ModelFamilyMetadataSchema, {
						modelFamilyLabel: family,
						entries:
							effort === undefined
								? []
								: [
										create(ModelFamilyMetadataEntrySchema, {
											key: "Reasoning Effort",
											value: create(ModelFamilyMetadataValueSchema, { name: effort, order: 0 }),
										}),
									],
					}),
				}),
	});
}

/** Devin's discovered models for a roster whose account default is `defaultUid`. */
async function discoverDevin(configs: ClientModelConfig[], defaultUid: string): Promise<Model<Api>[]> {
	const payload = toBinary(
		GetCliModelConfigsResponseSchema,
		create(GetCliModelConfigsResponseSchema, {
			clientModelConfigs: configs,
			defaultOverrideModelConfig: create(DefaultOverrideModelConfigSchema, { modelUid: defaultUid }),
		}),
	);
	const specs = await fetchDevinModels({
		apiKey: "fixture-token",
		fetch: async () => new Response(payload, { status: 200, headers: { "content-type": "application/proto" } }),
	});
	if (specs === null) throw new Error("expected the fixture roster to yield Devin models");
	return specs.map(spec => buildModel(spec));
}

/** The SWE-2 lanes as Devin serves them; the account `disabled` flag is the plan gate. */
function swe2Lanes(disabled: boolean): ClientModelConfig[] {
	return [
		devinConfig("swe-2-high", { disabled, family: "SWE-2", effort: "High", familyDefault: true }),
		devinConfig("swe-2-medium", { disabled, family: "SWE-2", effort: "Medium" }),
		devinConfig("swe-2-max", { disabled, family: "SWE-2", effort: "Max" }),
	];
}

describe("provider default selection", () => {
	/**
	 * `pickDefaultAvailableModel` prefers the first model whose id equals its
	 * provider's declared default and falls through to `availableModels[0]`
	 * when nothing matches. Synthetic's default pointed at `hf:zai-org/GLM-5.1`
	 * after the provider moved to GLM-5.2, so an account with only
	 * `SYNTHETIC_API_KEY` opened on whichever model sorted first instead of the
	 * declared default.
	 *
	 * The default is moved to the back of the availability list rather than
	 * relying on catalog order, so the assertion keeps proving that the picker
	 * overrides position — not that `gen:models` happens to sort some other
	 * model first.
	 */
	test("picks Synthetic's declared default over availability order", () => {
		const bundled = getBundledModels("synthetic") as Model<Api>[];
		const declaredDefault = bundled.find(model => model.id === DEFAULT_MODEL_PER_PROVIDER.synthetic);
		expect(declaredDefault).toBeDefined();
		if (!declaredDefault) return;

		const available = [...bundled.filter(model => model !== declaredDefault), declaredDefault];
		expect(available.length).toBeGreaterThan(1);

		const picked = pickDefaultAvailableModel(available);

		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.synthetic);
	});

	test("starts a Pro Devin account on its account default, SWE-2 at High, over the bundled SWE-1.6", async () => {
		const devin = await discoverDevin(
			[
				...swe2Lanes(false),
				devinConfig("swe-1-6", { family: "SWE-1.6" }),
				devinConfig("swe-1-6-fast", { family: "SWE-1.6 Fast" }),
			],
			"swe-2-high",
		);

		const picked = pickDefaultAvailableModel(devin);

		expect(picked).toMatchObject({
			provider: "devin",
			id: "swe-2",
			requestModelId: "swe-2-high",
			thinking: { defaultLevel: "high" },
		});
	});

	test("starts a Devin family on the account default's lane when it is not the family default", async () => {
		// SWE-2 High stays the server's family default; the account default names the Medium lane.
		const devin = await discoverDevin(
			[...swe2Lanes(false), devinConfig("swe-1-6", { family: "SWE-1.6" })],
			"swe-2-medium",
		);

		const picked = pickDefaultAvailableModel(devin);

		expect(picked).toMatchObject({
			provider: "devin",
			id: "swe-2",
			requestModelId: "swe-2-medium",
			thinking: { defaultLevel: "medium" },
		});
	});

	test("starts a statically collapsed Devin family on the account default's lane", async () => {
		// No server family metadata: `taxonomy/_collapse.kdl` collapses these lanes into `claude-opus-5`.
		const devin = await discoverDevin(
			["claude-opus-5-low", "claude-opus-5-medium", "claude-opus-5-high"].map(uid => devinConfig(uid)),
			"claude-opus-5-medium",
		);

		const picked = pickDefaultAvailableModel(devin);

		expect(picked).toMatchObject({
			provider: "devin",
			id: "claude-opus-5",
			requestModelId: "claude-opus-5-medium",
			thinking: { defaultLevel: "medium" },
		});
	});

	test("starts a Devin family whose account default is its no-thinking lane on the family's own default", async () => {
		// No effort routes to the `off` lane, so the family keeps a consistent default wire id and effort.
		const devin = await discoverDevin(
			[
				devinConfig("gpt-5-5-none", { family: "GPT-5.5", effort: "None" }),
				devinConfig("gpt-5-5-high", { family: "GPT-5.5", effort: "High", familyDefault: true }),
			],
			"gpt-5-5-none",
		);

		const picked = pickDefaultAvailableModel(devin);

		expect(picked).toMatchObject({
			provider: "devin",
			id: "gpt-5-5",
			requestModelId: "gpt-5-5-high",
			thinking: { defaultLevel: "high", effortRouting: { off: "gpt-5-5-none", high: "gpt-5-5-high" } },
		});
	});

	test("gives a Free Devin account its account default, SWE-1.6 Slow, as Devin's default", async () => {
		// Free serves only SWE-1.6 Slow, so the bundled `swe-1-6` is never listed. Without the account
		// default Devin had no default of its own and lost to the next provider's.
		const devin = await discoverDevin(
			[
				...swe2Lanes(true),
				devinConfig("swe-1-6-slow", { family: "SWE-1.6 Slow" }),
				devinConfig("swe-1-6", { disabled: true, family: "SWE-1.6" }),
				devinConfig("swe-1-6-fast", { disabled: true, family: "SWE-1.6 Fast" }),
			],
			"swe-1-6-slow",
		);
		const openaiDefault = getBundledModel("openai", DEFAULT_MODEL_PER_PROVIDER.openai);

		const picked = pickDefaultAvailableModel([...devin, openaiDefault]);

		expect(picked).toMatchObject({ provider: "devin", id: "swe-1-6-slow" });
	});

	test("keeps Cursor on its bundled default when the account default is the Auto router", async () => {
		const ids = ["default", DEFAULT_MODEL_PER_PROVIDER.cursor];
		const responses: Record<string, Uint8Array> = {
			"/agent.v1.AgentService/GetUsableModels": toBinary(
				GetUsableModelsResponseSchema,
				create(GetUsableModelsResponseSchema, {
					models: ids.map(modelId => create(ModelDetailsSchema, { modelId })),
				}),
			),
			"/aiserver.v1.AiService/AvailableModels": toBinary(
				AvailableModelsResponseSchema,
				create(AvailableModelsResponseSchema, {
					models: ids.map(name =>
						create(AvailableModelsResponse_ModelDetailsSchema, { name, supportsAgent: true }),
					),
				}),
			),
			"/agent.v1.AgentService/GetDefaultModelForCli": toBinary(
				GetDefaultModelForCliResponseSchema,
				create(GetDefaultModelForCliResponseSchema, { model: create(ModelDetailsSchema, { modelId: "default" }) }),
			),
		};
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				const body = responses[new URL(request.url).pathname];
				return body ? new Response(body) : new Response(null, { status: 404 });
			},
		});
		try {
			const specs = await fetchCursorUsableModels({
				apiKey: "account-token",
				baseUrl: server.url.toString(),
				timeoutMs: 1_000,
			});
			const cursor = (specs ?? []).map(spec => buildModel(spec));
			expect(cursor.map(model => model.id).sort()).toEqual([...ids].sort());

			const picked = pickDefaultAvailableModel(cursor);

			expect(picked).toMatchObject({ provider: "cursor", id: DEFAULT_MODEL_PER_PROVIDER.cursor });
		} finally {
			server.stop(true);
		}
	});
});
