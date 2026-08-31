import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-wave-a-turn";

function oauth(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage in-flight turn reservations", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-turn-res-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("lets a second acquire see the first and succeed after release", () => {
		if (!storage) throw new Error("setup failed");
		const first = storage.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "req-1",
		});
		expect(first.ok).toBe(true);
		const second = storage.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "req-2",
		});
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("second acquire must observe the first");
		expect(second.heldByRequestId).toBe("req-1");

		if (!first.ok) throw new Error("first acquire must succeed");
		first.reservation.release();
		const third = storage.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "req-3",
		});
		expect(third.ok).toBe(true);
	});

	it("does not pin an expired reservation forever", () => {
		if (!storage) throw new Error("setup failed");
		const first = storage.tryAcquireTurnReservation({
			credentialId: 9,
			incarnation: 1,
			requestId: "ttl-1",
			ttlMs: 0,
		});
		expect(first.ok).toBe(true);
		const second = storage.tryAcquireTurnReservation({
			credentialId: 9,
			incarnation: 1,
			requestId: "ttl-2",
		});
		expect(second.ok).toBe(true);
	});

	it("makes a reserved credential invisible to a concurrent getApiKey selector", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth("a"), oauth("b")]);
		const rows = storage.listStoredCredentials(PROVIDER);
		const idA = rows[0]?.id;
		if (idA === undefined) throw new Error("missing credential");
		const held = storage.tryAcquireTurnReservation({
			credentialId: idA,
			incarnation: storage.getCredentialIncarnation(idA),
			requestId: "inflight-a",
		});
		expect(held.ok).toBe(true);
		const key = await storage.getApiKey(PROVIDER, "other-selector");
		expect(key).not.toBe("access-a");
		expect(key).toBe("access-b");
	});

	it("does not vend a reserved credential to a second concurrent getApiKey", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth("a"), oauth("b")]);
		const first = await storage.getApiKey(PROVIDER, "s-one", { requestId: "req-a" });
		const second = await storage.getApiKey(PROVIDER, "s-two", { requestId: "req-b" });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
	});

	it("does not let an old release() kill a renewed same-requestId reservation (negative)", () => {
		if (!storage) throw new Error("setup failed");
		const first = storage.tryAcquireTurnReservation({
			credentialId: 3,
			incarnation: 1,
			requestId: "same",
			ttlMs: 60_000,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("first acquire must succeed");
		const renewed = storage.tryAcquireTurnReservation({
			credentialId: 3,
			incarnation: 1,
			requestId: "same",
			ttlMs: 60_000,
		});
		expect(renewed.ok).toBe(true);
		first.reservation.release();
		const other = storage.tryAcquireTurnReservation({
			credentialId: 3,
			incarnation: 1,
			requestId: "other",
		});
		expect(other.ok).toBe(false);
	});

	it("getApiKey with the holder's requestId still vends the reserved credential", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth("a"), oauth("b")]);
		const rows = storage.listStoredCredentials(PROVIDER);
		const idA = rows[0]?.id;
		if (idA === undefined) throw new Error("missing credential");
		const held = storage.tryAcquireTurnReservation({
			credentialId: idA,
			incarnation: storage.getCredentialIncarnation(idA),
			requestId: "holder",
		});
		expect(held.ok).toBe(true);
		const key = await storage.getApiKey(PROVIDER, "holder-session", { requestId: "holder" });
		expect(key).toBe("access-a");
	});

	it("reserves stored api_key rows before returning them", async () => {
		if (!storage) throw new Error("setup failed");
		const apiProvider = `${PROVIDER}-api-keys`;
		await storage.set(apiProvider, [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
		]);
		const first = await storage.getApiKey(apiProvider, "s-a", { requestId: "api-req-a" });
		const second = await storage.getApiKey(apiProvider, "s-b", { requestId: "api-req-b" });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
	});

	it("releases api_key reservation when configValueResolver fails", async () => {
		if (!store) throw new Error("setup failed");
		const apiProvider = `${PROVIDER}-api-key-fail`;
		const failing = new AuthStorage(store, {
			configValueResolver: async () => undefined,
		});
		await failing.set(apiProvider, [{ type: "api_key", key: "!command:missing", source: "login" }]);
		const id = failing.listStoredCredentials(apiProvider)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		const missing = await failing.getApiKey(apiProvider, "s-fail", { requestId: "fail-req" });
		expect(missing).toBeUndefined();
		const reacquire = failing.tryAcquireTurnReservation({
			credentialId: id,
			incarnation: failing.getCredentialIncarnation(id),
			requestId: "after-fail",
		});
		expect(reacquire.ok).toBe(true);
	});
});
