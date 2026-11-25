/**
 * Some hosted embedding APIs cap the inputs per request (DashScope: 10). With `batchSize` set to
 * that cap, `embed()` must split a large text list into several requests, keep the order, and
 * return null when any part fails. Servers that cap each input by tokens (llama.cpp's physical
 * batch) reject a whole request over one long input; `embed()` must isolate and re-clip it.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const LIMIT = 10;

interface FakeServer {
	url: string;
	sizes: number[];
	stop(): void;
}

function startServer(handler?: (call: number) => Response | undefined): FakeServer {
	const sizes: number[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { input: string[] };
			sizes.push(body.input.length);
			const override = handler?.(sizes.length);
			if (override !== undefined) return override;
			if (body.input.length > LIMIT) {
				return new Response(JSON.stringify({ error: "batch size is invalid, it should not be larger than 10" }), {
					status: 400,
				});
			}
			// The first component carries the text's numeric value so order is checkable.
			const data = body.input.map((text, index) => ({ index, embedding: [Number(text) || 0, 1, 0] }));
			return new Response(JSON.stringify({ data }));
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, sizes, stop: () => server.stop(true) };
}

function run<T>(url: string, fn: () => Promise<T>): Promise<T> {
	return withMnemopiRuntimeOptions(
		{ embeddings: { model: "text-embedding-v4", apiUrl: url, apiKey: "test-key", batchSize: LIMIT } },
		fn,
	);
}

describe("embed() against an API with a per-request input cap", () => {
	let server: FakeServer;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server.stop();
	});

	it("splits 25 texts into requests of at most 10 and keeps the order", async () => {
		server = startServer();
		const texts = Array.from({ length: 25 }, (_, i) => String(i));
		const matrix = await run(server.url, () => embed(texts));
		expect(server.sizes).toEqual([10, 10, 5]);
		expect(matrix?.map(v => v[0])).toEqual(texts.map(Number));
	});

	it("returns null when one part is rejected", async () => {
		server = startServer(call => (call === 2 ? new Response("quota", { status: 403 }) : undefined));
		const texts = Array.from({ length: 25 }, (_, i) => String(i));
		const matrix = await run(server.url, () => embed(texts));
		expect(matrix).toBeNull();
		expect(server.sizes).toHaveLength(2);
	});

	it("returns null when the API returns fewer vectors than texts", async () => {
		server = startServer(() => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] })));
		const matrix = await run(server.url, () => embed(["1", "2", "3"]));
		expect(matrix).toBeNull();
	});

	it("treats a fractional batchSize as the default cap instead of sending empty requests", async () => {
		server = startServer();
		const matrix = await withMnemopiRuntimeOptions(
			{ embeddings: { model: "text-embedding-v4", apiUrl: server.url, apiKey: "test-key", batchSize: 0.5 } },
			() => embed(["1", "2", "3"]),
		);
		expect(matrix?.map(v => v[0])).toEqual([1, 2, 3]);
		expect(server.sizes).toEqual([3]);
	});
});

function seedBank(model: string, count: number): Database {
	const db = new Database(":memory:");
	initBeam(db);
	const ts = new Date().toISOString();
	for (let i = 0; i < count; i++) {
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run(`wm-${i}`, `memory ${i}`, ts);
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			`wm-${i}`,
			JSON.stringify([1, 0, 0]),
			model,
		);
	}
	return db;
}

function storedModels(memory: Mnemopi): string[] {
	const rows = memory.conn.query("SELECT model FROM memory_embeddings").all() as { model: string }[];
	return rows.map(row => row.model);
}

describe("an embedding model switch against an API with a per-request input cap", () => {
	let server: FakeServer;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server.stop();
	});

	it("rebuilds every vector in requests of at most 10 after one probe request", async () => {
		server = startServer();
		const db = seedBank("old-model", 25);
		const memory = new Mnemopi({
			db,
			embeddings: { model: "text-embedding-v4", apiUrl: server.url, apiKey: "test-key", batchSize: LIMIT },
		});
		try {
			await memory.flushExtractions();
			expect(server.sizes).toEqual([1, 10, 10, 5]);
			const models = storedModels(memory);
			expect(models).toHaveLength(25);
			expect(models.every(model => model === "text-embedding-v4")).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});

	it("keeps every old vector when a rebuild batch is rejected after the probe succeeds", async () => {
		server = startServer(call => (call === 2 ? new Response("quota", { status: 403 }) : undefined));
		const db = seedBank("old-model", 25);
		const memory = new Mnemopi({
			db,
			embeddings: { model: "text-embedding-v4", apiUrl: server.url, apiKey: "test-key", batchSize: LIMIT },
		});
		try {
			await memory.flushExtractions();
			expect(server.sizes).toEqual([1, 10]);
			const models = storedModels(memory);
			expect(models).toHaveLength(25);
			expect(models.every(model => model === "old-model")).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});
});

/** Fake llama-server; `requests` holds each request's input lengths. */
interface TokenCappedServer {
	url: string;
	requests: number[][];
	stop(): void;
}

// llama-server with `-ub 2048` on dense text (2.5 chars/token): any input over 5120 chars fails the whole request.
function startTokenCappedServer(maxChars = 5120): TokenCappedServer {
	const requests: number[][] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const { input } = (await req.json()) as { input: string[] };
			requests.push(input.map(text => text.length));
			const big = input.find(text => text.length > maxChars);
			if (big !== undefined) {
				const message = `input (${Math.ceil(big.length / 2.5)} tokens) is too large to process. increase the physical batch size (current batch size: 2048)`;
				return Response.json({ error: { code: 500, message, type: "server_error" } }, { status: 500 });
			}
			// The first component carries the embedded text's length so the re-clip is checkable.
			return Response.json({ data: input.map((text, index) => ({ index, embedding: [text.length, 1, 0] })) });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

describe("embed() against a server that rejects a request over one too-large input", () => {
	let server: TokenCappedServer;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server.stop();
	});

	it("embeds the other inputs and re-clips the rejected one without resending the failed request", async () => {
		server = startTokenCappedServer();
		const failures: unknown[] = [];
		const matrix = await withMnemopiRuntimeOptions(
			{ embeddings: { model: "alias", apiUrl: server.url, apiKey: "", onRequestFailed: f => failures.push(f) } },
			() => embed(["short memory", "x".repeat(7000)]),
		);
		expect(server.requests).toEqual([[12, 7000], [12], [7000], [3500]]);
		expect(matrix?.map(v => v[0])).toEqual([12, 3500]);
		expect(failures).toEqual([]);
	});

	it("gives up and reports once when an input stays too large at the shortest window", async () => {
		server = startTokenCappedServer(0);
		const failures: { status?: number }[] = [];
		const matrix = await withMnemopiRuntimeOptions(
			{ embeddings: { model: "alias", apiUrl: server.url, apiKey: "", onRequestFailed: f => failures.push(f) } },
			() => embed(["y".repeat(7000)]),
		);
		expect(matrix).toBeNull();
		expect(server.requests).toEqual([[7000], [3500], [1750], [875], [437]]);
		expect(failures.map(f => f.status)).toEqual([500]);
	});
});
