import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

/**
 * Model discovery resolves its key through `keys.peek()`, and credential-scoped
 * catalogs (GitHub Copilot, Cursor) key their cache rows on the peeked
 * account. A peek that rotates accounts reads a different cache namespace on
 * every discovery pass, so one pass can replace another account's cached
 * catalog with the bundled fallback.
 */
describe("AuthStorage keys.peek", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("returns the same unexpired account on every call, skipping an expired one", async () => {
		const storage = await AuthStorage.create(":memory:");
		storages.push(storage);
		const now = Date.now();
		await storage.credentials.set("cursor", [
			{ type: "oauth", access: "expired-a", refresh: "refresh-a", expires: now - 60_000 },
			{ type: "oauth", access: "live-b", refresh: "refresh-b", expires: now + 3_600_000 },
			{ type: "oauth", access: "live-c", refresh: "refresh-c", expires: now + 3_600_000 },
		]);

		const peeks = [
			await storage.keys.peek("cursor"),
			await storage.keys.peek("cursor"),
			await storage.keys.peek("cursor"),
		];

		expect(peeks).toEqual(["live-b", "live-b", "live-b"]);
	});
});
