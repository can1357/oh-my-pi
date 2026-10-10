import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type FactoryDroidOptions, streamFactoryDroid } from "@oh-my-pi/pi-ai/providers/factory-droid";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { anthropicChunks, completionsChunks, factoryModel, geminiChunks, WORKOS_TOKEN } from "./helpers/factory-droid";

const context: Context = { messages: [{ role: "user", content: "Answer.", timestamp: 1 }] };
const protectedOptions = { preserveModelSelection: true, preserveThinkingEffort: true };
const lanes = [
	{
		id: "kimi-k3",
		family: "completions",
		api: "openai-completions",
		upstream: "fireworks",
		prefix: "api/llm/o/v1",
		path: "/api/llm/o/v1/chat/completions",
	},
	{
		id: "gpt-5.2",
		family: "responses",
		api: "openai-responses",
		upstream: "openai",
		prefix: "api/llm/o/v1",
		path: "/api/llm/o/v1/responses",
	},
	{
		id: "claude-fable-5",
		family: "anthropic",
		api: "anthropic-messages",
		upstream: "anthropic",
		prefix: "api/llm/a",
		path: "/api/llm/a/v1/messages",
	},
	{
		id: "gemini-3.1-pro-preview",
		family: "gemini",
		api: "google-generative-ai",
		upstream: "google",
		prefix: "api/llm/g/v1",
		path: "/api/llm/g/v1/generate",
	},
] satisfies Array<{
	id: string;
	family: "completions" | "responses" | "anthropic" | "gemini";
	api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
	upstream: string;
	prefix: string;
	path: string;
}>;
type Lane = (typeof lanes)[number];
interface Request {
	raw: string;
	body: Record<string, unknown>;
	headers: Headers;
	path: string;
}

