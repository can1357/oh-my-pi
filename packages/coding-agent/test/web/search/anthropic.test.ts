import { describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const SELECTED_BASE_URL = "https://anthropic-grounding.example.test/v1";

function createFixture(modelId = "claude-haiku-4-5") {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "selected-anthropic-key");
	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const model = buildModel({
		id: modelId,
		name: `Selected ${modelId}`,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: SELECTED_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	});
	return { authStorage, modelRegistry, model };
}

function makeCaptureFetch(): {
	fetch: FetchImpl;
	body: () => Record<string, unknown> | undefined;
	url: () => string | undefined;
	headers: () => Headers | undefined;
} {
	let capturedBody: Record<string, unknown> | undefined;
	let capturedUrl: string | undefined;
	let capturedHeaders: Headers | undefined;
	const fetch: FetchImpl = async (input, init) => {
		capturedUrl = String(input);
		capturedHeaders = new Headers(init?.headers);
		const raw = init?.body;
		const text =
			typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
		capturedBody = JSON.parse(text);
		return new Response(
			JSON.stringify({
				id: "msg_test",
				model: "claude-haiku-4-5",
				content: [],
				usage: { input_tokens: 1, output_tokens: 2 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	return {
		fetch,
		body: () => capturedBody,
		url: () => capturedUrl,
		headers: () => capturedHeaders,
	};
}

describe("Anthropic search request body", () => {
	it("uses the selected model transport, custom-endpoint bearer credentials, and attribution", async () => {
		const fixture = createFixture("claude-selected-grounding");
		try {
			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "gateway attribution requirements",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch: cap.fetch,
			});

			expect(cap.url()).toBe("https://anthropic-grounding.example.test/v1/messages?beta=true");
			expect(cap.headers()?.get("authorization")).toBe("Bearer selected-anthropic-key");
			expect(cap.body()?.model).toBe("claude-selected-grounding");
			expect(cap.body()?.metadata).toEqual({ user_id: "session-2295" });
		} finally {
			fixture.authStorage.close();
		}
	});

	it("builds a Claude-Code-shaped metadata.user_id for OAuth auth", async () => {
		const accountUuid = "abcd1234-abcd-1234-abcd-1234abcd1234";
		const fixture = createFixture();
		fixture.authStorage.keys.setRuntime("anthropic", "sk-ant-oat-fake-oauth-token");
		vi.spyOn(fixture.authStorage.oauth, "identity").mockReturnValue({ accountId: accountUuid });
		try {
			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "oauth attribution",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch: cap.fetch,
			});

			const metadata = cap.body()?.metadata as { user_id: string } | undefined;
			expect(metadata).toBeDefined();
			const userId = JSON.parse(metadata!.user_id) as {
				session_id: string;
				account_uuid?: string;
				device_id?: string;
			};
			expect(userId.session_id).toBe("session-2295");
			expect(userId.account_uuid).toBe(accountUuid);
			expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			vi.restoreAllMocks();
			fixture.authStorage.close();
		}
	});

	it("maps site: to allowed_domains and strips the directive from the query", async () => {
		const fixture = createFixture();
		try {
			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "sdk docs site:docs.anthropic.com",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch: cap.fetch,
			});

			const body = cap.body();
			const tool = (body?.tools as Record<string, unknown>[] | undefined)?.[0];
			expect(tool?.allowed_domains).toEqual(["docs.anthropic.com"]);
			expect(tool).not.toHaveProperty("blocked_domains");
			const messages = body?.messages as { content: string }[];
			expect(messages[0]?.content).toBe("sdk docs");
		} finally {
			fixture.authStorage.close();
		}
	});

	it("maps -site: to blocked_domains when there are no site includes", async () => {
		const fixture = createFixture();
		try {
			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "rust async runtime -site:reddit.com",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch: cap.fetch,
			});

			const body = cap.body();
			const tool = (body?.tools as Record<string, unknown>[] | undefined)?.[0];
			expect(tool?.blocked_domains).toEqual(["reddit.com"]);
			expect(tool).not.toHaveProperty("allowed_domains");
			const messages = body?.messages as { content: string }[];
			expect(messages[0]?.content).toBe("rust async runtime");
		} finally {
			fixture.authStorage.close();
		}
	});

	it("omits temperature for sampling-restricted selected models", async () => {
		const fixture = createFixture("claude-opus-5");
		try {
			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "sampling compatibility",
				systemPrompt: "Use web search.",
				temperature: 0.1,
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch: cap.fetch,
			});

			expect(cap.body()?.model).toBe("claude-opus-5");
			expect(cap.body()).not.toHaveProperty("temperature");
		} finally {
			fixture.authStorage.close();
		}
	});

	it("preserves temperature for compatible selected models", async () => {
		const fixture = createFixture("claude-haiku-4-5");
		try {
			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "sampling compatibility",
				systemPrompt: "Use web search.",
				temperature: 0.1,
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch: cap.fetch,
			});

			expect(cap.body()?.model).toBe("claude-haiku-4-5");
			expect(cap.body()?.temperature).toBe(0.1);
		} finally {
			fixture.authStorage.close();
		}
	});
});
