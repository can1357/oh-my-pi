/**
 * Asymmetric embedders embed recall queries differently from stored memories: instruction-tuned
 * models (Qwen3-Embedding, E5) need a text prefix on the query, and NVIDIA NIM retrievers reject
 * requests without `input_type`. A failed request must also reach the host's `onRequestFailed`
 * hook, since the embedding call itself only returns null.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { embed, embedQuery, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import {
	type EmbeddingRequestFailure,
	type ResolvedMnemopiEmbeddingRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";

interface RecordedRequest {
	model: string;
	input: string[];
	input_type?: string;
}

interface FakeServer {
	url: string;
	requests: RecordedRequest[];
	stop(): void;
}

/** Answers like a NIM asymmetric retriever (400 without `input_type`) unless `respond` overrides every answer. */
function startServer(respond?: () => Response): FakeServer {
	const requests: RecordedRequest[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as RecordedRequest;
			requests.push(body);
			if (respond !== undefined) return respond();
			if (body.input_type === undefined) {
				return new Response(
					JSON.stringify({ message: "'input_type' parameter is required for asymmetric models" }),
					{
						status: 400,
					},
				);
			}
			const data = body.input.map((_, index) => ({ index, embedding: [1, 0, 0] }));
			return new Response(JSON.stringify({ data }));
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

function run<T>(
	server: FakeServer,
	options: Partial<ResolvedMnemopiEmbeddingRuntimeOptions>,
	fn: () => Promise<T>,
): Promise<T> {
	return withMnemopiRuntimeOptions(
		{ embeddings: { model: "nv-embedqa-e5-v5", apiUrl: server.url, apiKey: "test-key", ...options } },
		fn,
	);
}

describe("query-side conditioning for asymmetric embedders", () => {
	let server: FakeServer;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server.stop();
	});

	it("sends recall queries as input_type query and stored memories as passage", async () => {
		server = startServer();
		const options = { inputType: true, queryPrefix: "query: " };
		const query = await run(server, options, () => embedQuery("which package manager"));
		const stored = await run(server, options, () => embed(["the project uses bun"]));
		expect(query).not.toBeNull();
		expect(stored).not.toBeNull();
		expect(server.requests).toEqual([
			{ model: "nv-embedqa-e5-v5", input: ["query: which package manager"], input_type: "query" },
			{ model: "nv-embedqa-e5-v5", input: ["the project uses bun"], input_type: "passage" },
		] as RecordedRequest[]);
	});

	it("omits input_type unless enabled, so OpenAI-style endpoints see the plain request", async () => {
		server = startServer();
		const vector = await run(server, {}, () => embedQuery("which package manager"));
		expect(vector).toBeNull();
		expect(server.requests).toEqual([
			{ model: "nv-embedqa-e5-v5", input: ["which package manager"] },
		] as RecordedRequest[]);
	});

	it("does not serve a query vector cached before input_type was enabled", async () => {
		server = startServer(() => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 1, 0] }] })));
		await run(server, {}, () => embedQuery("which package manager"));
		await run(server, { inputType: true }, () => embedQuery("which package manager"));
		expect(server.requests.map(request => request.input_type)).toEqual([undefined, "query"]);
	});
});

describe("onRequestFailed", () => {
	let server: FakeServer;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server.stop();
	});

	it("reports a rejected request with its status and provider text", async () => {
		server = startServer();
		const failures: EmbeddingRequestFailure[] = [];
		const vectors = await run(server, { onRequestFailed: failure => failures.push(failure) }, () =>
			embed(["a stored memory"]),
		);
		expect(vectors).toBeNull();
		expect(failures).toEqual([
			{
				baseUrl: server.url,
				model: "nv-embedqa-e5-v5",
				status: 400,
				message: expect.stringContaining("'input_type' parameter is required"),
			},
		]);
	});

	it("reports a 401 with the provider's denial text", async () => {
		server = startServer(() => new Response("The credential is invalid or expired.", { status: 401 }));
		const failures: EmbeddingRequestFailure[] = [];
		const vector = await run(server, { onRequestFailed: failure => failures.push(failure) }, () =>
			embedQuery("anything"),
		);
		expect(vector).toBeNull();
		expect(failures.map(failure => [failure.status, failure.message])).toEqual([
			[401, "The credential is invalid or expired."],
		]);
	});

	it("keeps returning null when the hook throws", async () => {
		server = startServer(() => new Response("forbidden", { status: 403 }));
		const vectors = await run(
			server,
			{
				onRequestFailed: () => {
					throw new Error("host hook failed");
				},
			},
			() => embed(["a stored memory"]),
		);
		expect(vectors).toBeNull();
	});
});
