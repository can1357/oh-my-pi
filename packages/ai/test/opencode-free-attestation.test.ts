import { describe, expect, it } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { applyInferenceHeaders } from "@oh-my-pi/pi-ai/providers/inference-headers";
import {
	isOpenCodeFreeModel,
	OPENCODE_FREE_SYSTEM_PROMPT,
	OPENCODE_FREE_USER_AGENT,
	openCodeFreeSessionId,
	withOpenCodeFreeSystemPrompt,
} from "@oh-my-pi/pi-ai/providers/opencode-free";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { USER_AGENT } from "@oh-my-pi/pi-utils";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

interface WireCall {
	headers: Headers;
	body: { stream?: boolean; messages: Array<{ role: string; content: string }> };
}

function chatSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function makeZenModel(id = "deepseek-v4.1-flash-free"): Model<"openai-completions"> {
	return buildModel({
		provider: "opencode-zen",
		id,
		name: id,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
		baseUrl: "https://opencode.ai/zen/v1",
	});
}

describe("isOpenCodeFreeModel", () => {
	it("matches only free Zen models", () => {
		expect(isOpenCodeFreeModel({ provider: "opencode-zen", id: "deepseek-v4.1-flash-free" })).toBe(true);
		expect(isOpenCodeFreeModel({ provider: "opencode-zen", id: "deepseek-v4.1-flash" })).toBe(false);
		expect(isOpenCodeFreeModel({ provider: "opencode-go", id: "deepseek-v4.1-flash-free" })).toBe(false);
	});

	it("resolves the declared backend for a custom provider", () => {
		expect(isOpenCodeFreeModel({ provider: "mine", providerType: "opencode-zen", id: "glm-5-free" })).toBe(true);
	});

	it("is not fooled by an empty id", () => {
		expect(isOpenCodeFreeModel({ provider: "opencode-zen", id: "" })).toBe(false);
	});
});

describe("openCodeFreeSessionId", () => {
	it("shapes the id like the client's and stays stable", () => {
		const id = openCodeFreeSessionId("session-1");
		expect(id).toMatch(/^ses_[a-z0-9]+$/);
		expect(openCodeFreeSessionId("session-1")).toBe(id);
		expect(openCodeFreeSessionId("session-2")).not.toBe(id);
	});

	it("leaves an already-shaped session alone", () => {
		expect(openCodeFreeSessionId("ses_abc123")).toBe("ses_abc123");
	});
});

describe("withOpenCodeFreeSystemPrompt", () => {
	it("puts the client prompt in front of the real system prompt", () => {
		const context: Context = { systemPrompt: ["You are omp."], messages: [] };
		const patched = withOpenCodeFreeSystemPrompt(context);
		expect(patched.systemPrompt?.[0]).toBe(`${OPENCODE_FREE_SYSTEM_PROMPT}\n\nYou are omp.`);
		expect(context.systemPrompt).toEqual(["You are omp."]);
	});

	it("keeps later system blocks in order", () => {
		const patched = withOpenCodeFreeSystemPrompt({ systemPrompt: ["a", "b"], messages: [] });
		expect(patched.systemPrompt).toEqual([`${OPENCODE_FREE_SYSTEM_PROMPT}\n\na`, "b"]);
	});

	it("covers a context with no system prompt", () => {
		expect(withOpenCodeFreeSystemPrompt({ messages: [] }).systemPrompt).toEqual([OPENCODE_FREE_SYSTEM_PROMPT]);
	});

	it("does not double up on a retried context", () => {
		const once = withOpenCodeFreeSystemPrompt({ systemPrompt: ["You are omp."], messages: [] });
		expect(withOpenCodeFreeSystemPrompt(once)).toBe(once);
	});
});

describe("free Zen request identity", () => {
	it("sends the client User-Agent and a ses_ session on a free model", () => {
		const headers: Record<string, string> = {};
		applyInferenceHeaders(headers, {
			provider: "opencode-zen",
			protocol: "openai",
			modelId: "deepseek-v4.1-flash-free",
			sessionId: "session-1",
		});
		expect(headers["User-Agent"]).toBe(OPENCODE_FREE_USER_AGENT);
		expect(headers[OPENCODE_SESSION_HEADER]).toBe(openCodeFreeSessionId("session-1"));
	});

	it("leaves every other Zen and Go lane on omp's identity", () => {
		for (const [provider, modelId] of [
			["opencode-zen", "deepseek-v4.1-flash"],
			["opencode-go", "deepseek-v4-pro"],
		] as const) {
			const headers: Record<string, string> = {};
			applyInferenceHeaders(headers, { provider, protocol: "openai", modelId, sessionId: "session-1" });
			expect(headers["User-Agent"]).toBe(USER_AGENT);
			expect(headers[OPENCODE_SESSION_HEADER]).toBe("session-1");
		}
	});

	it("carries both onto the wire for a streamed free-model turn", async () => {
		const seen: WireCall[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as WireCall["body"] });
			return chatSse();
		};
		await completeSimple(
			makeZenModel(),
			{ systemPrompt: ["You are omp."], messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "public", sessionId: "session-1", fetch: fetchMock as typeof fetch },
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get("User-Agent")).toBe(OPENCODE_FREE_USER_AGENT);
		expect(seen[0]?.headers.get(OPENCODE_SESSION_HEADER)).toBe(openCodeFreeSessionId("session-1"));
		const system = seen[0]?.body.messages.find(m => m.role === "system");
		expect(system?.content).toBe(`${OPENCODE_FREE_SYSTEM_PROMPT}\n\nYou are omp.`);
		expect(seen[0]?.body.stream).toBe(true);
	});

	it("leaves the paid lane's body and headers untouched", async () => {
		const seen: WireCall[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as WireCall["body"] });
			return chatSse();
		};
		await completeSimple(
			makeZenModel("deepseek-v4.1-flash"),
			{ systemPrompt: ["You are omp."], messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", sessionId: "session-1", fetch: fetchMock as typeof fetch },
		);

		expect(seen[0]?.headers.get("User-Agent")).toBe(USER_AGENT);
		expect(seen[0]?.headers.get(OPENCODE_SESSION_HEADER)).toBe("session-1");
		expect(seen[0]?.body.messages[0].content).toBe("You are omp.");
	});
});
