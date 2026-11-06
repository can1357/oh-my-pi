import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamFactoryDroid } from "@oh-my-pi/pi-ai/providers/factory-droid";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { serviceTierPeerFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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

function completionsOk(servedServiceTier?: string): Response {
	const chunks = [
		{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
		{
			id: "c",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			...(servedServiceTier === undefined ? {} : { service_tier: servedServiceTier }),
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
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

/**
 * A tier route's own cost card. A host that sells a tier sells it at its own
 * rate — OpenAI's flex lists at half the standard pool — and which of the two
 * cards a recovered turn is billed at is the whole accounting question here.
 * Both cards must be nonzero and must differ, or every cost assertion in this
 * file passes whatever the code does.
 */
const TIER_ROUTE_COST = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 };
/** What the same row costs where its id names no tier: twice the flex rate. */
const PLAIN_ROUTE_COST = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const TIER_SUFFIXED_ID = /-(?:flex|scale|priority|ultrafast|fast)$/;

function responsesModel(id: string): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.test/v1",
		reasoning: false,
		input: ["text"],
		cost: TIER_SUFFIXED_ID.test(id) ? TIER_ROUTE_COST : PLAIN_ROUTE_COST,
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
		cost: TIER_SUFFIXED_ID.test(id) ? TIER_ROUTE_COST : PLAIN_ROUTE_COST,
		contextWindow: 200_000,
		maxTokens: 32_000,
	}) as Model<"openai-completions">;
}

/**
 * A CoralBricks row. Coral renamed its GLM slug to `glm-5.3-fast` on
 * 2026-10-07 and ships no `glm-5.3`
 * (`compat/rules/providers/coralbricks.kdl`), so the suffix there is part of
 * the model's name, not a lane onto a sibling.
 */
function coralbricksModel(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "coralbricks",
		baseUrl: "https://inference.coralbricks.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.12, output: 4.4, cacheRead: 0, cacheWrite: 1.68 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
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

	it("reads the standard peer of a tier-suffixed wire id on the hosts that declare one", () => {
		expect(serviceTierPeerFor("openai", "gpt-6.1-sol-flex")).toEqual({ peerId: "gpt-6.1-sol", tier: "flex" });
		// `-ultrafast` must never be read as the shorter `-fast`.
		expect(serviceTierPeerFor("factory-droid", "gpt-6.1-sol-ultrafast")).toEqual({
			peerId: "gpt-6.1-sol",
			tier: "ultrafast",
		});
		expect(serviceTierPeerFor("factory-droid", "gpt-6-sol-fast")).toEqual({
			peerId: "gpt-6-sol",
			tier: "priority",
		});
		// An id carrying none of the host's suffixes, and one that is nothing but
		// the suffix, both have no peer.
		expect(serviceTierPeerFor("openai", "gpt-6.1-sol")).toBeUndefined();
		expect(serviceTierPeerFor("openai", "-flex")).toBeUndefined();
		// The spelling is not the rule. `-fast` is CoralBricks' renamed GLM slug
		// (it ships no `glm-5.3`) and xAI's separately priced Grok 4 Fast model,
		// so neither host may have a peer invented for it — and the hosts that do
		// declare `-fast` do not thereby declare it everywhere.
		expect(serviceTierPeerFor("coralbricks", "glm-5.3-fast")).toBeUndefined();
		expect(serviceTierPeerFor("xai", "grok-4-fast")).toBeUndefined();
		expect(serviceTierPeerFor("openai", "gpt-6.1-sol-fast")).toBeUndefined();
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

	it("responses: a rebuild is re-aimed even when a hook chose the route that was refused", async () => {
		// The hook can change the model on the very first attempt, so the route the
		// host refuses is the hook's, not the builder's. A later rebuild starts from
		// the builder's id again, which never matched the refused one — so the
		// fresh-build re-aim has to be unconditional, and only the post-hook one
		// may compare.
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
						return body.model === "gpt-6.1-sol-flex" ? { ...body, model: "hook-reasoner-flex" } : body;
					},
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["hook-reasoner-flex", "hook-reasoner", "hook-reasoner"]);
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

	it("responses: a turn recovered onto the standard peer is billed at the peer's rate", async () => {
		// The tier row lists at half its peer. Once the recovery rewrote the wire
		// id the standard SKU served the turn, so the peer's card is the charge;
		// keeping the refused row's card under-reports the spend by the discount
		// the host just declined to honour.
		const peer = getBundledModel("openai", "gpt-6.1-sol");
		const { fetch } = recordingFetch(entry => (entry.model.endsWith("-flex") ? tierUnavailable() : responsesOk()));
		const message = await collect(
			streamOpenAIResponses(responsesModel("gpt-6.1-sol-flex"), context, { apiKey: "k", fetch }),
		);
		expect(message.stopReason).toBe("stop");
		// `responsesOk` reports one input and one output token.
		expect(message.usage.cost.total).toBeCloseTo((peer.cost.input + peer.cost.output) / 1_000_000, 12);
		expect(message.usage.cost.total).not.toBeCloseTo(
			(TIER_ROUTE_COST.input + TIER_ROUTE_COST.output) / 1_000_000,
			12,
		);
	});

	it("completions: a turn recovered onto the standard peer is billed at the peer's rate", async () => {
		const peer = getBundledModel("openai", "gpt-6.1-sol");
		const { fetch } = recordingFetch(entry => (entry.model.endsWith("-flex") ? tierUnavailable() : completionsOk()));
		const message = await collect(
			streamOpenAICompletions(completionsModel("gpt-6.1-sol-flex"), context, { apiKey: "k", fetch }),
		);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBeCloseTo((peer.cost.input + peer.cost.output) / 1_000_000, 12);
		expect(message.usage.cost.total).not.toBeCloseTo(
			(TIER_ROUTE_COST.input + TIER_ROUTE_COST.output) / 1_000_000,
			12,
		);
	});

	it("responses: a turn a hook re-routed after recovery is billed at the model that served it", async () => {
		// The recovery picks a peer, but an `onPayload` hook can send somewhere
		// else entirely on a later rebuild. The charge follows the route the host
		// accepted — pricing the remembered peer under-reports a dearer model.
		const served = getBundledModel("openai", "gpt-6-astra");
		const peer = getBundledModel("openai", "gpt-6.1-sol");
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
						return body.model === "gpt-6.1-sol" ? { ...body, model: "gpt-6-astra" } : body;
					},
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.at(-1)?.model).toBe("gpt-6-astra");
		expect(message.usage.cost.total).toBeCloseTo((served.cost.input + served.cost.output) / 1_000_000, 12);
		// Neither the remembered peer's card nor the refused row's.
		expect(message.usage.cost.total).not.toBeCloseTo((peer.cost.input + peer.cost.output) / 1_000_000, 12);
		expect(message.usage.cost.total).not.toBeCloseTo(
			(TIER_ROUTE_COST.input + TIER_ROUTE_COST.output) / 1_000_000,
			12,
		);
	});

	it("completions: a turn a hook re-routed after recovery is billed at the model that served it", async () => {
		const served = getBundledModel("openai", "gpt-6-astra");
		const peer = getBundledModel("openai", "gpt-6.1-sol");
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
					onPayload: payload => {
						const body = payload as { model?: unknown };
						return body.model === "gpt-6.1-sol" ? { ...body, model: "gpt-6-astra" } : body;
					},
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.at(-1)?.model).toBe("gpt-6-astra");
		expect(message.usage.cost.total).toBeCloseTo((served.cost.input + served.cost.output) / 1_000_000, 12);
		expect(message.usage.cost.total).not.toBeCloseTo((peer.cost.input + peer.cost.output) / 1_000_000, 12);
	});

	it("responses: a peer the bundle does not carry leaves the refused row's own card in place", async () => {
		// The peer id is a route, not a price: a row discovered off a gateway has
		// no bundled sibling to read a card from. Reporting the row's own rate is
		// a known under-report; inventing a rate for a model the catalog has never
		// seen would be worse, so the recovery changes the route and not the card.
		const { fetch, sent } = recordingFetch(entry =>
			entry.model.endsWith("-flex") ? tierUnavailable() : responsesOk(),
		);
		const message = await collect(
			streamOpenAIResponses(responsesModel("qa-capacity-probe-flex"), context, { apiKey: "k", fetch }),
		);
		expect(sent.map(entry => entry.model)).toEqual(["qa-capacity-probe-flex", "qa-capacity-probe"]);
		expect(message.usage.cost.total).toBeCloseTo((TIER_ROUTE_COST.input + TIER_ROUTE_COST.output) / 1_000_000, 12);
	});

	it("completions: a capacity refusal where `-fast` is a renamed slug invents no peer", async () => {
		// CoralBricks ships `glm-5.3-fast` and no `glm-5.3`. A capacity code on
		// its own says nothing about what the suffix means, so the id must stay
		// put: stripping it would turn a transient refusal into a request for a
		// model that does not exist. With no reroute, the transport retry — the
		// only recovery such a host has — stays available.
		let refusals = 0;
		const { fetch, sent } = recordingFetch(() =>
			refusals++ === 0 ? tierUnavailable("service_tier_unavailable") : completionsOk(),
		);
		const message = await collect(
			streamOpenAICompletions(coralbricksModel("glm-5.3-fast"), context, { apiKey: "k", fetch }),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.map(entry => entry.model)).toEqual(["glm-5.3-fast", "glm-5.3-fast"]);
	});

	it("responses: a recovered turn is billed at the tier policy of the model that served it", async () => {
		// `gpt-5-mini-flex` is refused, the recovery aims at `gpt-5-mini`, and a
		// hook re-routes the non-strict rebuild to Astra on the ultrafast tier.
		// Astra's card is already read for the base charge; its tier table has to
		// come from the same row, or the turn is billed at 1x for a 6x tier.
		const served = getBundledModel("openai", "gpt-6-astra");
		expect(served.serviceTierCost?.ultrafast).toBe(6);
		const { fetch, sent } = recordingFetch(entry => {
			if (entry.model.endsWith("-flex")) return tierUnavailable();
			if (sent.length === 2) return strictToolsRejection();
			return responsesOk();
		});
		const message = await collect(
			streamOpenAIResponses(
				responsesModel("gpt-5-mini-flex"),
				{ ...context, tools: [echoTool] },
				{
					apiKey: "k",
					fetch,
					onPayload: payload => {
						const body = payload as { model?: unknown };
						return body.model === "gpt-5-mini"
							? { ...body, model: "gpt-6-astra", service_tier: "ultrafast" }
							: body;
					},
				},
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent.at(-1)).toEqual({ model: "gpt-6-astra", serviceTier: "ultrafast" });
		expect(message.serviceTier).toBe("ultrafast");
		expect(message.usage.premiumRequests).toBe(1);
		// One input and one output token on Astra's card, at Astra's 6x ultrafast rate.
		expect(message.usage.cost.total).toBeCloseTo((6 * (served.cost.input + served.cost.output)) / 1_000_000, 12);
		// The card alone, with the refused row's (absent) tier table: the 1x answer.
		expect(message.usage.cost.total).not.toBeCloseTo((served.cost.input + served.cost.output) / 1_000_000, 12);
	});

	it("completions: the served tier is accounted on this wire too, at the served route's policy", async () => {
		// The Completions wire sends `service_tier` and never accounted for it:
		// no recorded tier, no premium request, and no multiplier. Each row picks
		// its multiplier from a different place — Astra's published ultrafast
		// entry, the API-generic priority default, and the response echo that
		// overrides what the request asked for.
		const served = getBundledModel("openai", "gpt-6-astra");
		const base = (served.cost.input + served.cost.output) / 1_000_000;
		const rows = [
			{ requested: "ultrafast", echoed: undefined, tier: "ultrafast", multiplier: 6, premium: 1 },
			{ requested: "priority", echoed: undefined, tier: "priority", multiplier: 2, premium: 1 },
			// The host downgraded the turn it served; the echo, not the ask, is billed.
			{ requested: "ultrafast", echoed: "default", tier: "default", multiplier: 1, premium: 0 },
		] as const;
		for (const row of rows) {
			const { fetch, sent } = recordingFetch(entry => {
				if (entry.model.endsWith("-flex")) return tierUnavailable();
				if (sent.length === 2) return strictToolsRejection();
				return completionsOk(row.echoed);
			});
			const message = await collect(
				streamOpenAICompletions(
					completionsModel("gpt-5-mini-flex"),
					{ ...context, tools: [echoTool] },
					{
						apiKey: "k",
						fetch,
						onPayload: payload => {
							const body = payload as { model?: unknown };
							return body.model === "gpt-5-mini"
								? { ...body, model: "gpt-6-astra", service_tier: row.requested }
								: body;
						},
					},
				),
			);
			expect(message.stopReason).toBe("stop");
			expect(sent.at(-1)).toEqual({ model: "gpt-6-astra", serviceTier: row.requested });
			expect(message.serviceTier).toBe(row.tier);
			expect(message.usage.premiumRequests).toBe(row.premium);
			expect(message.usage.cost.total).toBeCloseTo(row.multiplier * base, 12);
		}
	});

	it("responses: the Copilot premium weight follows the route that served the turn", async () => {
		// Copilot bills a premium request per model, and the weight is read off
		// the row before the request goes out. Here the body that went out names
		// another model — the hook's — so the refused row's 0.33 is not what the
		// account was charged. Copilot never asks for a tier itself; the hook's
		// body is what the host refused for want of tier capacity, and the resend
		// it licenses is served on the hook's route.
		const row = getBundledModel("github-copilot", "gpt-5.4-mini") as Model<"openai-responses">;
		const served = getBundledModel("github-copilot", "gpt-6-astra");
		expect(row.premiumMultiplier).toBe(0.33);
		expect(served.premiumMultiplier).toBeUndefined();
		const { fetch, sent } = recordingFetch(entry => (entry.serviceTier ? tierUnavailable() : responsesOk()));
		const message = await collect(
			streamOpenAIResponses(row, context, {
				apiKey: "k",
				fetch,
				onPayload: payload => ({ ...(payload as object), model: "gpt-6-astra", service_tier: "flex" }),
			}),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent).toEqual([{ model: "gpt-6-astra", serviceTier: "flex" }, { model: "gpt-6-astra" }]);
		expect(message.usage.premiumRequests).toBe(1);
		expect(message.usage.cost.total).toBeCloseTo((served.cost.input + served.cost.output) / 1_000_000, 12);
		expect(message.usage.cost.total).not.toBeCloseTo((row.cost.input + row.cost.output) / 1_000_000, 12);
	});

	it("completions: the Copilot premium weight follows the route that served the turn", async () => {
		const row = getBundledModel("github-copilot", "grok-code-fast-1") as Model<"openai-completions">;
		const served = getBundledModel("github-copilot", "kimi-k2.7-code");
		expect(row.premiumMultiplier).toBe(0.25);
		expect(served.premiumMultiplier).toBeUndefined();
		const { fetch, sent } = recordingFetch(entry => (entry.serviceTier ? tierUnavailable() : completionsOk()));
		const message = await collect(
			streamOpenAICompletions(row, context, {
				apiKey: "k",
				fetch,
				onPayload: payload => ({ ...(payload as object), model: "kimi-k2.7-code", service_tier: "flex" }),
			}),
		);
		expect(message.stopReason).toBe("stop");
		expect(sent).toEqual([{ model: "kimi-k2.7-code", serviceTier: "flex" }, { model: "kimi-k2.7-code" }]);
		expect(message.usage.premiumRequests).toBe(1);
		expect(message.usage.cost.total).toBeCloseTo((served.cost.input + served.cost.output) / 1_000_000, 12);
	});
});
