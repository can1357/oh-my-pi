import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveVariantSelector } from "@oh-my-pi/pi-catalog/compat/collapse";
import { fetchAntigravityDiscoveryModels } from "@oh-my-pi/pi-catalog/discovery/antigravity";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { googleAntigravityModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/google";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface CapturedRequestBody {
	model?: string;
	request?: {
		labels?: Record<string, string>;
		generationConfig?: {
			maxOutputTokens?: number;
			thinkingConfig?: {
				includeThoughts?: boolean;
				thinkingLevel?: string;
				thinkingBudget?: number;
			};
		};
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function collapsedFlashModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.5-flash",
		requestModelId: "gemini-3.5-flash-extra-low",
		name: "Gemini 3.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: {
				[Effort.Minimal]: 1000,
				[Effort.Low]: 1000,
				[Effort.Medium]: 4000,
				[Effort.High]: 10000,
			},
			effortRouting: {
				off: "gemini-3.5-flash-extra-low",
				[Effort.Minimal]: "gemini-3.5-flash-extra-low",
				[Effort.Low]: "gemini-3.5-flash-extra-low",
				[Effort.Medium]: "gemini-3.5-flash-low",
				[Effort.High]: "gemini-3-flash-agent",
			},
			suppressWhenOff: true,
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	} satisfies ModelSpec<"google-gemini-cli">);
}

function collapsedClaudeModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "claude-sonnet-4-6",
		requestModelId: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "claude-sonnet-4-6",
				[Effort.Minimal]: "claude-sonnet-4-6-thinking",
				[Effort.Low]: "claude-sonnet-4-6-thinking",
				[Effort.Medium]: "claude-sonnet-4-6-thinking",
				[Effort.High]: "claude-sonnet-4-6-thinking",
			},
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"google-gemini-cli">);
}

function unroutedModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	} satisfies ModelSpec<"google-gemini-cli">);
}

async function captureRequest(
	model: Model<"google-gemini-cli">,
	reasoning: Effort | undefined,
	options: { forceReasoningOff?: boolean; email?: string } = {},
): Promise<{ body: CapturedRequestBody; attributedModel: string }> {
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (_input, init) => {
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
	};
	const stream = streamSimple(model, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: options.email }),
		reasoning,
		forceReasoningOff: options.forceReasoningOff,
		fetch: fetchMock,
	});
	const result = await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return { body: JSON.parse(requestBody) as CapturedRequestBody, attributedModel: result.model };
}

