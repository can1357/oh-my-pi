import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	buildCopilotDynamicHeaders,
	clearCopilotIntegrationCache,
	getCachedCopilotIntegrationId,
	getCopilotIntegrationCacheKey,
	getCopilotInitiatorOverride,
	getCopilotPremiumMultiplier,
	hasCopilotVisionInput,
	inferCopilotInitiator,
	rememberCopilotWorkingIntegrationId,
	resolveCopilotIntegrationIdOverride,
	resolveCopilotRequestIdentity,
	wrapFetchForCopilotFallback,
} from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { COPILOT_CHAT_INTEGRATION_ID } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import type { Message } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("inferCopilotInitiator", () => {
	it("returns 'user' when there are no messages", () => {
		expect(inferCopilotInitiator([])).toBe("user");
	});

	it("returns 'agent' when last message role is assistant", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
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
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'agent' when last message is toolResult", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'user' when last message is user with text content", () => {
		const messages: Message[] = [{ role: "user", content: "what time is it?", timestamp: Date.now() }];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});

	it("returns 'user' when last message is user with text content blocks", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "explain this image" }],
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});

	it("prefers explicit attribution over role when attribution is agent", () => {
		const messages: Message[] = [
			{ role: "user", content: "internal reminder", attribution: "agent", timestamp: Date.now() },
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("prefers explicit attribution over role when attribution is user", () => {
		const messages: Message[] = [
			{ role: "developer", content: "forward user note", attribution: "user", timestamp: Date.now() },
		];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});
	it("returns 'agent' when last message is user but last content block is tool_result", () => {
		const messages: unknown[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tc_1", content: "done" }],
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'agent' for any non-user role", () => {
		const messages: unknown[] = [
			{
				role: "tool",
				tool_call_id: "call_abc123",
				content: "tool output",
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});
});

describe("getCopilotInitiatorOverride", () => {
	it("returns undefined when no initiator header is configured", () => {
		expect(getCopilotInitiatorOverride(undefined)).toBeUndefined();
		expect(getCopilotInitiatorOverride({})).toBeUndefined();
	});

	it("returns the last valid case-insensitive initiator value", () => {
		const headers = {
			"x-initiator": "agent",
			"X-Initiator": "user",
			"X-INITIATOR": "invalid",
			"x-InItIaToR": "agent",
		};
		expect(getCopilotInitiatorOverride(headers)).toBe("agent");
	});

	it("ignores invalid initiator values", () => {
		expect(getCopilotInitiatorOverride({ "X-Initiator": "system" })).toBeUndefined();
	});
});
describe("hasCopilotVisionInput", () => {
	it("returns false when no messages have images", () => {
		const messages: Message[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});

	it("returns true when a user message has image content", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this" },
					{ type: "image", data: "abc123", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns true when a toolResult has image content", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "screenshot",
				content: [{ type: "image", data: "def456", mimeType: "image/jpeg" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns false when user message has only text content", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "just text" }],
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
});

describe("getCopilotPremiumMultiplier", () => {
	it("returns bundled multiplier metadata for paid-tier Copilot plans", () => {
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "claude-haiku-4.5").premiumMultiplier, "paid"),
		).toBe(0.33);
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "claude-opus-4.6").premiumMultiplier, "paid"),
		).toBe(3);
		expect(getCopilotPremiumMultiplier(getBundledModel("github-copilot", "gpt-4o").premiumMultiplier, "paid")).toBe(
			0,
		);
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "gpt-5.4-mini").premiumMultiplier, "paid"),
		).toBe(0.33);
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "grok-code-fast-1").premiumMultiplier, "paid"),
		).toBe(0.25);
	});

	it("treats zero-multiplier models as 1x for free-tier or unknown plans", () => {
		expect(getCopilotPremiumMultiplier(0, "free")).toBe(1);
		expect(getCopilotPremiumMultiplier(0, undefined)).toBe(1);
		expect(getCopilotPremiumMultiplier(0, "enterprise")).toBe(1);
	});

	it("defaults to 1x when multiplier metadata is missing", () => {
		expect(getCopilotPremiumMultiplier(undefined, "paid")).toBe(1);
		expect(getCopilotPremiumMultiplier(undefined, "free")).toBe(1);
	});
});