function responsesChunks(text: string, model: string): string[] {
	const part = { type: "output_text", text, annotations: [], logprobs: [] };
	const item = { id: "msg_admitted", type: "message", role: "assistant", status: "completed", content: [part] };
	const completed = {
		id: "resp_admitted",
		object: "response",
		created_at: 1,
		model,
		status: "completed",
		output: [item],
		usage: {
			input_tokens: 9,
			output_tokens: 4,
			total_tokens: 13,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	const started = { ...completed, status: "in_progress", output: [], usage: null };
	const location = { output_index: 0, item_id: item.id, content_index: 0 };
	return [
		{ type: "response.created", response: started },
		{ type: "response.in_progress", response: started },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", ...location, part: { ...part, text: "" } },
		{ type: "response.output_text.delta", ...location, delta: text },
		{ type: "response.output_text.done", ...location, text, logprobs: [] },
		{ type: "response.content_part.done", ...location, part },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: completed },
	].map((event, sequence_number) => JSON.stringify({ ...event, sequence_number }));
}

function response(lane: Lane): Response {
	const chunks =
		lane.family === "completions"
			? completionsChunks("admitted", lane.id)
			: lane.family === "responses"
				? responsesChunks("admitted", lane.id)
				: lane.family === "anthropic"
					? anthropicChunks("admitted")
					: geminiChunks("admitted");
	if (lane.family === "anthropic") {
		const start = JSON.parse(chunks[0]);
		start.message.model = lane.id;
		chunks[0] = JSON.stringify(start);
	}
	const frames = chunks.map(chunk => {
		const event = JSON.parse(chunk) as { type?: string };
		return event.type ? `event: ${event.type}\ndata: ${chunk}` : `data: ${chunk}`;
	});
	if (lane.family === "completions" || lane.family === "gemini") frames.push("data: [DONE]");
	return new Response(`${frames.join("\n\n")}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function endpoint(lane: Lane, reply?: (request: Request, attempt: number) => Response) {
	const requests: Request[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const raw = await request.text();
			const captured = {
				raw,
				body: JSON.parse(raw) as Record<string, unknown>,
				headers: request.headers,
				path: new URL(request.url).pathname,
			};
			requests.push(captured);
			return reply?.(captured, requests.length) ?? response(lane);
		},
	});
	const model: Model<"factory-droid-agent"> = {
		...factoryModel(lane.id, [lane.upstream]),
		baseUrl: `${server.url}${lane.prefix}`,
	};
	return { server, requests, model };
}

function effort(body: Record<string, unknown>, lane: Lane) {
	if (lane.family === "completions") return body.reasoning_effort;
	const controls =
		lane.family === "responses"
			? body.reasoning
			: lane.family === "anthropic"
				? body.output_config
				: body.generationConfig;
	if (controls === null || typeof controls !== "object") return undefined;
	if (lane.family !== "gemini") return "effort" in controls ? controls.effort : undefined;
	const thinking = "thinkingConfig" in controls ? controls.thinkingConfig : undefined;
	return thinking !== null && typeof thinking === "object" && "thinkingLevel" in thinking
		? thinking.thinkingLevel
		: undefined;
}

describe("governed native Factory adapter dispatch", () => {
	it.each(lanes)("serves $family through its authorized inner API with high effort", async lane => {
		const { server, requests, model } = endpoint(lane);
		let admissions = 0;
		let hookApi: string | undefined;
		try {
			const result = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				onBeforeRequest: () => {
					admissions++;
				},
				onPayload: (_payload, inner) => {
					if (!inner) throw new Error("expected native Factory payload hook model");
					hookApi = inner.api;
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
			expect(requests[0].path).toBe(lane.path);
			expect(requests[0].body.model).toBe(model.requestModelId ?? model.id);
			expect(effort(requests[0].body, lane)).toBe(lane.family === "gemini" ? "HIGH" : "high");
			expect(requests[0].headers.get("x-api-provider")).toBe(lane.upstream);
			expect(admissions).toBe(1);
			expect(hookApi).toBe(lane.family === "gemini" ? "factory-droid-agent" : lane.api);
			expect(model.api).toBe("factory-droid-agent");
		} finally {
			server.stop(true);
		}
	});

	it.each(lanes)("rejects weakened actual $family effort controls", async lane => {
		const { server, requests, model } = endpoint(lane);
		try {
			const result = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				onPayload: value => {
					// The native adapter owns this in-process JSON request shape.
					const payload = value as Record<string, unknown>;
					if (lane.family === "completions") payload.reasoning_effort = "low";
					else if (lane.family === "responses") payload.reasoning = { effort: "low" };
					else if (lane.family === "anthropic") payload.output_config = { effort: "low" };
					else payload.generationConfig = { thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } };
				},
			}).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it.each(lanes)("rejects an encoded $family model substitution despite caller option mutation", async lane => {
		const { server, requests, model } = endpoint(lane);
		try {
			const options: FactoryDroidOptions = {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				onPayload: value => {
					options.preserveModelSelection = false;
					options.preserveThinkingEffort = false;
					options.onBeforeRequest = undefined;
					// The native adapter's hook receives its in-process JSON request.
					const payload = value as Record<string, unknown>;
					payload.model = "unapproved-model";
				},
			};
			const result = await streamFactoryDroid(model, context, options).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("retains trusted model flags and callbacks across option accessors", async () => {
		const { server, requests, model } = endpoint(lanes[0]);
		let reads = 0;
		try {
			const options: FactoryDroidOptions = {
				preserveThinkingEffort: true,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				onPayload: value => {
					// The native adapter owns this in-process JSON request shape.
					const payload = value as Record<string, unknown>;
					payload.model = "unapproved-model";
				},
			};
			Object.defineProperty(options, "preserveModelSelection", { enumerable: true, get: () => ++reads === 1 });
			const result = await streamFactoryDroid(model, context, options).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it.each(lanes)("rejects unsafe $family serializers without running them", async lane => {
		const { server, requests, model } = endpoint(lane);
		let evaluations = 0;
		try {
			const result = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				onPayload: value => {
					Object.defineProperty(value, "toJSON", {
						value: () => {
							evaluations++;
							return { model: "unapproved-model" };
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

	it.each(lanes)("runs final $family admission after hooks and before any send", async lane => {
		const { server, requests, model } = endpoint(lane);
		let admitted = true;
		let admissions = 0;
		try {
			const result = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				onPayload: () => {
					admitted = false;
				},
				onBeforeRequest: () => {
					admissions++;
					if (!admitted) throw new Error("grant revoked");
				},
			}).result();
			expect(requests).toHaveLength(0);
			expect(admissions).toBe(1);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it.each(lanes.filter(lane => lane.family !== "gemini"))(
		"revokes $family admission during HTTP retry",
		async lane => {
			const { server, requests, model } = endpoint(
				lane,
				() => new Response("overloaded", { status: 429, headers: { "retry-after": "0" } }),
			);
			let admissions = 0;
			let hooks = 0;
			try {
				const result = await streamFactoryDroid(model, context, {
					...protectedOptions,
					apiKey: WORKOS_TOKEN,
					reasoning: Effort.High,
					onPayload: () => {
						hooks++;
					},
					providerRetryWait: async () => {},
					onBeforeRequest: () => {
						if (++admissions > 1) throw new Error("grant revoked");
					},
				}).result();
				expect(requests).toHaveLength(1);
				expect(admissions).toBe(2);
				expect(hooks).toBe(1);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			} finally {
				server.stop(true);
			}
		},
	);

	it("retains native refusal alternatives only for ordinary calls", async () => {
		const { server, requests, model } = endpoint(lanes[2]);
		try {
			const ordinary = await streamFactoryDroid(model, context, {
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
			}).result();
			const governed = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
			}).result();
			expect(ordinary.stopReason).toBe("stop");
			expect(governed.stopReason).toBe("stop");
			expect(requests).toHaveLength(2);
			expect(requests[0].body.fallbacks).toEqual([{ model: "claude-opus-5" }]);
			expect(requests[1].body.fallbacks).toBeUndefined();
			expect(requests[1].headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback-");
			expect(requests[1].headers.get("anthropic-beta") ?? "").not.toContain("fallback-credit-");
		} finally {
			server.stop(true);
		}
	});

	it("rejects an unauthorized actual upstream header rather than stripping it", async () => {
		const { server, requests, model } = endpoint(lanes[0]);
		try {
			const result = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				reasoning: Effort.High,
				headers: { "X-Api-Provider": "unauthorized" },
			}).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(result.stopReason).toBe("error");
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it("preserves ordinary Gemini display-off behavior but refuses to claim fixed reasoning off", async () => {
		const { server, requests, model } = endpoint(lanes[3]);
		try {
			const ordinary = await streamFactoryDroid(model, context, {
				apiKey: WORKOS_TOKEN,
				disableReasoning: true,
			}).result();
			const governed = await streamFactoryDroid(model, context, {
				...protectedOptions,
				apiKey: WORKOS_TOKEN,
				disableReasoning: true,
			}).result();
			expect(ordinary.stopReason).toBe("stop");
			expect(
				ordinary.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join(""),
			).toBe("admitted");
			expect(requests).toHaveLength(1);
			const generationConfig = requests[0].body.generationConfig;
			if (!generationConfig || typeof generationConfig !== "object" || !("thinkingConfig" in generationConfig)) {
				throw new Error("Expected native Gemini thinking configuration");
			}
			expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: false });
			expect(AIError.is(governed.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(governed.stopReason).toBe("error");
			expect(AIError.retriable(AIError.classifyMessage(governed))).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it.each(lanes)(
		"keeps ordinary $family upstream failures recoverable despite admission-looking diagnostics",
		async lane => {
			const { server, requests, model } = endpoint(
				lane,
				() =>
					new Response(
						JSON.stringify({
							error: {
								type: "ModelSelectionError",
								message: "upstream temporarily unavailable",
								errorId: AIError.create(AIError.Flag.HostAdmission),
							},
						}),
						{ status: 503, headers: { "content-type": "application/json", "retry-after": "0" } },
					),
			);
			try {
				const result = await streamFactoryDroid(model, context, {
					apiKey: WORKOS_TOKEN,
					reasoning: Effort.High,
					providerRetryWait: async () => {},
				}).result();
				expect(requests.length).toBeGreaterThan(0);
				expect(result.stopReason).toBe("error");
				expect(result.errorStatus).toBe(503);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(false);
				expect(AIError.retriable(AIError.classifyMessage(result))).toBe(true);
			} finally {
				server.stop(true);
			}
		},
	);
});