describe("google-gemini-cli effort-tier variant routing", () => {
	it("discovers one Claude 5.5 model per family and sends each served tier its advertised level, label and cap", async () => {
		const tiers = [Effort.Low, Effort.Medium, Effort.High] as const;
		const families = ["claude-opus-5-5", "claude-sonnet-5-5"];
		const result = await fetchAntigravityDiscoveryModels({
			token: "token",
			userAgent: "test",
			fetcher: async () =>
				Response.json({
					models: Object.fromEntries(
						families.flatMap(id =>
							tiers.map((tier, index) => [
								`${id}-${tier}`,
								{
									supportsThinking: true,
									supportsImages: true,
									maxTokens: 1_000_000,
									maxOutputTokens: 128_000,
									model: `MODEL_TEST_${id}-${tier}`,
									thinkingLevel: index + 1,
								},
							]),
						),
					),
				}),
		});
		expect(result?.models.map(spec => spec.id)).toEqual(families);
		if (!result || result.rejectedStatus !== undefined) throw new Error("discovery failed");
		const specs = result.models;

		for (const id of families) {
			const spec = specs.find(spec => spec.id === id);
			if (!spec) throw new Error(`missing logical model ${id}`);
			const model = buildModel(spec);
			for (const tier of tiers) {
				expect(resolveVariantSelector("google-antigravity", `${id}-${tier}`)).toBe(id);
				const request = await captureRequest(model, tier);
				expect(request.body.model).toBe(`${id}-${tier}`);
				expect(request.attributedModel).toBe(id);
				expect(request.body.request?.generationConfig).toEqual({
					maxOutputTokens: 128_000,
					thinkingConfig: { includeThoughts: true, thinkingLevel: tier.toUpperCase() },
				});
				expect(request.body.request?.labels?.model_enum).toBe(`MODEL_TEST_${id}-${tier}`);
			}

			// These SKUs always think: off and external scratchpads (an effort is
			// selected but reasoning is forced off) must keep a valid backing tier
			// rather than sending the unserved logical id.
			for (const [reasoning, options] of [
				[undefined, {}],
				[Effort.High, { forceReasoningOff: true }],
			] as const) {
				const request = await captureRequest(model, reasoning, options);
				expect(request.body.model).toBe(`${id}-low`);
				expect(request.body.request?.generationConfig?.thinkingConfig).toEqual({
					includeThoughts: true,
					thinkingLevel: "LOW",
				});
			}
		}
	});

	it("sends each account the request constants its own roster advertised when accounts share a model", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-account-profiles-"));
		const rosters: Record<string, { model: string; maxOutputTokens: number }> = {
			"Bearer token-a": { model: "MODEL_ACCOUNT_A", maxOutputTokens: 64_000 },
			"Bearer token-b": { model: "MODEL_ACCOUNT_B", maxOutputTokens: 128_000 },
		};
		const fetcher = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				if (!String(input).includes(":fetchAvailableModels"))
					return Promise.resolve(new Response("version: 2.26.0\n"));
				const roster = rosters[new Headers(init?.headers).get("Authorization") ?? ""];
				return Promise.resolve(
					Response.json({
						models: Object.fromEntries(
							(["low", "medium", "high"] as const).map((tier, index) => [
								`claude-sonnet-5-5-${tier}`,
								{
									supportsThinking: true,
									maxTokens: 1_000_000,
									maxOutputTokens: roster?.maxOutputTokens,
									model: `${roster?.model}_${tier}`,
									thinkingLevel: index + 1,
								},
							]),
						),
					}),
				);
			},
			{ preconnect: fetch.preconnect },
		);
		try {
			const options = googleAntigravityModelManagerOptions({
				resolveAccounts: async () => [
					{ accessToken: "token-a", accountKey: "a@example.com" },
					{ accessToken: "token-b", accountKey: "b@example.com" },
				],
				endpoint: "https://cca.test",
				fetch: fetcher,
			});
			const result = await resolveProviderModels({ ...options, cacheDbPath: path.join(dir, "models.db") }, "online");
			const model = result.models.find(model => model.id === "claude-sonnet-5-5");
			if (!model) throw new Error("missing claude-sonnet-5-5");

			for (const [email, expected] of [
				["a@example.com", rosters["Bearer token-a"]],
				["b@example.com", rosters["Bearer token-b"]],
			] as const) {
				const request = await captureRequest(model, Effort.Medium, { email });
				expect(request.body.model).toBe("claude-sonnet-5-5-medium");
				expect(request.body.request?.labels?.model_enum).toBe(`${expected?.model}_medium`);
				expect(request.body.request?.generationConfig?.maxOutputTokens).toBe(expected?.maxOutputTokens);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("discovers one Gemini 4 Argon model and sends each thinking level to its served SKU", async () => {
		const tiers = [Effort.Low, Effort.Medium, Effort.High] as const;
		const result = await fetchAntigravityDiscoveryModels({
			token: "token",
			userAgent: "test",
			fetcher: async () =>
				Response.json({
					models: Object.fromEntries(
						tiers.map((tier, index) => [
							`gemini-4-argon-${tier}`,
							{
								supportsThinking: true,
								supportsImages: true,
								maxTokens: 1_048_576,
								maxOutputTokens: 65_536,
								// Argon advertises both; the level wins like in the native client.
								thinkingBudget: -1,
								thinkingLevel: index + 1,
							},
						]),
					),
				}),
		});
		if (!result || result.rejectedStatus !== undefined) throw new Error("discovery failed");
		expect(result.models.map(spec => spec.id)).toEqual(["gemini-4-argon"]);
		const model = buildModel(result.models[0]);

		for (const tier of tiers) {
			expect(resolveVariantSelector("google-antigravity", `gemini-4-argon-${tier}`)).toBe("gemini-4-argon");
			const request = await captureRequest(model, tier);
			expect(request.body.model).toBe(`gemini-4-argon-${tier}`);
			expect(request.attributedModel).toBe("gemini-4-argon");
			expect(request.body.request?.generationConfig?.thinkingConfig).toEqual({
				includeThoughts: true,
				thinkingLevel: tier.toUpperCase(),
			});
		}

		// Argon always thinks: off and external scratchpads keep the low SKU
		// instead of sending the unserved logical id.
		for (const [reasoning, options] of [
			[undefined, {}],
			[Effort.High, { forceReasoningOff: true }],
		] as const) {
			const request = await captureRequest(model, reasoning, options);
			expect(request.body.model).toBe("gemini-4-argon-low");
			expect(request.body.request?.generationConfig?.thinkingConfig).toEqual({
				includeThoughts: true,
				thinkingLevel: "LOW",
			});
		}
	});

	it("sends each Gemini 3.8 Flash tier the thinking budget its SKU advertises", async () => {
		const budgets = { [Effort.Low]: 1000, [Effort.Medium]: 4000, [Effort.High]: -1 } as const;
		const result = await fetchAntigravityDiscoveryModels({
			token: "token",
			userAgent: "test",
			fetcher: async () =>
				Response.json({
					models: Object.fromEntries(
						Object.entries(budgets).map(([tier, thinkingBudget]) => [
							`gemini-3.8-flash-${tier}`,
							{
								supportsThinking: true,
								supportsImages: true,
								maxTokens: 1_048_576,
								maxOutputTokens: 65_536,
								model: `MODEL_TEST_FLASH_${tier}`,
								thinkingBudget,
							},
						]),
					),
				}),
		});
		if (!result || result.rejectedStatus !== undefined) throw new Error("discovery failed");
		expect(result.models.map(spec => spec.id)).toEqual(["gemini-3.8-flash"]);
		const model = buildModel(result.models[0]);

		for (const [tier, thinkingBudget] of Object.entries(budgets) as [Effort, number][]) {
			const request = await captureRequest(model, tier);
			expect(request.body.model).toBe(`gemini-3.8-flash-${tier}`);
			expect(request.body.request?.generationConfig).toEqual({
				maxOutputTokens: 65_536,
				thinkingConfig: { includeThoughts: true, thinkingBudget },
			});
			expect(request.body.request?.labels?.model_enum).toBe(`MODEL_TEST_FLASH_${tier}`);
		}
	});

	it("sends a lone discovered Gemini 3.8 Flash tier the thinking budget its SKU advertises", async () => {
		const result = await fetchAntigravityDiscoveryModels({
			token: "token",
			userAgent: "test",
			fetcher: async () =>
				Response.json({
					models: {
						"gemini-3.8-flash-low": {
							supportsThinking: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_536,
							model: "MODEL_TEST_FLASH_low",
							thinkingBudget: 1000,
						},
					},
				}),
		});
		if (!result || result.rejectedStatus !== undefined) throw new Error("discovery failed");
		expect(result.models.map(spec => spec.id)).toEqual(["gemini-3.8-flash"]);
		const request = await captureRequest(buildModel(result.models[0]), Effort.Low);
		expect(request.body.model).toBe("gemini-3.8-flash-low");
		expect(request.body.request?.generationConfig).toEqual({
			maxOutputTokens: 65_536,
			thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 },
		});
	});

	it("caps a discovered Claude 4.6 output limit at the 64000 the backend accepts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-claude46-cap-"));
		const fetcher = Object.assign(
			(input: string | URL | Request) =>
				Promise.resolve(
					String(input).includes(":fetchAvailableModels")
						? Response.json({
								models: {
									"claude-sonnet-4-6": {
										supportsThinking: true,
										maxTokens: 1_000_000,
										maxOutputTokens: 65_536,
										model: "MODEL_TEST_SONNET_46",
									},
								},
							})
						: new Response("version: 2.26.0\n"),
				),
			{ preconnect: fetch.preconnect },
		);
		try {
			const options = googleAntigravityModelManagerOptions({
				resolveAccounts: async () => [{ accessToken: "token", accountKey: "a@example.com" }],
				endpoint: "https://cca.test",
				fetch: fetcher,
			});
			const result = await resolveProviderModels({ ...options, cacheDbPath: path.join(dir, "models.db") }, "online");
			const model = result.models.find(model => model.id === "claude-sonnet-4-6");
			if (!model) throw new Error("missing claude-sonnet-4-6");
			// With the serving account's profile and with the row's own.
			for (const email of ["a@example.com", undefined]) {
				const request = await captureRequest(model, undefined, { email });
				expect(request.body.model).toBe("claude-sonnet-4-6");
				expect(request.body.request?.labels?.model_enum).toBe("MODEL_TEST_SONNET_46");
				expect(request.body.request?.generationConfig?.maxOutputTokens).toBe(64_000);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps per-effort budgets when every effort routes to one thinking SKU", async () => {
		const result = await fetchAntigravityDiscoveryModels({
			token: "token",
			userAgent: "test",
			fetcher: async () =>
				Response.json({
					models: Object.fromEntries(
						["gemini-2.5-flash", "gemini-2.5-flash-thinking"].map(id => [
							id,
							{
								supportsThinking: true,
								maxTokens: 1_048_576,
								maxOutputTokens: 65_535,
								model: `MODEL_TEST_${id}`,
								thinkingLevel: 1,
							},
						]),
					),
				}),
		});
		if (!result || result.rejectedStatus !== undefined) throw new Error("discovery failed");
		expect(result.models.map(spec => spec.id)).toEqual(["gemini-2.5-flash"]);
		const model = buildModel(result.models[0]);

		const low = await captureRequest(model, Effort.Low);
		const high = await captureRequest(model, Effort.High);
		for (const request of [low, high]) {
			expect(request.body.model).toBe("gemini-2.5-flash-thinking");
			expect(request.body.request?.labels?.model_enum).toBe("MODEL_TEST_gemini-2.5-flash-thinking");
			expect(request.body.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBeUndefined();
		}
		const lowBudget = low.body.request?.generationConfig?.thinkingConfig?.thinkingBudget;
		const highBudget = high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget;
		expect(lowBudget).toBeGreaterThan(0);
		expect(highBudget).toBeGreaterThan(lowBudget ?? 0);
	});

	it("routes each effort to its backing wire id with the per-tier budget and attributes usage to the logical id", async () => {
		const high = await captureRequest(collapsedFlashModel(), Effort.High);
		expect(high.body.model).toBe("gemini-3-flash-agent");
		expect(high.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 10000,
		});
		expect(high.body.request?.generationConfig?.maxOutputTokens).toBe(65536);
		expect(high.attributedModel).toBe("gemini-3.5-flash");

		const medium = await captureRequest(collapsedFlashModel(), Effort.Medium);
		expect(medium.body.model).toBe("gemini-3.5-flash-low");
		expect(medium.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(4000);

		const low = await captureRequest(collapsedFlashModel(), Effort.Low);
		expect(low.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(low.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1000);
	});

	it("suppresses thinking with a zero budget on the wire when off and suppressWhenOff is set", async () => {
		const off = await captureRequest(collapsedFlashModel(), undefined);
		expect(off.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(off.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingBudget: 0,
		});
	});

	it("routes to the explicit off wire shape when an external scratchpad replaces reasoning", async () => {
		const off = await captureRequest(collapsedFlashModel(), Effort.High, { forceReasoningOff: true });
		expect(off.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(off.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingBudget: 0,
		});
	});

	it("routes claude pairs to the bare id when off without wire suppression", async () => {
		const off = await captureRequest(collapsedClaudeModel(), undefined);
		expect(off.body.model).toBe("claude-sonnet-4-6");
		// Omitting thinkingConfig is correct on the non-thinking backing id.
		expect(off.body.request?.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("routes claude pairs to the -thinking id with a budget when reasoning", async () => {
		const high = await captureRequest(collapsedClaudeModel(), Effort.High);
		expect(high.body.model).toBe("claude-sonnet-4-6-thinking");
		expect(high.body.request?.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
		expect(high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
	});

	it("keeps the status quo for un-routed models", async () => {
		const off = await captureRequest(unroutedModel(), undefined);
		expect(off.body.model).toBe("gemini-2.5-flash");
		expect(off.body.request?.generationConfig?.thinkingConfig).toBeUndefined();

		const high = await captureRequest(unroutedModel(), Effort.High);
		expect(high.body.model).toBe("gemini-2.5-flash");
		expect(high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
	});
});