describe("buildCopilotDynamicHeaders", () => {
	it("uses Copilot CLI identity for user-initiated requests", () => {
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			premiumMultiplier: 0.33,
		});
		expect(headers).toEqual({
			"User-Agent": "copilot/1.0.82",
			"Editor-Version": "copilot/1.0.82",
			"Copilot-Integration-Id": "copilot-chat",
			"Copilot-Harness-Id": "copilot-sdk",
			"Openai-Intent": "conversation-agent",
			"X-Initiator": "user",
			"X-Interaction-Type": "conversation-user",
		});
		expect(premiumRequests).toBe(0.33);
	});

	it("uses 0x multiplier for included models on paid-tier plans", () => {
		const { premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			premiumMultiplier: 0,
			planTier: "paid",
		});
		expect(premiumRequests).toBe(0);
	});

	it("treats included models as 1x for free-tier plans", () => {
		const { premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			premiumMultiplier: 0,
			planTier: "free",
		});
		expect(premiumRequests).toBe(1);
	});

	it("defaults unknown or missing plan tiers to free-tier behavior", () => {
		expect(
			buildCopilotDynamicHeaders({
				messages: [],
				hasImages: false,
				premiumMultiplier: 0,
			}).premiumRequests,
		).toBe(1);
		expect(
			buildCopilotDynamicHeaders({
				messages: [],
				hasImages: false,
				premiumMultiplier: 0,
				planTier: "enterprise",
			}).premiumRequests,
		).toBe(1);
	});

	it("infers agent initiation when bundled model headers are present", () => {
		const model = getBundledModel("github-copilot", "gpt-4o");
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [{ role: "tool", tool_call_id: "call_abc123", content: "done" }],
			hasImages: false,
			premiumMultiplier: 3,
			headers: model.headers,
		});
		expect(headers["X-Initiator"]).toBe("agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-agent");
		expect(premiumRequests).toBe(0);
	});

	it("preserves explicit initiator override over inferred value and sets 0 premium requests for agent", () => {
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [
				{
					role: "user",
					content:
						"<conversation>\nuser: summarize the discarded history\nassistant: keep the latest turn\n</conversation>\n\nProvide a compaction summary.",
				},
			],
			hasImages: false,
			premiumMultiplier: 3,
			initiatorOverride: "agent",
		});
		expect(headers["X-Initiator"]).toBe("agent");
		expect(headers["Openai-Intent"]).toBe("conversation-agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-agent");
		expect(premiumRequests).toBe(0);
	});

	it("sets Copilot-Vision-Request when hasImages is true", () => {
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: true,
			premiumMultiplier: 3,
		});
		expect(headers["X-Initiator"]).toBe("user");
		expect(headers["Openai-Intent"]).toBe("conversation-agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-user");
		expect(headers["Copilot-Vision-Request"]).toBe("true");
		expect(premiumRequests).toBe(3);
	});

	it("defaults to 1x when premium multiplier is not provided", () => {
		const { premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
		});
		expect(premiumRequests).toBe(1);
	});
});

describe("resolveCopilotIntegrationIdOverride", () => {
	it("returns undefined when COPILOT_INTEGRATION_ID is unset", () => {
		expect(resolveCopilotIntegrationIdOverride({})).toBeUndefined();
	});

	it("trims surrounding whitespace", () => {
		expect(resolveCopilotIntegrationIdOverride({ COPILOT_INTEGRATION_ID: "  vscode-chat  " })).toBe("vscode-chat");
	});

	it("ignores blank and header-injection values", () => {
		for (const value of ["", "   ", "chat\r\nX-Injected: 1"]) {
			expect(resolveCopilotIntegrationIdOverride({ COPILOT_INTEGRATION_ID: value })).toBeUndefined();
		}
	});
});

