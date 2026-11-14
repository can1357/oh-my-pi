import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	adoptRequiredClaudeCodeVersion,
	DEFAULT_CLAUDE_CODE_VERSION,
	ensureClaudeCodeVersion,
	getClaudeCodeUserAgent,
	getClaudeCodeVersion,
	resetClaudeCodeVersionForTest,
} from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags";
const savedVersion = process.env.PI_AI_CLAUDE_CODE_VERSION;

function distTagsFetch(respond: () => Promise<Response>): { fetcher: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetcher = Object.assign(
		(input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
			urls.push(String(input));
			return respond();
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetcher, urls };
}

function latest(version: string): () => Promise<Response> {
	return async () => new Response(JSON.stringify({ latest: version, stable: "2.0.0" }), { status: 200 });
}

function tooOld(sent: string, required: string): Error {
	return new Error(
		`400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code ${sent} does not support this model; version ${required} or newer is required.","details":{"error_code":"claude_code_version_too_old"}}}`,
	);
}

withOfficialAnthropicEndpoint();

describe("Claude Code version lookup", () => {
	beforeEach(() => {
		delete process.env.PI_AI_CLAUDE_CODE_VERSION;
		resetClaudeCodeVersionForTest();
	});

	afterEach(() => {
		resetClaudeCodeVersionForTest();
		if (savedVersion === undefined) delete process.env.PI_AI_CLAUDE_CODE_VERSION;
		else process.env.PI_AI_CLAUDE_CODE_VERSION = savedVersion;
	});

	it("reports the npm `latest` release of @anthropic-ai/claude-code", async () => {
		const { fetcher, urls } = distTagsFetch(latest("2.1.400"));

		await ensureClaudeCodeVersion(fetcher);

		expect(urls).toEqual([DIST_TAGS_URL]);
		expect(getClaudeCodeVersion()).toBe("2.1.400");
		expect(getClaudeCodeUserAgent()).toBe("claude-cli/2.1.400 (external, cli)");
	});

	it("skips the registry when PI_AI_CLAUDE_CODE_VERSION is set", async () => {
		process.env.PI_AI_CLAUDE_CODE_VERSION = "2.0.1";
		const { fetcher, urls } = distTagsFetch(latest("2.1.400"));

		await ensureClaudeCodeVersion(fetcher);

		expect(urls).toEqual([]);
		expect(getClaudeCodeVersion()).toBe("2.0.1");
	});

	it("keeps a higher version adopted from a rejection over an older npm release", async () => {
		expect(
			adoptRequiredClaudeCodeVersion(tooOld(DEFAULT_CLAUDE_CODE_VERSION, "3.0.0"), DEFAULT_CLAUDE_CODE_VERSION),
		).toBe(true);
		await ensureClaudeCodeVersion(distTagsFetch(latest("2.1.400")).fetcher);

		expect(getClaudeCodeVersion()).toBe("3.0.0");
	});

	it("moves past an adopted version once npm publishes a newer one", async () => {
		expect(
			adoptRequiredClaudeCodeVersion(tooOld(DEFAULT_CLAUDE_CODE_VERSION, "3.0.0"), DEFAULT_CLAUDE_CODE_VERSION),
		).toBe(true);
		await ensureClaudeCodeVersion(distTagsFetch(latest("3.0.5")).fetcher);

		expect(getClaudeCodeVersion()).toBe("3.0.5");
	});

	it("keeps the pinned version when the registry is unreachable", async () => {
		const { fetcher, urls } = distTagsFetch(async () => {
			throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
		});

		await ensureClaudeCodeVersion(fetcher);

		expect(urls).toEqual([DIST_TAGS_URL]);
		expect(getClaudeCodeVersion()).toBe(DEFAULT_CLAUDE_CODE_VERSION);
	});

	it("sends the npm release in the User-Agent and billing header of OAuth requests", async () => {
		const registry = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => latest("2.1.400")(), { preconnect: fetch.preconnect }),
		);
		const requests: { url: string; userAgent: string; body: string }[] = [];
		const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input),
				userAgent: new Headers(init?.headers).get("User-Agent") ?? "",
				body: await new Response(init?.body).text(),
			});
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		const model = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const context: Context = { messages: [{ role: "user", content: "Hello there", timestamp: Date.now() }] };

		try {
			await streamAnthropic(model, context, { apiKey: "sk-ant-oat-test", fetch: providerFetch }).result();
			expect(registry.mock.calls.map(([input]) => String(input))).toEqual([DIST_TAGS_URL]);
		} finally {
			registry.mockRestore();
		}

		expect(requests).toHaveLength(1);
		expect(requests[0].url).not.toBe(DIST_TAGS_URL);
		expect(requests[0].userAgent).toBe("claude-cli/2.1.400 (external, cli)");
		expect(requests[0].body).toContain("cc_version=2.1.400.");
	});

	it("does not query the registry for API-key requests", async () => {
		const registry = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => latest("2.1.400")(), { preconnect: fetch.preconnect }),
		);
		const providerFetch = (async () =>
			new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			)) as unknown as typeof fetch;
		const model = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const context: Context = { messages: [{ role: "user", content: "Hello there", timestamp: Date.now() }] };

		try {
			await streamAnthropic(model, context, { apiKey: "sk-ant-api03-test", fetch: providerFetch }).result();
			expect(registry).not.toHaveBeenCalled();
		} finally {
			registry.mockRestore();
		}
	});
});
