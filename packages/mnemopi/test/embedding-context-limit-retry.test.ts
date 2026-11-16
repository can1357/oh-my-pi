/**
 * llama.cpp embedding servers started with a physical batch smaller than the
 * model context (Ollama's `-b 2048` default) reject the whole request with
 * HTTP 413 as soon as one input passes that batch. These tests cover the token
 * budget that keeps inputs under it and the retry that recovers when a
 * provider's limit is still lower than the estimate.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import {
	type ResolvedMnemopiEmbeddingRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { estimateTokens } from "@oh-my-pi/pi-mnemopi/core/text-window";

const LIMIT = 2048;

interface FakeServer {
	url: string;
	requests: string[][];
	stop(): void;
}

function contextLimitResponse(status = 413): Response {
	return new Response(
		JSON.stringify({
			error: {
				message:
					status === 413
						? "the input length exceeds the context length"
						: "This model's maximum context length is 2048 tokens",
			},
		}),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

function startServer(handler?: (call: number, texts: string[]) => Response | undefined): FakeServer {
	const requests: string[][] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { input: string[] };
			requests.push(body.input);
			const override = handler?.(requests.length, body.input);
			if (override !== undefined) return override;
			if (body.input.some(text => estimateTokens(text) > LIMIT)) return contextLimitResponse();
			const data = body.input.map((text, index) => ({
				index,
				embedding: [Number.parseInt(text, 10) || 0, 1, 0],
			}));
			return new Response(JSON.stringify({ data }));
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

function run<T>(
	url: string,
	fn: () => Promise<T>,
	extra: Partial<ResolvedMnemopiEmbeddingRuntimeOptions> = {},
): Promise<T> {
	return withMnemopiRuntimeOptions(
		{ embeddings: { model: "text-embedding-v4", apiUrl: url, apiKey: "test-key", ...extra } },
		fn,
	);
}

describe("embed() against a server with a 2048-token batch", () => {
	let server: FakeServer;
	afterEach(() => {
		resetEmbeddingProviderForTests();
		server.stop();
	});

	it("keeps a CJK input under the token budget before the first request", async () => {
		server = startServer();
		const matrix = await run(server.url, () => embed(["中".repeat(20_000)]));

		expect(matrix?.length).toBe(1);
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.every(text => estimateTokens(text) <= LIMIT)).toBe(true);
	});

	it("retries a single oversized input with a smaller head/tail window", async () => {
		server = startServer();
		const matrix = await run(server.url, () => embed(["1:" + "a".repeat(20_000)]), { maxInputChars: 0 });

		expect(matrix?.[0]?.[0]).toBe(1);
		expect(server.requests.length).toBeGreaterThan(1);
		expect(server.requests.at(-1)?.every(text => estimateTokens(text) <= LIMIT)).toBe(true);
	});

	it("splits a rejected batch so only the offending members shrink, keeping order", async () => {
		server = startServer();
		const texts = ["1:" + "a".repeat(20_000), "2:small", "3:" + "b".repeat(20_000), "4:small"];
		const matrix = await run(server.url, () => embed(texts), { maxInputChars: 0 });

		expect(matrix?.map(vector => vector[0])).toEqual([1, 2, 3, 4]);
		expect(server.requests.length).toBeGreaterThan(2);
	});

	it("does not report a rejection that a retry recovered", async () => {
		server = startServer();
		let failures = 0;
		const matrix = await run(server.url, () => embed(["1:" + "a".repeat(20_000)]), {
			maxInputChars: 0,
			onRequestFailed: () => {
				failures++;
			},
		});

		expect(matrix).not.toBeNull();
		expect(failures).toBe(0);
	});

	it("treats a 400 maximum-context message as retryable", async () => {
		server = startServer((_call, texts) =>
			texts.some(text => estimateTokens(text) > LIMIT) ? contextLimitResponse(400) : undefined,
		);
		const matrix = await run(server.url, () => embed(["1:" + "a".repeat(20_000)]), {
			maxInputChars: 0,
		});

		expect(matrix?.[0]?.[0]).toBe(1);
		expect(server.requests.length).toBeGreaterThan(1);
	});

	it("does not retry a non-context rejection", async () => {
		server = startServer(() => new Response("forbidden", { status: 403 }));
		const matrix = await run(server.url, () => embed(["1:small"]), { maxInputChars: 0 });

		expect(matrix).toBeNull();
		expect(server.requests).toHaveLength(1);
	});

	it("bounds retries and reports once when the provider always rejects", async () => {
		server = startServer(() => contextLimitResponse());
		let failures = 0;
		const matrix = await run(server.url, () => embed(["x".repeat(100_000)]), {
			maxInputChars: 0,
			onRequestFailed: () => {
				failures++;
			},
		});

		expect(matrix).toBeNull();
		expect(server.requests.length).toBeLessThanOrEqual(17);
		expect(failures).toBe(1);
	});
});
