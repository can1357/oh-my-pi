import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	pollOpenAIResponsesResultForCompletion,
	streamOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const SOCKET_CLOSE =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

/** The shipped bundled rows: resume must work on the first request, before any discovery. */
function bundledModel(provider: "muse-code" | "openai"): Model<"openai-responses"> {
	const model = getBundledModel<"openai-responses">(provider, provider === "muse-code" ? "muse-spark-1.3" : "gpt-5");
	if (!model || model.api !== "openai-responses") throw new Error(`Expected bundled ${provider} Responses model`);
	return model;
}

function sseFrame(payload: { type: string }): string {
	return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * SSE body that delivers the created event and partial reasoning (plus, when
 * given, already-visible answer text) on the first read, then fails the next
 * read like a socket dropped mid-body. Pull-driven, so the drop is ordered by
 * the consumer, not a timer.
 */
function dyingSseBody(
	responseId: string,
	committedText?: string,
	completedReasoning = false,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const frames: Array<{ type: string }> = [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: responseId, object: "response", status: "in_progress", output: [] },
		} as { type: string },
		{
			type: "response.output_item.added",
			output_index: 0,
			sequence_number: 1,
			item: { id: "rs_1", type: "reasoning", summary: [] },
		} as { type: string },
		{
			type: "response.reasoning_summary_text.delta",
			output_index: 0,
			item_id: "rs_1",
			sequence_number: 2,
			delta: "partial plan",
		} as { type: string },
	];
	if (completedReasoning) {
		// The reasoning item finished before the drop, so its native item was
		// already recorded for chaining.
		frames.push({
			type: "response.output_item.done",
			output_index: 0,
			sequence_number: 3,
			item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "partial plan" }] },
		} as { type: string });
	}
	if (committedText !== undefined) {
		frames.push(
			{
				type: "response.output_item.added",
				output_index: 1,
				sequence_number: 3,
				item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },
			} as { type: string },
			{
				type: "response.output_text.delta",
				output_index: 1,
				item_id: "msg_0",
				content_index: 0,
				sequence_number: 4,
				delta: committedText,
			} as { type: string },
		);
	}
	const payload = frames.map(sseFrame).join("");
	let delivered = false;
	return new ReadableStream({
		pull(controller) {
			if (!delivered) {
				delivered = true;
				controller.enqueue(encoder.encode(payload));
				return;
			}
			controller.error(new Error(SOCKET_CLOSE));
		},
	});
}

function completedResult(responseId: string): Record<string, unknown> {
	return {
		id: responseId,
		object: "response",
		status: "completed",
		output: [
			{ id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "full resumed plan" }] },
			{
				id: "msg_1",
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "adopted answer", annotations: [] }],
			},
		],
		usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
	};
}

interface DropScenario {
	fetchImpl: FetchImpl;
	posts: string[];
	gets: string[];
	postBodies: unknown[];
}

