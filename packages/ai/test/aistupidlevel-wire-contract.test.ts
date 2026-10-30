/**
 * Wire-contract tests for the AI Stupid Level Smart Router's Chat Completions
 * endpoint (https://aistupidlevel.info/router/docs, 2026-10-23): requests go to
 * https://aistupidlevel.info/v1 with the router key, the output cap rides
 * `max_completion_tokens`, `reasoning_effort` accepts every level for every
 * model (`none` turns reasoning off), and the router answers image parts with
 * `400 unsupported_content`.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { aistupidlevelModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const ROUTER_BASE_URL = "https://aistupidlevel.info/v1";

function routingMode(id: string): Model<"openai-completions"> {
	const spec = seedModels<"openai-completions">("aistupidlevel").find(candidate => candidate.id === id);
	if (!spec) throw new Error(`aistupidlevel routing mode ${id} is not seeded`);
	return buildModel(spec);
}

/** A pinned model id as live discovery returns it: no capability data on the row. */
async function pinnedModel(id: string, owner: string): Promise<Model<"openai-completions">> {
	const options = aistupidlevelModelManagerOptions({
		apiKey: "aism_test",
		fetch: async () =>
			Response.json({ object: "list", data: [{ id, object: "model", created: 0, owned_by: owner }] }),
	});
	const spec = (await options.fetchDynamicModels?.())?.find(candidate => candidate.id === id);
	if (!spec) throw new Error(`discovery dropped ${id}`);
	return buildModel(spec);
}

const userTurn: Context = {
	systemPrompt: ["Answer briefly."],
	messages: [{ role: "user", content: "What is 2+2? Answer with just the number.", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finishReason?: string): unknown {
	return {
		id: "chatcmpl-aistupidlevel-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: "claude-sonnet-5-5",
		choices: [{ index: 0, delta, ...(finishReason && { finish_reason: finishReason }) }],
	};
}

const textAnswer = [chunk({ content: "4" }), chunk({}, "stop"), "[DONE]"];

async function captureRequest(
	model: Model<"openai-completions">,
	context: Context,
	options: { reasoning?: "high" | "max"; disableReasoning?: boolean; maxTokens?: number },
	events: unknown[] = textAnswer,
): Promise<{
	url: string;
	authorization: string | null;
	payload: Record<string, unknown>;
	result: AssistantMessage;
}> {
	let url = "";
	let authorization: string | null = null;
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			url = input.toString();
			authorization = new Headers(init?.headers).get("authorization");
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse(events);
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamOpenAICompletions(model, context, {
		apiKey: "aism_test",
		fetch: fetchMock,
		...options,
	}).result();
	if (!payload) throw new Error("Expected a captured request payload");
	return { url, authorization, payload, result };
}

describe("AI Stupid Level wire contract", () => {
	it("sends a routing mode to the router's chat-completions endpoint with its documented fields", async () => {
		const { url, authorization, payload, result } = await captureRequest(routingMode("auto-coding"), userTurn, {
			maxTokens: 1024,
		});
		expect(result.stopReason).toBe("stop");
		expect(url).toBe(`${ROUTER_BASE_URL}/chat/completions`);
		expect(authorization).toBe("Bearer aism_test");
		expect(payload.model).toBe("auto-coding");
		expect(payload.max_completion_tokens).toBe(1024);
		expect(payload.max_tokens).toBeUndefined();
		// `store` is not a router parameter, and the system prompt rides the `system` role.
		expect(payload.store).toBeUndefined();
		expect((payload.messages as Array<{ role: string }>)[0]?.role).toBe("system");
	});

	it("sends the thinking level as reasoning_effort and `none` when thinking is off", async () => {
		const model = routingMode("auto-reasoning");
		expect((await captureRequest(model, userTurn, { reasoning: "high" })).payload.reasoning_effort).toBe("high");
		expect((await captureRequest(model, userTurn, { reasoning: "max" })).payload.reasoning_effort).toBe("max");
		expect((await captureRequest(model, userTurn, { disableReasoning: true })).payload.reasoning_effort).toBe("none");
	});

	it("never sends an image part, even for a pinned model whose vendor takes images", async () => {
		const imageTurn: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this screenshot." },
						{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
					],
					timestamp: 0,
				},
			],
		};
		const { payload } = await captureRequest(await pinnedModel("claude-opus-5-5", "anthropic"), imageTurn, {});
		expect(payload.model).toBe("claude-opus-5-5");
		expect(JSON.stringify(payload.messages)).not.toContain("image_url");
	});
});
