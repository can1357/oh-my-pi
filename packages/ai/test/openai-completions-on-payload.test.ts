// Regression: openai-completions ignored the onPayload replacement return
// value (fire-and-forget), so extensions hooking before_provider_request
// could never transform the body actually sent upstream. The replacement
// contract matches anthropic / openai-responses / google: await the hook,
// and use its non-undefined return as the request body.
import { describe, expect, it } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withEnv } from "./helpers";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(capture?: (body: unknown) => void): FetchImpl {
	async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
		capture?.(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
		const encoder = new TextEncoder();
		const chunk = (extra: Record<string, unknown>) =>
			`data: ${JSON.stringify({ id: "chatcmpl-payload", object: "chat.completion.chunk", created: 0, model: completionsModel.id, ...extra })}\n\n`;
		const sse =
			chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }) +
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
			"data: [DONE]\n\n";
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

type Body = Record<string, any>;

describe("openai-completions onPayload replacement", () => {
	it("sends an async onPayload replacement body", async () => {
		let captured: Body | undefined;
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: async payload => ({
				...(payload as Record<string, unknown>),
				messages: [{ role: "user", content: "replacement" }],
			}),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured?.messages).toEqual([{ role: "user", content: "replacement" }]);
		expect(JSON.stringify(captured)).not.toContain("Say hello");
	}, 10_000);

	it("sends a synchronous onPayload replacement body", async () => {
		let captured: Body | undefined;
		await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: payload => ({
				...(payload as Record<string, unknown>),
				messages: [{ role: "user", content: "sync-replacement" }],
			}),
		}).result();

		expect(captured?.messages).toEqual([{ role: "user", content: "sync-replacement" }]);
	}, 10_000);

	it("keeps the original body when onPayload returns undefined", async () => {
		let captured: Body | undefined;
		await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: async () => undefined,
		}).result();

		expect(JSON.stringify(captured?.messages)).toContain("Say hello");
	}, 10_000);
});