function dropScenario(
	responseId: string,
	pollResponses: Array<() => Response>,
	options: { committedText?: string; completedReasoning?: boolean } = {},
): DropScenario {
	const posts: string[] = [];
	const gets: string[] = [];
	const postBodies: unknown[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		const target = String(url);
		if (target.endsWith("/responses")) {
			posts.push(target);
			postBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(dyingSseBody(responseId, options.committedText, options.completedReasoning), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		gets.push(target);
		const next = pollResponses[Math.min(gets.length - 1, pollResponses.length - 1)];
		if (!next) throw new Error("Expected a scripted poll response");
		return next();
	}) as FetchImpl;
	return { fetchImpl, posts, gets, postBodies };
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] };
// Poll sleeps and transient-retry backoff go through the injectable wait seam.
const noWait = async (): Promise<void> => {};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses socket-drop resume", () => {
	it("adopts the stored result on the bundled muse-code model instead of replaying the turn", async () => {
		// The run keeps going server-side after the socket dies: an in-flight 404
		// first, then the finished result. The shipped model stores results on its
		// first request, and the turn adopts the result with one POST.
		const scenario = dropScenario("resp_resume1", [
			() => new Response("{}", { status: 404 }),
			() => new Response(JSON.stringify(completedResult("resp_resume1")), { status: 200 }),
		]);
		const result = await streamOpenAIResponses(bundledModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(scenario.postBodies[0]).toMatchObject({ store: true });
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_resume1");
		expect(scenario.posts).toHaveLength(1);
		expect(scenario.gets).toEqual([
			"https://api.meta.ai/v1/responses/resp_resume1",
			"https://api.meta.ai/v1/responses/resp_resume1",
		]);
		const thinking = result.content.find(block => block.type === "thinking");
		if (!thinking || thinking.type !== "thinking") throw new Error("Expected adopted thinking block");
		expect(thinking.thinking).toContain("full resumed plan");
		const text = result.content.find(block => block.type === "text");
		if (!text || text.type !== "text") throw new Error("Expected adopted text block");
		expect(text.text).toBe("adopted answer");
	});

	it("delivers the adopted answer to delta-only consumers", async () => {
		// ACP renders only `text_delta` chunks and suppresses the final `done` text
		// once any delta arrived. The adopted answer must therefore arrive as
		// deltas, and what a delta-only consumer rendered must equal the final text.
		const scenario = dropScenario("resp_resume4", [
			() => new Response(JSON.stringify(completedResult("resp_resume4")), { status: 200 }),
		]);
		const stream = streamOpenAIResponses(bundledModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		const rendered = events.flatMap(event => (event.type === "text_delta" ? [event.delta] : [])).join("");
		const finalText = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
		expect(finalText).toBe("adopted answer");
		expect(rendered).toBe(finalText);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("does not resume once answer text already reached the client", async () => {
		// A delta-only consumer cannot retract text it rendered, so adopting a
		// stored answer after visible text would leave the client showing stale
		// output. The drop must fall through to the normal failure path instead.
		const scenario = dropScenario(
			"resp_resume5",
			[() => new Response(JSON.stringify(completedResult("resp_resume5")), { status: 200 })],
			{ committedText: "draft" },
		);
		const result = await streamOpenAIResponses(bundledModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(scenario.gets).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/socket connection was closed/);
	});

	it("keeps the socket failure when the stored result is definitively rejected", async () => {
		const scenario = dropScenario("resp_resume2", [() => new Response("gone", { status: 403 })]);
		const result = await streamOpenAIResponses(bundledModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/socket connection was closed/);
		expect(scenario.posts).toHaveLength(1);
		expect(scenario.gets).toHaveLength(1);
		// The dead partial is restored for the caller's retry policy.
		const thinking = result.content.find(block => block.type === "thinking");
		if (!thinking || thinking.type !== "thinking") throw new Error("Expected the dead partial's thinking block");
		expect(thinking.thinking).toBe("partial plan");
	});

	it("never polls for hosts that do not store results", async () => {
		// `store: false` runs are unrecoverable (verified: 404 indefinitely), so a
		// non-storing host must fail fast instead of burning the poll budget.
		const scenario = dropScenario("resp_resume3", [
			() => new Response(JSON.stringify(completedResult("resp_resume3")), { status: 200 }),
		]);
		const result = await streamOpenAIResponses(bundledModel("openai"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(scenario.postBodies[0]).toMatchObject({ store: false });
		expect(result.stopReason).toBe("error");
		expect(scenario.gets).toEqual([]);
	});

	it("records each adopted output item once when reasoning finished before the drop", async () => {
		// The replay re-emits every output item. A reasoning item that already hit
		// `output_item.done` before the drop must not be recorded twice: the history
		// payload feeds `previous_response_id` chaining, and a duplicate item id is
		// rejected by the Responses API on the next turn.
		const scenario = dropScenario(
			"resp_resume6",
			[() => new Response(JSON.stringify(completedResult("resp_resume6")), { status: 200 })],
			{ completedReasoning: true },
		);
		const result = await streamOpenAIResponses(bundledModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(result.stopReason).toBe("stop");
		const payload = result.providerPayload;
		if (payload?.type !== "openaiResponsesHistory") throw new Error("Expected a Responses history payload");
		expect(payload.items.map(item => item.id)).toEqual(["rs_1", "msg_1"]);
	});

	it("never polls when only stateful chaining forces store on a non-storing host", async () => {
		// Official OpenAI turns chained through `previous_response_id` send
		// `store: true`, but that host is not known to finish a dropped run
		// server-side. Resume follows the host contract, not the wire flag, so the
		// drop fails fast as before instead of parking the turn on polls.
		const scenario = dropScenario("resp_resume7", [
			() => new Response(JSON.stringify(completedResult("resp_resume7")), { status: 200 }),
		]);
		const result = await streamOpenAIResponses(bundledModel("openai"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
			sessionId: "stateful-session",
			providerSessionState: new Map(),
		}).result();

		expect(scenario.postBodies[0]).toMatchObject({ store: true });
		expect(result.stopReason).toBe("error");
		expect(scenario.gets).toEqual([]);
	});
});

describe("pollOpenAIResponsesResultForCompletion", () => {
	const url = "https://api.meta.ai/v1/responses/resp_poll1";
	const headers = { authorization: "Bearer test-key" };

	function sequencedFetch(statuses: Array<{ status: number; body?: unknown }>): {
		fetchImpl: FetchImpl;
		calls: number[];
	} {
		const calls: number[] = [];
		const fetchImpl = (async () => {
			const next = statuses[Math.min(calls.length, statuses.length - 1)];
			calls.push(1);
			if (!next) throw new Error("Expected a scripted poll status");
			return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
		}) as FetchImpl;
		return { fetchImpl, calls };
	}

	it("returns the completed result after in-flight 404s", async () => {
		const { fetchImpl, calls } = sequencedFetch([
			{ status: 404 },
			{ status: 404 },
			{ status: 200, body: completedResult("resp_poll1") },
		]);
		const result = await pollOpenAIResponsesResultForCompletion({
			fetchImpl,
			url,
			headers,
			responseId: "resp_poll1",
			wait: noWait,
		});
		expect(result).toMatchObject({ id: "resp_poll1", status: "completed" });
		expect(calls).toHaveLength(3);
	});

	it("adopts an incomplete result that already has output", async () => {
		const incomplete = { ...completedResult("resp_poll1"), status: "incomplete" };
		const { fetchImpl, calls } = sequencedFetch([{ status: 200, body: incomplete }]);
		const result = await pollOpenAIResponsesResultForCompletion({
			fetchImpl,
			url,
			headers,
			responseId: "resp_poll1",
			wait: noWait,
		});
		expect(result).toMatchObject({ status: "incomplete" });
		expect(calls).toHaveLength(1);
	});

	it("gives up at once on failed runs, rejections, and a mismatched id", async () => {
		for (const scripted of [
			{ status: 200, body: { id: "resp_poll1", status: "failed", error: { message: "boom" } } },
			{ status: 403 },
			{ status: 200, body: { id: "resp_other", status: "completed", output: [] } },
		]) {
			const { fetchImpl, calls } = sequencedFetch([scripted]);
			expect(
				await pollOpenAIResponsesResultForCompletion({
					fetchImpl,
					url,
					headers,
					responseId: "resp_poll1",
					wait: noWait,
				}),
			).toBeUndefined();
			expect(calls).toHaveLength(1);
		}
	});

	it("stops after the request backstop when the run never finishes", async () => {
		const { fetchImpl, calls } = sequencedFetch([{ status: 404 }]);
		expect(
			await pollOpenAIResponsesResultForCompletion({
				fetchImpl,
				url,
				headers,
				responseId: "resp_poll1",
				wait: noWait,
			}),
		).toBeUndefined();
		expect(calls).toHaveLength(24);
	});

	it("bounds recovery by wall-clock time when each request stalls", async () => {
		// Each GET burns its full 30s timeout. Counting requests alone would let
		// 24 stalled requests hold the failed turn ~14 minutes; the deadline must
		// end recovery within the 2-minute budget instead.
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const calls: number[] = [];
		const fetchImpl = (async () => {
			calls.push(now);
			now += 30_000;
			return new Response("", { status: 404 });
		}) as FetchImpl;
		const result = await pollOpenAIResponsesResultForCompletion({
			fetchImpl,
			url,
			headers,
			responseId: "resp_poll1",
			wait: async ms => {
				now += ms;
			},
		});

		expect(result).toBeUndefined();
		expect(calls).toEqual([0, 35_000, 70_000, 105_000]);
	});

	it("does not poll once the caller has aborted", async () => {
		const { fetchImpl, calls } = sequencedFetch([{ status: 404 }]);
		const controller = new AbortController();
		controller.abort();
		expect(
			await pollOpenAIResponsesResultForCompletion({
				fetchImpl,
				url,
				headers,
				responseId: "resp_poll1",
				signal: controller.signal,
				wait: noWait,
			}),
		).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});
