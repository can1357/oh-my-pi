import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

function credential(suffix: string, email = "alice@example.com"): AuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		email,
		accountId: "workspace",
		orgId: "workspace",
	};
}

function readRows(dbPath: string): Array<{ id: number; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT id, disabled_cause FROM auth_credentials ORDER BY id ASC").all() as Array<{
			id: number;
			disabled_cause: string | null;
		}>;
	} finally {
		db.close();
	}
}

function ageRow(dbPath: string, id: number): void {
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE auth_credentials SET updated_at = ? WHERE id = ?").run(
			Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60,
			id,
		);
	} finally {
		db.close();
	}
}

const AUTOMATIC_CAUSE = "oauth refresh failed: refresh_token_invalidated";

describe("disabled credential tombstone retention", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-disabled-tombstones-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("preserves an automatic OAuth tombstone and its cause across same-identity re-login", async () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const newId = store.upsertAuthCredentialForProvider("openai-codex", credential("new"))[0].id;

		expect(readRows(dbPath)).toEqual([
			{ id: oldId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: newId, disabled_cause: null },
		]);
		expect(await store.listDisabledCredentials("openai-codex")).toMatchObject([
			{ id: oldId, cause: AUTOMATIC_CAUSE },
		]);
	});

	it("hard-deletes superseded lifecycle tombstones on same-identity re-login", async () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, "replaced by newer credential");
		const newId = store.upsertAuthCredentialForProvider("openai-codex", credential("new"))[0].id;

		expect(readRows(dbPath)).toEqual([{ id: newId, disabled_cause: null }]);
		expect(await store.listDisabledCredentials("openai-codex")).toEqual([]);
	});

	it("expires old tombstones on open while preserving fresh tombstones and old active rows", async () => {
		if (!store) throw new Error("test setup failed");
		const expiredId = store.upsertAuthCredentialForProvider("openai-codex", credential("expired"))[0].id;
		store.deleteAuthCredential(expiredId, AUTOMATIC_CAUSE);
		const freshId = store.upsertAuthCredentialForProvider("openai-codex", credential("fresh"))[0].id;
		store.deleteAuthCredential(freshId, AUTOMATIC_CAUSE);
		const activeId = store.upsertAuthCredentialForProvider("openai-codex", credential("active"))[0].id;
		store.close();
		store = null;
		ageRow(dbPath, expiredId);
		ageRow(dbPath, activeId);
		store = await SqliteAuthCredentialStore.open(dbPath);

		expect(readRows(dbPath)).toEqual([
			{ id: freshId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: activeId, disabled_cause: null },
		]);
		expect(await store.listDisabledCredentials("openai-codex")).toMatchObject([
			{ id: freshId, cause: AUTOMATIC_CAUSE },
		]);
	});

	it("expires old tombstones during re-login without reopening the store", () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		ageRow(dbPath, oldId);
		const newId = store.upsertAuthCredentialForProvider("openai-codex", credential("new"))[0].id;

		expect(readRows(dbPath)).toEqual([{ id: newId, disabled_cause: null }]);
	});

	it("lets deliberate removal supersede older automatic tombstones only for the removed identity", () => {
		if (!store) throw new Error("test setup failed");
		const unrelatedId = store.upsertAuthCredentialForProvider("openai-codex", credential("bob", "bob@example.com"))[0]
			.id;
		store.deleteAuthCredential(unrelatedId, AUTOMATIC_CAUSE);
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const newId = store.upsertAuthCredentialForProvider("openai-codex", credential("new"))[0].id;
		store.deleteAuthCredential(newId, "deleted by user");

		expect(readRows(dbPath)).toEqual([
			{ id: unrelatedId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: newId, disabled_cause: "deleted by user" },
		]);
	});

	it("lets provider logout supersede automatic tombstones for every logged-out identity only", () => {
		if (!store) throw new Error("test setup failed");
		const peerId = store.upsertAuthCredentialForProvider("anthropic", credential("peer"))[0].id;
		store.deleteAuthCredential(peerId, AUTOMATIC_CAUSE);
		const absentId = store.upsertAuthCredentialForProvider(
			"openai-codex",
			credential("absent", "absent@example.com"),
		)[0].id;
		store.deleteAuthCredential(absentId, AUTOMATIC_CAUSE);
		for (const email of ["alice@example.com", "bob@example.com"]) {
			const rows = store.upsertAuthCredentialForProvider("openai-codex", credential("old", email));
			const oldRow = rows.find(row => row.credential.type === "oauth" && row.credential.email === email);
			if (!oldRow) throw new Error("missing inserted credential");
			store.deleteAuthCredential(oldRow.id, AUTOMATIC_CAUSE);
			store.upsertAuthCredentialForProvider("openai-codex", credential("new", email));
		}
		const activeIds = store.listAuthCredentials("openai-codex").map(row => row.id);
		store.deleteAuthCredentialsForProvider("openai-codex", "deleted by user");

		expect(readRows(dbPath)).toEqual([
			{ id: peerId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: absentId, disabled_cause: AUTOMATIC_CAUSE },
			...activeIds.map(id => ({ id, disabled_cause: "deleted by user" })),
		]);
		expect(store.listAuthCredentials("openai-codex")).toEqual([]);
	});

	it("keeps earlier same-identity tombstones when a recovered credential is automatically disabled again", () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const newId = store.upsertAuthCredentialForProvider("openai-codex", credential("new"))[0].id;
		store.deleteAuthCredential(newId, "oauth refresh failed: x");

		expect(readRows(dbPath)).toEqual([
			{ id: oldId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: newId, disabled_cause: "oauth refresh failed: x" },
		]);
	});
});
