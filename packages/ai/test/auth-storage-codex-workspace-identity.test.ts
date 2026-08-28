/**
 * OpenAI Codex workspace-scoped credential identity.
 *
 * The ChatGPT workspace (`chatgpt_account_id`, captured as `orgId` at login)
 * is the subscription pool a Codex token draws limits from. One email can
 * hold a personal Plus/Pro plan plus Team/Enterprise seats — different
 * workspaces with independent pools — while every member of one workspace
 * shares the workspace id. Identity therefore composes `email|org:<ws>`:
 *   - same email + same workspace  => replace in place (re-login);
 *   - same email + diff workspace  => coexist (personal + enterprise seat);
 *   - diff email + same workspace  => coexist (two Team members, #197);
 *   - workspace-less legacy rows keep their bare email key and are claimed
 *     in place by the first workspace-scoped login with the same email.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as codexUsage from "@oh-my-pi/pi-ai/usage/openai-codex";
import { removeWithRetries } from "../../utils/src/temp";

const EMAIL = "shared@example.com";
const PERSONAL_WS = "ws-personal-1111";
const TEAM_WS = "ws-team-2222";

function codexCredential(args: {
	suffix: string;
	accountId: string;
	/** Workspace qualifier; omitted for legacy rows written before workspace capture. */
	orgId?: string;
	orgName?: string;
	email?: string;
}): AuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: args.accountId,
		email: args.email ?? EMAIL,
		orgId: args.orgId,
		orgName: args.orgName,
	};
}

function readIdentityRows(dbPath: string): Array<{ identity_key: string | null; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT identity_key, disabled_cause FROM auth_credentials WHERE provider = 'openai-codex' ORDER BY id ASC",
			)
			.all() as Array<{ identity_key: string | null; disabled_cause: string | null }>;
	} finally {
		db.close();
	}
}

describe("openai-codex workspace-scoped credential identity", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-codex-ws-identity-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("stores a personal plan and an enterprise seat of one email side by side and updates same-workspace logins in place", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "personal", accountId: PERSONAL_WS, orgId: PERSONAL_WS, orgName: "plus" }),
		);
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "enterprise" }),
		);

		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${PERSONAL_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);

		// Same-workspace re-login: replaces the matching row instead of adding a third.
		const rows = store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "team-renewed", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "enterprise" }),
		);
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${PERSONAL_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);
		const teamRow = rows.find(row => row.credential.type === "oauth" && row.credential.orgId === TEAM_WS);
		expect(teamRow?.credential.type).toBe("oauth");
		if (teamRow?.credential.type === "oauth") {
			expect(teamRow.credential.access).toBe("access-team-renewed");
		}
	});

	it("keeps two members of one workspace separate even though they share the workspace id", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "alice", accountId: TEAM_WS, orgId: TEAM_WS, email: "alice@example.com" }),
		);
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "bob", accountId: TEAM_WS, orgId: TEAM_WS, email: "bob@example.com" }),
		);

		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:alice@example.com|org:${TEAM_WS}`, disabled_cause: null },
			{ identity_key: `email:bob@example.com|org:${TEAM_WS}`, disabled_cause: null },
		]);
	});

	it("upgrades a legacy email-keyed row on the first workspace-scoped login with the same email", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "legacy", accountId: PERSONAL_WS }),
		);
		expect(readIdentityRows(dbPath)).toEqual([{ identity_key: `email:${EMAIL}`, disabled_cause: null }]);

		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "team" }),
		);
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);
	});

	it("purges a disabled legacy email-keyed row on the first workspace-scoped login with the same email", async () => {
		if (!store) throw new Error("test setup failed");

		// Pre-org login → bare email key, then upstream invalidates the refresh
		// token and the row is auto-disabled (a tombstone).
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "legacy", accountId: PERSONAL_WS }),
		);
		const legacyId = store.listAuthCredentials("openai-codex")[0].id;
		store.deleteAuthCredential(legacyId, "oauth refresh failed: OAuthError: 401 refresh_token_invalidated");

		// Same human logs in again, now workspace-scoped: the org-scoped login
		// claims and hard-deletes the pre-org tombstone instead of stranding it.
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "team" }),
		);
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
		]);
		expect(await store.listDisabledCredentials("openai-codex")).toHaveLength(0);
	});

	it("keeps a disabled row of a different member of the same workspace after a workspace-scoped login", async () => {
		if (!store) throw new Error("test setup failed");

		// Alice's org-scoped row is disabled (tombstone). Bob, a different member
		// of the SAME workspace, logs in. The shared-workspace guard must keep
		// Alice's tombstone — it is not Bob's subscription.
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "alice", accountId: TEAM_WS, orgId: TEAM_WS, email: "alice@example.com" }),
		);
		const aliceId = store.listAuthCredentials("openai-codex")[0].id;
		store.deleteAuthCredential(aliceId, "oauth refresh failed: OAuthError: 401 refresh_token_invalidated");

		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "bob", accountId: TEAM_WS, orgId: TEAM_WS, email: "bob@example.com" }),
		);
		expect(await store.listDisabledCredentials("openai-codex")).toHaveLength(1);
	});

	it("never clobbers workspace-scoped rows with a workspace-less credential", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "personal", accountId: PERSONAL_WS, orgId: PERSONAL_WS, orgName: "plus" }),
		);
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "team", accountId: TEAM_WS, orgId: TEAM_WS, orgName: "enterprise" }),
		);
		store.upsertAuthCredentialForProvider(
			"openai-codex",
			codexCredential({ suffix: "orgless", accountId: PERSONAL_WS }),
		);

		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${PERSONAL_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${TEAM_WS}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}`, disabled_cause: null },
		]);
	});
});

