import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type GoogleOptions, streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import {
	type CloudCodeAssistRequest,
	type GoogleGeminiCliOptions,
	streamGoogleGeminiCli,
} from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { GenerateContentParameters } from "@oh-my-pi/pi-ai/providers/google-shared";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const common = {
	id: "gemini-3.1-pro-preview",
	name: "Gemini 3.1 Pro",
	// Preserve each provider's default endpoint selection.
	baseUrl: "",
	reasoning: true,
	input: ["text"] as "text"[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};
const google = buildModel({ ...common, api: "google-generative-ai", provider: "google" });
const vertex = buildModel({ ...common, api: "google-vertex", provider: "google-vertex" });
const cli = buildModel({
	...common,
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://cloudcode-pa.googleapis.com",
});
const antigravity = buildModel({
	...common,
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
});
const credentials = JSON.stringify({ token: "token", projectId: "project" });
const high = { enabled: true, level: "HIGH" } as const;
const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
beforeEach(() => {
	process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
});
afterEach(() => {
	if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
});

function sse(text = "admitted response", cca = false): Response {
	const chunk = { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
	return new Response(`data: ${JSON.stringify(cca ? { response: chunk } : chunk)}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

const directRoutes = [
	{ name: "Gemini", open: (options: GoogleOptions) => streamGoogle(google, context, options) },
	{
		name: "Vertex",
		open: (options: GoogleOptions) => streamGoogleVertex(vertex, context, { location: "global", ...options }),
	},
];

describe("governed Google REST wire controls", () => {
	for (const route of directRoutes) {
		it(`${route.name} admits unchanged encoded effort and harmless hook edits with a real signal`, async () => {
			let captured: { url: string; body: Record<string, any> } | undefined;
			const order: string[] = [];
			const fetchImpl: FetchImpl = async (input, init) => {
				order.push("send");
				captured = { url: input.toString(), body: JSON.parse(init?.body as string) };
				return sse();
			};
			const result = await route
				.open({
					apiKey: "key",
					signal: new AbortController().signal,
					fetch: fetchImpl,
					thinking: high,
					preserveModelSelection: true,
					preserveThinkingEffort: true,
					onBeforeRequest: async () => {
						order.push("admit");
					},
					onPayload: async payload => {
						const params = payload as { config: { temperature?: number } };
						params.config.temperature = 0.25;
						return payload;
					},
				})
				.result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "admitted response" })]);
			expect(captured?.url).toContain(`/models/${common.id}:streamGenerateContent`);
			expect(captured?.body.generationConfig).toMatchObject({
				temperature: 0.25,
				thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
			});
			expect(order).toEqual(["admit", "send"]);
		});

		it(`${route.name} rejects a hook weakening the final nested thinking control before any send`, async () => {
			let sends = 0;
			const result = await route
				.open({
					apiKey: "key",
					thinking: high,
					preserveThinkingEffort: true,
					fetch: async () => {
						sends++;
						return sse();
					},
					onPayload: payload => {
						// This in-process hook receives the provider's generated parameter shape.
						const params = payload as GenerateContentParameters;
						if (!params.config?.thinkingConfig) throw new Error("expected generated Google thinking config");
						params.config.thinkingConfig.thinkingLevel = "LOW";
					},
				})
				.result();
			expect(sends).toBe(0);
			expect(result.stopReason).toBe("error");
			expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
		});

		it(`${route.name} never invokes a governed thinking getter during REST transformation`, async () => {
			let getters = 0;
			let sends = 0;
			const result = await route
				.open({
					apiKey: "key",
					thinking: high,
					preserveThinkingEffort: true,
					fetch: async () => {
						sends++;
						return sse();
					},
					onPayload: payload => {
						// This in-process hook receives the provider's generated parameter shape.
						const params = payload as GenerateContentParameters;
						const config = params.config?.thinkingConfig;
						if (!config) throw new Error("expected generated Google thinking config");
						Object.defineProperty(config, "thinkingLevel", {
							enumerable: true,
							get() {
								getters++;
								return getters === 1 ? "HIGH" : "LOW";
							},
						});
					},
				})
				.result();
			expect(getters).toBe(0);
			expect(sends).toBe(0);
			expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
		});
	}

	it("streamSimple retains fixed high and explicit off in the actual Gemini body", async () => {
		const requests: Record<string, any>[] = [];
		const suppressible = buildModel({
			...common,
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-generative-ai",
			provider: "google",
		});
		for (const reasoning of [Effort.High, undefined]) {
			const result = await streamSimple(suppressible, context, {
				apiKey: "key",
				reasoning,
				disableReasoning: reasoning === undefined,
				thinkingBudgets: { high: 4096 },
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				fetch: async (_input, init) => {
					requests.push(JSON.parse(init?.body as string));
					return sse();
				},
			}).result();
			expect(result.stopReason).toBe("stop");
		}
		expect(requests[0]?.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 4096 });
		expect(requests[1]?.generationConfig.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 0 });
	});

	it("re-admits an empty Gemini response retry without rerunning the payload hook", async () => {
		let sends = 0;
		let hooks = 0;
		let admissions = 0;
		const result = await streamGoogle(google, context, {
			apiKey: "key",
			thinking: high,
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			onPayload: () => {
				hooks++;
			},
			onBeforeRequest: () => {
				if (++admissions > 1) throw new AIError.ModelSelectionError("grant revoked during empty response retry");
			},
			fetch: async () => {
				sends++;
				return sse("");
			},
		}).result();
		expect(sends).toBe(1);
		expect(hooks).toBe(1);
		expect(admissions).toBe(2);
		expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
	});

	it("re-admits regional Vertex failover and sends no global request after revocation", async () => {
		const savedLocation = process.env.GOOGLE_VERTEX_LOCATION;
		process.env.GOOGLE_VERTEX_LOCATION = "europe-west4";
		try {
			const urls: string[] = [];
			let admissions = 0;
			let hooks = 0;
			const result = await streamGoogleVertex(vertex, context, {
				apiKey: "key",
				preserveModelSelection: true,
				onPayload: () => {
					hooks++;
				},
				onBeforeRequest: () => {
					if (++admissions > 1) throw new AIError.ModelSelectionError("grant revoked before global failover");
				},
				fetch: async input => {
					urls.push(input.toString());
					return new Response("missing", { status: 404 });
				},
			}).result();
			expect(urls).toHaveLength(1);
			expect(urls[0]).toContain("europe-west4-aiplatform.googleapis.com");
			expect(admissions).toBe(2);
			expect(hooks).toBe(1);
			expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
		} finally {
			if (savedLocation === undefined) delete process.env.GOOGLE_VERTEX_LOCATION;
			else process.env.GOOGLE_VERTEX_LOCATION = savedLocation;
		}
	});
});

describe("governed CLI and Antigravity envelopes", () => {
	for (const model of [cli, antigravity]) {
		it(`${model.provider} protects request.generationConfig.thinkingConfig in the actual envelope`, async () => {
			let sends = 0;
			const result = await streamGoogleGeminiCli(model, context, {
				apiKey: credentials,
				thinking: high,
				preserveThinkingEffort: true,
				fetch: async () => {
					sends++;
					return sse("admitted response", true);
				},
				onPayload: payload => {
					// This in-process hook receives the provider's generated CCA envelope.
					const request = payload as CloudCodeAssistRequest;
					if (!request.request.generationConfig?.thinkingConfig)
						throw new Error("expected generated CCA thinking config");
					request.request.generationConfig.thinkingConfig.thinkingLevel = "LOW";
				},
			}).result();
			expect(sends).toBe(0);
			expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
		});

		it(`${model.provider} rejects root toJSON without executing it`, async () => {
			let serializers = 0;
			let sends = 0;
			const result = await streamGoogleGeminiCli(model, context, {
				apiKey: credentials,
				preserveModelSelection: true,
				fetch: async () => {
					sends++;
					return sse("admitted response", true);
				},
				onPayload: payload => ({
					...(payload as object),
					toJSON() {
						serializers++;
						return { model: "other-model" };
					},
				}),
			}).result();
			expect(serializers).toBe(0);
			expect(sends).toBe(0);
			expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
		});

		it(`${model.provider} does not assimilate synchronous Proxy or then-getter hook results`, async () => {
			let reads = 0;
			let sends = 0;
			const hooks: NonNullable<GoogleGeminiCliOptions["onPayload"]>[] = [
				payload => {
					if (!payload || typeof payload !== "object") throw new Error("expected generated CCA envelope");
					return new Proxy(payload, {
						get(target, key, receiver) {
							reads++;
							return Reflect.get(target, key, receiver);
						},
					});
				},
				payload => {
					if (!payload || typeof payload !== "object") throw new Error("expected generated CCA envelope");
					// oxlint-disable-next-line unicorn/no-thenable -- Adversarial hook; this getter must never be read.
					Object.defineProperty(payload, "then", {
						get() {
							reads++;
							return undefined;
						},
					});
					return payload;
				},
			];
			for (const onPayload of hooks) {
				const result = await streamGoogleGeminiCli(model, context, {
					apiKey: credentials,
					thinking: high,
					preserveModelSelection: true,
					preserveThinkingEffort: true,
					onPayload,
					fetch: async () => {
						sends++;
						return sse("admitted response", true);
					},
				}).result();
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			}
			expect(reads).toBe(0);
			expect(sends).toBe(0);
		});
	}

	it("uses the admitted derived CLI wire id and fixed effort on a successful request", async () => {
		const routed = buildModel({ ...cli, requestModelId: "gemini-3.1-pro-preview-high" });
		let body: Record<string, any> | undefined;
		const result = await streamGoogleGeminiCli(routed, context, {
			apiKey: credentials,
			thinking: high,
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			onPayload: async payload => {
				const request = payload as CloudCodeAssistRequest;
				if (!request.request.generationConfig) throw new Error("expected generated CCA configuration");
				request.request.generationConfig.temperature = 0.25;
				return request;
			},
			fetch: async (_input, init) => {
				body = JSON.parse(init?.body as string);
				return sse("admitted response", true);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.model).toBe("gemini-3.1-pro-preview-high");
		expect(body?.request.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
		expect(body?.request.generationConfig.temperature).toBe(0.25);
	});

	it("checks admission outside CLI HTTP retry catches", async () => {
		let sends = 0;
		let hooks = 0;
		let admissions = 0;
		const result = await streamGoogleGeminiCli(cli, context, {
			apiKey: credentials,
			preserveModelSelection: true,
			onPayload: () => {
				hooks++;
			},
			onBeforeRequest: () => {
				if (++admissions > 1)
					throw new AIError.ModelSelectionError("grant revoked", {
						cause: new AIError.GoogleApiError("transient cause", 503),
					});
			},
			fetch: async () => {
				sends++;
				return new Response("retry", { status: 503, headers: { "retry-after": "0" } });
			},
		}).result();
		expect(sends).toBe(1);
		expect(hooks).toBe(1);
		expect(admissions).toBe(2);
		expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
	});

	it("does not infer on the alternate Antigravity endpoint after revocation", async () => {
		let sends = 0;
		let hooks = 0;
		let admissions = 0;
		const result = await streamGoogleGeminiCli(antigravity, context, {
			apiKey: credentials,
			preserveModelSelection: true,
			onPayload: () => {
				hooks++;
			},
			onBeforeRequest: () => {
				if (++admissions > 1) throw new AIError.ModelSelectionError("grant revoked before endpoint failover");
			},
			fetch: async () => {
				sends++;
				return new Response("retry", { status: 503 });
			},
		}).result();
		expect(sends).toBe(1);
		expect(admissions).toBe(2);
		expect(hooks).toBe(1);
		expect((result.errorId ?? 0) & AIError.Flag.HostAdmission).toBe(AIError.Flag.HostAdmission);
	});

	it("keeps ordinary CLI hook model and effort replacements", async () => {
		let body: Record<string, any> | undefined;
		const result = await streamGoogleGeminiCli(cli, context, {
			apiKey: credentials,
			thinking: high,
			onPayload: payload => {
				const request = payload as {
					model: string;
					request: { generationConfig: { thinkingConfig: { thinkingLevel: string } } };
				};
				request.model = "hook-selected-model";
				request.request.generationConfig.thinkingConfig.thinkingLevel = "LOW";
			},
			fetch: async (_input, init) => {
				body = JSON.parse(init?.body as string);
				return sse("ordinary response", true);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.model).toBe("hook-selected-model");
		expect(body?.request.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
	});
});

describe("fixed Google effort dialect eligibility", () => {
	for (const route of directRoutes) {
		it(`${route.name} rejects MINIMAL and omission as fixed off before inference`, async () => {
			for (const thinking of [{ enabled: false, level: "MINIMAL" } as const, { enabled: false }]) {
				let sends = 0;
				const result = await route
					.open({
						apiKey: "key",
						thinking,
						preserveThinkingEffort: true,
						fetch: async () => {
							sends++;
							return sse();
						},
					})
					.result();
				expect(sends).toBe(0);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			}
		});

		it(`${route.name} rejects a Proxy hook without evaluating its traps`, async () => {
			let traps = 0;
			let sends = 0;
			const result = await route
				.open({
					apiKey: "key",
					thinking: high,
					preserveThinkingEffort: true,
					fetch: async () => {
						sends++;
						return sse();
					},
					onPayload: payload => {
						if (!payload || typeof payload !== "object") throw new Error("expected generated Google parameters");
						return new Proxy(payload, {
							ownKeys(target) {
								traps++;
								return Reflect.ownKeys(target);
							},
							get(target, key, receiver) {
								traps++;
								return Reflect.get(target, key, receiver);
							},
						});
					},
				})
				.result();
			expect(traps).toBe(0);
			expect(sends).toBe(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		});

		it(`${route.name} rejects a synchronous then getter without reading it`, async () => {
			let reads = 0;
			let sends = 0;
			const result = await route
				.open({
					apiKey: "key",
					thinking: high,
					preserveThinkingEffort: true,
					onPayload: payload => {
						if (!payload || typeof payload !== "object") throw new Error("expected generated Google parameters");
						// oxlint-disable-next-line unicorn/no-thenable -- Adversarial hook; this getter must never be read.
						Object.defineProperty(payload, "then", {
							get() {
								reads++;
								return undefined;
							},
						});
						return payload;
					},
					fetch: async () => {
						sends++;
						return sse();
					},
				})
				.result();
			expect(reads).toBe(0);
			expect(sends).toBe(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		});
	}

	it("accepts a CLI native zero budget as fixed off", async () => {
		const budgetModel = buildModel({
			...common,
			id: "gemini-2.5-flash",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
		});
		let body: CloudCodeAssistRequest | undefined;
		const result = await streamGoogleGeminiCli(budgetModel, context, {
			apiKey: credentials,
			thinking: { enabled: false, suppress: { budget: 0 } },
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			fetch: async (_input, init) => {
				body = JSON.parse(init?.body as string);
				return sse("off response", true);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 0 });
	});

	it("accepts an authoritative Antigravity off SKU without requiring unsupported off controls", async () => {
		const offModel = buildModel({
			...common,
			id: "claude-sonnet-4-5",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			thinking: {
				mode: "budget",
				efforts: [Effort.High],
				effortRouting: { off: "claude-sonnet-4-5", high: "claude-sonnet-4-5-thinking" },
			},
		});
		let body: CloudCodeAssistRequest | undefined;
		const result = await streamGoogleGeminiCli(offModel, context, {
			apiKey: credentials,
			thinking: { enabled: false },
			preserveThinkingEffort: true,
			fetch: async (_input, init) => {
				body = JSON.parse(init?.body as string);
				return sse("off SKU response", true);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.model).toBe("claude-sonnet-4-5");
		expect(body?.request.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("rejects fixed CLI off represented only by MINIMAL", async () => {
		let sends = 0;
		const result = await streamGoogleGeminiCli(cli, context, {
			apiKey: credentials,
			thinking: { enabled: false, suppress: { level: "MINIMAL" } },
			preserveThinkingEffort: true,
			fetch: async () => {
				sends++;
				return sse("must not infer", true);
			},
		}).result();
		expect(sends).toBe(0);
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
	});

	it("protects every recognized CLI thinking placement from added overrides", async () => {
		const overrides: Array<(request: CloudCodeAssistRequest) => void> = [
			request => {
				request.request.thinkingConfig = { thinkingBudget: 0 };
			},
			request => {
				request.request.thinking_config = { thinkingBudget: 0 };
			},
			request => {
				if (!request.request.generationConfig) throw new Error("expected generated config");
				request.request.generationConfig.thinking_config = { thinkingBudget: 0 };
			},
			request => {
				request.request.generation_config = { thinking_config: { thinkingBudget: 0 } };
			},
		];
		for (const override of overrides) {
			let sends = 0;
			const result = await streamGoogleGeminiCli(cli, context, {
				apiKey: credentials,
				thinking: high,
				preserveThinkingEffort: true,
				fetch: async () => {
					sends++;
					return sse("must not infer", true);
				},
				onPayload: payload => {
					// The hook receives the in-process CCA request built by this provider.
					const request = payload as CloudCodeAssistRequest;
					override(request);
				},
			}).result();
			expect(sends).toBe(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		}
	});

	it("keeps model-only governance distinct from fixed-effort governance", async () => {
		let body: CloudCodeAssistRequest | undefined;
		const result = await streamGoogleGeminiCli(cli, context, {
			apiKey: credentials,
			thinking: high,
			preserveModelSelection: true,
			onPayload: payload => {
				// The hook receives the in-process CCA request built by this provider.
				const request = payload as CloudCodeAssistRequest;
				if (!request.request.generationConfig?.thinkingConfig) throw new Error("expected generated config");
				request.request.generationConfig.thinkingConfig.thinkingLevel = "LOW";
			},
			fetch: async (_input, init) => {
				body = JSON.parse(init?.body as string);
				return sse("model-only response", true);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.model).toBe(common.id);
		expect(body?.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("LOW");
	});

	it("cannot erase the original CLI admission callback through a harmless payload hook", async () => {
		let admissions = 0;
		let sends = 0;
		const options: GoogleGeminiCliOptions = {
			apiKey: credentials,
			preserveModelSelection: true,
			onBeforeRequest: () => {
				if (++admissions > 1) throw new Error("authority revoked during HTTP backoff");
			},
			fetch: async () => {
				sends++;
				return new Response("retry", { status: 503, headers: { "retry-after": "0" } });
			},
			onPayload: () => {
				options.onBeforeRequest = () => {};
				options.preserveModelSelection = false;
			},
		};
		const result = await streamGoogleGeminiCli(cli, context, options).result();
		expect(sends).toBe(1);
		expect(admissions).toBe(2);
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
	});
});

describe("Google guarded source and transport failures", () => {
	for (const route of directRoutes) {
		it(`${route.name} retains the original flags when the hook replaces a control with a getter`, async () => {
			let reads = 0;
			let sends = 0;
			const options: GoogleOptions = {
				apiKey: "key",
				thinking: high,
				preserveThinkingEffort: true,
				fetch: async () => {
					sends++;
					return sse();
				},
				onPayload: payload => {
					options.preserveThinkingEffort = false;
					// The hook receives the in-process generated Google parameters.
					const params = payload as GenerateContentParameters;
					if (!params.config?.thinkingConfig) throw new Error("expected generated thinking config");
					Object.defineProperty(params.config.thinkingConfig, "thinkingLevel", {
						enumerable: true,
						get() {
							reads++;
							return "LOW";
						},
					});
				},
			};
			const result = await route.open(options).result();
			expect(reads).toBe(0);
			expect(sends).toBe(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		});

		it(`${route.name} rejects fixed positive effort represented by zero or dynamic budget`, async () => {
			for (const budgetTokens of [0, -1]) {
				let sends = 0;
				const result = await route
					.open({
						apiKey: "key",
						thinking: { enabled: true, budgetTokens },
						preserveThinkingEffort: true,
						fetch: async () => {
							sends++;
							return sse();
						},
					})
					.result();
				expect(sends).toBe(0);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			}
		});
	}

	it("does not retry a local admission failure thrown inside the CLI fetch boundary", async () => {
		let sends = 0;
		const result = await streamGoogleGeminiCli(cli, context, {
			apiKey: credentials,
			preserveModelSelection: true,
			fetch: async () => {
				sends++;
				throw new AIError.ModelSelectionError("fetch middleware denied the attempt", {
					cause: new AIError.GoogleApiError("transient provider cause", 503),
				});
			},
		}).result();
		expect(sends).toBe(1);
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
	});

	it("does not call a disabled budget off on a mandatory or Google-level model", async () => {
		const mandatoryBudget = buildModel({
			...common,
			id: "gemini-2.5-pro",
			api: "google-generative-ai",
			provider: "google",
			thinking: { mode: "budget", efforts: [Effort.High], requiresEffort: true },
		});
		for (const model of [google, mandatoryBudget]) {
			let sends = 0;
			const result = await streamGoogle(model, context, {
				apiKey: "key",
				thinking: { enabled: false, budgetTokens: 0 },
				preserveThinkingEffort: true,
				fetch: async () => {
					sends++;
					return sse();
				},
			}).result();
			expect(sends).toBe(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		}
	});
});
