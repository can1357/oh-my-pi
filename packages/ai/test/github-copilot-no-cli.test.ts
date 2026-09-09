import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, TextContent } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

afterEach(() => {
	vi.restoreAllMocks();
});

const BUSINESS_API_ENDPOINT = "https://api.business.githubcopilot.com";
const VALID_OAUTH_TOKEN = "ghu_direct_oauth_token";
const FORBIDDEN_OAUTH_TOKEN = "ghu_forbidden_oauth_token";

const validCredentialWithCliDisabled = JSON.stringify({
	token: VALID_OAUTH_TOKEN,
	apiEndpoint: BUSINESS_API_ENDPOINT,
	cliDisabled: true,
});

const validCredentialDefault = JSON.stringify({
	token: "ghu_fallback_probe_token",
	apiEndpoint: BUSINESS_API_ENDPOINT,
});

const forbiddenCredential = JSON.stringify({
	token: FORBIDDEN_OAUTH_TOKEN,
	apiEndpoint: BUSINESS_API_ENDPOINT,
});

/**
 * Stale CLI metadata simulating bundled or cached model headers.
 * Uses mixed-case keys to ensure case-insensitive identity sanitation.
 */
const STALE_CLI_METADATA_HEADERS: Record<string, string> = {
	"User-Agent": "copilot/1.0.82",
	"Editor-Version": "copilot/1.0.82",
	"Copilot-Integration-Id": "copilot-developer-cli",
	"Copilot-Harness-Id": "copilot-sdk",
	"Openai-Intent": "conversation-agent",
	"X-GitHub-Api-Version": "2026-08-01",
	"copilot-integration-ID": "copilot-developer-cli",
	"editor-VERSION": "vscode/1.136.0",
	"COPILOT-HARNESS-ID": "copilot-sdk",
	"X-Custom-Model-Feature": "preserved-feature",
};

const textContext: Context = {
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

const visionContext: Context = {
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "inspect this image" },
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				},
			],
			timestamp: Date.now(),
		},
	],
};

function makeModel<TApi extends "openai-responses" | "openai-completions" | "anthropic-messages">(
	id: string,
): Model<TApi> {
	const bundled = getBundledModel<TApi>("github-copilot", id);
	if (!bundled) throw new Error(`Missing bundled model: ${id}`);
	return {
		...bundled,
		headers: {
			...bundled.headers,
			...STALE_CLI_METADATA_HEADERS,
		},
	};
}

function hasCliOrEditorIdentity(headers: Headers): boolean {
	if (headers.get("copilot-integration-id")) return true;
	if (headers.get("copilot-harness-id")) return true;
	if (headers.get("editor-version")) return true;
	if (headers.get("editor-plugin-version")) return true;
	const userAgent = headers.get("user-agent") ?? "";
	return /^copilot\//i.test(userAgent) || /vscode/i.test(userAgent) || /GitHubCopilotChat/i.test(userAgent);
}

