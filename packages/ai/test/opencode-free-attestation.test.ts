import { describe, expect, it } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { applyInferenceHeaders } from "@oh-my-pi/pi-ai/providers/inference-headers";
import {
	OPENCODE_FREE_SYSTEM_PROMPT,
	usesOpenCodeClientIdentity,
	withOpenCodeFreeSystemPrompt,
} from "@oh-my-pi/pi-ai/providers/opencode-free";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	getOpenCodeUserAgent,
	OPENCODE_SESSION_TOKEN_PATTERN,
	toOpenCodeSessionToken,
} from "@oh-my-pi/pi-catalog/wire/opencode";
import { USER_AGENT } from "@oh-my-pi/pi-utils";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

const OPENCODE_UA = getOpenCodeUserAgent();

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

describe("usesOpenCodeClientIdentity", () => {
	it("follows the KDL opt-in", () => {
		expect(usesOpenCodeClientIdentity({ opencodeClientIdentity: true })).toBe(true);
		expect(usesOpenCodeClientIdentity({})).toBe(false);
		expect(usesOpenCodeClientIdentity(undefined)).toBe(false);
	});
});

describe("toOpenCodeSessionToken", () => {
	it("produces the accepted shape and keeps the head's low 12 bits in range", () => {
		for (let index = 0; index < 40; index++) {
			const token = toOpenCodeSessionToken(`session-${index}`);
			expect(token).toMatch(OPENCODE_SESSION_TOKEN_PATTERN);
			expect(Number.parseInt(token.slice(4, 16), 16) & 0xfff).toBeGreaterThanOrEqual(0xfc0);
		}
	});

	it("stays stable for one conversation and apart across conversations", () => {
		expect(toOpenCodeSessionToken("session-1")).toBe(toOpenCodeSessionToken("session-1"));
		expect(toOpenCodeSessionToken("session-1")).not.toBe(toOpenCodeSessionToken("session-2"));
	});

	it("leaves an accepted token alone but repairs a low head", () => {
		const accepted = "ses_012345678fc0ABCDEFGHIJKLMN";
		expect(toOpenCodeSessionToken(accepted)).toBe(accepted);
		// Well shaped, head low12 0x9ab: the gateway rejects it as-is.
		const low = "ses_0123456789abABCDEFGHIJKLMN";
		const repaired = toOpenCodeSessionToken(low);
		expect(repaired).not.toBe(low);
		expect(Number.parseInt(repaired.slice(4, 16), 16) & 0xfff).toBeGreaterThanOrEqual(0xfc0);
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

	it("tolerates a bare string system prompt in a cast context", () => {
		const patched = withOpenCodeFreeSystemPrompt({ systemPrompt: "You are omp." } as unknown as Context);
		expect(patched.systemPrompt).toEqual([`${OPENCODE_FREE_SYSTEM_PROMPT}\n\nYou are omp.`]);
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
			compat: { opencodeClientIdentity: true },
			sessionId: "session-1",
		});
		expect(headers["User-Agent"]).toBe(OPENCODE_UA);
		expect(headers[OPENCODE_SESSION_HEADER]).toBe(toOpenCodeSessionToken("session-1"));
	});

	it("carries the identity for the zero-cost row without the -free suffix", () => {
		const model = makeZenModel("big-pickle");
		expect(usesOpenCodeClientIdentity(model.compat)).toBe(true);
	});

	it("still carries the identity when the caller has no conversation id", () => {
		const headers: Record<string, string> = {};
		applyInferenceHeaders(headers, {
			provider: "opencode-zen",
			protocol: "openai",
			compat: { opencodeClientIdentity: true },
		});
		expect(headers["User-Agent"]).toBe(OPENCODE_UA);
		expect(headers[OPENCODE_SESSION_HEADER]).toMatch(OPENCODE_SESSION_TOKEN_PATTERN);
	});

	it("leaves every other Zen and Go lane on omp's identity", () => {
		for (const provider of ["opencode-zen", "opencode-go"] as const) {
			const headers: Record<string, string> = {};
			applyInferenceHeaders(headers, { provider, protocol: "openai", compat: {}, sessionId: "session-1" });
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
		expect(seen[0]?.headers.get("User-Agent")).toBe(OPENCODE_UA);
		expect(seen[0]?.headers.get(OPENCODE_SESSION_HEADER)).toBe(toOpenCodeSessionToken("session-1"));
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
