import { describe, expect, it } from "bun:test";
import {
	applyInferenceHeaders,
	ensureOpenCodeSystemPrompt,
	formatOpenCodeSessionId,
	OPENCODE_USER_AGENT,
} from "../src/providers/inference-headers";
import { resolveOpenAIRequestSetup } from "../src/providers/openai-shared";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamAnthropic } from "../src/providers/anthropic";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl } from "../src/types";

const OPENCODE_ZEN_DEEPSEEK_FREE_MODEL = buildModel({
	id: "deepseek-v4.1-flash-free",
	name: "DeepSeek V4.1 Flash Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
});

const OPENCODE_ZEN_PAID_COMPLETIONS_MODEL = buildModel({
	id: "deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
});

const OPENCODE_ZEN_PAID_ANTHROPIC_MODEL = buildModel({
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

describe("OpenCode Zen / Go inference compatibility", () => {
	describe("formatOpenCodeSessionId", () => {
		it("formats an undefined sessionId into a valid descending OpenCode session ID", () => {
			const id = formatOpenCodeSessionId();
			expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		});

		it("preserves an already valid OpenCode session ID in outbound headers", () => {
			const validId = "ses_e8a14520fffer76IeUC0mt79MV";
			const headers: Record<string, string> = {};
			applyInferenceHeaders(headers, {
				provider: "opencode-zen",
				protocol: "openai",
				sessionId: validId,
				requiresOpenCodeClient: true,
			});
			expect(headers["x-opencode-session"]).toBe(validId);
		});

		it("produces identical and deterministic session IDs for a persisted session across turns", () => {
			const uuid = "01a175eb-40d4-7e73-8560-21c159cab4b5";
			const id1 = formatOpenCodeSessionId(uuid);
			const id2 = formatOpenCodeSessionId(uuid);
			expect(id1).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
			expect(id1).toBe(id2);
		});
	});

	describe("applyInferenceHeaders", () => {
		it("sets required OpenCode headers for Zen free tier", () => {
			const headers: Record<string, string> = {};
			applyInferenceHeaders(headers, {
				provider: "opencode-zen",
				protocol: "openai",
				sessionId: "test-session",
				requiresOpenCodeClient: true,
			});

			expect(headers["User-Agent"]).toBe(`${OPENCODE_USER_AGENT} (${USER_AGENT})`);
			expect(headers["x-opencode-client"]).toBe("cli");
			expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		});

		it("preserves standard User-Agent and raw session ID for Go subscriber lanes", () => {
			const headers: Record<string, string> = {};
			applyInferenceHeaders(headers, {
				provider: "opencode-go",
				protocol: "openai",
				sessionId: "custom-session-id",
			});

			expect(headers["User-Agent"]).toBe(USER_AGENT);
			expect(headers["x-opencode-session"]).toBe("custom-session-id");
		});

		it("preserves Claude OAuth User-Agent fingerprint on OpenCode Anthropic routes", () => {
			const headers: Record<string, string> = {
				"User-Agent": "claude-cli/1.0.0 (external, cli)",
			};
			applyInferenceHeaders(headers, {
				provider: "opencode-zen",
				protocol: "anthropic",
				sessionId: "session-oauth",
				requiresOpenCodeClient: true,
			});

			expect(headers["User-Agent"]).toBe("claude-cli/1.0.0 (external, cli)");
		});
	});

	describe("ensureOpenCodeSystemPrompt", () => {
		it("injects <env> working directory block with provided cwd", () => {
			const result = ensureOpenCodeSystemPrompt(["You are a helper."], "/workspace/test");
			expect(result).toHaveLength(2);
			expect(result[1]).toBe("<env>\n  Working directory: /workspace/test\n</env>");
		});

		it("creates initial <env> block when prompts array is empty", () => {
			const result = ensureOpenCodeSystemPrompt([], "/workspace/empty");
			expect(result).toEqual(["<env>\n  Working directory: /workspace/empty\n</env>"]);
		});

		it("prevents duplicating the environment block when already present", () => {
			const initial = ensureOpenCodeSystemPrompt(["Instructions"], "/first");
			const reapplied = ensureOpenCodeSystemPrompt(initial, "/second");
			expect(reapplied.filter(p => p.includes("<env>"))).toHaveLength(1);
			expect(reapplied.some(p => p.includes("/first"))).toBe(true);
			expect(reapplied.some(p => p.includes("/second"))).toBe(false);
		});
	});

	describe("resolveOpenAIRequestSetup", () => {
		it("falls back to Bearer public when apiKey is empty for free models", () => {
			const setup = resolveOpenAIRequestSetup(OPENCODE_ZEN_DEEPSEEK_FREE_MODEL, {
				apiKey: "",
				messages: [],
			});
			expect(setup.headers.Authorization).toBe("Bearer public");
		});

		it("uses explicit user API key when configured", () => {
			const setup = resolveOpenAIRequestSetup(OPENCODE_ZEN_DEEPSEEK_FREE_MODEL, {
				apiKey: "oc_sk_test_key_12345",
				messages: [],
			});
			expect(setup.headers.Authorization).toBe("Bearer oc_sk_test_key_12345");
		});

		it("rejects unauthenticated requests for paid completions-routed Zen models", () => {
			expect(() => {
				resolveOpenAIRequestSetup(OPENCODE_ZEN_PAID_COMPLETIONS_MODEL, {
					apiKey: "",
					messages: [],
				});
			}).toThrow();

			expect(() => {
				resolveOpenAIRequestSetup(OPENCODE_ZEN_PAID_COMPLETIONS_MODEL, {
					apiKey: "public",
					messages: [],
				});
			}).toThrow();
		});

		it("rejects unauthenticated requests for paid Anthropic-routed Zen models", async () => {
			const stream = streamAnthropic(
				OPENCODE_ZEN_PAID_ANTHROPIC_MODEL,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "" },
			);
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
		});
	});

	describe("streamOpenAICompletions outbound request", () => {
		it("transmits OpenCode headers and system <env> block with session cwd", async () => {
			let capturedUrl = "";
			let capturedHeaders: Record<string, string> = {};
			let capturedBody: Record<string, unknown> = {};

			const fetchMock: FetchImpl = async (input, init) => {
				capturedUrl = String(input);
				capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
				capturedBody = JSON.parse(String(init?.body ?? "{}"));
				return new Response('data: {"id":"1","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};

			const stream = streamOpenAICompletions(
				OPENCODE_ZEN_DEEPSEEK_FREE_MODEL,
				{
					systemPrompt: ["You are omp."],
					messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
					tools: [{ name: "read", description: "read file", parameters: { type: "object" } }],
				},
				{
					fetch: fetchMock,
					cwd: "/test/session/path",
				},
			);

			await stream.result();

			expect(capturedUrl).toBe("https://opencode.ai/zen/v1/chat/completions");
			expect(capturedHeaders["user-agent"]).toBe(`${OPENCODE_USER_AGENT} (${USER_AGENT})`);
			expect(capturedHeaders["x-opencode-client"]).toBe("cli");
			expect(capturedHeaders["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
			expect(capturedHeaders["authorization"]).toBe("Bearer public");

			// System prompt contains <env> with session cwd
			const messages = capturedBody.messages as Array<{ role: string; content: string }>;
			expect(
				messages.some(
					m => m.role === "system" && m.content.includes("<env>\n  Working directory: /test/session/path\n</env>"),
				),
			).toBe(true);
		});
	});
});
