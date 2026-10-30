import { afterEach, describe, expect, it } from "bun:test";
import type { DispatchHold, FetchImpl } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { embed } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { complete } from "@oh-my-pi/pi-mnemopi/core/local-llm";
import { Mnemopi, type MnemopiOptions } from "@oh-my-pi/pi-mnemopi/core/memory";
import { type MnemopiLlmCompleteOptions, withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { TempDir } from "@oh-my-pi/pi-utils";

registerMockApi();

const tempDirs: TempDir[] = [];
const memories: Mnemopi[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const memory of memories.splice(0)) memory.close();
	for (const server of servers.splice(0)) server.stop(true);
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
});

/**
 * A hold the test opens and closes, standing in for a host's `/pause`.
 * `parked` settles once a request asks the hold while it is closed: the
 * request has reached its last step before the wire and waits there. It is
 * renewed when the hold opens, so a test may await it before it closes.
 */
function gate() {
	let closed: PromiseWithResolvers<void> | undefined;
	let parked = Promise.withResolvers<void>();
	const hold: DispatchHold = () => {
		if (!closed) return;
		parked.resolve();
		return closed.promise;
	};
	return {
		hold,
		get closed() {
			return closed !== undefined;
		},
		get parked() {
			return parked.promise;
		},
		close() {
			closed ??= Promise.withResolvers<void>();
		},
		open() {
			closed?.resolve();
			closed = undefined;
			parked = Promise.withResolvers<void>();
		},
	};
}

/** One macrotask turn: whatever a request that slipped past the hold would do next has run. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function memoryWith(options: MnemopiOptions): Mnemopi {
	const tempDir = TempDir.createSync("@mnemopi-dispatch-hold-");
	tempDirs.push(tempDir);
	const memory = new Mnemopi({ dbPath: tempDir.join("mnemopi.db"), reconcile: false, ...options });
	memories.push(memory);
	return memory;
}

function completionReply(text: string): Response {
	return Response.json({ choices: [{ message: { content: text } }] });
}

describe("remote requests behind the instance's beforeDispatch", () => {
	it("holds a remote completion until the hold opens", async () => {
		const g = gate();
		const sent: boolean[] = [];
		const fetchMock: FetchImpl = async () => {
			sent.push(g.closed);
			return completionReply("remote summary");
		};
		const memory = memoryWith({
			llm: { baseUrl: "http://remote.test/v1", apiKey: "sk-test", model: "m" },
			beforeDispatch: g.hold,
		});

		g.close();
		const pending = withMnemopiRuntimeOptions(memory.runtimeOptions, () =>
			complete("summarize", 0.3, { fetch: fetchMock }),
		);
		await g.parked;
		await tick();
		expect(sent).toEqual([]);

		g.open();
		expect(await pending).toBe("remote summary");
		expect(sent).toEqual([false]);
	});

	it("holds every attempt the completion retries, not only the first", async () => {
		const g = gate();
		const sent: boolean[] = [];
		const fetchMock: FetchImpl = async () => {
			sent.push(g.closed);
			if (sent.length > 1) return completionReply("second attempt");
			// The hold closes while the first attempt is on the wire.
			g.close();
			return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
		};
		const memory = memoryWith({
			llm: { baseUrl: "http://remote.test/v1", apiKey: "sk-test", model: "m" },
			beforeDispatch: g.hold,
		});

		const pending = withMnemopiRuntimeOptions(memory.runtimeOptions, () =>
			complete("summarize", 0.3, { fetch: fetchMock }),
		);
		// The retry has reached the hold the first attempt's response found closed.
		await g.parked;
		await tick();
		expect(sent).toEqual([false]);

		g.open();
		expect(await pending).toBe("second attempt");
		expect(sent).toEqual([false, false]);
	});

	it("fails a held completion without sending it when the hold rejects", async () => {
		const sent: unknown[] = [];
		const fetchMock: FetchImpl = async () => {
			sent.push(true);
			return completionReply("should not be sent");
		};
		const owner = new AbortController();
		const ownerGone = Promise.withResolvers<void>();
		owner.signal.addEventListener("abort", () => ownerGone.reject(owner.signal.reason), { once: true });
		const memory = memoryWith({
			llm: { baseUrl: "http://remote.test/v1", apiKey: "sk-test", model: "m" },
			beforeDispatch: () => ownerGone.promise,
		});

		const pending = withMnemopiRuntimeOptions(memory.runtimeOptions, () =>
			complete("summarize", 0.3, { fetch: fetchMock }),
		);
		await tick();
		owner.abort(new Error("memory closed"));
		expect(await pending).toBeNull();
		expect(sent).toEqual([]);
	});

	it("holds a remote embedding until the hold opens", async () => {
		const g = gate();
		const sent: boolean[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				sent.push(g.closed);
				const { input } = (await request.json()) as { input: string[] };
				return Response.json({ data: input.map(() => ({ embedding: [1, 2, 3] })) });
			},
		});
		servers.push(server);
		const memory = memoryWith({
			embeddings: { model: "openai/text-embedding-3-small", apiUrl: server.url.href, apiKey: "sk-test" },
			beforeDispatch: g.hold,
		});

		g.close();
		const pending = withMnemopiRuntimeOptions(memory.runtimeOptions, () => embed(["paused memory"]));
		await g.parked;
		await tick();
		expect(sent).toEqual([]);

		g.open();
		const rows = await pending;
		expect(rows?.map(row => Array.from(row))).toEqual([[1, 2, 3]]);
		expect(sent).toEqual([false]);
	});

	it("ends a recall's held query embedding on the recall's own signal, without sending it", async () => {
		const g = gate();
		const sent: boolean[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				sent.push(g.closed);
				const { input } = (await request.json()) as { input: string[] };
				return Response.json({ data: input.map(() => ({ embedding: [1, 2, 3] })) });
			},
		});
		servers.push(server);
		const memory = memoryWith({
			embeddings: { model: "openai/text-embedding-3-small", apiUrl: server.url.href, apiKey: "sk-test" },
			beforeDispatch: g.hold,
		});
		memory.remember("The deploy host is alpha-7.", { source: "test", extract: false });
		// The row's own embedding goes out while the hold is open.
		await memory.flushExtractions();
		sent.length = 0;
		const turn = new AbortController();

		g.close();
		const recalled = memory.recallEnhanced("deploy host", 5, { signal: turn.signal });
		await g.parked;
		turn.abort(new Error("turn cancelled"));
		// Without its embedding the recall still ranks by text.
		expect((await recalled).map(result => result.content)).toContain("The deploy host is alpha-7.");

		g.open();
		await tick();
		expect(sent).toEqual([]);
	});

	it("hands the hold to a custom completion that sends the request itself", async () => {
		const g = gate();
		let received: MnemopiLlmCompleteOptions | undefined;
		const memory = memoryWith({
			llm: async (_prompt, opts) => {
				received = opts;
				return "custom";
			},
			beforeDispatch: g.hold,
		});

		expect(await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("summarize"))).toBe("custom");
		expect(received?.beforeDispatch).toBe(g.hold);
	});

	it("passes the hold to a pi-ai model completion", async () => {
		const g = gate();
		const sent: boolean[] = [];
		const model = createMockModel({
			handler: () => {
				sent.push(g.closed);
				return { content: ["model summary"] };
			},
		});
		const memory = memoryWith({ llm: model, beforeDispatch: g.hold });

		g.close();
		const pending = withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("summarize"));
		await g.parked;
		await tick();
		expect(sent).toEqual([]);

		g.open();
		expect(await pending).toBe("model summary");
		expect(sent).toEqual([false]);
	});
});
