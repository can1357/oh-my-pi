// The embed client owns the worker subprocess lifetime. A session that
// embedded once used to hold that worker — and its loaded model — until the
// session ended, so every concurrent session paid the model's address space
// again. These tests pin the replacement contract: the worker is spawned on
// demand, reaped after an idle window, and transparently respawned (with the
// model/cacheDir replayed) by the next request.
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { MnemopiEmbedClient } from "../src/mnemopi/embed-client";

interface FakeWorker {
	sent: Array<{ type: string; id: string; model?: string; cacheDir?: string }>;
	terminated: boolean;
	handle: unknown;
	reply(message: unknown): void;
}

/** Worker that answers every request after a microtask, like the real IPC round-trip. */
function makeFakeWorker(): FakeWorker {
	const worker = {
		sent: [] as FakeWorker["sent"],
		terminated: false,
		handle: null as unknown,
		reply: () => {},
	};
	const handlers = new Set<(message: unknown) => void>();
	worker.handle = {
		send(message: FakeWorker["sent"][number]) {
			worker.sent.push(message);
			queueMicrotask(() =>
				worker.reply(
					message.type === "init"
						? { type: "ready", id: message.id }
						: { type: "vectors", id: message.id, vectors: [[1, 2, 3]] },
				),
			);
		},
		onMessage(handler: (message: unknown) => void) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		onError() {
			return () => {};
		},
		async terminate() {
			worker.terminated = true;
			handlers.clear();
		},
	};
	worker.reply = (message: unknown) => {
		for (const handler of handlers) handler(message);
	};
	return worker;
}

function spawnRecorder(spawned: FakeWorker[]): () => never {
	return () => {
		const worker = makeFakeWorker();
		spawned.push(worker);
		return worker.handle as never;
	};
}

async function drain(iterable: AsyncIterable<number[][]>): Promise<number[][]> {
	const rows: number[][] = [];
	for await (const batch of iterable) rows.push(...batch);
	return rows;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("MnemopiEmbedClient worker lifetime", () => {
	test("spawns no worker until the first request, then reaps it when idle", async () => {
		const spawned: FakeWorker[] = [];
		const client = new MnemopiEmbedClient(spawnRecorder(spawned), 5_000, 30);

		expect(spawned).toHaveLength(0);

		const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
		expect(model).not.toBeNull();
		expect(spawned).toHaveLength(1);
		expect(await drain(model!.embed(["a"]))).toEqual([[1, 2, 3]]);
		expect(spawned[0]!.terminated).toBe(false);

		// Idle past the TTL: the worker (and its loaded model) is released.
		vi.advanceTimersByTime(31);
		expect(spawned[0]!.terminated).toBe(true);

		// The next request respawns and replays model + cacheDir, so the fresh
		// worker reloads without another `initialize` call.
		expect(await drain(model!.embed(["b"]))).toEqual([[1, 2, 3]]);
		expect(spawned).toHaveLength(2);
		expect(spawned[1]!.sent[0]).toMatchObject({
			type: "embed",
			model: "fast-bge-base-en-v1.5",
			cacheDir: "/tmp/cache",
		});

		await client.terminate();
		expect(spawned[1]!.terminated).toBe(true);
	});

	test("keeps a worker that is used again inside the idle window", async () => {
		const spawned: FakeWorker[] = [];
		const client = new MnemopiEmbedClient(spawnRecorder(spawned), 5_000, 60);

		const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(20);
			expect(await drain(model!.embed([`text ${i}`]))).toEqual([[1, 2, 3]]);
		}

		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.terminated).toBe(false);
		await client.terminate();
	});
});
