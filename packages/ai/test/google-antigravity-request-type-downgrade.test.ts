import { expect, test } from "bun:test";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const RESOURCE_EXHAUSTED_BODY = JSON.stringify({
	error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
});
const QUOTA_METRIC_BODY = JSON.stringify({
	error: { code: 429, message: "Quota exceeded for quota metric 'Requests'", status: "RESOURCE_EXHAUSTED_METRIC" },
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function requestTypeOf(init: Parameters<FetchImpl>[1]): string | undefined {
	const body = init?.body;
	if (typeof body !== "string") return undefined;
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || !("requestType" in parsed)) return undefined;
	const requestType = parsed.requestType;
	return typeof requestType === "string" ? requestType : undefined;
}

function sseResponse(text: string): Response {
	const body = `data: ${JSON.stringify({
		response: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] },
	})}\n\n`;
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	Object.defineProperty(response, "url", {
		value: `${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
	});
	return response;
}

function stream(fetchMock: FetchImpl) {
	return streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "production",
		maxRetryDelayMs: 0,
		fetch: fetchMock,
	});
}

test("retries an agent-tagged request as chat when Cloud Code Assist answers RESOURCE_EXHAUSTED", async () => {
	const sentRequestTypes: (string | undefined)[] = [];
	const fetchMock: FetchImpl = async (_input, init) => {
		const requestType = requestTypeOf(init);
		sentRequestTypes.push(requestType);
		if (requestType === "chat") return sseResponse("Served as chat.");
		return new Response(RESOURCE_EXHAUSTED_BODY, { status: 429 });
	};

	const result = await stream(fetchMock).result();

	expect(sentRequestTypes[0]).toBe("agent");
	expect(sentRequestTypes.at(-1)).toBe("chat");
	expect(sentRequestTypes.filter(type => type === "chat")).toHaveLength(1);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Served as chat." }]);
});

test("surfaces the 429 when the chat retry is also refused", async () => {
	const sentRequestTypes: (string | undefined)[] = [];
	const fetchMock: FetchImpl = async (_input, init) => {
		sentRequestTypes.push(requestTypeOf(init));
		return new Response(RESOURCE_EXHAUSTED_BODY, { status: 429 });
	};

	const result = await stream(fetchMock).result();

	expect(result.stopReason).toBe("error");
	expect(sentRequestTypes).toContain("chat");
});

test("leaves the agent tag alone for 429s that name a spent quota metric", async () => {
	const sentRequestTypes: (string | undefined)[] = [];
	const fetchMock: FetchImpl = async (_input, init) => {
		sentRequestTypes.push(requestTypeOf(init));
		return new Response(QUOTA_METRIC_BODY, { status: 429 });
	};

	const result = await stream(fetchMock).result();

	expect(result.stopReason).toBe("error");
	expect(sentRequestTypes.every(type => type === "agent")).toBe(true);
});
