import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import {
	applyClaudeToolPrefix,
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	buildAnthropicSystemBlocks,
	claudeAgentSdkVersion,
	claudeCodeSystemInstruction,
	claudeCodeVersion,
	claudeToolPrefix,
	deriveClaudeDeviceId,
	generateClaudeCloakingUserId,
	isClaudeCloakingUserId,
	mapStainlessArch,
	mapStainlessOs,
	streamAnthropic,
	stripClaudeToolPrefix,
} from "@pk-nerdsaver-ai/pi-ai/providers/anthropic";
import { getEnvApiKey, streamSimple } from "@pk-nerdsaver-ai/pi-ai/stream";
import type {
	AssistantMessage,
	Context,
	Model,
	ModelSpec,
	TJsonSchema,
	TokenTaskBudget,
	Tool,
} from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { type as arkType } from "arktype";
import { withEnv } from "./helpers";

const ANTHROPIC_MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = buildModel(ANTHROPIC_MODEL_SPEC);

const CLOUDFLARE_ANTHROPIC_MODEL: Model<"anthropic-messages"> = buildModel({
	...ANTHROPIC_MODEL_SPEC,
	id: "anthropic/claude-sonnet-4-5",
	name: "Claude Sonnet 4.5 via Cloudflare",
	provider: "cloudflare-ai-gateway",
	baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
});

