import { afterEach, describe, expect, it, vi } from "bun:test";
import { CHATGPT_TOKEN_SHARING_SCOPE } from "@oh-my-pi/pi-ai/providers/openai-chatgpt-sharing";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function accessToken(scope: string): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256" })}.${encode({ aud: "https://api.openai.com/v1", scope })}.sig`;
}

const sharingToken = () => accessToken(`openid ${CHATGPT_TOKEN_SHARING_SCOPE} offline_access`);

function sse(text: string, responseId: string): Response {
	const events = [
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Two chained-eligible turns with the same options; returns the request bodies the server saw. */
async function twoTurns(apiKey: string | undefined, preferWebsockets = false): Promise<Array<Record<string, unknown>>> {
	const sent: Array<Record<string, unknown>> = [];
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return sse(`Answer ${sent.length}`, `resp_${sent.length}`);
	}) as FetchImpl;
	const options = {
		apiKey,
		sessionId: "sharing-session",
		providerSessionState: new Map<string, ProviderSessionState>(),
		statefulResponses: true,
		preferWebsockets,
		maxTokens: 1000,
		maxTokensExplicit: true,
		temperature: 0.2,
		reasoning: "low" as const,
		fetch: fetchMock,
	};
	const systemPrompt = ["You are a helpful assistant."];
	const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
	const first = await streamOpenAIResponses(model, { systemPrompt, messages: [firstUser] }, options).result();
	await streamOpenAIResponses(
		model,
		{
			systemPrompt,
			messages: [firstUser, first, { role: "user", content: "Second question", timestamp: 1001 }],
		},
		options,
	).result();
	return sent;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses with a ChatGPT token-sharing credential", () => {
	it("never stores, never chains, and omits the fields the route rejects", async () => {
		const [first, second] = await twoTurns(sharingToken(), true);

		for (const body of [first, second]) {
			expect(body?.store).toBe(false);
			expect(body?.stream).toBe(true);
			expect(body?.previous_response_id).toBeUndefined();
			for (const field of ["max_output_tokens", "temperature", "stream_options", "prompt_cache_retention"]) {
				expect(body).not.toHaveProperty(field);
			}
		}
		// Without chaining the second turn carries the whole transcript.
		const replay = JSON.stringify(second?.input);
		expect(replay).toContain("First question");
		expect(replay).toContain("Second question");
	});

	it("leaves an ordinary key on the chained, stored path", async () => {
		const [, second] = await twoTurns("sk-ordinary-key");

		expect(second?.previous_response_id).toBe("resp_1");
		expect(second?.store).toBe(true);
	});

	it("does not treat an access token without the sharing scope as token sharing", async () => {
		const [, second] = await twoTurns(accessToken("openid profile"));

		expect(second?.previous_response_id).toBe("resp_1");
	});

	it("shapes the request when the token comes from OPENAI_API_KEY rather than options", async () => {
		const previous = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = sharingToken();
		try {
			const [first, second] = await twoTurns(undefined, true);

			expect(first?.store).toBe(false);
			expect(second?.store).toBe(false);
			expect(second?.previous_response_id).toBeUndefined();
			expect(first).not.toHaveProperty("max_output_tokens");
		} finally {
			if (previous === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previous;
		}
	});
});
