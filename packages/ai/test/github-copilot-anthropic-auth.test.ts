import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildAnthropicUrl } from "@oh-my-pi/pi-ai/utils/anthropic-auth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...COPILOT_API_HEADERS },
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	});
}
function makeOpenCodeGoQwen37Model(): Model<"anthropic-messages"> {
	return buildModel({
		id: "qwen3.7-max",
		name: "Qwen3.7 Max",
		api: "anthropic-messages",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function getRequestHeader(
	input: string | URL | Request,
	init: RequestInit | undefined,
	headerName: string,
): string | null {
	if (input instanceof Request) {
		return input.headers.get(headerName);
	}
	return new Headers(init?.headers).get(headerName);
}

describe("Anthropic Copilot auth config", () => {
	it("uses apiKey: null and Authorization Bearer for Copilot models", () => {
		const model = makeCopilotClaudeModel();
		const token = "ghu_test_token_12345";
		const options = buildAnthropicClientOptions({
			model,
			apiKey: token,
			extraBetas: ["interleaved-thinking-2025-05-14"],
			stream: true,
			dynamicHeaders: {
				"X-Initiator": "user",
				"Openai-Intent": "conversation-agent",
			},
		});

		expect(options.apiKey).toBeNull();
		expect(options.defaultHeaders.Authorization).toBe(`Bearer ${token}`);
	});

	it("uses X-Api-Key auth for OpenCode Go Anthropic models", () => {
		const model = makeOpenCodeGoQwen37Model();
		const token = "opencode_test_key";
		const options = buildAnthropicClientOptions({
			model,
			apiKey: token,
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.apiKey).toBe(token);
		expect(options.authToken).toBeNull();
		expect(options.defaultHeaders.Authorization).toBeUndefined();
	});

	it("sends OpenCode Go Anthropic requests with X-Api-Key", async () => {
		const requestedApiKeys: Array<string | null> = [];
		const requestedAuthorizations: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedApiKeys.push(getRequestHeader(input, init, "X-Api-Key"));
			requestedAuthorizations.push(getRequestHeader(input, init, "Authorization"));
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await streamAnthropic(makeOpenCodeGoQwen37Model(), testContext, {
			apiKey: "opencode_test_key",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedApiKeys[0]).toBe("opencode_test_key");
		expect(requestedAuthorizations[0]).toBeNull();
	});

	it("unwraps structured Copilot credentials before setting Authorization", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: JSON.stringify({ token: "ghu_test_token_12345", enterpriseUrl: "ghe.example.com" }),
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.apiKey).toBeNull();
		expect(options.defaultHeaders.Authorization).toBe("Bearer ghu_test_token_12345");
	});

	it("uses model baseUrl directly (no proxy-ep extraction)", () => {
		const model = makeCopilotClaudeModel();
		const token = "ghu_test_token_12345";
		const options = buildAnthropicClientOptions({
			model,
			apiKey: token,
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://api.githubcopilot.com");
	});

	it("routes structured enterprise credentials to the enterprise baseUrl", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: JSON.stringify({ token: "ghu_test_token_12345", enterpriseUrl: "ghe.example.com" }),
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://copilot-api.ghe.example.com");
	});
	it("includes Copilot CLI static headers from model.headers", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.defaultHeaders).toMatchObject({
			"User-Agent": "copilot/1.0.82",
			"Editor-Version": "copilot/1.0.82",
			"Copilot-Integration-Id": "copilot-developer-cli",
			"Copilot-Harness-Id": "copilot-sdk",
			"Openai-Intent": "conversation-agent",
			"X-GitHub-Api-Version": "2026-08-01",
		});
	});

	it("includes interleaved-thinking beta header when enabled", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: ["interleaved-thinking-2025-05-14"],
			stream: true,
			dynamicHeaders: {},
		});

		const beta = options.defaultHeaders["anthropic-beta"];
		expect(beta).toBeDefined();
		expect(beta).toContain("interleaved-thinking-2025-05-14");
	});

	it("does not include fine-grained-tool-streaming beta for Copilot", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: ["interleaved-thinking-2025-05-14"],
			stream: true,
			dynamicHeaders: {},
		});

		const beta = options.defaultHeaders["anthropic-beta"];
		if (beta) {
			expect(beta).not.toContain("fine-grained-tool-streaming");
		}
	});

	it("does not set isOAuthToken for Copilot models", () => {
		const model = makeCopilotClaudeModel();
		const result = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(result.isOAuthToken).toBe(false);
	});

	it("normalizes trailing /v1 in anthropic base URLs", () => {
		const model = {
			...makeCopilotClaudeModel(),
			provider: "custom-proxy",
			baseUrl: "http://127.0.0.1:8317/v1",
		};
		const result = buildAnthropicClientOptions({
			model,
			apiKey: "test-key",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(result.baseURL).toBe("http://127.0.0.1:8317");
	});

	it("sends Content-Type and anthropic-version on Copilot anthropic requests", () => {
		const result = buildAnthropicClientOptions({
			model: makeCopilotClaudeModel(),
			apiKey: "ghu_test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		// The client posts JSON.stringify(params); without these the request goes
		// out with no Content-Type at all (Bun does not default it for string
		// bodies when a plain headers object is supplied).
		expect(result.defaultHeaders["Content-Type"]).toBe("application/json");
		expect(result.defaultHeaders["anthropic-version"]).toBe("2023-06-01");
	});

	it("merges Copilot headers case-insensitively so auth headers cannot duplicate", () => {
		const result = buildAnthropicClientOptions({
			model: {
				...makeCopilotClaudeModel(),
				headers: { ...COPILOT_API_HEADERS, authorization: "Bearer override" },
			},
			apiKey: "ghu_test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		// A miscased duplicate would survive Object.assign and the Headers
		// constructor then joins both values comma-separated on the wire.
		const authKeys = Object.keys(result.defaultHeaders).filter(key => key.toLowerCase() === "authorization");
		expect(authKeys).toHaveLength(1);
		expect(result.defaultHeaders[authKeys[0]]).toBe("Bearer override");
	});

	it("builds anthropic auth URLs from the normalized service root", () => {
		const url = buildAnthropicUrl({
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:8317/v1",
			isOAuth: false,
		});

		expect(url).toBe("http://127.0.0.1:8317/v1/messages?beta=true");
	});

	it("forwards initiatorOverride to Copilot message requests", async () => {
		const requestedInitiators: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedInitiators.push(getRequestHeader(input, init, "X-Initiator"));
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		const model = makeCopilotClaudeModel();
		const result = await streamAnthropic(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
			initiatorOverride: "agent",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedInitiators[0]).toBe("agent");
	});
});
