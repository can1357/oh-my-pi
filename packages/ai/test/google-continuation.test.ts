import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { CONTINUATION_MAX_ATTEMPTS } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Gemini 4 Hydrogen ends each 65,536-token segment of a longer generation with
// `finishReason: CONTINUATION` and a `continuationToken`; resending the request with the
// token streams the next segment. Each segment reports only its own usage, and its prompt
// is the original prompt plus all output so far (as measured live on Antigravity).

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const firstSegment = [
	{
		candidates: [{ content: { role: "model", parts: [{ thought: true, text: "Counting the " }] } }],
		usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 40, totalTokenCount: 50 },
	},
	{
		candidates: [
			{
				content: { role: "model", parts: [{ text: "" }] },
				finishReason: "CONTINUATION",
				continuationToken: "tok-1",
			},
		],
		usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 100, totalTokenCount: 110 },
	},
];

const secondSegment = [
	{
		candidates: [
			{ content: { role: "model", parts: [{ thought: true, text: "residues." }] }, continuationToken: "tok-2a" },
		],
		usageMetadata: { promptTokenCount: 110, thoughtsTokenCount: 30, totalTokenCount: 140 },
	},
	{
		candidates: [{ content: { role: "model", parts: [{ text: "42" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 110, candidatesTokenCount: 5, thoughtsTokenCount: 50, totalTokenCount: 165 },
	},
];

const tokenlessContinuation = {
	candidates: [{ content: { role: "model", parts: [{ text: "Partial" }] }, finishReason: "CONTINUATION" }],
	usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
};

const context: Context = { messages: [{ role: "user", content: "How many?", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-4-hydrogen",
	name: "Gemini 4 Hydrogen",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-4-hydrogen",
	name: "Gemini 4 Hydrogen (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
});

const cliAuth = JSON.stringify({ token: "token", projectId: "proj-123" });

function recordingFetch(responses: Response[]): { fetch: FetchImpl; bodies: Record<string, unknown>[] } {
	const bodies: Record<string, unknown>[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		const response = responses.shift();
		if (!response) throw new Error("unexpected request");
		return response;
	};
	return { fetch, bodies };
}

const overloaded = () => new Response("overloaded", { status: 503 });

/** Serves `first`, then holds every later request until its signal aborts. */
function stalledResumeFetch(first: Response): { fetch: FetchImpl; resumeInits: RequestInit[] } {
	const resumeInits: RequestInit[] = [];
	let served = false;
	const fetch: FetchImpl = async (_input, init) => {
		if (!served) {
			served = true;
			return first;
		}
		resumeInits.push(init ?? {});
		const { promise, reject } = Promise.withResolvers<Response>();
		const signal = init?.signal;
		if (!signal) return promise;
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		return promise;
	};
	return { fetch, resumeInits };
}

function expectOneGeneration(result: AssistantMessage): void {
	expect(result.stopReason).toBe("stop");
	expect(result.errorMessage).toBeUndefined();
	const thinking = result.content.filter(block => block.type === "thinking");
	expect(thinking.map(block => block.thinking)).toEqual(["Counting the residues."]);
	const text = result.content.filter(block => block.type === "text");
	expect(text.map(block => block.text)).toEqual(["42"]);
	// Cost counts every request; the conversation's size is what one unsplit request would
	// report, the second segment's own total (its prompt already holds the first segment).
	expect(result.usage).toMatchObject({
		input: 120,
		output: 155,
		totalTokens: 275,
		reasoningTokens: 150,
		contextTokens: 165,
	});
}

describe("Google output continuation (Gemini API path)", () => {
	it("resends the request with the continuation token and streams both segments as one message", async () => {
		const { fetch, bodies } = recordingFetch([sse(...firstSegment), sse(...secondSegment)]);
		const result = await streamGoogle(genaiModel, context, { apiKey: "k", fetch }).result();

		expectOneGeneration(result);
		expect(bodies).toHaveLength(2);
		expect(bodies[0].continuationToken).toBeUndefined();
		expect(bodies[1]).toEqual({ ...bodies[0], continuationToken: "tok-1" });
	});

	it("ends a CONTINUATION without a token as cut short, not as a failure", async () => {
		const { fetch, bodies } = recordingFetch([sse(tokenlessContinuation)]);
		const result = await streamGoogle(genaiModel, context, { apiKey: "k", fetch }).result();

		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("length");
		expect(result.content.filter(block => block.type === "text").map(block => block.text)).toEqual(["Partial"]);
	});

	it("retries a resume that fails transiently instead of discarding the streamed segment", async () => {
		const { fetch, bodies } = recordingFetch([sse(...firstSegment), overloaded(), sse(...secondSegment)]);
		const result = await streamGoogle(genaiModel, context, { apiKey: "k", fetch, maxRetryDelayMs: 0 }).result();

		expectOneGeneration(result);
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).toEqual(bodies[1]);
	});

	it("ends with a timeout error when a resume request never returns headers", async () => {
		const { fetch, resumeInits } = stalledResumeFetch(sse(...firstSegment));
		const result = await streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch,
			streamFirstEventTimeoutMs: 50,
			maxRetryDelayMs: 0,
		}).result();

		expect(resumeInits).toHaveLength(CONTINUATION_MAX_ATTEMPTS);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	});
});

describe("Google output continuation (Cloud Code Assist path)", () => {
	it("resends the request with the token inside `request` and streams both segments as one message", async () => {
		const { fetch, bodies } = recordingFetch([
			sse(...firstSegment.map(response => ({ response }))),
			sse(...secondSegment.map(response => ({ response }))),
		]);
		const result = await streamGoogleGeminiCli(cliModel, context, { apiKey: cliAuth, fetch }).result();

		expectOneGeneration(result);
		expect(bodies).toHaveLength(2);
		const first = bodies[0] as { request: Record<string, unknown> };
		expect(first.request.continuationToken).toBeUndefined();
		expect(bodies[1]).toEqual({ ...first, request: { ...first.request, continuationToken: "tok-1" } });
	});

	it("ends a CONTINUATION without a token as cut short, not as a failure", async () => {
		const { fetch, bodies } = recordingFetch([sse({ response: tokenlessContinuation })]);
		const result = await streamGoogleGeminiCli(cliModel, context, { apiKey: cliAuth, fetch }).result();

		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("length");
	});

	it("retries a resume that fails transiently instead of discarding the streamed segment", async () => {
		const { fetch, bodies } = recordingFetch([
			sse(...firstSegment.map(response => ({ response }))),
			overloaded(),
			sse(...secondSegment.map(response => ({ response }))),
		]);
		const result = await streamGoogleGeminiCli(cliModel, context, {
			apiKey: cliAuth,
			fetch,
			maxRetryDelayMs: 0,
		}).result();

		expectOneGeneration(result);
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).toEqual(bodies[1]);
	});

	it("ends with a timeout error when a resume request never returns headers", async () => {
		const { fetch, resumeInits } = stalledResumeFetch(sse(...firstSegment.map(response => ({ response }))));
		const result = await streamGoogleGeminiCli(cliModel, context, {
			apiKey: cliAuth,
			fetch,
			streamFirstEventTimeoutMs: 50,
			maxRetryDelayMs: 0,
		}).result();

		expect(resumeInits).toHaveLength(CONTINUATION_MAX_ATTEMPTS);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	});
});
