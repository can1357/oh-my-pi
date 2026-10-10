import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient, type AnthropicRequestOptions } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParams, MessageCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

withOfficialAnthropicEndpoint();

const MODEL_ID = "claude-fable-5-1";
const context: Context = { messages: [{ role: "user", content: "Answer the question.", timestamp: 1 }] };
const protectedOptions = { preserveModelSelection: true, preserveThinkingEffort: true };

type Request = { body: MessageCreateParamsStreaming; raw: string; headers: Headers; url: string };

function anthropicResponse(model: string, text = "admitted"): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_wire",
				type: "message",
				role: "assistant",
				model,
				content: [],
				usage: { input_tokens: 3, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: text ? 2 : 0 } },
		{ type: "message_stop" },
	];
	return new Response(
		`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function endpoint(modelId = MODEL_ID, reply?: (request: Request, attempt: number) => Response) {
	const requests: Request[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const raw = await request.text();
			const captured = {
				raw,
				body: JSON.parse(raw) as MessageCreateParamsStreaming,
				headers: request.headers,
				url: request.url,
			};
			requests.push(captured);
			return reply?.(captured, requests.length) ?? anthropicResponse(modelId);
		},
	});
	return { requests, server };
}

function model(baseUrl: string, id = MODEL_ID) {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function history(target: Model<"anthropic-messages">): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Earlier answer." }],
		api: target.api,
		provider: target.provider,
		model: target.id,
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		requestControls: { messageIndex: 1, effort: { topLevel: "low", tail: "low" } },
	};
	return { messages: [context.messages[0], assistant, { role: "user", content: "Continue.", timestamp: 3 }] };
}

describe("governed Anthropic final transport", () => {
	it("sends admitted high effort after Unicode normalization and OAuth CCH rewriting", async () => {
		const { server, requests } = endpoint();
		try {
			const result = await streamAnthropic(model(server.url.toString()), context, {
				...protectedOptions,
				apiKey: "sk-ant-oat-wire",
				isOAuth: true,
				thinkingEnabled: true,
				effort: "high",
				onPayload: value => {
					// The real provider passes its built Messages payload to this hook.
					const payload = value as MessageCreateParamsStreaming;
					payload.messages[0].content = "text\ud800";
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(
				result.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join(""),
			).toBe("admitted");
			expect(requests).toHaveLength(1);
			expect(requests[0].body.model).toBe(MODEL_ID);
			expect(requests[0].body.output_config?.effort).toBe("high");
			expect(requests[0].body.messages[0].content).toBe("text\ufffd");
			const system = requests[0].body.system;
			if (!Array.isArray(system)) throw new Error("Expected OAuth system blocks");
			const billing = system[0].text;
			expect(billing.startsWith("x-anthropic-billing-header:")).toBe(true);
			expect(billing.includes("cch=00000")).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it.each(["model", "effort", "historical-effort", "task-budget"] as const)(
		"rejects a hook changing %s before dispatch",
		async kind => {
			const { server, requests } = endpoint();
			try {
				const result = await streamAnthropic(model(server.url.toString()), context, {
					...protectedOptions,
					apiKey: "test",
					thinkingEnabled: true,
					effort: "high",
					onPayload: value => {
						const payload = value as MessageCreateParamsStreaming;
						if (kind === "model") payload.model = "claude-opus-5";
						else if (kind === "effort") payload.output_config = { effort: "low" };
						else if (kind === "task-budget")
							payload.output_config = { effort: "high", task_budget: { type: "tokens", total: 0 } };
						else payload.messages.push({ role: "system", content: [], output_config: { effort: "low" } });
					},
				}).result();
				expect(requests).toHaveLength(0);
				expect(result.stopReason).toBe("error");
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			} finally {
				server.stop(true);
			}
		},
	);

	it("refuses server-side fallback iterations that cannot refresh admission", async () => {
		const { server, requests } = endpoint();
		try {
			const result = await streamAnthropic(model(server.url.toString()), context, {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
				fallbacks: [{ model: "claude-opus-5" }],
			}).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("binds canonical effort routing and refuses undeclared or unproven wire overrides", async () => {
		const high = "claude-fable-5-1";
		const low = "claude-fable-5";
		const { server, requests } = endpoint(high);
		try {
			const initial = model(server.url.toString());
			const target: Model<"anthropic-messages"> = {
				...initial,
				thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High], effortRouting: { high, low } },
			};
			const admitted = await streamAnthropic(target, context, {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				reasoning: Effort.High,
				effort: "high",
			}).result();
			expect(admitted.stopReason).toBe("stop");
			expect(requests).toHaveLength(1);
			expect(requests[0].body.model).toBe(high);
			for (const selection of [
				{ requestModelId: "undeclared-model", reasoning: Effort.High },
				{ requestModelId: low, reasoning: Effort.High },
				{ requestModelId: low },
			]) {
				const rejected = await streamAnthropic(target, context, {
					...protectedOptions,
					apiKey: "test",
					thinkingEnabled: true,
					effort: "high",
					...selection,
				}).result();
				expect(requests).toHaveLength(1);
				expect(AIError.is(rejected.errorId, AIError.Flag.HostAdmission)).toBe(true);
			}
		} finally {
			server.stop(true);
		}
	});

	it.each(["toJSON", "accessor"] as const)("rejects unsafe %s without invoking it", async kind => {
		const { server, requests } = endpoint();
		let evaluations = 0;
		try {
			const result = await streamAnthropic(model(server.url.toString()), context, {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
				onPayload: value => {
					if (kind === "toJSON")
						Object.defineProperty(value, "toJSON", {
							value: () => {
								evaluations++;
								return { model: "claude-opus-5" };
							},
						});
					else
						Object.defineProperty(value, "model", {
							enumerable: true,
							get: () => {
								evaluations++;
								return "claude-opus-5";
							},
						});
				},
			}).result();
			expect(requests).toHaveLength(0);
			expect(evaluations).toBe(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("revokes admission during an outer transport retry without replaying the hook", async () => {
		let admitted = true;
		let admissions = 0;
		let hooks = 0;
		const { server, requests } = endpoint(MODEL_ID, () => new Response("overloaded", { status: 503 }));
		try {
			const options: AnthropicOptions = {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
				onPayload: () => {
					hooks++;
					options.preserveModelSelection = false;
					options.preserveThinkingEffort = false;
					options.onBeforeRequest = undefined;
				},
				onBeforeRequest: () => {
					admissions++;
					if (!admitted)
						throw new Error("grant revoked", {
							cause: new AIError.AnthropicConnectionError(new Error("network")),
						});
				},
				providerRetryWait: async () => {
					admitted = false;
				},
			};
			const result = await streamAnthropic(model(server.url.toString()), context, options).result();
			expect(requests).toHaveLength(1);
			expect(admissions).toBe(2);
			expect(hooks).toBe(1);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("replays identical empty-completion bytes with one mutable hook and fresh admission", async () => {
		let hooks = 0;
		let admissions = 0;
		const { server, requests } = endpoint(MODEL_ID, (_request, attempt) =>
			anthropicResponse(MODEL_ID, attempt === 1 ? "" : "admitted"),
		);
		try {
			const result = await streamAnthropic(model(server.url.toString()), context, {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
				onPayload: () => {
					hooks++;
				},
				onBeforeRequest: () => {
					admissions++;
				},
				providerRetryWait: async () => {},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(requests).toHaveLength(2);
			expect(requests[1].raw).toBe(requests[0].raw);
			expect(hooks).toBe(1);
			expect(admissions).toBe(2);
		} finally {
			server.stop(true);
		}
	});

	it("rejects opaque injected clients but retains ordinary structural client transport", async () => {
		const { server, requests } = endpoint();
		let creates = 0;
		let introspections = 0;
		const owned = new AnthropicMessagesClient({
			baseURL: server.url.toString().slice(0, -1),
			apiKey: "test",
			maxRetries: 0,
		});
		const client = {
			messages: {
				create: (params: MessageCreateParams, options?: AnthropicRequestOptions) => {
					creates++;
					return owned.messages.create(params, options);
				},
			},
		};
		Object.defineProperty(client, "baseURL", {
			get: () => {
				introspections++;
				return server.url.toString();
			},
		});
		try {
			const target = model(server.url.toString());
			const ordinary = await streamAnthropic(target, context, {
				apiKey: "test",
				client,
				thinkingEnabled: true,
				effort: "high",
			}).result();
			expect(ordinary.stopReason).toBe("stop");
			const beforeRejection = introspections;
			const rejected = await streamAnthropic(target, context, {
				...protectedOptions,
				apiKey: "test",
				client,
				thinkingEnabled: true,
				effort: "high",
			}).result();
			expect(requests).toHaveLength(1);
			expect(creates).toBe(1);
			expect(introspections).toBe(beforeRejection);
			expect(AIError.is(rejected.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("keeps historical top-level effort while the new tail honors requested high", async () => {
		const { server, requests } = endpoint();
		try {
			const target = model(server.url.toString());
			const result = await streamAnthropic(target, history(target), {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(requests).toHaveLength(1);
			expect(requests[0].body.output_config?.effort).toBe("low");
			expect(
				requests[0].body.messages.filter(message => message.output_config?.effort !== undefined).at(-1)
					?.output_config?.effort,
			).toBe("high");
		} finally {
			server.stop(true);
		}
	});

	it("refuses native compaction when in-force history cannot express the requested effort", async () => {
		const { server, requests } = endpoint();
		try {
			const initial = model(server.url.toString());
			const target = {
				...initial,
				compat: { ...initial.compat, bedrockMessagesApi: true, supportsServerCompaction: true },
			};
			const result = await streamAnthropic(target, history(target), {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
				anthropicCompaction: { instructions: "Summarize." },
			}).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("admits native compaction whose historical tail already matches requested high", async () => {
		const events = [
			{
				type: "message_start",
				message: { id: "msg_compact_wire", model: MODEL_ID, usage: { input_tokens: 2, output_tokens: 0 } },
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "compaction", content: "Native summary.", signature: "opaque-summary-signature" },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "compaction" }, usage: { output_tokens: 2 } },
			{ type: "message_stop" },
		];
		const { server, requests } = endpoint(
			MODEL_ID,
			() =>
				new Response(
					`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		try {
			const initial = model(server.url.toString());
			const target = {
				...initial,
				compat: { ...initial.compat, bedrockMessagesApi: true, supportsServerCompaction: true },
			};
			const retained = history(target);
			const previous = retained.messages[1];
			if (previous.role !== "assistant" || !previous.requestControls) throw new Error("Expected recorded effort");
			previous.requestControls.effort = { topLevel: "low", tail: "high" };
			const result = await streamAnthropic(target, retained, {
				...protectedOptions,
				apiKey: "test",
				thinkingEnabled: true,
				effort: "high",
				anthropicCompaction: { instructions: "Summarize." },
			}).result();
			expect(requests).toHaveLength(1);
			expect(requests[0].body.compaction?.type).toBe("summarize");
			expect(requests[0].body.output_config?.effort).toBe("low");
			expect(
				requests[0].body.messages.filter(message => message.output_config?.effort !== undefined).at(-1)
					?.output_config?.effort,
			).toBe("high");
			expect(result.providerPayload).toEqual({
				type: "anthropicCompaction",
				provider: "anthropic",
				content: "Native summary.",
				signature: "opaque-summary-signature",
			});
			expect(result.stopDetails).toEqual({ type: "compaction" });
		} finally {
			server.stop(true);
		}
	});

	it("admits exactly matching frozen credit controls and rejects weaker frozen effort", async () => {
		const { server, requests } = endpoint();
		try {
			const target = model(server.url.toString());
			const options = { ...protectedOptions, apiKey: "test", thinkingEnabled: true, effort: "high" as const };
			await streamAnthropic(target, context, options).result();
			const params = structuredClone(requests[0].body);
			const credit = { token: "native-credit", params, prefillClaim: false, expiresAt: Date.now() + 60_000 };
			const admitted = await streamAnthropic(target, context, {
				...options,
				fallbackCreditRedemption: credit,
			}).result();
			expect(admitted.stopReason).toBe("stop");
			expect(requests).toHaveLength(2);
			expect(requests[1].body.fallback_credit_token).toBe("native-credit");
			params.output_config = { effort: "low" };
			const rejected = await streamAnthropic(target, context, {
				...options,
				fallbackCreditRedemption: credit,
			}).result();
			expect(requests).toHaveLength(2);
			expect(AIError.is(rejected.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("rejects high effort with a zero mapped budget, and rejects forced tool suppression", async () => {
		const { server, requests } = endpoint("claude-sonnet-4-5");
		try {
			const target = model(server.url.toString(), "claude-sonnet-4-5");
			let zero: unknown;
			try {
				await streamSimple(target, context, {
					...protectedOptions,
					apiKey: "test",
					reasoning: Effort.High,
					thinkingBudgets: { high: 0 },
				}).result();
			} catch (error) {
				zero = error;
			}
			const forced = await streamAnthropic(
				target,
				{
					...context,
					tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
				},
				{
					...protectedOptions,
					apiKey: "test",
					thinkingEnabled: true,
					thinkingBudgetTokens: 8192,
					toolChoice: "any",
				},
			).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(AIError.classify(zero), AIError.Flag.HostAdmission)).toBe(true);
			expect(AIError.is(forced.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("vetoes a revoked Copilot identity resend without wrapping it as a connection failure", async () => {
		let admissions = 0;
		const { server, requests } = endpoint(MODEL_ID, () => new Response("identity denied", { status: 403 }));
		try {
			await withEnv({ COPILOT_INTEGRATION_ID: undefined }, async () => {
				const target = buildModel({ ...model(server.url.toString()), provider: "github-copilot" });
				const result = await streamAnthropic(target, context, {
					preserveModelSelection: true,
					apiKey: "copilot-wire-token",
					onBeforeRequest: () => {
						if (++admissions > 1) throw new Error("grant revoked");
					},
				}).result();
				expect(requests).toHaveLength(1);
				expect(admissions).toBe(2);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			});
		} finally {
			server.stop(true);
		}
	});
});

it("owned Anthropic client admission is outside retries and preserves genuine cancellation", async () => {
	const { server, requests } = endpoint();
	let admissions = 0;
	try {
		const client = new AnthropicMessagesClient({
			baseURL: server.url.toString().slice(0, -1),
			apiKey: "test",
			maxRetries: 3,
		});
		const abort = new AIError.AbortError("cancelled");
		const error = await client.messages
			.create(
				{ model: MODEL_ID, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true },
				{
					onBeforeRequest: () => {
						admissions++;
						throw abort;
					},
				},
			)
			.asResponse()
			.catch(error => error);
		expect(requests).toHaveLength(0);
		expect(admissions).toBe(1);
		expect(error).toBe(abort);
		expect(AIError.is(AIError.classify(error), AIError.Flag.HostAdmission)).toBe(false);
	} finally {
		server.stop(true);
	}
});
