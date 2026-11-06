/**
 * Some hosted embedding APIs cap the inputs per request (DashScope: 10). With `batchSize` set to
 * that cap, `embed()` must split a large text list into several requests, keep the order, and
 * return null when any part fails. A rejected request must leave the status and body in the log.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";

const LIMIT = 10;
const REJECTED = "mnemopi embedding request rejected";

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

function run<T>(url: string, fn: () => Promise<T>, debug = false): Promise<T> {
	return withMnemopiRuntimeOptions(
		{ debug, embeddings: { model: "text-embedding-v4", apiUrl: url, apiKey: "test-key", batchSize: LIMIT } },
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
});

describe("embed() logging of a rejected API request", () => {
	let server: FakeServer;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server.stop();
	});

	it("logs the status and response body at debug", async () => {
		server = startServer(() => new Response("insufficient_quota: tpm limit", { status: 403 }));
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(await run(server.url, () => embed(["1"]))).toBeNull();
			expect(debugSpy).toHaveBeenCalledWith(REJECTED, { status: 403, body: "insufficient_quota: tpm limit" });
			expect(warnSpy).not.toHaveBeenCalledWith(REJECTED, expect.anything());
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("logs a 401 that survives key handling with its status", async () => {
		server = startServer(() => new Response("unauthorized", { status: 401 }));
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			expect(await run(server.url, () => embed(["1"]))).toBeNull();
			expect(debugSpy).toHaveBeenCalledWith(REJECTED, expect.objectContaining({ status: 401 }));
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("escalates to warn when runtime debug is on", async () => {
		server = startServer(() => new Response("bad request", { status: 400 }));
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(await run(server.url, () => embed(["1"]), true)).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(REJECTED, { status: 400, body: "bad request" });
			expect(debugSpy).not.toHaveBeenCalledWith(REJECTED, expect.anything());
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
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

	it("keeps the old vectors when the API rejects the key", async () => {
		server = startServer(() => new Response("unauthorized", { status: 401 }));
		const db = seedBank("old-model", 25);
		const memory = new Mnemopi({
			db,
			embeddings: { model: "text-embedding-v4", apiUrl: server.url, apiKey: "test-key", batchSize: LIMIT },
		});
		try {
			await memory.flushExtractions();
			expect(server.sizes.every(size => size === 1)).toBe(true);
			const models = storedModels(memory);
			expect(models).toHaveLength(25);
			expect(models.every(model => model === "old-model")).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});
});
