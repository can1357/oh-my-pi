import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { releaseTurnOnStreamEnd } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { StreamCommitGate } from "@oh-my-pi/pi-ai/auth-gateway/stream-commit-gate";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

describe("releaseTurnOnStreamEnd", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-release-stream-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("releases the turn reservation when reader.read() rejects", async () => {
		if (!storage) throw new Error("setup failed");
		const credentialId = 42;
		const incarnation = 1;
		const requestId = "req-read-reject";
		const held = storage.tryAcquireTurnReservation({ credentialId, incarnation, requestId });
		expect(held.ok).toBe(true);

		const upstream = new ReadableStream<Uint8Array>({
			pull() {
				return Promise.reject(new Error("upstream read failed"));
			},
		});
		const wrapped = releaseTurnOnStreamEnd(upstream, storage, requestId);
		const reader = wrapped.getReader();
		await expect(reader.read()).rejects.toThrow("upstream read failed");

		const again = storage.tryAcquireTurnReservation({
			credentialId,
			incarnation,
			requestId: "req-after-release",
		});
		expect(again.ok).toBe(true);
	});

	it("keeps the reservation held while the stream is still open (negative)", async () => {
		if (!storage) throw new Error("setup failed");
		const credentialId = 43;
		const incarnation = 1;
		const requestId = "req-still-open";
		expect(storage.tryAcquireTurnReservation({ credentialId, incarnation, requestId }).ok).toBe(true);

		const { promise: waitRead, resolve: allowRead } = Promise.withResolvers<void>();
		const upstream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await waitRead;
				controller.enqueue(new Uint8Array([1]));
				controller.close();
			},
		});
		const wrapped = releaseTurnOnStreamEnd(upstream, storage, requestId);
		const reader = wrapped.getReader();
		const pending = reader.read();
		const blocked = storage.tryAcquireTurnReservation({
			credentialId,
			incarnation,
			requestId: "req-other",
		});
		expect(blocked.ok).toBe(false);
		allowRead();
		await pending;
		await reader.read();
		const after = storage.tryAcquireTurnReservation({
			credentialId,
			incarnation,
			requestId: "req-after-close",
		});
		expect(after.ok).toBe(true);
	});
	it("waits for canonical completion before reporting successful settlement", async () => {
		if (!storage) throw new Error("setup failed");
		const ended = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<AssistantMessage>();
		const outcomes: boolean[] = [];
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.close();
				ended.resolve();
			},
		});
		const wrapped = releaseTurnOnStreamEnd(upstream, storage, "settled", undefined, settled.promise, outcome => {
			outcomes.push(outcome.ok);
		});
		const read = wrapped.getReader().read();
		await ended.promise;
		expect(outcomes).toEqual([]);
		settled.resolve({
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await read;
		expect(outcomes).toEqual([true]);
	});

	it("reports cancellation as unsuccessful even after stream commit without waiting for a hung provider", async () => {
		if (!storage) throw new Error("setup failed");
		const gate = new StreamCommitGate();
		gate.classifyAndObserve("response.output_text.delta", 1);
		const settled = Promise.withResolvers<AssistantMessage>();
		const outcomes: boolean[] = [];
		const wrapped = releaseTurnOnStreamEnd(
			new ReadableStream<Uint8Array>(),
			storage,
			"cancelled",
			gate,
			settled.promise,
			outcome => {
				outcomes.push(outcome.ok);
			},
		);
		await wrapped.cancel("client cancelled");
		expect(outcomes).toEqual([false]);
	});
});
