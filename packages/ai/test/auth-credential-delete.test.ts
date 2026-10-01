import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type CredentialDisabledEvent,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

interface PersistedCredentialRow {
	id: number;
	provider: string;
	data: string;
	disabled_cause: string | null;
}

function oauthCredential(account: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires: Date.now() + 3_600_000,
		accountId: account,
		email: `${account}@example.com`,
	};
}

describe("explicit permanent credential deletion", () => {
	let tempDir: string;
	let db: Database;
	let observer: Database;
	let store: SqliteAuthCredentialStore;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-delete-"));
		const dbPath = path.join(tempDir, "agent.db");
		db = new Database(dbPath);
		store = new SqliteAuthCredentialStore(db);
		observer = new Database(dbPath, { readonly: true });
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		observer.close();
		store.close();
		await removeWithRetries(tempDir);
	});

	function persistedRows(): PersistedCredentialRow[] {
		return observer
			.query("SELECT id, provider, data, disabled_cause FROM auth_credentials ORDER BY id")
			.all() as PersistedCredentialRow[];
	}

	test("physically removes only the requested row, including disabled rows", async () => {
		await auth.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [a, b, c] = auth.credentials.list("anthropic");
		if (!a || !b || !c) throw new Error("expected three seeded accounts");
		expect(await auth.credentials.disable(c.id, "oauth refresh failed: invalid_grant")).toBe(true);
		const before = persistedRows();
		const generation = auth.credentials.generation;

		expect(await auth.credentials.removeById("anthropic", b.id)).toBe(true);
		expect(persistedRows()).toEqual(before.filter(row => row.id !== b.id));
		expect(auth.credentials.list("anthropic")).toEqual([a]);
		expect(await auth.credentials.listDisabled("anthropic")).toMatchObject([
			{ id: c.id, provider: "anthropic", cause: "oauth refresh failed: invalid_grant" },
		]);
		expect(auth.credentials.generation).toBeGreaterThan(generation);
		expect(await store.hardDeleteAuthCredential(b.id)).toBe(false);

		const tombstoneGeneration = auth.credentials.generation;
		expect(await auth.credentials.removeById("anthropic", c.id)).toBe(true);
		expect(persistedRows()).toEqual(before.filter(row => row.id === a.id));
		expect(auth.credentials.list("anthropic")).toEqual([a]);
		expect(await auth.credentials.listDisabled("anthropic")).toEqual([]);
		expect(auth.credentials.generation).toBeGreaterThan(tombstoneGeneration);
	});

	test("rejects exact-provider mismatches and missing IDs without changing rows or pool", async () => {
		await auth.credentials.set("anthropic", [oauthCredential("active"), oauthCredential("disabled")]);
		const [active, disabled] = auth.credentials.list("anthropic");
		if (!active || !disabled) throw new Error("expected active and disabled accounts");
		await auth.credentials.disable(disabled.id, "disabled by test");
		const rows = persistedRows();
		const entries = auth.credentials.list();
		const generation = auth.credentials.generation;

		expect(await auth.credentials.removeById("openai", active.id)).toBe(false);
		expect(await auth.credentials.removeById("ANTHROPIC", disabled.id)).toBe(false);
		expect(await auth.credentials.removeById("anthropic", disabled.id + 1)).toBe(false);
		expect(persistedRows()).toEqual(rows);
		expect(auth.credentials.list()).toEqual(entries);
		expect(auth.credentials.generation).toBe(generation);
	});

	test("hard-delete write failures reject without mutating either pool or persisted rows", async () => {
		await auth.credentials.set("anthropic", [oauthCredential("active"), oauthCredential("disabled")]);
		const [active, disabled] = auth.credentials.list("anthropic");
		if (!active || !disabled) throw new Error("expected active and disabled accounts");
		await auth.credentials.disable(disabled.id, "disabled by test");
		expect(auth.sessions.pin("anthropic", "pinned", active.id)).toBe(true);
		const rows = persistedRows();
		const entries = auth.credentials.list();
		const generation = auth.credentials.generation;
		db.run("PRAGMA query_only = ON");

		await expect(auth.credentials.removeById("anthropic", active.id)).rejects.toThrow("readonly");
		await expect(auth.credentials.removeById("anthropic", disabled.id)).rejects.toThrow("readonly");
		expect(persistedRows()).toEqual(rows);
		expect(auth.credentials.list()).toEqual(entries);
		expect(auth.credentials.generation).toBe(generation);
		expect(auth.oauth.identity("anthropic", "pinned")).toMatchObject({ accountId: "active" });
	});

	test("legacy deletion and provider logout remain disable-only even with the user-deletion cause", async () => {
		await auth.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b")]);
		const [a, b] = auth.credentials.list("anthropic");
		if (!a || !b) throw new Error("expected two accounts");
		const before = persistedRows();

		expect(await store.deleteAuthCredential(a.id, "deleted by user")).toBe(true);
		expect(await store.deleteAuthCredential(a.id, "another disable cause")).toBe(false);
		expect(persistedRows()).toEqual(
			before.map(row => (row.id === a.id ? { ...row, disabled_cause: "deleted by user" } : row)),
		);
		await auth.credentials.reload();
		await auth.credentials.remove("anthropic");
		expect(auth.credentials.list("anthropic")).toEqual([]);
		expect(persistedRows()).toEqual(before.map(row => ({ ...row, disabled_cause: "deleted by user" })));
	});

	test("duplicate pruning still reloads a deduplicated pool when SQLite cannot persist the disable", async () => {
		await auth.credentials.set("anthropic", oauthCredential("duplicate"));
		const [original] = auth.credentials.list("anthropic");
		if (!original) throw new Error("expected seeded account");
		// A persisted duplicate can predate pool-level deduplication or come from a peer writer.
		db.run(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key)
			 SELECT provider, credential_type, data, identity_key FROM auth_credentials WHERE id = ?`,
			[original.id],
		);
		const rows = persistedRows();
		const newest = rows[rows.length - 1];
		if (!newest) throw new Error("expected persisted duplicate");
		db.run("PRAGMA query_only = ON");

		await auth.credentials.reload();
		expect(auth.credentials.list("anthropic")).toEqual([{ ...original, id: newest.id }]);
		expect(persistedRows()).toEqual(rows);

		db.run("PRAGMA query_only = OFF");
		await auth.credentials.reload();
		expect(persistedRows()).toEqual(
			rows.map(row =>
				row.id === original.id ? { ...row, disabled_cause: "deduplicated duplicate credential" } : row,
			),
		);
	});

	test("failed disables retain the active credential and emit no disabled event", async () => {
		await auth.credentials.set("anthropic", oauthCredential("active"));
		const [active] = auth.credentials.list("anthropic");
		if (!active) throw new Error("expected seeded account");
		const rows = persistedRows();
		const generation = auth.credentials.generation;
		const events: CredentialDisabledEvent[] = [];
		auth.credentials.onDisabled(event => {
			events.push(event);
		});
		db.run("PRAGMA query_only = ON");

		expect(await store.deleteAuthCredential(active.id, "oauth refresh failed: invalid_grant")).toBe(false);
		expect(await auth.credentials.disable(active.id, "deleted by user")).toBe(false);
		expect(persistedRows()).toEqual(rows);
		expect(auth.credentials.list("anthropic")).toEqual([active]);
		expect(auth.credentials.generation).toBe(generation);
		expect(events).toEqual([]);
	});

	test("invalidated OAuth rotation returns its prior failure outcome when the disable cannot be persisted", async () => {
		await auth.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b")]);
		const entries = auth.credentials.list("anthropic");
		const [target] = entries;
		if (!target) throw new Error("expected seeded account");
		const rows = persistedRows();
		const events: CredentialDisabledEvent[] = [];
		auth.credentials.onDisabled(event => {
			events.push(event);
		});
		db.run("PRAGMA query_only = ON");

		expect(
			await auth.limits.rotate("anthropic", "failed-rotation", {
				credentialId: target.id,
				error: new Error("Encountered invalidated oauth token for user, failing request"),
			}),
		).toEqual({ switched: false });
		expect(persistedRows()).toEqual(rows);
		expect(auth.credentials.list("anthropic")).toEqual(entries);
		expect(events).toEqual([]);
	});
});