describe("resolveCopilotRequestIdentity", () => {
	it("prefers an explicit value over headers and env", () => {
		expect(
			resolveCopilotRequestIdentity({ "Copilot-Integration-Id": "copilot-chat" }, "vscode-chat", {
				COPILOT_INTEGRATION_ID: "other-chat",
			}),
		).toBe("vscode-chat");
	});

	it("reads caller headers case-insensitively ahead of env", () => {
		expect(resolveCopilotRequestIdentity({ "copilot-integration-id": "copilot-chat" }, undefined, {})).toBe(
			"copilot-chat",
		);
	});

	it("falls back to COPILOT_INTEGRATION_ID", () => {
		expect(resolveCopilotRequestIdentity(undefined, undefined, { COPILOT_INTEGRATION_ID: "copilot-chat" })).toBe(
			"copilot-chat",
		);
	});

	it("returns undefined when nothing is set", () => {
		expect(resolveCopilotRequestIdentity(undefined, undefined, {})).toBeUndefined();
	});

	it("rejects header-injection values from every source", () => {
		expect(resolveCopilotRequestIdentity({ "Copilot-Integration-Id": "a\r\nb" }, undefined, {})).toBeUndefined();
		expect(resolveCopilotRequestIdentity(undefined, "a\r\nb", {})).toBeUndefined();
	});
});

describe("buildCopilotDynamicHeaders integration identity", () => {
	it("sends an explicit integration id without touching the rest of the identity", () => {
		const { headers } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			integrationId: "copilot-chat",
			enterpriseUrl: "ghe.example.com",
		});
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-chat");
		expect(headers["Editor-Version"]).toBe("copilot/1.0.82");
	});

	it("falls back to the chat-surface default", () => {
		const { headers } = buildCopilotDynamicHeaders({ messages: [], hasImages: false });
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-chat");
	});

	it("keeps the CLI identity for Enterprise requests", () => {
		const { headers } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			enterpriseUrl: "ghe.example.com",
		});
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
	});

	it("treats invalid explicit values as unset", () => {
		for (const value of ["", "chat\r\nX-Injected: 1"]) {
			const { headers } = buildCopilotDynamicHeaders({ messages: [], hasImages: false, integrationId: value });
			expect(headers["Copilot-Integration-Id"]).toBe("copilot-chat");
		}
	});
});

