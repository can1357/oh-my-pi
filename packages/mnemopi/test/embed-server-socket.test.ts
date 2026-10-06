import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import type { LocalEmbeddingModel, LocalModelInitializer } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { type EmbedServer, startEmbedServer } from "@oh-my-pi/pi-mnemopi/embed-server";

const MODEL = "BAAI/bge-small-en-v1.5";

/** Deterministic 2-dim "model": [length, 1]. */
const initializer: LocalModelInitializer = async () => {
	const model: LocalEmbeddingModel = {
		async *embed(texts) {
			yield texts.map(text => [text.length, 1]);
		},
	};
	return model;
};

let dir = "";
let socket = "";
let server: EmbedServer | null = null;

beforeEach(() => {
	// A short path: unix socket paths are capped near 104 bytes on macOS.
	dir = mkdtempSync(join(tmpdir(), "mn-"));
	socket = join(dir, "e.sock");
});

afterEach(async () => {
	resetEmbeddingProviderForTests();
	await server?.stop();
	server = null;
	rmSync(dir, { recursive: true, force: true });
});

function viaSocket(path: string, init?: RequestInit): Promise<Response> {
	return fetch("http://localhost/v1/embeddings", { unix: path, ...init } as RequestInit);
}

describe("mnemopi embed-serve over a unix socket", () => {
	it("serves embeddings on a socket only its owner can open, and removes the file on stop", async () => {
		server = await startEmbedServer({ socket, initializer });
		expect(server.url).toBe(`unix:${socket}`);
		expect(statSync(socket).mode & 0o777).toBe(0o600);
		const response = await viaSocket(socket, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: MODEL, input: "hello" }),
		});
		const body = (await response.json()) as { data: Array<{ embedding: number[] }> };
		expect(body.data[0]?.embedding).toEqual([5, 1]);
		await server.stop();
		server = null;
		expect(() => statSync(socket)).toThrow();
	});

	it("replaces a stale socket file left by a crashed server but refuses to clobber a live one", async () => {
		writeFileSync(socket, "");
		server = await startEmbedServer({ socket, initializer });
		expect((await fetch("http://localhost/health", { unix: socket } as RequestInit)).status).toBe(200);
		await expect(startEmbedServer({ socket, initializer })).rejects.toThrow("already running");
		expect((await fetch("http://localhost/health", { unix: socket } as RequestInit)).status).toBe(200);
	});

	it("rejects combining a socket with a host or port", async () => {
		await expect(startEmbedServer({ socket, port: 1234, initializer })).rejects.toThrow("socket");
	});

	it("serves mnemopi's own embedding client through a unix: URL", async () => {
		server = await startEmbedServer({ socket, model: MODEL, initializer });
		const vectors = await withMnemopiRuntimeOptions({ embeddings: { apiUrl: server.url, model: MODEL } }, () =>
			embed(["hello", "sky"]),
		);
		expect(vectors?.map(v => Array.from(v))).toEqual([
			[5, 1],
			[3, 1],
		]);
	});
});
