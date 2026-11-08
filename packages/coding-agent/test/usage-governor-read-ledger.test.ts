import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { FakeAccountSpec } from "./fixtures/usage-governor/fake-provider";
import { GovernorProof } from "./fixtures/usage-governor/harness";

function account(
	provider: FakeAccountSpec["provider"],
	label: string,
	overrides: Partial<FakeAccountSpec> = {},
): FakeAccountSpec {
	return {
		provider,
		label,
		bearer: `tok-${provider}-${label}`,
		accountId: `acct-${provider}-${label}`,
		email: `${provider}-${label}@example.invalid`,
		usedFraction: 0,
		resetInMs: 50_000,
		perRequest: 0.1,
		...overrides,
	};
}

function assertConfined(proof: GovernorProof): void {
	expect(proof.tripwire.records).toEqual([]);
}

describe("usage governor readLedger", () => {
	test("waits through concurrent lock during schema initialization rather than failing with SQLITE_BUSY", async () => {
		const proof = await GovernorProof.create([account("govplan", "a")], { enabled: true });
		try {
			// Spawn a child that holds an exclusive lock, notifies parent via stdout, and releases after a brief hold.
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
					import { Database } from "bun:sqlite";
					const db = new Database(${JSON.stringify(proof.ledgerPath)});
					db.run("BEGIN EXCLUSIVE");
					process.stdout.write("LOCKED\\n");
					setTimeout(() => {
						db.run("PRAGMA journal_mode = WAL");
						db.run("CREATE TABLE IF NOT EXISTS waits (id INTEGER PRIMARY KEY, started_at_ms INTEGER, ended_at_ms INTEGER, outcome TEXT, provider TEXT, credential_id INTEGER, role TEXT, source TEXT, pid INTEGER, reason TEXT, binding_label TEXT, used REAL, allowed REAL, until_ms INTEGER, resets_at_ms INTEGER)");
						db.run("CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, grant_id TEXT, quota_key TEXT, generation INTEGER, created_at_ms INTEGER, settled_at_ms INTEGER, pid INTEGER, provider TEXT, credential_id INTEGER, role TEXT, source TEXT, interactive INTEGER)");
						db.run("COMMIT");
						db.close();
						process.exit(0);
					}, 150);
				`,
				],
				{
					stdout: "pipe",
					stderr: "inherit",
				},
			);

			const reader = child.stdout.getReader();
			await reader.read();
			reader.releaseLock();

			// readLedger should wait through the concurrent lock and succeed without throwing SQLITE_BUSY
			const ledger = proof.readLedger();
			expect(ledger).toEqual({ waits: [], reservations: [] });

			await child.exited;
			expect(child.exitCode).toBe(0);
			assertConfined(proof);
		} finally {
			proof.close();
		}
	});

	test("returns empty ledger when ledger file exists but schema tables are not yet committed", async () => {
		const proof = await GovernorProof.create([account("govplan", "a")], { enabled: true });
		try {
			await Bun.write(proof.ledgerPath, "");
			expect(proof.readLedger()).toEqual({ waits: [], reservations: [] });
			assertConfined(proof);
		} finally {
			proof.close();
		}
	});

	test("discriminates non-BUSY errors: does not mask SQLITE_NOTADB as empty", async () => {
		const proof = await GovernorProof.create([account("govplan", "a")], { enabled: true });
		try {
			await Bun.write(proof.ledgerPath, "not a valid sqlite database file header");
			expect(() => proof.readLedger()).toThrow(/ledger read failed/);
			try {
				proof.readLedger();
				expect.unreachable("should have thrown");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				expect(message).toContain("SQLITE_NOTADB");
			}
			assertConfined(proof);
		} finally {
			proof.close();
		}
	});

	test("discriminates non-BUSY errors: does not mask SQLITE_CORRUPT as empty", async () => {
		const proof = await GovernorProof.create([account("govplan", "a")], { enabled: true });
		try {
			const db = new Database(proof.ledgerPath);
			db.run(
				"CREATE TABLE waits (id INTEGER PRIMARY KEY, started_at_ms INTEGER, ended_at_ms INTEGER, outcome TEXT, provider TEXT, credential_id INTEGER, role TEXT, source TEXT, pid INTEGER, reason TEXT, binding_label TEXT, used REAL, allowed REAL, until_ms INTEGER, resets_at_ms INTEGER)",
			);
			db.run(
				"CREATE TABLE reservations (id INTEGER PRIMARY KEY, grant_id TEXT, quota_key TEXT, generation INTEGER, created_at_ms INTEGER, settled_at_ms INTEGER, pid INTEGER, provider TEXT, credential_id INTEGER, role TEXT, source TEXT, interactive INTEGER)",
			);
			db.run("INSERT INTO waits (started_at_ms, provider, source, pid, reason) VALUES (1, 'p', 's', 1, 'r')");
			db.close();

			// Corrupt the page contents
			const buf = await fs.readFile(proof.ledgerPath);
			buf.fill(0xff, 100, Math.min(500, buf.length));
			await Bun.write(proof.ledgerPath, buf);

			expect(() => proof.readLedger()).toThrow(/ledger read failed/);
			try {
				proof.readLedger();
				expect.unreachable("should have thrown");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				expect(message).toContain("SQLITE_CORRUPT");
			}
			assertConfined(proof);
		} finally {
			proof.close();
		}
	});
});
