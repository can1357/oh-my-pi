import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	__resetProxyCache();
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	__resetProxyCache();
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(baseUrl = "https://chatgpt.com/backend-api"): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

// A fixed replacement payload pins the outgoing wire body so the serialized
// JSON is byte-deterministic across the compress/decompress round-trip.
const PINNED_PAYLOAD: Record<string, unknown> = {
	model: "gpt-5.3-codex-spark",
	input: [{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }],
	stream: true,
	prompt_cache_key: "zstd-test-cache-key",
};

interface CapturedRequest {
	body: RequestInit["body"];
	headers: Headers;
}

async function runAndCaptureRequests(options?: { baseUrl?: string; statuses?: number[] }): Promise<CapturedRequest[]> {
	const token = createCodexTestToken();
	const model = createCodexTestModel(options?.baseUrl);
	const statuses = options?.statuses ?? [200];
	const captured: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.push({
			body: init?.body,
			headers: init?.headers instanceof Headers ? new Headers(init.headers) : new Headers(init?.headers),
		});
		const status = statuses[Math.min(captured.length - 1, statuses.length - 1)]!;
		return new Response(status === 200 ? createCompletedCodexSse("Hello") : "unsupported content encoding", {
			status,
			headers: { "content-type": status === 200 ? "text/event-stream" : "text/plain" },
		});
	});

	const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
		apiKey: token,
		fetch: fetchMock as FetchImpl,
		onPayload: async () => PINNED_PAYLOAD,
	}).result();

	expect(result.stopReason).toBe("stop");
	return captured;
}

async function runAndCaptureRequest(): Promise<CapturedRequest> {
	const [captured] = await runAndCaptureRequests();
	if (captured === undefined) throw new Error("expected the SSE request to reach fetch");
	return captured;
}

describe("codex SSE request body zstd compression", () => {
	it("compresses the request body with zstd and sets content-encoding by default", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.get("content-encoding")).toBe("zstd");
			expect(headers.get("content-type")).toContain("application/json");
			if (!(body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
			// A zstd frame begins with the magic number 0xFD2FB528 (little-endian).
			expect(body[0]).toBe(0x28);
			expect(body[1]).toBe(0xb5);
			expect(body[2]).toBe(0x2f);
			expect(body[3]).toBe(0xfd);

			const decompressed = new TextDecoder().decode(Bun.zstdDecompressSync(body));
			expect(decompressed).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("sends the plain JSON string without content-encoding when PI_CODEX_ZSTD=0", async () => {
		await withEnv({ PI_CODEX_ZSTD: "0" }, async () => {
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.has("content-encoding")).toBe(false);
			expect(headers.get("content-type")).toContain("application/json");
			expect(typeof body).toBe("string");
			expect(body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("keeps custom Codex-compatible endpoints on plain JSON", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const [captured] = await runAndCaptureRequests({ baseUrl: "https://relay.example/v1" });
			if (captured === undefined) throw new Error("expected the SSE request to reach fetch");

			expect(captured.headers.has("content-encoding")).toBe(false);
			expect(captured.body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("retries once with plain JSON when an official endpoint rejects zstd", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			for (const rejectedStatus of [400, 415]) {
				const captured = await runAndCaptureRequests({ statuses: [rejectedStatus, 200] });

				expect(captured).toHaveLength(2);
				expect(captured[0]?.headers.get("content-encoding")).toBe("zstd");
				expect(captured[0]?.body).toBeInstanceOf(Uint8Array);
				expect(captured[1]?.headers.has("content-encoding")).toBe(false);
				expect(captured[1]?.body).toBe(JSON.stringify(PINNED_PAYLOAD));
			}
		});
	});

	it("falls back to plain JSON when local compression fails", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			vi.spyOn(Bun, "zstdCompressSync").mockImplementation(() => {
				throw new Error("zstd unavailable");
			});
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.has("content-encoding")).toBe(false);
			expect(body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("replays the compressed bytes on transient HTTP retries", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const captured = await runAndCaptureRequests({ statuses: [500, 200] });

			expect(captured).toHaveLength(2);
			for (const request of captured) {
				expect(request.headers.get("content-encoding")).toBe("zstd");
				if (!(request.body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
				expect(new TextDecoder().decode(Bun.zstdDecompressSync(request.body))).toBe(JSON.stringify(PINNED_PAYLOAD));
			}
		});
	});
});