// ─── Usage report dedupe partitioning ───────────────────────────────────────

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	return {
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function codexRow(
	id: number,
	args?: { orgId?: string; orgName?: string; accountId?: string; email?: string },
): StoredAuthCredential {
	return {
		id,
		provider: "openai-codex",
		credential: {
			type: "oauth",
			access: `oat-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + 3_600_000,
			accountId: args?.accountId ?? args?.orgId ?? "ws-legacy",
			email: args?.email ?? EMAIL,
			orgId: args?.orgId,
			orgName: args?.orgName,
		},
		disabledCause: null,
	};
}

/** Report carrying ONLY email identity — workspace attribution must come from the credential. */
function emailOnlyReport(email: string): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 hours",
				scope: { provider: "openai-codex", windowId: "5h" },
				window: { id: "5h", label: "5 hours" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email },
	};
}

describe("openai-codex usage report dedupe partitions by workspace", () => {
	let storage: AuthStorage | null = null;

	afterEach(() => {
		storage?.close();
		storage = null;
		vi.restoreAllMocks();
	});

	it("keeps reports from two workspaces on one email separate and attributes each to its workspace", async () => {
		storage = new AuthStorage(
			makeStore([
				codexRow(1, { orgId: PERSONAL_WS, orgName: "plus" }),
				codexRow(2, { orgId: TEAM_WS, orgName: "enterprise" }),
			]),
			{
				usageProviderResolver: provider =>
					provider === "openai-codex" ? codexUsage.openaiCodexUsageProvider : undefined,
			},
		);
		await storage.reload();

		vi.spyOn(codexUsage.openaiCodexUsageProvider, "fetchUsage").mockImplementation(async () =>
			emailOnlyReport(EMAIL),
		);

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "openai-codex");
		expect(reports).toHaveLength(2);
		const orgIds = reports.map(report => report.metadata?.orgId).sort();
		expect(orgIds).toEqual([PERSONAL_WS, TEAM_WS].sort());
		const orgNames = reports.map(report => report.metadata?.orgName).sort();
		expect(orgNames).toEqual(["enterprise", "plus"].sort());
	});

	it("still merges workspace-less reports with the same email into one row", async () => {
		storage = new AuthStorage(makeStore([codexRow(1), codexRow(2)]), {
			usageProviderResolver: provider =>
				provider === "openai-codex" ? codexUsage.openaiCodexUsageProvider : undefined,
		});
		await storage.reload();

		vi.spyOn(codexUsage.openaiCodexUsageProvider, "fetchUsage").mockImplementation(async () =>
			emailOnlyReport(EMAIL),
		);

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "openai-codex");
		expect(reports).toHaveLength(1);
	});
});
