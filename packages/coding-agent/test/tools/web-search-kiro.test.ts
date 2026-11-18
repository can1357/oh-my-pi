import { afterAll, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { encodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchKiro } from "@oh-my-pi/pi-coding-agent/web/search/providers/kiro";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PROFILE_ARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test-profile";

function storageWith(key?: string): AuthStorage {
	const storage = createInMemoryAuthStorage();
	if (key) storage.keys.setRuntime("kiro", key);
	return storage;
}
const loginStorage = storageWith(
	encodeKiroCredential({
		kind: "oauth",
		token: "access",
		region: "eu-central-1",
		loginId: "l",
		profileArn: PROFILE_ARN,
	}),
);
const apiKeyStorage = storageWith(encodeKiroCredential({ kind: "api_key", token: "ksk_test", region: "us-east-1" }));
const unpinnedKeyStorage = storageWith("ksk_test");
const emptyStorage = storageWith();

afterAll(() => {
	for (const storage of [loginStorage, apiKeyStorage, unpinnedKeyStorage, emptyStorage]) storage.close();
});

function makeParams(query: string, authStorage: AuthStorage) {
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("web", "kiro");
	if (!model) throw new Error("Expected bundled web/kiro model");
	return { query, authStorage, model, modelRegistry, systemPrompt: "Kiro test prompt" } as const;
}

interface Captured {
	url: string;
	headers: Headers;
	body: { id: string; method: string; params: { name: string; arguments: { query: string } } };
}

/** Answers like the Kiro runtime MCP: the tool result is JSON text content echoing the request id. */
function mockFetch(captured: Captured[], result: unknown): FetchImpl {
	return async (input, init) => {
		const body = JSON.parse(String(init?.body)) as Captured["body"];
		captured.push({ url: String(input), headers: new Headers(init?.headers), body });
		return Response.json({ jsonrpc: "2.0", id: body.id, result });
	};
}

const toolText = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
const RESULTS = toolText({
	results: [
		{
			title: "Bun v1.4.4",
			url: "https://bun.com/blog/bun-v1.4.4",
			snippet: "Fixes  issues,\n  and more.",
			publishedDate: Date.parse("2026-11-01T00:00:00Z"),
			maxVerbatimWordLimit: 30,
			publicDomain: false,
		},
		{ title: "", url: "https://bun.com/docs", snippet: "", publishedDate: null },
		{ title: "dup", url: "https://bun.com/blog/bun-v1.4.4", snippet: "duplicate" },
		{ title: "bad", url: "javascript:alert(1)", snippet: "dropped" },
	],
	totalResults: 4,
	query: "bun",
	error: null,
});

describe("Kiro web search provider", () => {
	it("calls the login region's MCP web_search tool and maps its results", async () => {
		const captured: Captured[] = [];
		const response = await searchKiro({
			...makeParams('bun "release notes" site:bun.com after:2026-10-01', loginStorage),
			fetch: mockFetch(captured, RESULTS),
		});
		expect(captured).toHaveLength(1);
		const [request] = captured;
		expect(request.url).toBe("https://runtime.eu-central-1.kiro.dev/mcp");
		expect(request.headers.get("authorization")).toBe("Bearer access");
		expect(request.headers.get("x-amzn-kiro-profile-arn")).toBe(PROFILE_ARN);
		expect(request.headers.get("tokentype")).toBeNull();
		expect(request.body).toMatchObject({ method: "tools/call", params: { name: "web_search" } });
		// Phrases and site: are sent; dates are left to the central post-filter.
		expect(request.body.params.arguments).toEqual({ query: 'bun "release notes" site:bun.com' });
		expect(response).toMatchObject({ provider: "kiro", authMode: "oauth" });
		expect(response.sources).toEqual([
			{
				title: "Bun v1.4.4",
				url: "https://bun.com/blog/bun-v1.4.4",
				snippet: "Fixes issues, and more.",
				publishedDate: "2026-11-01T00:00:00.000Z",
				ageSeconds: expect.any(Number),
			},
			{ title: "https://bun.com/docs", url: "https://bun.com/docs", snippet: undefined, publishedDate: undefined },
		]);
	});

	it("authenticates an API key as one and routes it by its region", async () => {
		const captured: Captured[] = [];
		const response = await searchKiro({ ...makeParams("bun", apiKeyStorage), fetch: mockFetch(captured, RESULTS) });
		expect(captured[0].url).toBe("https://runtime.us-east-1.kiro.dev/mcp");
		expect(captured[0].headers.get("tokentype")).toBe("API_KEY");
		expect(captured[0].headers.get("x-amzn-kiro-profile-arn")).toBeNull();
		expect(response.authMode).toBe("api_key");
	});

	it("fails without a request when the query is too long or the key has no region, and on a tool rejection", async () => {
		const captured: Captured[] = [];
		const fetch = mockFetch(captured, { content: [{ type: "text", text: "Web search is disabled" }], isError: true });
		await expect(searchKiro({ ...makeParams("x".repeat(201), loginStorage), fetch })).rejects.toThrow(
			/limited to 200 characters/,
		);
		await expect(searchKiro({ ...makeParams("bun", unpinnedKeyStorage), fetch })).rejects.toThrow(/KIRO_API_REGION/);
		expect(captured).toHaveLength(0);
		await expect(searchKiro({ ...makeParams("bun", loginStorage), fetch })).rejects.toThrow(/rejected/);
	});

	it("is available only with a Kiro credential", async () => {
		const provider = await getSearchProvider("kiro");
		expect(provider.isAvailable(loginStorage)).toBe(true);
		expect(provider.isAvailable(emptyStorage)).toBe(false);
	});
});
