import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { serviceTierPeerFor } from "@oh-my-pi/pi-catalog/compat/behavior";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

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

	it("responses: resending the refused id unchanged would not recover, so the peer is tried once and the failure surfaces", async () => {
		// Every id is refused: this is what a plain same-id retry looks like, and
		// it is why the id change is the fix rather than another attempt.
		const { fetch, sent } = recordingFetch(() => tierUnavailable());
		const failure = await drainToFailure(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol-flex"), context, { apiKey: "k", fetch }),
		);
		expect(failure).toMatch(/service tier is currently unavailable/i);
		// Exactly two attempts: the flex route, then its peer. No busy loop.
		expect(sent.map(entry => entry.model)).toEqual(["gpt-6.1-sol-flex", "gpt-6.1-sol"]);
	});

	it("responses: a request that named no tier is not re-aimed", async () => {
		// An ordinary 500 carrying the code on a plain id has nothing to change;
		// re-sending identical bytes would only ask the same absent pool again.
		const { fetch, sent } = recordingFetch(() => tierUnavailable());
		const failure = await drainToFailure(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol"), context, { apiKey: "k", fetch }),
		);
		expect(failure).toMatch(/service tier is currently unavailable/i);
		expect(sent).toHaveLength(1);
	});

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
});