describe("wrapFetchForCopilotFallback", () => {
	const chatUrl = "https://api.githubcopilot.com/chat/completions";
	function chatRequest(init?: RequestInit): [string, RequestInit | undefined] {
		return [
			chatUrl,
			{
				...init,
				headers: {
					Authorization: "Bearer ghu_test",
					"Copilot-Integration-Id": COPILOT_CHAT_INTEGRATION_ID,
				},
			},
		];
	}

	it("passes non-403 responses through untouched", async () => {
		const ok = new Response("{}", { status: 200 });
		const fetchMock = vi.fn(async () => ok);
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		await expect(wrapped(...chatRequest())).resolves.toBe(ok);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("passes through when disabled", async () => {
		const denied = new Response("{}", { status: 403 });
		const fetchMock = vi.fn(async () => denied);
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, false);
		await expect(wrapped(...chatRequest())).resolves.toBe(denied);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("ignores 403s without the default chat identity", async () => {
		const denied = new Response("{}", { status: 403 });
		const seen: (string | null)[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("Copilot-Integration-Id"));
			return denied;
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		await wrapped(chatUrl, { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(seen).toEqual(["copilot-developer-cli"]);
	});

	it("respects a resolved identity instead of retrying", async () => {
		const denied = new Response("{}", { status: 403 });
		const fetchMock = vi.fn(async () => denied);
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, "vscode-chat");
		await expect(wrapped(...chatRequest())).resolves.toBe(denied);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a chat-default 403 once as the Copilot CLI and returns the retry", async () => {
		const seen: (string | null)[] = [];
		let calls = 0;
		let first: Response | undefined;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			calls++;
			seen.push(new Headers(init?.headers).get("Copilot-Integration-Id"));
			const response = new Response("{}", { status: calls === 1 ? 403 : 200 });
			if (calls === 1) first = response;
			return response;
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		const result = await wrapped(...chatRequest());
		expect(result.status).toBe(200);
		expect(seen).toEqual([COPILOT_CHAT_INTEGRATION_ID, "copilot-developer-cli"]);
		expect(first?.bodyUsed).toBe(true);
	});

	it("stops after the retry stays denied", async () => {
		const seen: (string | null)[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("Copilot-Integration-Id"));
			return new Response("{}", { status: 403 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		const result = await wrapped(...chatRequest());
		expect(result.status).toBe(403);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(seen).toEqual([COPILOT_CHAT_INTEGRATION_ID, "copilot-developer-cli"]);
	});

	it("retries a chat-default 400 model_not_supported once as the Copilot CLI", async () => {
		const seen: (string | null)[] = [];
		let calls = 0;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			calls++;
			seen.push(new Headers(init?.headers).get("Copilot-Integration-Id"));
			const body = JSON.stringify({ error: { code: "model_not_supported" } });
			return new Response(body, { status: calls === 1 ? 400 : 200 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		const result = await wrapped(...chatRequest());
		expect(result.status).toBe(200);
		expect(seen).toEqual([COPILOT_CHAT_INTEGRATION_ID, "copilot-developer-cli"]);
	});

	it("passes 400s that are not model_not_supported through with the body intact", async () => {
		const denied = new Response(JSON.stringify({ error: { code: "invalid_request_error" } }), { status: 400 });
		const fetchMock = vi.fn(async () => denied);
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		const result = await wrapped(...chatRequest());
		expect(result).toBe(denied);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(denied.bodyUsed).toBe(false);
		expect(await result.json()).toEqual({ error: { code: "invalid_request_error" } });
	});

	it("preserves method, auth, and body on the retry", async () => {
		let retryInit: RequestInit | undefined;
		let calls = 0;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			calls++;
			if (calls === 2) retryInit = init;
			return new Response("{}", { status: 403 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		const [url, init] = chatRequest({ method: "POST", body: JSON.stringify({ model: "gpt-4o" }) });
		await wrapped(url, init);
		const retryHeaders = new Headers(retryInit?.headers);
		expect(retryInit?.method).toBe("POST");
		expect(retryHeaders.get("Authorization")).toBe("Bearer ghu_test");
		expect(retryInit?.body).toBe(JSON.stringify({ model: "gpt-4o" }));
		expect(retryHeaders.get("Copilot-Integration-Id")).toBe("copilot-developer-cli");
	});

	it("passes Request inputs through without retrying", async () => {
		const denied = new Response("{}", { status: 403 });
		const fetchMock = vi.fn(async () => denied);
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true);
		const request = new Request(chatUrl, {
			method: "POST",
			headers: { "Copilot-Integration-Id": COPILOT_CHAT_INTEGRATION_ID },
			body: "{}",
		});
		await expect(wrapped(request)).resolves.toBe(denied);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(denied.bodyUsed).toBe(false);
	});
});

describe("copilot working integration cache", () => {
	afterEach(() => {
		clearCopilotIntegrationCache();
		vi.restoreAllMocks();
	});

	it("keys credentials by bearer hash with routing inputs, never raw bytes", () => {
		const personal = getCopilotIntegrationCacheKey("ghu_personal_token")!;
		expect(getCopilotIntegrationCacheKey("ghu_personal_token")).toBe(personal);
		expect(personal).not.toContain("ghu_personal_token");
		expect(getCopilotIntegrationCacheKey("ghu_other_token")).not.toBe(personal);
		const enterprise = getCopilotIntegrationCacheKey(
			JSON.stringify({ token: "ghu_personal_token", enterpriseUrl: "ghe.example.com" }),
		)!;
		expect(enterprise).not.toBe(personal);
		expect(getCopilotIntegrationCacheKey(undefined)).toBeUndefined();
		expect(getCopilotIntegrationCacheKey("   ")).toBeUndefined();
	});

	it("isolates the same token across effective hosts", () => {
		const token = "ghu_shared_proxy_token";
		const hostA = getCopilotIntegrationCacheKey(token, "https://proxy-a.example")!;
		const hostB = getCopilotIntegrationCacheKey(token, "https://proxy-b.example")!;
		expect(hostA).not.toBe(hostB);
		expect(getCopilotIntegrationCacheKey(token, "https://proxy-a.example/")).toBe(hostA);
		rememberCopilotWorkingIntegrationId(hostA, "copilot-developer-cli");
		expect(getCachedCopilotIntegrationId(hostA)).toBe("copilot-developer-cli");
		expect(getCachedCopilotIntegrationId(hostB)).toBeUndefined();
	});

	it("remembers and clears the working shape per credential", () => {
		const key = getCopilotIntegrationCacheKey("ghu_cache_roundtrip")!;
		expect(getCachedCopilotIntegrationId(key)).toBeUndefined();
		rememberCopilotWorkingIntegrationId(key, "copilot-developer-cli");
		expect(getCachedCopilotIntegrationId(key)).toBe("copilot-developer-cli");
		rememberCopilotWorkingIntegrationId(key, "not an id\r\ninjected");
		expect(getCachedCopilotIntegrationId(key)).toBe("copilot-developer-cli");
		clearCopilotIntegrationCache(key);
		expect(getCachedCopilotIntegrationId(key)).toBeUndefined();
	});

	it("prefers cached working shape over defaults but never over explicit", () => {
		expect(
			buildCopilotDynamicHeaders({ messages: [], hasImages: false, cachedIntegrationId: "copilot-developer-cli" })
				.headers["Copilot-Integration-Id"],
		).toBe("copilot-developer-cli");
		expect(
			buildCopilotDynamicHeaders({
				messages: [],
				hasImages: false,
				integrationId: "vscode-chat",
				cachedIntegrationId: "copilot-developer-cli",
			}).headers["Copilot-Integration-Id"],
		).toBe("vscode-chat");
		expect(
			buildCopilotDynamicHeaders({ messages: [], hasImages: false, cachedIntegrationId: "bad\r\nid" }).headers[
				"Copilot-Integration-Id"
			],
		).toBe("copilot-chat");
	});

	it("lets a learned chat shape override the Enterprise CLI default", () => {
		expect(
			buildCopilotDynamicHeaders({
				messages: [],
				hasImages: false,
				enterpriseUrl: "ghe.example.com",
				cachedIntegrationId: "copilot-chat",
			}).headers["Copilot-Integration-Id"],
		).toBe("copilot-chat");
	});
});

describe("wrapFetchForCopilotFallback working-identity cache", () => {
	const chatUrl = "https://api.githubcopilot.com/chat/completions";
	afterEach(() => {
		clearCopilotIntegrationCache();
		vi.restoreAllMocks();
	});

	function chatRequest(init?: RequestInit): [string, RequestInit | undefined] {
		return [
			chatUrl,
			{
				...init,
				headers: {
					Authorization: "Bearer ghu_test",
					"Copilot-Integration-Id": COPILOT_CHAT_INTEGRATION_ID,
				},
			},
		];
	}

	it("remembers CLI after a chat denial clears on retry", async () => {
		const cacheKey = "test-working-shape-forward";
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls++;
			if (calls === 1) return new Response("{}", { status: 403 });
			return new Response("{}", { status: 200 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, undefined, cacheKey);
		const result = await wrapped(...chatRequest());
		expect(result.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBe("copilot-developer-cli");
	});

	it("leaves the cache empty when the CLI retry stays denied", async () => {
		const cacheKey = "test-working-shape-still-denied";
		const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, undefined, cacheKey);
		await wrapped(...chatRequest());
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBeUndefined();
	});

	it("never caches on auth failure and never retries an explicit pin", async () => {
		const authKey = "test-working-shape-401";
		let calls = 0;
		const authMock = vi.fn(async () => {
			calls++;
			return new Response("{}", { status: calls === 1 ? 403 : 401 });
		});
		await wrapFetchForCopilotFallback(
			authMock as unknown as typeof fetch,
			true,
			undefined,
			authKey,
		)(...chatRequest());
		expect(getCachedCopilotIntegrationId(authKey)).toBeUndefined();

		const pinKey = "test-working-shape-pinned";
		const denied = new Response("{}", { status: 403 });
		const pinMock = vi.fn(async () => denied);
		const pinned = wrapFetchForCopilotFallback(pinMock as unknown as typeof fetch, true, "vscode-chat", pinKey);
		await expect(pinned(...chatRequest())).resolves.toBe(denied);
		expect(pinMock).toHaveBeenCalledTimes(1);
		expect(getCachedCopilotIntegrationId(pinKey)).toBeUndefined();
	});

	it("retries a stale cached CLI as chat and relearns", async () => {
		const cacheKey = "test-working-shape-reverse";
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-developer-cli");
		const seen: (string | null)[] = [];
		let calls = 0;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			calls++;
			seen.push(new Headers(init?.headers).get("Copilot-Integration-Id"));
			if (calls === 1) return new Response("{}", { status: 403 });
			return new Response("{}", { status: 200 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, undefined, cacheKey);
		const result = await wrapped(chatUrl, {
			headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
		});
		expect(result.status).toBe(200);
		expect(seen).toEqual(["copilot-developer-cli", "copilot-chat"]);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBe("copilot-chat");
	});

	it("retries a stale cached CLI even when a sibling relearns mid-flight", async () => {
		const cacheKey = "test-working-shape-reverse-race";
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-developer-cli");
		const seen: (string | null)[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const outgoing = new Headers(init?.headers).get("Copilot-Integration-Id");
			seen.push(outgoing);
			return outgoing === "copilot-developer-cli"
				? new Response("{}", { status: 403 })
				: new Response("{}", { status: 200 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, undefined, cacheKey);
		// The wrapper snapshots the cached CLI synchronously on invocation, so a
		// sibling stream relearning chat between dispatch and denial must not
		// cancel this request's own reverse retry — otherwise it would surface a
		// denial even though chat works.
		const second = wrapped(chatUrl, { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } });
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-chat");
		const result = await second;
		expect(result.status).toBe(200);
		expect(seen).toEqual(["copilot-developer-cli", "copilot-chat"]);
	});

	it("clears a cached CLI both sides deny", async () => {
		const cacheKey = "test-working-shape-reverse-denied";
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-developer-cli");
		const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, undefined, cacheKey);
		await wrapped(chatUrl, { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBeUndefined();
	});

	it("leaves an uncached CLI denial terminal", async () => {
		const denied = new Response("{}", { status: 403 });
		const fetchMock = vi.fn(async () => denied);
		const wrapped = wrapFetchForCopilotFallback(
			fetchMock as unknown as typeof fetch,
			true,
			undefined,
			"test-working-shape-uncached-cli",
		);
		await expect(wrapped(chatUrl, { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } })).resolves.toBe(
			denied,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("clears the cache when the CLI retry fails", async () => {
		const cacheKey = "test-working-shape-forward-indeterminate";
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-chat");
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const outgoing = new Headers(init?.headers).get("Copilot-Integration-Id");
			if (outgoing === COPILOT_CHAT_INTEGRATION_ID) return new Response("{}", { status: 403 });
			return new Response("{}", { status: 500 });
		});
		const wrapped = wrapFetchForCopilotFallback(fetchMock as unknown as typeof fetch, true, undefined, cacheKey);
		const result = await wrapped(chatUrl, {
			headers: {
				Authorization: "Bearer ghu_test",
				"Copilot-Integration-Id": COPILOT_CHAT_INTEGRATION_ID,
			},
		});
		expect(result.status).toBe(500);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBeUndefined();
	});

	it("keeps reverse-retrying across transport resends and clears on failure", async () => {
		const cacheKey = "test-working-shape-reverse-indeterminate";
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-developer-cli");
		// Build-time provenance, as threaded by the transports: the resend
		// below reuses the headers (and snapshot) built before the first
		// attempt, so it must reverse-retry even though the failed first
		// attempt already invalidated the shared entry.
		const snapshot = getCachedCopilotIntegrationId(cacheKey);
		const seen: (string | null)[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const outgoing = new Headers(init?.headers).get("Copilot-Integration-Id");
			seen.push(outgoing);
			// CLI is identity-denied; chat hits a transport-retryable 500 the
			// transport will resend with the original CLI headers.
			return outgoing === "copilot-developer-cli"
				? new Response("{}", { status: 403 })
				: new Response("{}", { status: 500 });
		});
		const cliRequest = {
			headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
		};
		const first = await wrapFetchForCopilotFallback(
			fetchMock as unknown as typeof fetch,
			true,
			undefined,
			cacheKey,
			snapshot,
		)(chatUrl, cliRequest);
		expect(first.status).toBe(500);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBeUndefined();
		const second = await wrapFetchForCopilotFallback(
			fetchMock as unknown as typeof fetch,
			true,
			undefined,
			cacheKey,
			snapshot,
		)(chatUrl, cliRequest);
		expect(second.status).toBe(500);
		expect(seen).toEqual(["copilot-developer-cli", "copilot-chat", "copilot-developer-cli", "copilot-chat"]);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBeUndefined();
	});

	it("honors build-time provenance over a sibling's mid-flight relearn", async () => {
		const cacheKey = "test-working-shape-provenance";
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-developer-cli");
		// Headers built from the cached CLI; a sibling relearns chat before
		// this request dispatches. Without the build-time snapshot the wrapper
		// would see chat, skip its reverse retry, and surface the CLI denial
		// even though chat works.
		const snapshot = getCachedCopilotIntegrationId(cacheKey);
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-chat");
		const seen: (string | null)[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const outgoing = new Headers(init?.headers).get("Copilot-Integration-Id");
			seen.push(outgoing);
			return outgoing === "copilot-developer-cli"
				? new Response("{}", { status: 403 })
				: new Response("{}", { status: 200 });
		});
		const wrapped = wrapFetchForCopilotFallback(
			fetchMock as unknown as typeof fetch,
			true,
			undefined,
			cacheKey,
			snapshot,
		);
		const result = await wrapped(chatUrl, { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } });
		expect(result.status).toBe(200);
		expect(seen).toEqual(["copilot-developer-cli", "copilot-chat"]);
		expect(getCachedCopilotIntegrationId(cacheKey)).toBe("copilot-chat");
	});

	it("treats a null snapshot as default-built and skips reverse retry", async () => {
		const cacheKey = "test-working-shape-null-snapshot";
		const denied = new Response("{}", { status: 403 });
		const fetchMock = vi.fn(async () => denied);
		// `null` pins "cache was empty at build" (e.g. Enterprise default):
		// a sibling learning afterwards must not turn this default-built
		// request into a reverse retry.
		const wrapped = wrapFetchForCopilotFallback(
			fetchMock as unknown as typeof fetch,
			true,
			undefined,
			cacheKey,
			null,
		);
		rememberCopilotWorkingIntegrationId(cacheKey, "copilot-developer-cli");
		await expect(wrapped(chatUrl, { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } })).resolves.toBe(
			denied,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
