import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { releaseTurnOnStreamEnd, renewReservationUntilSettled } from "@oh-my-pi/pi-ai/auth-gateway/server";
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
		vi.useRealTimers();
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

	it("renews an active inference reservation past its TTL and stops after settlement", async () => {
		if (!storage) throw new Error("setup failed");
		vi.useFakeTimers();
		storage.tryAcquireTurnReservation({ credentialId: 99, incarnation: 1, requestId: "long" });
		const deferred = Promise.withResolvers<void>();
		const pending = renewReservationUntilSettled(storage, "long", deferred.promise);
		vi.advanceTimersByTime(300_000);
		expect(storage.tryAcquireTurnReservation({ credentialId: 99, incarnation: 1, requestId: "other" }).ok).toBe(
			false,
		);
		deferred.resolve();
		await pending;
		vi.advanceTimersByTime(300_000);
		expect(storage.tryAcquireTurnReservation({ credentialId: 99, incarnation: 1, requestId: "other" }).ok).toBe(true);
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
});