describe("openai-completions governed payload selection", () => {
	const model = buildModel({
		provider: "payload-selection-test",
		id: "bound-model",
		name: "Bound model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		input: ["text"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
	});

	for (const field of ["models", "fallbacks"] as const) {
		it(`rejects baseline extraBody ${field} alternatives rather than dropping them`, async () => {
			let requests = 0;
			const configured = {
				...model,
				compat: { ...model.compat, extraBody: { [field]: [model.id, "catalog-outsider"] } },
			};
			const result = await streamOpenAICompletions(configured, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch(() => requests++),
				reasoning: Effort.High,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(requests).toBe(0);
		});
	}

	for (const change of ["model", "reasoning_effort", "models", "fallbacks"] as const) {
		it(`rejects a late in-place ${change} rewrite before sending a governed request`, async () => {
			let requests = 0;
			const result = await streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch(() => requests++),
				reasoning: Effort.High,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				onPayload: payload => {
					Object.assign(payload as Record<string, unknown>, {
						[change]:
							change === "models" || change === "fallbacks"
								? [model.id, "catalog-outsider"]
								: change === "model"
									? "catalog-outsider"
									: Effort.Low,
					});
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(requests).toBe(0);
		});
	}

	it("rejects a replacement body that discards governed controls", async () => {
		let requests = 0;
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(() => requests++),
			reasoning: Effort.High,
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			onPayload: () => [],
		}).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toBe(0);
	});

	for (const unsafe of ["toJSON", "getter"] as const) {
		it(`rejects a governed ${unsafe} without executing it or sending HTTP`, async () => {
			let requests = 0;
			let executions = 0;
			const result = await streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch(() => requests++),
				reasoning: Effort.High,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				onPayload: payload => {
					const replacement = { ...(payload as Body) };
					if (unsafe === "toJSON") {
						replacement.toJSON = () => {
							executions++;
							return { ...(payload as Body), model: "unauthorized-wire-model", reasoning_effort: "low" };
						};
					} else {
						Object.defineProperty(replacement, "model", {
							enumerable: true,
							get: () => {
								executions++;
								return executions === 1 ? model.id : "unauthorized-wire-model";
							},
						});
					}
					return replacement;
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(requests).toBe(0);
			expect(executions).toBe(0);
		});
	}

	it("keeps ordinary toJSON behavior without replaying its serialized capture", async () => {
		let captured: Body | undefined;
		let executions = 0;
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: payload => ({
				...(payload as Body),
				toJSON() {
					executions++;
					return { ...(payload as Body), model: "ordinary-hook-model" };
				},
			}),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(captured?.model).toBe("ordinary-hook-model");
		expect(executions).toBe(1);
	});

	it("pins the derived requestModelId rather than the public catalog alias", async () => {
		let captured: Body | undefined;
		const result = await streamOpenAICompletions(
			{ ...model, requestModelId: "authorized-wire-model" },
			baseContext(),
			{
				apiKey: "test-key",
				reasoning: Effort.High,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				fetch: createSseFetch(body => (captured = body as Body)),
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(captured?.model).toBe("authorized-wire-model");
		expect(captured?.reasoning_effort).toBe("high");
	});

	it("does not mistake model-only protection for a fixed effort", async () => {
		let captured: Body | undefined;
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			reasoning: Effort.High,
			preserveModelSelection: true,
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: payload => Object.assign(payload as Body, { reasoning_effort: "low" }),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(captured?.model).toBe(model.id);
		expect(captured?.reasoning_effort).toBe("low");
	});

	it("rejects Qwen extraBody weakening of generated enable_thinking", async () => {
		let requests = 0;
		const qwen = {
			...model,
			compat: {
				...model.compat,
				thinkingFormat: "qwen" as const,
				qwenTemplateReasoningEffort: true,
				extraBody: { enable_thinking: false },
			},
		};
		const result = await streamOpenAICompletions(qwen, baseContext(), {
			apiKey: "test-key",
			reasoning: Effort.High,
			preserveThinkingEffort: true,
			fetch: createSseFetch(() => requests++),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		expect(requests).toBe(0);
	});

	it("retains Factory's generated opt-in dialect and rejects later weakening", async () => {
		for (const weaken of [false, true]) {
			let captured: Body | undefined;
			let requests = 0;
			const result = await streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				preserveThinkingEffort: true,
				reasoningBody: { chat_template_args: { enable_thinking: true } },
				fetch: createSseFetch(body => {
					requests++;
					captured = body as Body;
				}),
				onPayload: weaken
					? payload => {
							(payload as Body).chat_template_args.enable_thinking = false;
						}
					: undefined,
			}).result();
			expect(result.stopReason).toBe(weaken ? "error" : "stop");
			expect(requests).toBe(weaken ? 0 : 1);
			if (!weaken) expect(captured?.chat_template_args).toEqual({ enable_thinking: true });
		}
	});

	for (const revoke of [false, true]) {
		it(`${revoke ? "rejects revoked" : "permits approved"} admission on a transport retry without replaying the hook`, async () => {
			let requests = 0;
			let admissions = 0;
			let hooks = 0;
			let allowed = true;
			const captures: string[] = [];
			const successful = createSseFetch();
			const fetchRetry: FetchImpl = async (input, init) => {
				requests++;
				captures.push(init?.body as string);
				if (requests === 1) {
					if (revoke) allowed = false;
					return new Response("temporarily unavailable", { status: 503, headers: { "retry-after": "0" } });
				}
				return successful(input, init);
			};
			const options: OpenAICompletionsOptions = {
				apiKey: "test-key",
				reasoning: Effort.High,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				fetch: fetchRetry,
				onBeforeRequest: () => {
					admissions++;
					if (!allowed) throw new Error("The model grant was revoked during retry.");
				},
				onPayload: payload => {
					hooks++;
					options.onBeforeRequest = () => {};
					options.preserveModelSelection = false;
					options.preserveThinkingEffort = false;
					return { ...(payload as Body), messages: [{ role: "user", content: "one transformed request" }] };
				},
			};
			const result = await streamOpenAICompletions(model, baseContext(), options).result();
			expect(result.stopReason).toBe(revoke ? "error" : "stop");
			expect(requests).toBe(revoke ? 1 : 2);
			expect(admissions).toBe(2);
			expect(hooks).toBe(1);
			expect(JSON.parse(captures[0]!)).toMatchObject({ model: model.id, reasoning_effort: "high" });
			if (!revoke) expect(captures[1]).toBe(captures[0]);
			else expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		}, 10_000);
	}

	it("rejects fixed effort with no wire dial while preserving the ordinary metadata-less request", async () => {
		const undialled = {
			...model,
			thinking: undefined,
			compat: { ...model.compat, supportsReasoningParams: false, supportsReasoningEffort: false },
		};
		let requests = 0;
		const ordinary = await streamOpenAICompletions(undialled, baseContext(), {
			apiKey: "test-key",
			reasoning: "high",
			fetch: createSseFetch(() => requests++),
		}).result();
		expect(ordinary.stopReason).toBe("stop");
		const fixed = await streamOpenAICompletions(undialled, baseContext(), {
			apiKey: "test-key",
			reasoning: "high",
			preserveThinkingEffort: true,
			fetch: createSseFetch(() => requests++),
		}).result();
		expect(fixed.stopReason).toBe("error");
		expect(AIError.is(fixed.errorId, AIError.Flag.HostAdmission)).toBe(true);
		expect(requests).toBe(1);
	});

	for (const rewrite of [false, true]) {
		it(`${rewrite ? "rejects changed" : "honors"} an effort encoded in the selected wire model`, async () => {
			const routed = {
				...model,
				thinking: {
					mode: "effort" as const,
					efforts: [Effort.Low, Effort.High],
					effortRouting: { off: "plain-wire", low: "low-wire", high: "high-wire" },
				},
				compat: { ...model.compat, supportsReasoningParams: false, supportsReasoningEffort: false },
			};
			const bodies: Body[] = [];
			const result = await streamOpenAICompletions(routed, baseContext(), {
				apiKey: "test-key",
				reasoning: "high",
				preserveThinkingEffort: true,
				fetch: createSseFetch(body => bodies.push(body as Body)),
				onPayload: rewrite ? payload => Object.assign(payload as Body, { model: "low-wire" }) : undefined,
			}).result();
			expect(result.stopReason).toBe(rewrite ? "error" : "stop");
			expect(bodies).toHaveLength(rewrite ? 0 : 1);
			if (!rewrite) expect(bodies[0]?.model).toBe("high-wire");
			else expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		});
	}

	it("rejects a pro-mode hook escape even when effort is not fixed", async () => {
		let requests = 0;
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			preserveModelSelection: true,
			fetch: createSseFetch(() => requests++),
			onPayload: payload => Object.assign(payload as Body, { reasoning: { mode: "pro" } }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		expect(requests).toBe(0);
	});

	for (const fragment of [
		{ model: "other-model" },
		{ models: ["other-model"] },
		{ fallbacks: ["other-model"] },
		{ provider: { order: ["other-provider"] } },
		{ providerOptions: { gateway: { only: ["other-provider"] } } },
		{ reasoning: { mode: "pro" } },
	]) {
		it(`rejects routing hidden in native reasoningBody ${Object.keys(fragment)[0]}`, async () => {
			let requests = 0;
			const result = await streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				preserveModelSelection: true,
				reasoningBody: fragment,
				fetch: createSseFetch(() => requests++),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(requests).toBe(0);
		});
	}

	it("does not adopt a native fragment's weaker caller effort as the approved baseline", async () => {
		let requests = 0;
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			reasoning: "high",
			preserveThinkingEffort: true,
			reasoningBody: { reasoning_effort: "low" },
			fetch: createSseFetch(() => requests++),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		expect(requests).toBe(0);
	});

	for (const revoke of [false, true]) {
		it(`${revoke ? "denies revoked" : "permits approved"} admission on Copilot's inner identity retry`, async () => {
			await withEnv({ COPILOT_INTEGRATION_ID: undefined }, async () => {
				const copilot = {
					...model,
					provider: "github-copilot",
					baseUrl: "https://api.githubcopilot.com",
				};
				let allowed = true;
				let hooks = 0;
				const requests: Array<{ body: string; identity: string | null }> = [];
				const successful = createSseFetch();
				const result = await streamOpenAICompletions(copilot, baseContext(), {
					apiKey: `wire-guard-copilot-${revoke}`,
					reasoning: "high",
					preserveModelSelection: true,
					preserveThinkingEffort: true,
					onPayload: () => {
						hooks++;
					},
					onBeforeRequest: () => {
						if (!allowed)
							throw new Error("Copilot model grant revoked.", { cause: new Error("503 Service Unavailable") });
					},
					fetch: async (input, init) => {
						requests.push({
							body: init?.body as string,
							identity: new Headers(init?.headers).get("Copilot-Integration-Id"),
						});
						if (requests.length === 1) {
							if (revoke) allowed = false;
							return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
						}
						return successful(input, init);
					},
				}).result();
				expect(result.stopReason).toBe(revoke ? "error" : "stop");
				expect(requests).toHaveLength(revoke ? 1 : 2);
				expect(hooks).toBe(1);
				if (revoke) expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
				else {
					expect(requests[1]?.body).toBe(requests[0]?.body);
					expect(requests[1]?.identity).not.toBe(requests[0]?.identity);
					expect(JSON.parse(requests[1]!.body)).toMatchObject({ model: model.id, reasoning_effort: "high" });
				}
			});
		}, 10_000);
	}
});
