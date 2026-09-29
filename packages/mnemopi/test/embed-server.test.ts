import { afterEach, describe, expect, it } from "bun:test";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import type { LocalEmbeddingModel, LocalModelInitializer } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import {
	EMBED_SERVE_MAX_INPUT_CHARS,
	EMBED_SERVE_MAX_INPUTS,
	type EmbedServer,
	startEmbedServer,
} from "@oh-my-pi/pi-mnemopi/embed-server";

const MODEL = "BAAI/bge-small-en-v1.5";

/** Deterministic 3-dim "model": [length, vowels, 1]. */
function fakeInitializer(counter: { loads: number }): LocalModelInitializer {
	return async () => {
		counter.loads += 1;
		const model: LocalEmbeddingModel = {
			async *embed(texts) {
				yield texts.map(text => [text.length, [...text].filter(c => "aeiou".includes(c)).length, 1]);
			},
		};
		return model;
	};
}

let server: EmbedServer | null = null;

afterEach(async () => {
	resetEmbeddingProviderForTests();
	await server?.stop();
	server = null;
});

async function post(body: unknown): Promise<Response> {
	return fetch(`${server?.url}/embeddings`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("mnemopi embed-serve", () => {
	it("returns OpenAI-shaped vectors in input order and loads the model once for many requests", async () => {
		const counter = { loads: 0 };
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer(counter) });
		const first = (await (await post({ model: MODEL, input: ["hello", "sky"] })).json()) as {
			data: Array<{ index: number; embedding: number[] }>;
		};
		expect(first.data.map(row => [row.index, row.embedding])).toEqual([
			[0, [5, 2, 1]],
			[1, [3, 0, 1]],
		]);
		const single = (await (await post({ model: MODEL, input: "aeiou" })).json()) as {
			data: Array<{ embedding: number[] }>;
		};
		expect(single.data[0]?.embedding).toEqual([5, 5, 1]);
		expect(counter.loads).toBe(1);
	});

	it("rejects a request for a model it is not serving instead of returning wrong-dimension vectors", async () => {
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer({ loads: 0 }) });
		const response = await post({ model: "BAAI/bge-base-en-v1.5", input: "x" });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { message: string } }).error.message).toContain(MODEL);
	});

	it("rejects malformed input with 400 and a model load failure with 500, then recovers on the next request", async () => {
		let attempts = 0;
		const flaky: LocalModelInitializer = async options => {
			attempts += 1;
			if (attempts === 1) throw new Error("onnx exploded");
			return fakeInitializer({ loads: 0 })(options);
		};
		server = await startEmbedServer({ port: 0, initializer: flaky });
		expect((await post({ input: 42 })).status).toBe(400);
		const failed = await post({ input: "x" });
		expect(failed.status).toBe(500);
		expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("onnx exploded");
		expect((await post({ input: "x" })).status).toBe(200);
	});

	it("serves mnemopi's own API embedding client so processes can share one model", async () => {
		server = await startEmbedServer({ port: 0, model: MODEL, initializer: fakeInitializer({ loads: 0 }) });
		// Async-local scope, not process env: the suite runs with `bun test --parallel`.
		const vectors = await withMnemopiRuntimeOptions({ embeddings: { apiUrl: server.url, model: MODEL } }, () =>
			embed(["hello"]),
		);
		expect(vectors?.map(v => Array.from(v))).toEqual([[5, 2, 1]]);
	});

	it("does not leave a listener running when the preload fails, so the port can be reused", async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port;
		await probe.stop(true);
		const failing: LocalModelInitializer = async () => {
			throw new Error("onnx exploded");
		};
		await expect(startEmbedServer({ port, preload: true, initializer: failing })).rejects.toThrow("onnx exploded");
		server = await startEmbedServer({ port, initializer: fakeInitializer({ loads: 0 }) });
		expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
	});

	it("answers JSON bodies that are not objects with a JSON 400 instead of a 500", async () => {
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer({ loads: 0 }) });
		for (const body of [null, 42, "text", [1]]) {
			const response = await post(body);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("application/json");
		}
	});

	it("refuses requests a web page could send without a preflight, before any inference runs", async () => {
		const counter = { loads: 0 };
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer(counter) });
		const simple = await fetch(`${server.url}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: JSON.stringify({ input: "hello" }),
		});
		expect(simple.status).toBe(415);
		const browser = await fetch(`${server.url}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
			body: JSON.stringify({ input: "hello" }),
		});
		expect(browser.status).toBe(403);
		expect(counter.loads).toBe(0);
	});

	it("rejects oversized requests with 413 instead of queueing the work", async () => {
		const counter = { loads: 0 };
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer(counter) });
		expect((await post({ input: Array.from({ length: EMBED_SERVE_MAX_INPUTS + 1 }, () => "x") })).status).toBe(413);
		expect((await post({ input: "x".repeat(EMBED_SERVE_MAX_INPUT_CHARS + 1) })).status).toBe(413);
		expect(counter.loads).toBe(0);
		expect((await post({ input: "x".repeat(EMBED_SERVE_MAX_INPUT_CHARS) })).status).toBe(200);
	});
});