const UMANS_ANTHROPIC_MODEL: Model<"anthropic-messages"> = buildModel({
	...ANTHROPIC_MODEL_SPEC,
	id: "umans-kimi-k2.7",
	name: "Umans Kimi K2.7 Code",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	maxTokens: 32_768,
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CaptureAnthropicOptions = {
	isOAuth?: boolean;
	metadata?: { user_id?: string; account_uuid?: string; accountId?: string; account_id?: string };
	thinkingEnabled?: boolean;
	reasoning?: Effort;
	temperature?: number;
	topP?: number;
	topK?: number;
	taskBudget?: TokenTaskBudget;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	thinkingDisplay?: "summarized" | "omitted";
	sessionId?: string;
	headers?: Record<string, string>;
};

function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: CaptureAnthropicOptions,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: options?.isOAuth ?? true,
		signal: createAbortedSignal(),
		metadata: options?.metadata,
		thinkingEnabled: options?.thinkingEnabled,
		reasoning: options?.reasoning,
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		taskBudget: options?.taskBudget,
		toolChoice: options?.toolChoice,
		thinkingDisplay: options?.thinkingDisplay,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function captureSimpleAnthropicPayload(
	model: Model<"anthropic-messages">,
	context: Context,
	reasoning: Effort,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamSimple(model, context, {
		apiKey: "sk-ant-oat-test",
		signal: createAbortedSignal(),
		reasoning,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function expectClaudeMetadataUserId(userId: string | undefined, expectedSessionId?: string): void {
	expect(typeof userId).toBe("string");
	const parsed = JSON.parse(userId ?? "{}") as {
		device_id?: unknown;
		account_uuid?: unknown;
		session_id?: unknown;
	};
	expect(typeof parsed.device_id).toBe("string");
	if (typeof parsed.device_id === "string") {
		expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/);
	}
	if (parsed.account_uuid !== undefined) {
		expect(parsed.account_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	}
	if (expectedSessionId) {
		expect(parsed.session_id).toBe(expectedSessionId);
	} else {
		expect(typeof parsed.session_id).toBe("string");
		if (typeof parsed.session_id === "string") {
			expect(parsed.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		}
	}
}

describe("Anthropic request fingerprint alignment", () => {
	it("maps Stainless OS and arch values from explicit inputs", () => {
		expect(mapStainlessOs("darwin")).toBe("MacOS");
		expect(mapStainlessOs("windows")).toBe("Windows");
		expect(mapStainlessOs("linux")).toBe("Linux");
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
		expect(mapStainlessOs("solaris")).toBe("Other::solaris");

		expect(mapStainlessArch("x64")).toBe("x64");
		expect(mapStainlessArch("amd64")).toBe("x64");
		expect(mapStainlessArch("arm64")).toBe("arm64");
		expect(mapStainlessArch("386")).toBe("x86");
		expect(mapStainlessArch("x86")).toBe("x86");
		expect(mapStainlessArch("sparc64")).toBe("other::sparc64");
	});

	it("uses runtime Stainless OS and arch mappings in Anthropic headers", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["X-Stainless-OS"]).toBe(mapStainlessOs(process.platform));
		expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch(process.arch));
	});

	it("matches Claude Code OAuth header defaults", () => {
		const sessionId = "167ec5b4-e711-4169-879f-84fa52679d9c";
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			claudeCodeSessionId: sessionId,
		});

		expect(headers.Accept).toBe("application/json");
		expect(headers["User-Agent"]).toBe(
			`claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`,
		);
		expect(headers["X-Claude-Code-Session-Id"]).toBe(sessionId);
		expect(headers["x-client-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("sends redact-thinking beta only when thinking display is omitted", () => {
		const baseArgs = {
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			stream: true,
			interleavedThinking: true,
			hasTools: true,
			thinkingEnabled: true,
		} as const;

		const visible = buildAnthropicClientOptions(baseArgs);
		expect(visible.defaultHeaders["anthropic-beta"]).not.toContain("redact-thinking-2026-02-12");

		const hidden = buildAnthropicClientOptions({ ...baseArgs, thinkingDisplay: "omitted" });
		expect(hidden.defaultHeaders["anthropic-beta"]).toContain("redact-thinking-2026-02-12");

		const hiddenUtility = buildAnthropicClientOptions({
			...baseArgs,
			hasTools: false,
			thinkingEnabled: false,
			thinkingDisplay: "omitted",
		});
		expect(hiddenUtility.defaultHeaders["anthropic-beta"]).toContain("redact-thinking-2026-02-12");
	});

	it("matches CC system-block layout: billing and instruction uncached, single breakpoint on the last context block", () => {
		// We mimic Claude Code's billing+instruction system layout but do NOT emit
		// the `scope: "global"` field that CC attaches to its middle breakpoint —
		// `prompt-caching-scope-2026-01-05` only works against canonical
		// `api.anthropic.com`, and third-party Anthropic-compatible proxies
		// (z.ai, openrouter, …) reject the unknown field outright.
		const blocks = buildAnthropicSystemBlocks(["Stay concise."], {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
			cacheControl: { type: "ephemeral" },
		});

		expect(blocks).toHaveLength(4);
		expect(blocks?.[0].text).toStartWith("x-anthropic-billing-header:");
		expect(blocks?.[0].cache_control).toBeUndefined();
		expect(blocks?.[1].text).toBe(claudeCodeSystemInstruction);
		expect(blocks?.[1].cache_control).toBeUndefined();
		// Only the LAST system block carries the cache breakpoint: a single trailing
		// `cache_control` caches the entire system prefix as one entry, conserving the
		// 4-breakpoint budget (`enforceCacheControlLimit`) for message-level caching.
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
			cache_control: { type: "ephemeral" },
		});
	});

	it("caches Claude Code context and the last user block in OAuth request payloads", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as {
			system?: Array<{ text?: string; cache_control?: unknown }>;
			messages?: Array<{ content?: Array<{ cache_control?: unknown }> | string }>;
		};

		expect(payload.system?.[0]?.text).toStartWith("x-anthropic-billing-header:");
		expect(payload.system?.[0]?.cache_control).toBeUndefined();
		expect(payload.system?.[1]?.text).toBe(claudeCodeSystemInstruction);
		expect(payload.system?.[1]?.cache_control).toBeUndefined();
		expect(payload.system?.[2]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		const content = payload.messages?.[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		expect(Array.isArray(content) ? content[0]?.cache_control : undefined).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("caches tool-result-only user messages in OAuth request payloads", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [
				{ role: "user", content: "Use the tool", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "lookup", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: ANTHROPIC_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "lookup",
					content: [{ type: "text", text: "large tool output" }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				},
			],
		})) as { messages?: Array<{ content?: Array<{ type?: string; cache_control?: unknown }> | string }> };

		const messages = payload.messages ?? [];
		const lastContent = messages[messages.length - 1]?.content;
		expect(Array.isArray(lastContent)).toBe(true);
		expect(Array.isArray(lastContent) ? lastContent[0]?.type : undefined).toBe("tool_result");
		expect(Array.isArray(lastContent) ? lastContent[0]?.cache_control : undefined).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("clamps requested max_tokens to Claude Code's 64k cap when the model ceiling is higher", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({ ...ANTHROPIC_MODEL_SPEC, id: "claude-opus-4-8", name: "Claude Opus 4.8", maxTokens: 128_000 }),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
		)) as { max_tokens?: number };
		expect(payload.max_tokens).toBe(64_000);
	});

	it("leaves max_tokens untouched when the model ceiling is below the 64k cap", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as { max_tokens?: number };
		expect(payload.max_tokens).toBe(8_192);
	});

	it("keeps the full model output ceiling for API-key requests", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({ ...ANTHROPIC_MODEL_SPEC, id: "claude-opus-4-8", name: "Claude Opus 4.8", maxTokens: 128_000 }),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { max_tokens?: number };
		expect(payload.max_tokens).toBe(128_000);
	});

	it("does not place cache_control on thinking blocks in the trailing cache window", async () => {
		const thinkingOnlyAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "long deliberation", thinkingSignature: "sig-1" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: ANTHROPIC_MODEL.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Think about it", timestamp: Date.now() }, thinkingOnlyAssistant],
			},
			{ isOAuth: false },
		)) as { messages?: Array<{ role: string; content: string | Array<{ type: string; cache_control?: unknown }> }> };

		// The thinking-only assistant turn sits inside the trailing two-message
		// cache window (the Continue. pad is appended after it) but must not get
		// a breakpoint — Anthropic rejects cache_control on thinking blocks.
		const assistant = payload.messages?.find(message => message.role === "assistant");
		expect(Array.isArray(assistant?.content)).toBe(true);
		for (const block of assistant?.content as Array<{ type: string; cache_control?: unknown }>) {
			expect(block.cache_control).toBeUndefined();
		}
		const last = payload.messages?.at(-1);
		expect((last?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toBeDefined();
	});

	it("adds effort and mid-conversation betas to API-key requests that use those features", async () => {
		let capturedBeta: string | undefined;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = (init?.headers as Record<string, string> | undefined)?.["anthropic-beta"];
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		const adaptiveModel: Model<"anthropic-messages"> = buildModel({
			...ANTHROPIC_MODEL_SPEC,
			id: "claude-opus-4-8-20260528",
			name: "Claude Opus 4.8",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
		});

		await streamAnthropic(
			adaptiveModel,
			{ systemPrompt: ["Stay concise."], messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
			{ apiKey: "sk-ant-api-test", thinkingEnabled: false, fetch: fetchMock },
		).result();

		// thinking-off on an adaptive-only model still pins output_config.effort,
		// and the converter may emit mid-conversation system turns on Opus 4.8 —
		// both fields need their betas on API-key requests too.
		expect(capturedBeta).toContain("effort-2025-11-24");
		expect(capturedBeta).toContain("mid-conversation-system-2026-04-07");
	});

	it("adds the context-management beta to API-key thinking requests", async () => {
		let capturedBeta: string | undefined;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = (init?.headers as Record<string, string> | undefined)?.["anthropic-beta"];
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		// `context_management.clear_thinking_20251015` is rejected without
		// the `context-management-2025-06-27` beta. OAuth requests carry it
		// via `claudeCodeAgentBetaDefaults`; API-key requests must add it
		// explicitly whenever thinking is enabled so the field is honored
		// instead of dropped on the floor (#3288).
		await streamAnthropic(
			ANTHROPIC_MODEL,
			{ systemPrompt: ["Stay concise."], messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
			{ apiKey: "sk-ant-api-test", thinkingEnabled: true, fetch: fetchMock },
		).result();

		expect(capturedBeta).toContain("context-management-2025-06-27");

		capturedBeta = undefined;
		await streamAnthropic(
			ANTHROPIC_MODEL,
			{ systemPrompt: ["Stay concise."], messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
			{ apiKey: "sk-ant-api-test", thinkingEnabled: false, fetch: fetchMock },
		).result();

		// No context_management field is sent when thinking is disabled, so the
		// beta MUST NOT be advertised either.
		expect(capturedBeta ?? "").not.toContain("context-management-2025-06-27");
	});

	it("billing-header fingerprint uses first user message, not leading developer message", async () => {
		const userText = "Hello from user with enough chars padding here";

		// Conversation with only a user message.
		const payloadUserOnly = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Be helpful."],
			messages: [{ role: "user", content: userText, timestamp: Date.now() }],
		})) as { system?: Array<{ type: string; text?: string }> };

		// Conversation prefixed with a developer message before the same user message.
		const payloadWithDev = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Be helpful."],
			messages: [
				{ role: "developer", content: "developer instruction text", timestamp: Date.now() },
				{ role: "user", content: userText, timestamp: Date.now() },
			],
		})) as { system?: Array<{ type: string; text?: string }> };

		const billingUserOnly = payloadUserOnly.system?.[0].text ?? "";
		const billingWithDev = payloadWithDev.system?.[0].text ?? "";

		// Both payloads must carry a billing header.
		expect(billingUserOnly).toStartWith("x-anthropic-billing-header:");
		expect(billingWithDev).toStartWith("x-anthropic-billing-header:");

		// The cc_version suffix (fingerprint) must be identical — developer message must not affect it.
		const extractSuffix = (header: string) => header.match(/cc_version=[^.]+\.([a-f0-9]{3})/)?.[1];
		expect(extractSuffix(billingWithDev)).toBe(extractSuffix(billingUserOnly));
	});

	it("places the automatic Anthropic cache breakpoint on the last ordered system prompt", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system", "stable durable context"],
				messages: [{ role: "user", content: "variable context", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { system?: Array<{ type: string; text?: string; cache_control?: unknown }> };

		expect(payload.system).toEqual([
			{ type: "text", text: "stable system" },
			{ type: "text", text: "stable durable context", cache_control: { type: "ephemeral" } },
		]);
	});

	it("uses Bearer auth for non-Anthropic API bases with api-key credentials", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com",
			stream: true,
		});

		expect(headers.Authorization).toBe("Bearer sk-ant-api-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("honors caller-supplied Authorization on non-official Anthropic endpoints (#3391)", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com/anthropic",
			stream: true,
			modelHeaders: { Authorization: "secret-proxy-key" },
		});

		expect(headers.Authorization).toBe("secret-proxy-key");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("honors lowercase `authorization` from caller without duplicating the header key", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com/anthropic",
			stream: true,
			modelHeaders: { authorization: "secret-proxy-key" },
		});

		const authKeys = Object.keys(headers).filter(key => key.toLowerCase() === "authorization");
		expect(authKeys).toHaveLength(1);
		expect(headers[authKeys[0]]).toBe("secret-proxy-key");
	});

	it("honors caller-supplied X-Api-Key on official Anthropic endpoints", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://api.anthropic.com",
			stream: true,
			modelHeaders: { "X-Api-Key": "custom-api-key" },
		});

		expect(headers["X-Api-Key"]).toBe("custom-api-key");
		expect(headers.Authorization).toBeUndefined();
	});

	it("honors caller-supplied Authorization alongside X-Api-Key on official endpoints", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://api.anthropic.com",
			stream: true,
			modelHeaders: { Authorization: "Token tok-abc" },
		});

		// Official endpoint keeps X-Api-Key as the primary credential but also
		// forwards the caller's custom Authorization so a fronting proxy/gateway
		// can read it.
		expect(headers.Authorization).toBe("Token tok-abc");
		expect(headers["X-Api-Key"]).toBe("sk-ant-api-test");
	});

	it("forces OAuth bearer auth and ignores caller-supplied Authorization under OAuth", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { Authorization: "should-not-leak" },
		});

		expect(headers.Authorization).toBe("Bearer sk-ant-oat-test");
	});

	it("suppresses the client-level X-Api-Key when model.headers carries a custom Authorization (#3391)", () => {
		const options = buildAnthropicClientOptions({
			model: buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "proxy-claude",
				name: "Proxy Claude",
				baseUrl: "https://proxy.example.com/anthropic",
				headers: { Authorization: "secret-proxy-key" },
			}),
			apiKey: "sk-ant-api-test",
			stream: true,
		});

		// `apiKey: null` keeps the lower-level client from adding an `X-Api-Key`
		// header alongside the caller-supplied custom Authorization.
		expect(options.apiKey).toBeNull();
		expect(options.defaultHeaders.Authorization).toBe("secret-proxy-key");
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("keeps Umans Anthropic-compatible requests on X-Api-Key auth", () => {
		const options = buildAnthropicClientOptions({
			model: buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "umans-coder",
				name: "Umans Coder",
				provider: "umans",
				baseUrl: "https://api.code.umans.ai",
			}),
			apiKey: "sk-umans-test",
			stream: true,
		});

		expect(options.apiKey).toBe("sk-umans-test");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
	});

	it("adds Umans gateway web search header from env", async () => {
		await withEnv({ UMANS_WEBSEARCH_PROVIDER: "exa" }, () => {
			const options = buildAnthropicClientOptions({
				model: UMANS_ANTHROPIC_MODEL,
				apiKey: "sk-umans-test",
				stream: true,
				hasTools: true,
			});

			expect(options.defaultHeaders["X-Umans-Websearch-Provider"]).toBe("exa");
		});
	});

	it("forwards only prefix-matching Claude Code User-Agent values", () => {
		const forwardedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli/2.1.63 (external, cli)" },
		});
		expect(forwardedHeaders["User-Agent"]).toBe("claude-cli/2.1.63 (external, cli)");

		// Test variant without slash
		const forwardedNoSlashHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli-dev" },
		});
		expect(forwardedNoSlashHeaders["User-Agent"]).toBe("claude-cli-dev");

		const normalizedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "curl/8.7.1" },
		});
		expect(normalizedHeaders["User-Agent"]).toBe(
			`claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`,
		);

		const embeddedClaudeCliHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "my-client claude-cli/2.1.63" },
		});
		expect(embeddedClaudeCliHeaders["User-Agent"]).toBe(
			`claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`,
		);
	});

	it("forwards model-supplied User-Agent on API-key requests", () => {
		// Direct Anthropic API (X-Api-Key branch).
		const directHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			isOAuth: false,
			stream: true,
			modelHeaders: { "User-Agent": "corp-gateway-client/2.0" },
		});
		expect(directHeaders["User-Agent"]).toBe("corp-gateway-client/2.0");

		// Non-Anthropic gateway (Bearer branch).
		const gatewayHeaders = buildAnthropicHeaders({
			apiKey: "gateway-token",
			isOAuth: false,
			stream: true,
			baseUrl: "https://gateway.example.com/anthropic",
			modelHeaders: { "User-Agent": "corp-gateway-client/2.0" },
		});
		expect(gatewayHeaders["User-Agent"]).toBe("corp-gateway-client/2.0");
	});

	it("omits Claude Code betas on API-key requests by default", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			isOAuth: false,
			stream: true,
			extraBetas: ["web-search-2025-03-05"],
		});
		expect(headers["anthropic-beta"]).toBe("web-search-2025-03-05");

		// And no empty anthropic-beta header when there are no betas at all.
		const bare = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			isOAuth: false,
			stream: true,
		});
		expect(bare["anthropic-beta"]).toBeUndefined();
	});

	it("skips Claude Code instruction injection for claude-3-5-haiku models", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({ ...ANTHROPIC_MODEL_SPEC, id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" }),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
		)) as { system?: Array<{ type: string; text?: string }> };

		expect(Array.isArray(payload.system)).toBe(true);
		const systemBlocks = payload.system ?? [];
		expect(systemBlocks.some(block => block.text?.startsWith("x-anthropic-billing-header:"))).toBe(false);
		expect(systemBlocks[0]?.text).toBe("Stay concise.");
	});

	it("accepts uppercase hex in the user hash segment", () => {
		const userId =
			"user_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD_account_12345678-1234-1234-1234-1234567890ab_session_abcdefab-cdef-abcd-efab-cdefabcdef12";
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("generates cloaking-compatible user IDs", () => {
		const userId = generateClaudeCloakingUserId();
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("scopes derived Claude device IDs to the account when known", () => {
		const installId = "test-install-id";
		const accountId = "12345678-1234-1234-1234-1234567890ab";
		const otherAccountId = "abcdefab-cdef-abcd-efab-cdefabcdef12";
		const deviceId = deriveClaudeDeviceId(installId, accountId);

		expect(deviceId).toMatch(/^[0-9a-f]{64}$/);
		expect(deviceId).toBe(deriveClaudeDeviceId(installId, accountId));
		expect(deviceId).not.toBe(deriveClaudeDeviceId(installId, otherAccountId));
		expect(deviceId).not.toBe(deriveClaudeDeviceId(installId));
	});

	it("injects Claude Code JSON metadata.user_id for OAuth requests when missing", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as { metadata?: { user_id?: string } };
		expectClaudeMetadataUserId(payload.metadata?.user_id);
	});

	it("derives generated OAuth device_id deterministically across sessions", async () => {
		const first = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ sessionId: "167ec5b4-e711-4169-879f-84fa52679d9c" },
		)) as { metadata?: { user_id?: string } };
		const second = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi again", timestamp: Date.now() }],
			},
			{ sessionId: "abcdefab-cdef-abcd-efab-cdefabcdef12" },
		)) as { metadata?: { user_id?: string } };
		const firstUserId = JSON.parse(first.metadata?.user_id ?? "{}") as { device_id?: string };
		const secondUserId = JSON.parse(second.metadata?.user_id ?? "{}") as { device_id?: string };

		expect(firstUserId.device_id).toBe(secondUserId.device_id);
	});

	it("uses metadata account_uuid when generating OAuth device_id", async () => {
		const sessionId = "167ec5b4-e711-4169-879f-84fa52679d9c";
		const accountId = "12345678-1234-1234-1234-1234567890ab";
		const otherAccountId = "abcdefab-cdef-abcd-efab-cdefabcdef12";
		const first = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { account_uuid: accountId }, sessionId },
		)) as { metadata?: { user_id?: string } };
		const second = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi again", timestamp: Date.now() }],
			},
			{ metadata: { account_uuid: otherAccountId }, sessionId },
		)) as { metadata?: { user_id?: string } };
		const firstUserId = JSON.parse(first.metadata?.user_id ?? "{}") as { account_uuid?: string; device_id?: string };
		const secondUserId = JSON.parse(second.metadata?.user_id ?? "{}") as {
			account_uuid?: string;
			device_id?: string;
		};

		expect(firstUserId.account_uuid).toBe(accountId);
		expect(secondUserId.account_uuid).toBe(otherAccountId);
		expect(firstUserId.device_id).toMatch(/^[0-9a-f]{64}$/);
		expect(firstUserId.device_id).not.toBe(secondUserId.device_id);
	});

	it("uses the explicit session id for generated OAuth metadata", async () => {
		const sessionId = "167ec5b4-e711-4169-879f-84fa52679d9c";
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ sessionId },
		)) as { metadata?: { user_id?: string } };

		expectClaudeMetadataUserId(payload.metadata?.user_id, sessionId);
	});

	it("does not inject metadata.user_id for non-OAuth requests without caller metadata", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { metadata?: { user_id?: string } };
		expect(payload.metadata).toBeUndefined();
	});

	it("preserves valid caller metadata.user_id for OAuth requests", async () => {
		const userId = generateClaudeCloakingUserId();
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("mirrors JSON metadata session_id into the Claude Code session header", async () => {
		const sessionId = "167ec5b4-e711-4169-879f-84fa52679d9c";
		const userId = JSON.stringify({
			device_id: "a".repeat(64),
			account_uuid: "12345678-1234-1234-1234-1234567890ab",
			session_id: sessionId,
		});
		const { promise, resolve } = Promise.withResolvers<{
			sessionHeader: string | null;
			url: string;
			accept: string | null;
		}>();
		const controller = new AbortController();
		const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			resolve({
				sessionHeader: headers.get("X-Claude-Code-Session-Id"),
				url: input instanceof Request ? input.url : String(input),
				accept: headers.get("Accept"),
			});
			controller.abort();
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		streamAnthropic(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "sk-ant-oat-test",
				isOAuth: true,
				metadata: { user_id: userId },
				signal: controller.signal,
				fetch: fakeFetch,
			},
		);

		expect(await promise).toEqual({
			sessionHeader: sessionId,
			url: "https://api.anthropic.com/v1/messages?beta=true",
			accept: "application/json",
		});
	});

	it("preserves real Claude Code JSON-format metadata.user_id for OAuth requests", async () => {
		// Matches the shape produced by services/api/claude.ts → getAPIMetadata in
		// the Claude Code source: { device_id, account_uuid, session_id, ...extra }.
		const userId = JSON.stringify({
			device_id: "a".repeat(64),
			account_uuid: "12345678-1234-1234-1234-1234567890ab",
			session_id: "abcdefab-cdef-abcd-efab-cdefabcdef12",
		});
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("preserves a minimal { session_id } JSON metadata.user_id for OAuth requests", async () => {
		const userId = JSON.stringify({ session_id: "0190fb1e-0000-7000-8000-000000000001" });
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("replaces JSON metadata.user_id missing session_id for OAuth requests", async () => {
		const userId = JSON.stringify({ device_id: "x".repeat(64) });
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe(userId);
		expectClaudeMetadataUserId(payload.metadata?.user_id);
	});

	it("replaces invalid caller metadata.user_id for OAuth requests", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: "invalid-user-id" } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe("invalid-user-id");
		expectClaudeMetadataUserId(payload.metadata?.user_id);
	});
	it("escapes Umans client tool names for unambiguous round-trips", async () => {
		const tools: Tool[] = [
			{
				name: "web_search",
				description: "search the web",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
			{
				name: "read",
				description: "read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
			},
			{
				name: "_web_search",
				description: "literal prefixed search",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		];

		const payload = (await captureAnthropicPayload(
			UMANS_ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false, toolChoice: { type: "tool", name: "web_search" } },
		)) as {
			tools?: Array<{ name?: string }>;
			tool_choice?: { type?: string; name?: string };
		};

		expect(payload.tools?.map(tool => tool.name)).toEqual(["_web_search", "_read", "__web_search"]);
		expect(payload.tool_choice).toEqual({ type: "tool", name: "_web_search" });
	});

	it("leaves Umans web_search unescaped when gateway web search is selected", async () => {
		const tools: Tool[] = [
			{
				name: "web_search",
				description: "search the web",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
			{
				name: "read",
				description: "read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
			},
		];

		const payload = (await captureAnthropicPayload(
			UMANS_ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{
				isOAuth: false,
				headers: { "X-Umans-Websearch-Provider": "native" },
				toolChoice: { type: "tool", name: "web_search" },
			},
		)) as {
			tools?: Array<{ name?: string }>;
			tool_choice?: { type?: string; name?: string };
		};

		expect(payload.tools?.map(tool => tool.name)).toEqual(["web_search", "_read"]);
		expect(payload.tool_choice).toEqual({ type: "tool", name: "web_search" });
	});

	it("adds additionalProperties false to Anthropic tool object schemas", async () => {
		const originalNestedSchema = {
			type: "object",
			properties: {
				path: { type: "string" },
			},
			patternProperties: {
				"^x-": { type: "string" },
			},
			required: ["path"],
		};
		const tools: Tool[] = [
			{
				name: "edit_file",
				description: "edit files",
				parameters: {
					type: "object",
					properties: {
						target: originalNestedSchema,
						operations: {
							type: "array",
							items: {
								type: "object",
								properties: { content: { type: "string" } },
								required: ["content"],
							},
						},
						env: {
							type: "object",
							patternProperties: {
								"^[A-Za-z_][A-Za-z0-9_]*$": { type: "string" },
							},
							propertyNames: {
								type: "string",
								pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
							},
						},
					},
					required: ["target"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			}>;
		};

		const inputSchema = payload.tools?.[0]?.input_schema;
		const properties = inputSchema?.properties as Record<string, Record<string, unknown>>;
		const target = properties.target as { additionalProperties?: boolean; patternProperties?: unknown };
		const operations = properties.operations as {
			type?: string;
			items?: { additionalProperties?: boolean; required?: string[] };
		};
		const env = properties.env as {
			additionalProperties?: boolean;
			patternProperties?: unknown;
			propertyNames?: unknown;
		};

		expect(inputSchema?.additionalProperties).toBe(false);
		expect(inputSchema?.required).toEqual(["target"]);
		expect(target.additionalProperties).toBe(false);
		expect(operations.type).toBe("array");
		expect(operations.items?.additionalProperties).toBe(false);
		expect(operations.items?.required).toEqual(["content"]);
		expect(target).not.toHaveProperty("patternProperties");
		expect(env.additionalProperties).toBe(false);
		expect(env).not.toHaveProperty("patternProperties");
		expect(env).not.toHaveProperty("propertyNames");
		expect(inputSchema?.properties).toHaveProperty("target");
		expect(originalNestedSchema).not.toHaveProperty("additionalProperties");
		expect(originalNestedSchema).toHaveProperty("patternProperties");
	});

	it("preserves explicit additionalProperties schemas and true for open record fields", async () => {
		// Mirrors open record-style shapes: Zod's `z.record(z.string(), z.unknown())`
		// emits `additionalProperties: {}`, typed maps use a schema, and the yield
		// fallback uses `additionalProperties: true`. Each must remain open after
		// unsupported key-schema keywords are stripped.
		const tools: Tool[] = [
			{
				name: "resolve",
				description: "resolve a pending action",
				parameters: {
					type: "object",
					properties: {
						action: { type: "string" },
						extra: {
							type: "object",
							propertyNames: { type: "string" },
							additionalProperties: {},
						},
						extraTyped: {
							type: "object",
							additionalProperties: { type: "string" },
						},
						extraLoose: {
							type: "object",
							additionalProperties: true,
						},
					},
					required: ["action"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
				};
			}>;
		};

		const inputSchema = payload.tools?.[0]?.input_schema;
		const properties = inputSchema?.properties as Record<string, Record<string, unknown>>;
		const extra = properties.extra as { additionalProperties?: unknown; propertyNames?: unknown };
		const extraTyped = properties.extraTyped as { additionalProperties?: unknown };
		const extraLoose = properties.extraLoose as { additionalProperties?: unknown };

		expect(inputSchema?.additionalProperties).toBe(false);
		// The unsupported `propertyNames` keyword is still stripped …
		expect(extra).not.toHaveProperty("propertyNames");
		// … but the explicit open-map schema survives (normalized to `true` per
		// JSON Schema 2020-12 §4.3.1 — `{}` and `true` are equivalent).
		expect(extra.additionalProperties).toBe(true);
		// A typed value schema is preserved verbatim (and would be recursed into
		// if it were an object — covered separately).
		expect(extraTyped.additionalProperties).toEqual({ type: "string" });
		expect(extraLoose.additionalProperties).toBe(true);
	});

	it("removes Anthropic-unsupported array item count constraints", async () => {
		const tools: Tool[] = [
			{
				name: "edit_file",
				description: "edit files",
				parameters: {
					type: "object",
					properties: {
						sub: {
							type: "array",
							items: { type: "string" },
							minItems: 2,
							maxItems: 2,
						},
						nonEmpty: {
							type: "array",
							items: { type: "string" },
							minItems: 1,
						},
					},
					required: ["sub"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					properties?: Record<string, unknown>;
				};
			}>;
		};

		const properties = payload.tools?.[0]?.input_schema?.properties as Record<string, Record<string, unknown>>;

		expect(properties.sub).not.toHaveProperty("minItems");
		expect(properties.sub).not.toHaveProperty("maxItems");
		expect(properties.nonEmpty.minItems).toBe(1);
	});

	it("strips minItems from object-typed property schemas (Anthropic rejects them)", async () => {
		const tools: Tool[] = [
			{
				name: "weird",
				description: "nested object with stray minItems",
				parameters: {
					type: "object",
					properties: {
						block: {
							type: "object",
							properties: { a: { type: "string" } },
							required: ["a"],
							minItems: 1,
						},
					},
					required: ["block"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: { properties?: Record<string, unknown> };
			}>;
		};

		const block = payload.tools?.[0]?.input_schema?.properties?.block as Record<string, unknown> | undefined;
		expect(block?.type).toBe("object");
		expect(block).not.toHaveProperty("minItems");
	});

	it("keeps OAuth tool names behind the proxy prefix with eager streaming and strict flags", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "run commands",
				strict: true,
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{ name?: string; strict?: boolean; eager_input_streaming?: boolean; cache_control?: unknown }>;
		};

		expect(payload.tools?.[0]?.name).toBe(`${claudeToolPrefix}bash`);
		expect(payload.tools?.[0]?.strict).toBe(true);
		expect(payload.tools?.[0]?.eager_input_streaming).toBe(true);
		expect(payload.tools?.[0]?.cache_control).toBeUndefined();
	});

	it("marks only the Anthropic strict allowlist strict", async () => {
		const tools: Tool[] = [
			...(["bash", "python", "edit", "find"] as const).map(name => ({
				name,
				description: `${name} tool`,
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			})),
			...(["write", "grep", "read", "task", "todo", "web_search", "ast_grep"] as const).map(name => ({
				name,
				description: `${name} tool`,
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			})),
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{ name?: string; strict?: boolean; input_schema?: { required?: string[] } }>;
		};

		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);

		expect(strictNames).toEqual(["bash", "python", "edit", "find"]);
		expect(payload.tools?.find(tool => tool.name === "bash")?.input_schema?.required).toEqual(["requiredValue"]);
	});

	it("marks regular two-field Zod object tools strict", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: true,
				parameters: arkType({
					command: "string",
					cwd: "string",
				}),
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{
				name?: string;
				strict?: boolean;
				input_schema?: { properties?: Record<string, unknown>; required?: string[] };
			}>;
		};

		const bashTool = payload.tools?.find(tool => tool.name === "bash");

		expect(bashTool?.strict).toBe(true);
		expect(Object.keys(bashTool?.input_schema?.properties ?? {})).toEqual(["command", "cwd"]);
		expect(bashTool?.input_schema?.required).toEqual(["command", "cwd"]);
	});

	it("does not mark allowlisted Anthropic tools strict when schemas contain open object maps", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
						env: {
							type: "object",
							additionalProperties: { type: "string" },
						},
					},
					required: ["command"],
				} as TJsonSchema,
			},
			{
				name: "python",
				description: "python tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{
				name?: string;
				strict?: boolean;
				input_schema?: { properties?: Record<string, unknown>; required?: string[] };
			}>;
		};

		const bashTool = payload.tools?.find(tool => tool.name === "bash");
		const pythonTool = payload.tools?.find(tool => tool.name === "python");
		const env = bashTool?.input_schema?.properties?.env as { additionalProperties?: unknown } | undefined;

		expect(bashTool?.strict).toBeUndefined();
		expect(env?.additionalProperties).toEqual({ type: "string" });
		expect(pythonTool?.strict).toBe(true);
		expect(pythonTool?.input_schema?.required).toEqual(["requiredValue"]);
	});

	it("honors strict=false and skips non-allowlisted Anthropic tools", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: false,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
			{
				name: "python",
				description: "python tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
			{
				name: "write",
				description: "write tool",
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
			{
				name: "grep",
				description: "grep tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as TJsonSchema,
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name?: string; strict?: boolean }> };

		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);
		expect(strictNames).toEqual(["python"]);
	});

	it("demotes allowlisted tools with strict-incompatible schema keywords to non-strict", async () => {
		const tools: Tool[] = [
			{
				name: "edit",
				description: "Edit a value",
				parameters: {
					type: "object",
					properties: { q: { oneOf: [{ type: "string" }, { type: "integer" }] } },
					required: ["q"],
				} as TJsonSchema,
			},
			{
				name: "python",
				description: "python tool",
				parameters: {
					type: "object",
					properties: { tagged: { type: "object", patternProperties: { "^x-": { type: "string" } } } },
					required: ["tagged"],
				} as TJsonSchema,
			},
			{
				name: "find",
				description: "find tool",
				parameters: {
					type: "object",
					properties: { pattern: { type: "string" } },
					required: ["pattern"],
				} as TJsonSchema,
			},
		];
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name?: string; strict?: boolean }> };

		// oneOf/allOf/$ref compile unpredictably under the strict grammar and
		// patternProperties contradicts the injected additionalProperties:false;
		// such tools must stay non-strict while clean allowlisted tools keep it.
		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);
		expect(strictNames).toEqual(["find"]);
	});

	it("keeps the interleaved-thinking beta for dated Opus 4.0 ids", () => {
		const legacy = buildAnthropicClientOptions({
			model: buildModel({ ...ANTHROPIC_MODEL_SPEC, id: "claude-opus-4-20250514", name: "Claude Opus 4" }),
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: true,
			hasTools: false,
		});
		// The date suffix must not parse as minor=20250514 (>= 4.7 display support).
		expect(legacy.defaultHeaders["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");

		const modern = buildAnthropicClientOptions({
			model: buildModel({ ...ANTHROPIC_MODEL_SPEC, id: "claude-opus-4-7", name: "Claude Opus 4.7" }),
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: true,
			hasTools: false,
		});
		expect(modern.defaultHeaders["anthropic-beta"] ?? "").not.toContain("interleaved-thinking-2025-05-14");
	});

	it("adds legacy fine-grained tool-streaming beta only for tool requests on incompatible models", () => {
		const incompatibleModel: Model<"anthropic-messages"> = buildModel({
			...ANTHROPIC_MODEL_SPEC,
			compat: { supportsEagerToolInputStreaming: false },
		});

		const withoutTools = buildAnthropicClientOptions({
			model: incompatibleModel,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: false,
		});
		const withCompatibleTools = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});
		const withIncompatibleTools = buildAnthropicClientOptions({
			model: incompatibleModel,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});

		// No betas at all → the header is omitted entirely on API-key requests.
		expect(withoutTools.defaultHeaders["anthropic-beta"]).toBeUndefined();
		expect(withCompatibleTools.defaultHeaders["anthropic-beta"]).toBeUndefined();
		expect(withIncompatibleTools.defaultHeaders["anthropic-beta"]).toContain(
			"fine-grained-tool-streaming-2025-05-14",
		);
	});

	it("uses Cloudflare AI Gateway authorization without Anthropic credential headers", () => {
		const options = buildAnthropicClientOptions({
			model: CLOUDFLARE_ANTHROPIC_MODEL,
			apiKey: "cf-gateway-token",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic");
		expect(options.apiKey).toBeNull();
		expect(options.authToken).toBeNull();
		expect(options.defaultHeaders["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("keeps Cloudflare gateway auth authoritative over caller-supplied auth headers", () => {
		const options = buildAnthropicClientOptions({
			model: {
				...CLOUDFLARE_ANTHROPIC_MODEL,
				headers: {
					Authorization: "Bearer anthropic-oauth",
					"X-Api-Key": "sk-ant-api-leak",
					"cf-aig-authorization": "Bearer stale-token",
				},
			},
			apiKey: "cf-gateway-token",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		expect(options.defaultHeaders["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("applies Claude Code TLS profile for direct Anthropic transport", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const tlsOptions = (
			options.fetchOptions as
				| {
						tls?: {
							rejectUnauthorized?: boolean;
							serverName?: string;
							ciphers?: string;
						};
				  }
				| undefined
		)?.tls;
		expect(tlsOptions).toBeDefined();
		expect(tlsOptions?.rejectUnauthorized).toBe(true);
		expect(tlsOptions?.serverName).toBe("api.anthropic.com");
		expect(tlsOptions?.ciphers).toBe(tls.DEFAULT_CIPHERS);
	});

	it("uses Foundry base URL, Bearer auth, and custom headers when enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "foundry-token",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.baseURL).toBe("https://foundry.example.com/anthropic");
				expect(options.defaultHeaders.Authorization).toBe("Bearer foundry-token");
				expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
				expect(options.defaultHeaders["user-id"]).toBe("alice");
				expect(options.defaultHeaders["x-route"]).toBe("engineering");
			},
		);
	});

	it("forwards ANTHROPIC_CUSTOM_HEADERS to an enterprise gateway base URL without Foundry mode", async () => {
		const gatewayModel: Model<"anthropic-messages"> = buildModel({
			...ANTHROPIC_MODEL_SPEC,
			baseUrl: "https://gateway.example.com",
		});
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Key: secret",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: gatewayModel,
					apiKey: "sk-ant-api-test",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.defaultHeaders["X-Gateway-Key"]).toBe("secret");
			},
		);
	});

	it("omits ANTHROPIC_CUSTOM_HEADERS when neither Foundry mode nor a custom base URL is configured", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Key: secret",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "sk-ant-api-test",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.defaultHeaders["X-Gateway-Key"]).toBeUndefined();
			},
		);
	});

	it("loads Foundry mTLS and CA material from file paths", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-foundry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const caPath = path.join(tmpDir, "ca.pem");
		const certPath = path.join(tmpDir, "client-cert.pem");
		const keyPath = path.join(tmpDir, "client-key.pem");
		fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", "utf8");

		try {
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: "1",
					FOUNDRY_BASE_URL: "https://foundry.example.com",
					NODE_EXTRA_CA_CERTS: caPath,
					CLAUDE_CODE_CLIENT_CERT: certPath,
					CLAUDE_CODE_CLIENT_KEY: keyPath,
				},
				() => {
					const options = buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					});

					const tlsOptions = (
						options.fetchOptions as
							| {
									tls?: {
										serverName?: string;
										ca?: string | string[];
										cert?: string;
										key?: string;
									};
							  }
							| undefined
					)?.tls;
					expect(tlsOptions?.serverName).toBe("foundry.example.com");
					expect(Array.isArray(tlsOptions?.ca)).toBe(true);
					const caValues = (tlsOptions?.ca ?? []) as string[];
					expect(caValues.length).toBeGreaterThanOrEqual(tls.rootCertificates.length + 1);
					expect(caValues.slice(0, tls.rootCertificates.length)).toEqual([...tls.rootCertificates]);
					expect(caValues.at(-1)).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.cert).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.key).toContain("BEGIN PRIVATE KEY");
				},
			);
		} finally {
			removeSyncWithRetries(tmpDir);
		}
	});

	it("throws when Foundry mTLS cert/key pair is incomplete", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com",
				CLAUDE_CODE_CLIENT_CERT: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
				CLAUDE_CODE_CLIENT_KEY: undefined,
			},
			() => {
				expect(() =>
					buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					}),
				).toThrow("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
			},
		);
	});

	it("resolves Anthropic Foundry API key when Foundry mode is enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				ANTHROPIC_FOUNDRY_API_KEY: "foundry-env-token",
				ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-should-not-win",
				ANTHROPIC_API_KEY: "sk-ant-api-should-not-win",
			},
			() => {
				expect(getEnvApiKey("anthropic")).toBe("foundry-env-token");
			},
		);
	});

	it("sends temperature for Anthropic requests without enabled thinking", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ temperature: 0.2 },
		)) as { temperature?: number; thinking?: { type?: string } };

		expect(payload.temperature).toBe(0.2);
		expect(payload.thinking).toBeUndefined();
	});

	it("sends disabled thinking for reasoning models when thinking is explicitly disabled", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ thinkingEnabled: false },
		)) as { thinking?: { type?: string } };

		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("keeps sampling params when reasoning is explicitly disabled", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ thinkingEnabled: false, temperature: 0.2, topP: 0.3, topK: 4 },
		)) as { thinking?: { type?: string }; temperature?: number; top_p?: number; top_k?: number };

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.temperature).toBe(0.2);
		expect(payload.top_p).toBe(0.3);
		expect(payload.top_k).toBe(4);
	});

	it("drops temperature and sampling params for Opus 4.7 without enabled thinking", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({ ...ANTHROPIC_MODEL_SPEC, id: "claude-opus-4-7", name: "Claude Opus 4.7" }),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("drops sampling params for Claude Fable/Mythos 5 without enabled thinking", async () => {
		for (const id of ["claude-fable-5", "claude-mythos-5"] as const) {
			const payload = (await captureAnthropicPayload(
				buildModel({
					...ANTHROPIC_MODEL_SPEC,
					id,
					name: id === "claude-fable-5" ? "Claude Fable 5" : "Claude Mythos 5",
				}),
				{
					systemPrompt: ["Stay concise."],
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					temperature: 0.2,
					topP: 0.3,
					topK: 4,
				},
			)) as {
				temperature?: number;
				top_p?: number;
				top_k?: number;
				thinking?: { type?: string };
			};

			expect(payload.temperature).toBeUndefined();
			expect(payload.top_p).toBeUndefined();
			expect(payload.top_k).toBeUndefined();
			expect(payload.thinking).toBeUndefined();
		}
	});

	it("drops sampling params and keeps summarized adaptive thinking for OAuth Opus 4.7+", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.High,
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string; display?: string };
			context_management?: { edits?: Array<{ type?: string; keep?: string | number }> };
			output_config?: { effort?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
		expect(payload.output_config).toEqual({ effort: "xhigh" });

		const maxPayload = (await captureAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.XHigh,
			},
		)) as {
			thinking?: { type?: string; display?: string };
			output_config?: { effort?: string };
		};
		expect(maxPayload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(maxPayload.output_config).toEqual({ effort: "max" });
	});

	it("maps simple-stream budget-effort reasoning to Anthropic output_config effort", async () => {
		const payload = (await captureSimpleAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "umans-glm-5.2",
				name: "Umans GLM 5.2",
				provider: "umans",
				baseUrl: "https://api.code.umans.ai",
				thinking: {
					mode: "anthropic-budget-effort",
					efforts: [Effort.High, Effort.XHigh],
					effortMap: { [Effort.XHigh]: "max" },
				},
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			Effort.XHigh,
		)) as {
			thinking?: { type?: string; budget_tokens?: number };
			output_config?: { effort?: string };
		};

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.budget_tokens).toBeGreaterThan(0);
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("omits output_config.effort on direct Anthropic Sonnet/Haiku 4.5 budget thinking (#3497)", async () => {
		// Anthropic's first-party Messages API rejects `output_config.effort` on
		// Claude Sonnet 4.5 and Haiku 4.5 with HTTP 400 "This model does not
		// support the effort parameter." These SKUs must serialize as plain
		// budget-token thinking while still honoring the requested effort tier
		// via `thinking.budget_tokens`. Opus 4.5 supports the field and keeps
		// emitting it — covered in the next test.
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				isOAuth: false,
				thinkingEnabled: true,
				reasoning: Effort.Medium,
			},
		)) as {
			thinking?: { type?: string; budget_tokens?: number; display?: string };
			output_config?: { effort?: string };
		};

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.budget_tokens).toBeGreaterThan(0);
		expect(payload.output_config).toBeUndefined();
	});

	it("emits output_config.effort on direct Anthropic Opus 4.5 budget thinking (#3497)", async () => {
		// Opus 4.5 supports `output_config.effort` alongside `thinking.budget_tokens`.
		// The catalog flips Opus 4.5 specifically back to `anthropic-budget-effort`
		// while Sonnet 4.5 / Haiku 4.5 stay on plain `budget`.
		const payload = (await captureAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5",
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				isOAuth: false,
				thinkingEnabled: true,
				reasoning: Effort.Medium,
			},
		)) as {
			thinking?: { type?: string; budget_tokens?: number; display?: string };
			output_config?: { effort?: string };
		};

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.budget_tokens).toBeGreaterThan(0);
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it("keeps summarized adaptive thinking and context management for API-key Opus 4.7+ requests", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				isOAuth: false,
				thinkingEnabled: true,
				reasoning: Effort.High,
			},
		)) as {
			thinking?: { type?: string; display?: string };
			context_management?: { edits?: Array<{ type?: string; keep?: string | number }> };
			output_config?: { effort?: string };
		};

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("sends task budgets through Anthropic output_config without dropping adaptive effort", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Review this repo", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.High,
				taskBudget: { type: "tokens", total: 64_000, remaining: 48_000 },
			},
		)) as {
			output_config?: {
				effort?: string;
				task_budget?: TokenTaskBudget;
			};
		};

		expect(payload.output_config).toEqual({
			effort: "xhigh",
			task_budget: { type: "tokens", total: 64_000, remaining: 48_000 },
		});
	});

	it("preserves task budget when forced tool choice disables thinking", async () => {
		const payload = (await captureAnthropicPayload(
			buildModel({
				...ANTHROPIC_MODEL_SPEC,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
			}),
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
				tools: [
					{
						name: "lookup",
						description: "Lookup a value",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.High,
				taskBudget: { type: "tokens", total: 64_000 },
				toolChoice: "any",
			},
		)) as {
			thinking?: unknown;
			output_config?: {
				effort?: string;
				task_budget?: TokenTaskBudget;
			};
		};

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({
			task_budget: { type: "tokens", total: 64_000 },
		});
	});

	it("downgrades forced tool choice for Claude Fable/Mythos without deleting adaptive thinking", async () => {
		for (const id of ["claude-fable-5", "claude-mythos-5"] as const) {
			const payload = (await captureAnthropicPayload(
				buildModel({
					...ANTHROPIC_MODEL_SPEC,
					id,
					name: id === "claude-fable-5" ? "Claude Fable 5" : "Claude Mythos 5",
					contextWindow: 1_000_000,
					maxTokens: 128_000,
					thinking: {
						mode: "anthropic-adaptive",
						efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
					},
				}),
				{
					systemPrompt: ["Stay concise."],
					messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
					tools: [
						{
							name: "lookup",
							description: "Lookup a value",
							parameters: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				},
				{
					thinkingEnabled: true,
					reasoning: Effort.High,
					toolChoice: "any",
				},
			)) as {
				thinking?: { type?: string; display?: string };
				tool_choice?: { type?: string };
				output_config?: { effort?: string };
			};

			expect(payload.tool_choice).toEqual({ type: "auto" });
			expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.output_config).toEqual({ effort: "xhigh" });
		}
	});

	it("treats tool prefix helpers as no-ops when prefix is empty string", () => {
		// Directly verify the codec's identity behaviour: builtins pass through apply unchanged.
		// (Empty-prefix path is exercised by the builtin guard below; the contract is
		//  roundtrip fidelity, not knowledge of the literal prefix string.)
		const name = "Read";
		expect(stripClaudeToolPrefix(applyClaudeToolPrefix(name))).toBe(name);
	});

	it("does not prefix built-in Anthropic tool names", () => {
		expect(applyClaudeToolPrefix("web_search")).toBe("web_search");
		expect(applyClaudeToolPrefix("CODE_EXECUTION")).toBe("CODE_EXECUTION");
		expect(applyClaudeToolPrefix("Text_Editor")).toBe("Text_Editor");
		expect(applyClaudeToolPrefix("computer")).toBe("computer");
	});

	it("prefixes custom tool names and roundtrips cleanly", () => {
		const name = "Read";
		const prefixed = applyClaudeToolPrefix(name);
		expect(prefixed).toBe(`${claudeToolPrefix}${name}`);
		expect(stripClaudeToolPrefix(prefixed)).toBe(name); // roundtrip

		// The prefix codec is injective, NOT idempotent: an internal tool name that
		// already starts with the prefix gets a second one so it survives the return
		// trip. Skipping it would strip a real leading underscore and lose the tool.
		const underscored = `${claudeToolPrefix}foo`;
		const underscoredWire = applyClaudeToolPrefix(underscored);
		expect(underscoredWire).toBe(`${claudeToolPrefix}${underscored}`);
		expect(stripClaudeToolPrefix(underscoredWire)).toBe(underscored);
	});
});

