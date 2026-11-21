import { describe, expect, test } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { type ResponsesWireEvent, sse } from "./fixtures/openai-responses-server";

// Meta answers this 400 for a replayed blob it no longer honors (key rotation,
// another credential, idle resume); OpenCode's gateway wraps the same refusal.
const META_REFUSAL = "reasoning `encrypted_content` was not issued to this caller";
const GATEWAY_REFUSAL = `Upstream request failed: [invalid_request_error] ${META_REFUSAL}`;

const model: Model<"openai-responses"> = buildModel(
	seedModels<"openai-responses">("meta").find(spec => spec.id === "muse-spark-1.3")!,
);

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A tool-call turn and an answer turn, both carrying encrypted reasoning the server no longer honors. */
function staleHistory(): Context {
	return {
		messages: [
			{ role: "user", content: "list files", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_ls|fc_ls", name: "bash", arguments: { command: "ls" } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "toolUse",
				providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
					{ type: "reasoning", id: "rs_dead_1", summary: [], encrypted_content: "dead-blob-1" },
					{
						type: "function_call",
						id: "fc_ls",
						call_id: "call_ls",
						name: "bash",
						arguments: '{"command":"ls"}',
						status: "completed",
					},
				]),
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_ls|fc_ls",
				toolName: "bash",
				content: [{ type: "text", text: "README.md" }],
				isError: false,
				timestamp: 3,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Found README.md." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "stop",
				providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
					{ type: "reasoning", id: "rs_dead_2", summary: [], encrypted_content: "dead-blob-2" },
					{
						type: "message",
						id: "msg_found",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Found README.md.", annotations: [] }],
					},
				]),
				timestamp: 4,
			},
			{ role: "user", content: "summarize it", timestamp: 5 },
		],
	};
}

function refusal(message: string): Response {
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

/** A successful turn whose reasoning carries a blob issued by the current key. */
function answer(text: string, blob: string, id: string): ResponsesWireEvent[] {
	const reasoning = { type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: blob };
	const message = {
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
		{ type: "response.output_item.done", output_index: 0, item: reasoning },
		{ type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			output_index: 1,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 1, item: message },
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [reasoning, message],
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	];
}

type WireItem = { type?: string; role?: string; call_id?: string; encrypted_content?: unknown; content?: unknown };

/** Serves `responses` in order and records every request body. */
function scriptedFetch(responses: Array<() => Response>) {
	const bodies: Array<{ input: WireItem[] }> = [];
	const fetch: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		const next = responses[bodies.length - 1];
		if (!next) throw new Error(`unexpected request ${bodies.length}`);
		return next();
	};
	return { fetch, bodies };
}

function blobs(input: WireItem[]): unknown[] {
	return input.filter(item => item.type === "reasoning").map(item => item.encrypted_content);
}

function assistantTexts(input: WireItem[]): string[] {
	return input
		.filter(item => item.type === "message" && item.role === "assistant" && Array.isArray(item.content))
		.flatMap(item => (item.content as Array<{ type: string; text?: string }>).map(part => part.text ?? ""));
}

describe("Responses replay of refused encrypted reasoning", () => {
	test("retries once without the refused blobs and keeps visible text and tool history", async () => {
		const { fetch, bodies } = scriptedFetch([
			() => refusal(GATEWAY_REFUSAL),
			() => sse(answer("Summary.", "fresh-blob", "resp_recovered")),
		]);

		const result = await streamOpenAIResponses(model, staleHistory(), { apiKey: "key", fetch }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Summary." }));
		expect(bodies).toHaveLength(2);
		expect(blobs(bodies[0].input)).toEqual(["dead-blob-1", "dead-blob-2"]);
		const retried = bodies[1].input;
		expect(blobs(retried)).toEqual([]);
		expect(retried.filter(item => item.type === "function_call").map(item => item.call_id)).toEqual(["call_ls"]);
		expect(retried.filter(item => item.type === "function_call_output").map(item => item.call_id)).toEqual([
			"call_ls",
		]);
		expect(assistantTexts(retried)).toEqual(["Found README.md."]);
		expect(retried.filter(item => item.role === "user")).toHaveLength(2);
	});

	test("surfaces a second refusal after exactly one retry", async () => {
		const { fetch, bodies } = scriptedFetch([() => refusal(META_REFUSAL), () => refusal(META_REFUSAL)]);

		const result = await streamOpenAIResponses(model, staleHistory(), { apiKey: "key", fetch }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("was not issued to this caller");
		expect(bodies).toHaveLength(2);
	});

	test("recovers an in-stream refusal only while no output has streamed", async () => {
		const inStreamRefusal = { type: "error", code: "invalid_request_error", message: META_REFUSAL, param: null };

		const beforeOutput = scriptedFetch([
			() => sse([inStreamRefusal]),
			() => sse(answer("Summary.", "fresh-blob", "resp_recovered")),
		]);
		const recovered = await streamOpenAIResponses(model, staleHistory(), {
			apiKey: "key",
			fetch: beforeOutput.fetch,
		}).result();
		expect(recovered.stopReason).toBe("stop");
		expect(beforeOutput.bodies).toHaveLength(2);
		expect(blobs(beforeOutput.bodies[1].input)).toEqual([]);

		const partial = answer("Partial", "fresh-blob", "resp_partial").slice(0, 6);
		const afterOutput = scriptedFetch([() => sse([...partial, inStreamRefusal])]);
		const surfaced = await streamOpenAIResponses(model, staleHistory(), {
			apiKey: "key",
			fetch: afterOutput.fetch,
		}).result();
		expect(surfaced.stopReason).toBe("error");
		expect(surfaced.errorMessage).toContain("was not issued to this caller");
		expect(afterOutput.bodies).toHaveLength(1);
	});

	test("later turns of a recovered session no longer replay the refused blobs", async () => {
		const history = staleHistory();
		const recovery = scriptedFetch([
			() => refusal(META_REFUSAL),
			() => sse(answer("Summary.", "fresh-blob", "resp_recovered")),
		]);
		const recovered = await streamOpenAIResponses(model, history, { apiKey: "key", fetch: recovery.fetch }).result();
		expect(recovered.stopReason).toBe("stop");

		// A fresh call with no provider session state, as after a restart or resume.
		history.messages.push(recovered, { role: "user", content: "and now?", timestamp: 7 });
		const later = scriptedFetch([() => sse(answer("Done.", "next-blob", "resp_later"))]);
		const result = await streamOpenAIResponses(model, history, { apiKey: "key", fetch: later.fetch }).result();

		expect(result.stopReason).toBe("stop");
		expect(later.bodies).toHaveLength(1);
		expect(blobs(later.bodies[0].input)).toEqual(["fresh-blob"]);
		expect(assistantTexts(later.bodies[0].input)).toEqual(["Found README.md.", "Summary."]);
	});
});
