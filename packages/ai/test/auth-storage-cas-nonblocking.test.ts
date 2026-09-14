/**
 * A best-effort compare-and-set must not pay the connection's `busy_timeout`
 * when a peer process holds the write lock. The MCP tool cache makes one such
 * claim per server BEFORE issuing that server's `tools/list`, all on the
 * JavaScript thread, so a blocking claim multiplied the timeout by the server
 * count and froze startup — including the 250ms startup race and every other
 * timer — for as long as the lock was held.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

describe("setCacheIfMatches nonblocking", () => {
	let tempDir = "";
	let dbPath = "";
	let holder: Database | undefined;
	let store: SqliteAuthCredentialStore | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cas-nonblocking-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		store?.close();
		store = undefined;
		holder?.close();
		holder = undefined;
		await removeWithRetries(tempDir);
	});

	test("reports unavailable at once while a peer holds the write lock", async () => {
		store = await SqliteAuthCredentialStore.open(dbPath);
		// A second connection to the SAME file, holding an EXCLUSIVE write
		// transaction — the real shape of a peer CLI process mid-write.
		holder = new Database(dbPath);
		holder.run("PRAGMA busy_timeout = 0");
		holder.run("BEGIN EXCLUSIVE");
		try {
			const started = Bun.nanoseconds();
			const outcome = store.setCacheIfMatches("claim:alpha", null, '{"claimedAt":1}', 2 ** 31 - 1, {
				nonblocking: true,
			});
			const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

			expect(outcome).toBe("unavailable");
			// RED (pre-fix): the call waited out the store's busy timeout (5s
			// interactive) before reporting the same outcome. The bound is far
			// below that and far above a healthy immediate failure, so it does not
			// depend on machine speed.
			expect(elapsedMs).toBeLessThan(1_000);
		} finally {
			holder.run("ROLLBACK");
		}
	}, 30_000);

	test("still writes when the lock is free", async () => {
		// The pragma juggling must not break the ordinary path, and must leave the
		// connection's timeout restored for later blocking callers.
		store = await SqliteAuthCredentialStore.open(dbPath);
		expect(store.setCacheIfMatches("claim:beta", null, '{"claimedAt":2}', 2 ** 31 - 1, { nonblocking: true })).toBe(
			"written",
		);
		expect(store.getCache("claim:beta")).toBe('{"claimedAt":2}');
		// A stale expectation is a MISMATCH, not an availability failure — the
		// distinction the claim loop acts on.
		expect(store.setCacheIfMatches("claim:beta", null, '{"claimedAt":3}', 2 ** 31 - 1, { nonblocking: true })).toBe(
			"mismatch",
		);
	}, 30_000);
});
