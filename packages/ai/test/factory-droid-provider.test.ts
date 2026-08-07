import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import * as FactoryDroidAuth from "@oh-my-pi/pi-catalog/discovery/factory-droid-auth";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DROID_SYSTEM_PREFIX, streamFactoryDroid } from "../src/providers/factory-droid";
import type { Model } from "../src/types";

function kimiK3(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "kimi-k3",
			name: "Kimi K3 (Droid Core)",
			contextWindow: 262_144,
			maxTokens: 65_536,
			upstream: "fireworks",
			supportedReasoningEfforts: ["off", Effort.Low, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
		}),
	);
}

function nemotron(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "nemotron-3-ultra",
			name: "Nemotron 3 Ultra (Droid Core)",
			contextWindow: 202_000,
			maxTokens: 65_536,
			upstream: "baseten",
			supportedReasoningEfforts: ["off", Effort.High],
			defaultReasoningEffort: Effort.High,
			noImageSupport: true,
		}),
	);
}

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function sseResponse(chunks: string[]): Response {
	const body = `${chunks.map(chunk => `data: ${chunk}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function textChunks(text: string, model: string): string[] {
	return [
		JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [{ index: 0, delta: { role: "assistant", content: text } }],
		}),
		JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
		}),
	];
}

function mockAuth(auth: FactoryDroidAuth.FactoryDroidAuth | null): void {
	spyOn(FactoryDroidAuth, "resolveFactoryDroidAuth").mockResolvedValue(auth);
}

function captureFetch(captured: CapturedRequest[], chunks: string[]) {
	return mock(async (url: string | URL | Request, init?: RequestInit) => {
		const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
		captured.push({
			url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
			headers,
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return sseResponse(chunks);
	});
}

afterEach(() => {
	mock.restore();
	FactoryDroidAuth.resetFactoryDroidAuthForTests();
});

describe("Factory Droid provider (direct HTTP transport)", () => {
	it("fails with sign-in guidance when no Droid session exists", async () => {
		mockAuth(null);
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("droid auth login");
	});

	it("posts to the Factory LLM proxy with bearer auth, client version, and upstream header", async () => {
		mockAuth({ accessToken: "workos-token", orgId: "org-1" });
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			kimiK3(),
			{ systemPrompt: ["OMP system prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ fetch: captureFetch(captured, textChunks("OMP_DIRECT_OK", "kimi-k3")) },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "OMP_DIRECT_OK" }]);
		expect(result.usage.input).toBe(11);
		expect(result.usage.output).toBe(3);

		expect(captured).toHaveLength(1);
		const request = captured[0];
		expect(request.url).toBe("https://api.factory.ai/api/llm/o/v1/chat/completions");
		expect(request.headers.authorization).toBe("Bearer workos-token");
		expect(request.headers["x-api-provider"]).toBe("fireworks");
		expect(request.headers["x-client-version"]).toBeDefined();
		expect(request.headers["x-factory-org-id"]).toBe("org-1");

		expect(request.body.model).toBe("kimi-k3");
		expect(request.body.stream).toBe(true);
		expect(request.body.stream_options).toEqual({ include_usage: true });
		const messages = request.body.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0].role).toBe("system");
		// The proxy gates on the Droid identity prefix; OMP's own prompt must survive behind it.
		expect(JSON.stringify(messages[0].content)).toContain(DROID_SYSTEM_PREFIX);
		expect(JSON.stringify(messages[0].content)).toContain("OMP system prompt");
	});

	it("routes reasoning off to the upstream disable switch", async () => {
		mockAuth({ accessToken: "workos-token" });
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ fetch: captureFetch(captured, textChunks("OK", "kimi-k3")), disableReasoning: true },
		).result();

		expect(captured[0].body.reasoning_effort).toBe("none");
	});

	it("emits OpenAI-style reasoning_effort for Fireworks upstreams when effort is set", async () => {
		mockAuth({ accessToken: "workos-token" });
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ fetch: captureFetch(captured, textChunks("OK", "kimi-k3")), reasoning: Effort.Max },
		).result();

		expect(captured[0].body.reasoning_effort).toBe("max");
	});

	it("emits chat_template_args enable_thinking for Baseten upstreams when effort is set", async () => {
		mockAuth({ accessToken: "workos-token" });
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			nemotron(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ fetch: captureFetch(captured, textChunks("OK", "nemotron-3-ultra")), reasoning: Effort.High },
		).result();

		expect(captured[0].body.chat_template_args).toEqual({ enable_thinking: true });
		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
	});
});