function createResponsesSseResponse(text: string): Response {
	const body =
		[
			`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_sol" } })}`,
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sol", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sol", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sol", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}`,
		].join("\n\n") + "\n\n";

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createCompletionsSseResponse(text: string): Response {
	const body =
		[
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
			`data: [DONE]`,
		].join("\n\n") + "\n\n";

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createAnthropicSseResponse(text: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_opus",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5",
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedRequest {
	url: string;
	headers: Headers;
}

function createCopilotFetchFixture(options?: { onCapture?: (captured: CapturedRequest) => void }) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const urlStr = input instanceof Request ? input.url : String(input);
		const headers = input instanceof Request ? input.headers : new Headers(init?.headers);

		options?.onCapture?.({ url: urlStr, headers });

		const auth = headers.get("authorization");
		if (auth === `Bearer ${FORBIDDEN_OAUTH_TOKEN}`) {
			return new Response(JSON.stringify({ error: { message: "Access denied", code: "access_denied" } }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}

		if (auth !== `Bearer ${VALID_OAUTH_TOKEN}` && auth !== `Bearer ghu_fallback_probe_token`) {
			return new Response(JSON.stringify({ error: { message: "Unauthorized", code: "unauthorized" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}

		// Deny whenever request claims CLI/editor integration or harness identity
		if (hasCliOrEditorIdentity(headers)) {
			return new Response(JSON.stringify({ error: { message: "Access denied", code: "access_denied" } }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}

		if (urlStr === `${BUSINESS_API_ENDPOINT}/responses`) {
			return createResponsesSseResponse("gpt-5.6-sol direct answer");
		}
		if (urlStr === `${BUSINESS_API_ENDPOINT}/chat/completions`) {
			return createCompletionsSseResponse("gemini-3.7-flash direct answer");
		}
		if (urlStr === `${BUSINESS_API_ENDPOINT}/v1/messages`) {
			return createAnthropicSseResponse("claude-opus-5 direct answer");
		}

		return new Response(JSON.stringify({ error: { message: `Not found: ${urlStr}`, code: "not_found" } }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	});
}

describe("GitHub Copilot direct OAuth streaming without CLI identity", () => {
	it("streams openai-responses (gpt-5.6-sol) with direct OAuth without leaking CLI identity", async () => {
		let captured: CapturedRequest | undefined;
		const fetchMock = createCopilotFetchFixture({
			onCapture: req => {
				captured = req;
			},
		});
		const model = makeModel<"openai-responses">("gpt-5.6-sol");

		const result = await streamOpenAIResponses(model, textContext, {
			apiKey: validCredentialWithCliDisabled,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as TextContent).text).toBe("gpt-5.6-sol direct answer");
		expect(captured?.url).toBe(`${BUSINESS_API_ENDPOINT}/responses`);
		expect(captured?.headers.get("authorization")).toBe(`Bearer ${VALID_OAUTH_TOKEN}`);
		expect(captured?.headers.get("x-custom-model-feature")).toBe("preserved-feature");
		expect(captured?.headers.get("x-initiator")).toBe("user");
	});

	it("streams openai-completions (gemini-3.7-flash) with direct OAuth and preserves vision request without leaking CLI identity", async () => {
		let captured: CapturedRequest | undefined;
		const fetchMock = createCopilotFetchFixture({
			onCapture: req => {
				captured = req;
			},
		});
		const model = makeModel<"openai-completions">("gemini-3.7-flash");

		const result = await streamOpenAICompletions(model, visionContext, {
			apiKey: validCredentialWithCliDisabled,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as TextContent).text).toBe("gemini-3.7-flash direct answer");
		expect(captured?.url).toBe(`${BUSINESS_API_ENDPOINT}/chat/completions`);
		expect(captured?.headers.get("authorization")).toBe(`Bearer ${VALID_OAUTH_TOKEN}`);
		expect(captured?.headers.get("copilot-vision-request")).toBe("true");
		expect(captured?.headers.get("x-custom-model-feature")).toBe("preserved-feature");
		expect(captured?.headers.get("x-initiator")).toBe("user");
	});

	it("streams anthropic-messages (claude-opus-5) with direct OAuth and initiator override without leaking CLI identity", async () => {
		let captured: CapturedRequest | undefined;
		const fetchMock = createCopilotFetchFixture({
			onCapture: req => {
				captured = req;
			},
		});
		const model = makeModel<"anthropic-messages">("claude-opus-5");

		const result = await streamAnthropic(model, textContext, {
			apiKey: validCredentialWithCliDisabled,
			initiatorOverride: "agent",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as TextContent).text).toBe("claude-opus-5 direct answer");
		expect(captured?.url).toBe(`${BUSINESS_API_ENDPOINT}/v1/messages`);
		expect(captured?.headers.get("authorization")).toBe(`Bearer ${VALID_OAUTH_TOKEN}`);
		expect(captured?.headers.get("x-custom-model-feature")).toBe("preserved-feature");
		expect(captured?.headers.get("x-initiator")).toBe("agent");
	});

	it("transparently falls back from CLI identity to chat identity on 403 and remembers for future turns", async () => {
		const fetchMock = createCopilotFetchFixture();
		const model = makeModel<"openai-responses">("gpt-5.6-sol");

		// Turn 1: starts with default CLI headers, gets 403, transparently retries with chat headers
		const turn1 = await streamOpenAIResponses(model, textContext, {
			apiKey: validCredentialDefault,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(turn1.stopReason).toBe("stop");
		expect(turn1.content).toHaveLength(1);
		expect((turn1.content[0] as TextContent).text).toBe("gpt-5.6-sol direct answer");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Turn 2: token is now remembered as cliDisabled, so it uses chat headers directly (1 call)
		fetchMock.mockClear();
		const turn2 = await streamOpenAIResponses(model, textContext, {
			apiKey: validCredentialDefault,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(turn2.stopReason).toBe("stop");
		expect(turn2.content).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces genuine 403 access denied without retrying", async () => {
		const fetchMock = createCopilotFetchFixture();
		const model = makeModel<"openai-responses">("gpt-5.6-sol");
		const result = await streamOpenAIResponses(model, textContext, {
			apiKey: forbiddenCredential,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
	});
});