describe("cch attestation", () => {
	it("wrapFetchForCch: replaces cch=00000 with correct XXHash64 in outgoing request body", async () => {
		const { promise: bodyPromise, resolve: bodyResolve } = Promise.withResolvers<string>();
		const controller = new AbortController();

		const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = init?.body;
			const body = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
			bodyResolve(body);
			controller.abort();
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		streamAnthropic(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Be helpful."],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ apiKey: "sk-ant-oat-test", isOAuth: true, signal: controller.signal, fetch: fakeFetch },
		);

		const capturedBody = await bodyPromise;

		// The placeholder must have been replaced before the request was sent.
		expect(capturedBody).toContain("cch=");
		expect(capturedBody).not.toContain("cch=00000");
		const m = capturedBody.match(/cch=([0-9a-f]{5})/);
		expect(m).not.toBeNull();

		// Self-consistency: hashing the body with the placeholder restored must reproduce the embedded cch.
		const CCH_SEED = 0x4d659218e32a3268n;
		const withPlaceholder = capturedBody.replace(/cch=[0-9a-f]{5}/, "cch=00000");
		const h = Bun.hash.xxHash64(new TextEncoder().encode(withPlaceholder), CCH_SEED);
		expect(m![1]).toBe((h & 0xfffffn).toString(16).padStart(5, "0"));
	});

	it("derives cch from low-20-bits of XXHash64(body, seed) — external reference values", () => {
		// Each body contains "cch=00000" as the Bun HTTP layer sees it before patching.
		// Expected low-20-bit hashes precomputed with the Python xxhash reference.
		const CCH_SEED = 0x4d659218e32a3268n;
		const enc = new TextEncoder();
		const cases: [string, string][] = [
			["cch=00000", "a47f7"],
			['{"messages":[],"cch=00000","x":1}', "3073d"],
			["x-anthropic-billing-header: cc_version=2.1.158; cc_entrypoint=cli; cch=00000;", "f2b0b"],
		];
		for (const [body, expected] of cases) {
			const h = Bun.hash.xxHash64(enc.encode(body), CCH_SEED);
			expect((h & 0xfffffn).toString(16).padStart(5, "0")).toBe(expected);
		}
	});
});
