import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

function credential(suffix: string, email = "alice@example.com"): OAuthCredential {
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

	it("expires only aged tombstones — never aged active rows — when a reopened store is read", async () => {
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

		// Opening alone leaves rows untouched so a just-migrated legacy tombstone stays inspectable.
		expect(readRows(dbPath).map(row => row.id)).toEqual([expiredId, freshId, activeId]);
		expect(await store.listDisabledCredentials("openai-codex")).toMatchObject([
			{ id: freshId, cause: AUTOMATIC_CAUSE },
		]);
		expect(readRows(dbPath)).toEqual([
			{ id: freshId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: activeId, disabled_cause: null },
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

	it("clears provider history on whole-provider logout without touching another provider", () => {
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

	it("keeps an identity's automatic tombstone when a duplicate row of it is deduplicated", () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const liveId = store.upsertAuthCredentialForProvider("openai-codex", credential("live"))[0].id;
		// The row AuthStorage.reload() retires when it finds two live rows for one identity.
		store.deleteAuthCredential(liveId, "deduplicated duplicate credential");

		expect(readRows(dbPath)).toEqual([
			{ id: oldId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: liveId, disabled_cause: "deduplicated duplicate credential" },
		]);
	});

	it("keeps an identity-less automatic tombstone through re-login and clears it on a deliberate logout", async () => {
		if (!store) throw new Error("test setup failed");
		const bare = (suffix: string): OAuthCredential => ({
			type: "oauth",
			access: `opaque-${suffix}`,
			refresh: `refresh-${suffix}`,
			expires: Date.now() + 3_600_000,
		});
		const oldId = store.upsertAuthCredentialForProvider("unit-idless", bare("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const newId = store.upsertAuthCredentialForProvider("unit-idless", bare("new"))[0].id;
		expect((await store.listDisabledCredentials("unit-idless")).map(row => row.id)).toEqual([oldId]);

		store.deleteAuthCredentialsForProvider("unit-idless", "logged out by user");
		expect(readRows(dbPath)).toEqual([{ id: newId, disabled_cause: "logged out by user" }]);
	});

	it("preserves an unrelated identity-less tombstone on named-account removal until provider logout", async () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", {
			type: "oauth",
			access: "opaque-account-a",
			refresh: "opaque-refresh-a",
			expires: Date.now() + 3_600_000,
		})[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const namedId = store.upsertAuthCredentialForProvider("openai-codex", credential("b", "bob@example.com"))[0].id;
		store.deleteAuthCredential(namedId, "deleted by user");

		expect(readRows(dbPath)).toEqual([
			{ id: oldId, disabled_cause: AUTOMATIC_CAUSE },
			{ id: namedId, disabled_cause: "deleted by user" },
		]);
		expect(await store.listDisabledCredentials("openai-codex")).toContainEqual(
			expect.objectContaining({ id: oldId, cause: AUTOMATIC_CAUSE }),
		);

		// No active rows remain: an explicit provider logout still owns its history.
		store.deleteAuthCredentialsForProvider("openai-codex", "logged out by user");
		expect(await store.listDisabledCredentials("openai-codex")).toEqual([]);
		expect(readRows(dbPath)).toEqual([]);
	});

	it("starts retention at automatic disable rather than the aged active row's last update", async () => {
		if (!store) throw new Error("test setup failed");
		const id = store.upsertAuthCredentialForProvider("openai-codex", credential("aged-active"))[0].id;
		ageRow(dbPath, id);
		const beforeDisableMs = Math.floor(Date.now() / 1000) * 1000;
		store.deleteAuthCredential(id, AUTOMATIC_CAUSE);
		const [summary] = await store.listDisabledCredentials("openai-codex");
		expect(summary).toMatchObject({ id, cause: AUTOMATIC_CAUSE });
		expect(summary?.disabledAtMs).toBeGreaterThanOrEqual(beforeDisableMs);
		expect(summary?.disabledAtMs).toBeLessThanOrEqual(Date.now());
		store.upsertAuthCredentialForProvider("openai-codex", credential("recovered"));
		expect((await store.listDisabledCredentials("openai-codex")).map(row => row.id)).toEqual([id]);
	});

	it("lets a deliberate removal clear a legacy tombstone the removed org-scoped login had upgraded", () => {
		if (!store) throw new Error("test setup failed");
		// Pre-org login (identity `email:<e>`), torn down automatically.
		const legacyId = store.upsertAuthCredentialForProvider("openai-codex", {
			...credential("legacy"),
			accountId: "personal",
			orgId: undefined,
		})[0].id;
		store.deleteAuthCredential(legacyId, AUTOMATIC_CAUSE);
		// Same person signs in again workspace-scoped (identity `email:<e>|org:<o>`)
		// and then logs that account out through the account selector.
		const orgId = store.upsertAuthCredentialForProvider("openai-codex", credential("team"))[0].id;
		expect(readRows(dbPath).map(row => row.id)).toEqual([legacyId, orgId]);
		store.deleteAuthCredential(orgId, "deleted by user");

		expect(readRows(dbPath)).toEqual([{ id: orgId, disabled_cause: "deleted by user" }]);
	});

	it("lets `omp auth-broker logout` clear upgraded legacy tombstones for every logged-out identity", () => {
		if (!store) throw new Error("test setup failed");
		const legacyId = store.upsertAuthCredentialForProvider("openai-codex", {
			...credential("legacy"),
			accountId: "personal",
			orgId: undefined,
		})[0].id;
		store.deleteAuthCredential(legacyId, AUTOMATIC_CAUSE);
		const bobId = store.upsertAuthCredentialForProvider("openai-codex", credential("bob", "bob@example.com"))[0].id;
		store.deleteAuthCredential(bobId, AUTOMATIC_CAUSE);
		const teamId = store.upsertAuthCredentialForProvider("openai-codex", credential("team"))[0].id;

		// The exact cause the CLI's runLogout() writes.
		store.deleteAuthCredentialsForProvider("openai-codex", "logged out by user");

		expect(readRows(dbPath)).toEqual([{ id: teamId, disabled_cause: "logged out by user" }]);
	});

	it("expires an aged tombstone on the read path of a store that never writes again", async () => {
		if (!store) throw new Error("test setup failed");
		const oldId = store.upsertAuthCredentialForProvider("openai-codex", credential("old"))[0].id;
		store.deleteAuthCredential(oldId, AUTOMATIC_CAUSE);
		const freshId = store.upsertAuthCredentialForProvider("openai-codex", credential("fresh", "fresh@example.com"))[0]
			.id;
		store.deleteAuthCredential(freshId, AUTOMATIC_CAUSE);
		expect((await store.listDisabledCredentials("openai-codex")).map(row => row.id)).toEqual([oldId, freshId]);

		ageRow(dbPath, oldId);
		expect((await store.listDisabledCredentials("openai-codex")).map(row => row.id)).toEqual([freshId]);
		expect(readRows(dbPath).map(row => row.id)).toEqual([freshId]);
	});
});
