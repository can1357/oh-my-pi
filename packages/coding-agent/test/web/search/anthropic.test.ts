import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage as CodingAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeCaptureFetch(): { fetch: FetchImpl; body: () => Record<string, unknown> | undefined } {
	let captured: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		const raw = init?.body;
		const text =
			typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
		captured = JSON.parse(text);
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
	return { fetch, body: () => captured };
}

function withSearchModel(model: string) {
	const original = Bun.env.ANTHROPIC_SEARCH_MODEL;
	Bun.env.ANTHROPIC_SEARCH_MODEL = model;
	return {
		[Symbol.dispose]() {
			if (original === undefined) {
				delete Bun.env.ANTHROPIC_SEARCH_MODEL;
			} else {
				Bun.env.ANTHROPIC_SEARCH_MODEL = original;
			}
		},
	};
}

describe("Anthropic search request body", () => {
	it("forwards the raw session id as metadata.user_id for API-key auth", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-apikey-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "gateway attribution requirements",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage,
				fetch: cap.fetch,
			});

			expect(cap.body()?.metadata).toEqual({ user_id: "session-2295" });
		} finally {
			authStorage.close();
		}
	});

	it("builds a Claude-Code-shaped metadata.user_id for OAuth auth", async () => {
		const accountUuid = "abcd1234-abcd-1234-abcd-1234abcd1234";
		const oauthAuthStorage = {
			resolver: () => () => Promise.resolve("sk-ant-oat-fake-oauth-token"),
			getOAuthAccountId: () => accountUuid,
			hasAuth: () => true,
		} as unknown as AuthStorage;

		const cap = makeCaptureFetch();
		await searchAnthropic({
			query: "oauth attribution",
			systemPrompt: "Use web search.",
			sessionId: "session-2295",
			authStorage: oauthAuthStorage,
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
	});

	it("maps site: to allowed_domains and strips the directive from the query", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-sites-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "sdk docs site:docs.anthropic.com",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage,
				fetch: cap.fetch,
			});

			const body = cap.body();
			const tool = (body?.tools as Record<string, unknown>[] | undefined)?.[0];
			expect(tool?.allowed_domains).toEqual(["docs.anthropic.com"]);
			expect(tool).not.toHaveProperty("blocked_domains");
			const messages = body?.messages as { content: string }[];
			expect(messages[0]?.content).toBe("sdk docs");
		} finally {
			authStorage.close();
		}
	});

	it("maps -site: to blocked_domains when there are no site includes", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-blocked-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "rust async runtime -site:reddit.com",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage,
				fetch: cap.fetch,
			});

			const body = cap.body();
			const tool = (body?.tools as Record<string, unknown>[] | undefined)?.[0];
			expect(tool?.blocked_domains).toEqual(["reddit.com"]);
			expect(tool).not.toHaveProperty("allowed_domains");
			const messages = body?.messages as { content: string }[];
			expect(messages[0]?.content).toBe("rust async runtime");
		} finally {
			authStorage.close();
		}
	});

	it("omits temperature for sampling-restricted models", async () => {
		using _model = withSearchModel("claude-opus-5");
		using tempDir = TempDir.createSync("@pi-anthropic-search-opus-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "sampling compatibility",
				systemPrompt: "Use web search.",
				temperature: 0.1,
				authStorage,
				fetch: cap.fetch,
			});

			expect(cap.body()?.model).toBe("claude-opus-5");
			expect(cap.body()).not.toHaveProperty("temperature");
		} finally {
			authStorage.close();
		}
	});

	it("preserves temperature for compatible models", async () => {
		using _model = withSearchModel("claude-haiku-4-5");
		using tempDir = TempDir.createSync("@pi-anthropic-search-haiku-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "sampling compatibility",
				systemPrompt: "Use web search.",
				temperature: 0.1,
				authStorage,
				fetch: cap.fetch,
			});

			expect(cap.body()?.model).toBe("claude-haiku-4-5");
			expect(cap.body()?.temperature).toBe(0.1);
		} finally {
			authStorage.close();
		}
	});
});
