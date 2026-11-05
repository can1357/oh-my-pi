import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamFactoryDroid } from "@oh-my-pi/pi-ai/providers/factory-droid";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { serviceTierPeerFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { factoryModel, WORKOS_TOKEN } from "./helpers/factory-droid";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const echoTool: Tool = { name: "echo", description: "Echo input", parameters: type({ text: "string" }) };

/** The strict-tools rejection both OpenAI-family loops repair by resending without `strict`. */
function strictToolsRejection(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "Invalid schema for function 'echo': strict mode is unsupported",
				type: "invalid_request_error",
				code: "invalid_function_parameters",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/**
 * OpenAI's capacity refusal for a serving tier: a 500 whose body carries
 * `flex_unavailable`. The status alone reads as a server fault; the code is the
 * only thing that says "wrong pool, same request".
 */
function tierUnavailable(code = "flex_unavailable"): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "Service tier is currently unavailable. Retry the request or use the default service tier.",
				type: "server_error",
				code,
			},
		}),
		{ status: 500, headers: { "content-type": "application/json" } },
	);
}

function responsesOk(): Response {
	const events = [
		{ type: "response.created", response: { id: "resp_ok", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_ok", content: [] } },
		{ type: "response.output_text.delta", item_id: "msg_ok", output_index: 0, content_index: 0, delta: "ok" },
		{
			type: "response.completed",
			response: {
				id: "resp_ok",
				status: "completed",
				output: [
					{ type: "message", id: "msg_ok", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
				],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function completionsOk(): Response {
	const chunks = [
		{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
		{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Records the `model` and `service_tier` of every request body the stub receives. */
function recordingFetch(respond: (sent: { model: string; serviceTier?: string }) => Response): {
	fetch: FetchImpl;
	sent: { model: string; serviceTier?: string }[];
} {
	const sent: { model: string; serviceTier?: string }[] = [];
	const fetch: FetchImpl = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; service_tier?: string };
		const entry = { model: String(body.model), ...(body.service_tier ? { serviceTier: body.service_tier } : {}) };
		sent.push(entry);
		return respond(entry);
	};
	return { fetch, sent };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessage> {
	let last: AssistantMessage | undefined;
	for await (const event of stream) {
		if ("partial" in event && event.partial) last = event.partial;
	}
	if (!last) throw new Error("stream produced no message");
	return last;
}

/** Drain a stream expected to fail, returning the failure text the caller sees. */
async function drainToFailure(stream: AsyncIterable<AssistantMessageEvent>): Promise<string> {
	try {
		for await (const event of stream) {
			if (event.type === "error") return JSON.stringify(event.error ?? event);
		}
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("stream was expected to fail");
}

function responsesModel(id: string): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	}) as Model<"openai-responses">;
}

function completionsModel(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	}) as Model<"openai-completions">;
}

describe("service-tier capacity refusals", () => {
	it("classifies flex_unavailable as capacity, not a server fault or a refusal", () => {
		const capacity = new AIError.ProviderHttpError("500 flex unavailable", 500, { code: "flex_unavailable" });
		expect(AIError.isServiceTierCapacityError(capacity)).toBe(true);
		// Transient: the request is servable, so the turn must stay retryable.
		expect(AIError.classify(capacity) & AIError.Flag.Transient).not.toBe(0);
		// Not a content verdict: a capacity code must never read as a refusal.
		expect(AIError.classify(capacity) & AIError.Flag.ContentBlocked).toBe(0);

		// A 4xx host spelling stays retryable — the status is not what decides.
		const fourHundred = new AIError.ProviderHttpError("400 scale unavailable", 400, {
			code: "scale_tier_unavailable",
		});
		expect(AIError.isServiceTierCapacityError(fourHundred)).toBe(true);
		expect(AIError.classify(fourHundred) & AIError.Flag.Transient).not.toBe(0);

		// Prose is never enough: an ordinary 500 that merely mentions flex is a
		// server fault, and must not be re-aimed at another tier.
		const prose = new AIError.ProviderHttpError("500 flex processing had an internal error", 500, {
			code: "server_error",
		});
		expect(AIError.isServiceTierCapacityError(prose)).toBe(false);
	});

	it("reads the standard peer of a tier-suffixed wire id, longest suffix first", () => {
		expect(serviceTierPeerFor("gpt-6.1-sol-flex")).toEqual({ peerId: "gpt-6.1-sol", tier: "flex" });
		// `-ultrafast` must never be read as the shorter `-fast`.
		expect(serviceTierPeerFor("gpt-6.1-sol-ultrafast")).toEqual({ peerId: "gpt-6.1-sol", tier: "ultrafast" });
		expect(serviceTierPeerFor("gpt-6.1-sol-fast")).toEqual({ peerId: "gpt-6.1-sol", tier: "priority" });
		// An id carrying no declared tier suffix, and one that is nothing but the
		// suffix, both have no peer.
		expect(serviceTierPeerFor("gpt-6.1-sol")).toBeUndefined();
		expect(serviceTierPeerFor("-flex")).toBeUndefined();
	});

	it("responses: re-aims a refused flex route at its standard peer and completes", async () => {
		const { fetch, sent } = recordingFetch(entry =>
			entry.model.endsWith("-flex") ? tierUnavailable() : responsesOk(),
		);
		const message = await collect(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol-flex"), context, { apiKey: "k", fetch }),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol"]);
	});

	it("responses: the refused id is never resent; the peer is reached once and the failure surfaces", async () => {
		// Every id is refused. The flex route is not resent even once — that is
		// what makes the id change the fix rather than another attempt — and the
		// peer, having no reroute of its own, keeps its ordinary transport retries
		// before the failure reaches the caller.
		const { fetch, sent } = recordingFetch(() => tierUnavailable());
		const failure = await drainToFailure(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol-flex"), context, { apiKey: "k", fetch }),
		);
		expect(failure).toMatch(/service tier is currently unavailable/i);
		expect(sent.filter(entry => entry.model === "gpt-6.1-sol-flex")).toHaveLength(1);
		expect(sent.map(entry => entry.model).slice(1)).not.toContain("gpt-6.1-sol-flex");
	}, 60_000);

	it("responses: a request that named no tier is never re-aimed", async () => {
		// An ordinary 500 carrying the code on a plain id has nothing to change, so
		// no peer is ever invented; the request keeps its own identity throughout.
		const { fetch, sent } = recordingFetch(() => tierUnavailable());
		const failure = await drainToFailure(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol"), context, { apiKey: "k", fetch }),
		);
		expect(failure).toMatch(/service tier is currently unavailable/i);
		expect(new Set(sent.map(entry => entry.model))).toEqual(new Set(["gpt-6.1-sol"]));
	}, 60_000);

	it("responses: drops service_tier when the tier rode in the field rather than the id", async () => {
		const { fetch, sent } = recordingFetch(entry => (entry.serviceTier ? tierUnavailable() : responsesOk()));
		const message = await collect(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol"), context, {
				apiKey: "k",
				fetch,
				serviceTier: "flex",
			}),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent).toEqual([{ model: "gpt-6.1-sol", serviceTier: "flex" }, { model: "gpt-6.1-sol" }]);
	});

	it("completions: re-aims a refused flex route at its standard peer and completes", async () => {
		const { fetch, sent } = recordingFetch(entry =>
			entry.model.endsWith("-flex") ? tierUnavailable() : completionsOk(),
		);
		const message = await collect(
			streamOpenAICompletions(completionsModel("gpt-6.1-sol-flex"), context, {
				apiKey: "k",
				fetch,
			}),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol"]);
	});

	it("responses: a recovered turn is not accounted at the tier the host refused", async () => {
		// The response carries no `service_tier` echo, so accounting falls back to
		// what the request asked for. After the retry dropped the field, that must
		// be standard — billing a standard turn at the flex rate halves the cost.
		const { fetch } = recordingFetch(entry => (entry.serviceTier ? tierUnavailable() : responsesOk()));
		const message = await collect(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol"), context, {
				apiKey: "k",
				fetch,
				serviceTier: "flex",
			}),
		);
		expect(message.stopReason).toBe("stop");
		expect(message.serviceTier).not.toBe("flex");
	});

	it("responses: the standard peer survives a later strict-tools repair", async () => {
		// The strict-tools fallback rebuilds the request from the original model.
		// Without carrying the tier selection across that rebuild it resurrects
		// the refused flex id, and the turn fails on a route that would serve it.
		const { fetch, sent } = recordingFetch(entry => {
			if (entry.model.endsWith("-flex")) return tierUnavailable();
			if (sent.length === 2) return strictToolsRejection();
			return responsesOk();
		});
		const message = await collect(
			streamOpenAIResponses(
				responsesModel("gpt-6.1-sol-flex"),
				{ ...context, tools: [echoTool] },
				{
					apiKey: "k",
					fetch,
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol", "gpt-6.1-sol"]);
	});

	it("completions: a strict-tools rejection of the standard peer is still repaired", async () => {
		// The capacity retry must re-enter the repair loop, not run beside it:
		// a rejection of the resent request has to reach the strict-tools branch.
		const { fetch, sent } = recordingFetch(entry => {
			if (entry.model.endsWith("-flex")) return tierUnavailable();
			if (sent.length === 2) return strictToolsRejection();
			return completionsOk();
		});
		const message = await collect(
			streamOpenAICompletions(
				completionsModel("gpt-6.1-sol-flex"),
				{ ...context, tools: [echoTool] },
				{
					apiKey: "k",
					fetch,
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol", "gpt-6.1-sol"]);
	});

	it("responses: a request with no reroute keeps its transport retry", async () => {
		// Capacity can return between attempts. Declining the transport retry is
		// only sound where a reroute replaces it; a plain id with no tier field
		// has none, so resending stays its only recovery.
		let refusals = 0;
		const { fetch, sent } = recordingFetch(() => (refusals++ === 0 ? tierUnavailable() : responsesOk()));
		const message = await collect(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol"), context, { apiKey: "k", fetch }),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
	});

	it("responses: an onPayload hook cannot restate the refused route after a repair", async () => {
		// The hook is handed the model row, whose id is still the tier one, so a
		// hook that echoes it back would undo the recovery on every rebuilt
		// request — and the one-shot guard is already spent by then.
		const { fetch, sent } = recordingFetch(entry => {
			if (entry.model.endsWith("-flex")) return tierUnavailable();
			if (sent.length === 2) return strictToolsRejection();
			return responsesOk();
		});
		const message = await collect(
			streamOpenAIResponses(
				responsesModel("gpt-6.1-sol-flex"),
				{ ...context, tools: [echoTool] },
				{ apiKey: "k", fetch, onPayload: payload => ({ ...(payload as object), model: "gpt-6.1-sol-flex" }) },
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol", "gpt-6.1-sol"]);
	});

	it("responses: an onPayload hook's own choice of a third model stands", async () => {
		// The re-aim exists to stop a hook restating the route the host refused,
		// not to override a model the hook deliberately picked for its own reasons.
		// The hook only runs again on a rebuilt request, so this needs a repair
		// after the reroute: flex is refused, the peer rejects strict tools, and
		// the hook then picks a third model for the non-strict rebuild.
		const { fetch, sent } = recordingFetch(entry => {
			if (entry.model.endsWith("-flex")) return tierUnavailable();
			if (sent.length === 2) return strictToolsRejection();
			return responsesOk();
		});
		const message = await collect(
			streamOpenAIResponses(
				responsesModel("gpt-6.1-sol-flex"),
				{ ...context, tools: [echoTool] },
				{
					apiKey: "k",
					fetch,
					onPayload: payload => {
						const body = payload as { model?: unknown };
						return body.model === "gpt-6.1-sol" ? { ...body, model: "third-responses-reasoner" } : body;
					},
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol", "third-responses-reasoner"]);
	});

	it("factory-droid: its OpenAI-wire tier routes recover on the standard peer too", async () => {
		// Factory delegates `gpt-*-ultrafast` to the Responses streamer, so the
		// recovery reaches a real public adapter with a catalog-declared tier
		// route — not only the hand-built models above.
		const sent: { model: string; serviceTier?: string }[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; service_tier?: string };
			sent.push({ model: String(body.model), ...(body.service_tier ? { serviceTier: body.service_tier } : {}) });
			return body.model?.endsWith("-ultrafast") ? tierUnavailable("ultrafast_unavailable") : responsesOk();
		};
		const message = await streamFactoryDroid(factoryModel("gpt-6.1-sol-ultrafast"), context, {
			apiKey: WORKOS_TOKEN,
			fetch,
		}).result();
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-ultrafast", "gpt-6.1-sol"]);
		expect(sent[1]?.serviceTier).toBeUndefined();
	});
});
