import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthAccountPolicies,
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	DEFAULT_USAGE_RESERVE_PCT,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

// Two Anthropic-style accounts; `b` is the one an `auth.accountPolicies` entry pauses.
const PROVIDER = "anthropic";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const PAUSE_B: AuthAccountPolicies = [
	{ provider: PROVIDER, account: { email: "b@example.com", orgId: "org-b" }, paused: true },
];
const PAUSE_BOTH: AuthAccountPolicies = [
	...PAUSE_B,
	{ provider: PROVIDER, account: { email: "a@example.com", orgId: "org-a" }, paused: true },
];

function account(name: "a" | "b"): OAuthCredential {
	const credential: OAuthCredentials = {
		access: `access-${name}`,
		refresh: `refresh-${name}`,
		expires: Date.now() + WEEK,
		accountId: name,
		email: `${name}@example.com`,
		orgId: `org-${name}`,
	};
	return { type: "oauth", ...credential };
}

let tempDir = "";
let store: SqliteAuthCredentialStore | null = null;

async function setup(
	accountPolicies: AuthAccountPolicies,
	credentials: AuthCredential[] = [account("a"), account("b")],
	credentialStore?: AuthCredentialStore,
): Promise<{ auth: AuthStorage; ids: Record<"a" | "b", number> }> {
	if (!store) throw new Error("test setup failed");
	const auth = new AuthStorage(credentialStore ?? store, { usageProviderResolver: () => undefined, accountPolicies });
	await auth.credentials.set(PROVIDER, credentials);
	const rows = store.listAuthCredentials(PROVIDER);
	const idOf = (name: string) =>
		rows.find(row => row.credential.type === "oauth" && row.credential.accountId === name)?.id;
	return { auth, ids: { a: idOf("a") ?? -1, b: idOf("b") ?? -1 } };
}

async function key(auth: AuthStorage, session: string): Promise<string | undefined> {
	return auth.keys.get(PROVIDER, session);
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-account-paused-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, all) => {
		const credential = all[provider] as OAuthCredentials | undefined;
		return credential?.accountId ? { apiKey: `api-${credential.accountId}`, newCredentials: credential } : null;
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	store?.close();
	store = null;
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("accountPolicies paused", () => {
	test("a paused account is never selected, even when the only visible account hits its limit", async () => {
		const { auth, ids } = await setup(PAUSE_B);
		expect(await key(auth, "s1")).toBe("api-a");

		await auth.limits.markReached(PROVIDER, "s1", { credentialId: ids.a, retryAfterMs: 60 * 60_000 });

		expect(await key(auth, "s1")).not.toBe("api-b");
		expect(await key(auth, "s2")).not.toBe("api-b");
	});

	test("pausing live drops a pin to the account; resuming brings the same login back", async () => {
		const { auth, ids } = await setup([]);
		expect(auth.sessions.pin(PROVIDER, "s1", ids.b)).toBe(true);
		expect(await key(auth, "s1")).toBe("api-b");
		const beforePause = auth.credentials.generation;

		auth.setAccountPolicies({ accountPolicies: PAUSE_B, defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });

		expect(auth.credentials.generation).toBeGreaterThan(beforePause);
		expect(await key(auth, "s1")).toBe("api-a");
		expect(auth.sessions.pin(PROVIDER, "s1", ids.b)).toBe(false);
		expect(auth.oauth.accounts(PROVIDER).map(summary => summary.credentialId)).toEqual([ids.a]);
		expect(auth.oauth.pausedAccounts(PROVIDER)).toEqual([
			{
				provider: PROVIDER,
				credentialId: ids.b,
				accountId: "b",
				email: "b@example.com",
				projectId: undefined,
				enterpriseUrl: undefined,
				orgId: "org-b",
				orgName: undefined,
				identityKey: "email:b@example.com|org:org-b",
			},
		]);
		const beforeResume = auth.credentials.generation;

		auth.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });

		expect(auth.credentials.generation).toBeGreaterThan(beforeResume);
		expect(auth.oauth.accounts(PROVIDER).map(summary => summary.credentialId)).toEqual([ids.a, ids.b]);
		expect(auth.oauth.pausedAccounts()).toEqual([]);
		expect(auth.sessions.pin(PROVIDER, "s1", ids.b)).toBe(true);
		expect(await key(auth, "s1")).toBe("api-b");
	});

	test("exact-account reads and health checks skip a paused account", async () => {
		const { auth, ids } = await setup(PAUSE_B);

		expect(await auth.oauth.accessById(PROVIDER, ids.b)).toBeUndefined();
		const all = await auth.oauth.accessAll(PROVIDER);
		expect(all.map(resolution => resolution.credentialId)).toEqual([ids.a]);
		const health = await auth.health.check();
		expect(health.map(row => row.id)).toEqual([ids.a]);
	});

	test("removing a visible sibling keeps the paused row, so resuming needs no re-login", async () => {
		const { auth, ids } = await setup(PAUSE_B);

		expect(await auth.credentials.removeById(PROVIDER, ids.a)).toBe(true);
		expect(auth.oauth.accounts(PROVIDER)).toEqual([]);
		auth.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });

		expect(auth.oauth.accounts(PROVIDER).map(summary => summary.credentialId)).toEqual([ids.b]);
		expect(await key(auth, "s1")).toBe("api-b");
	});

	test("logging in again to a paused account keeps it paused", async () => {
		const { auth, ids } = await setup(PAUSE_B);

		await auth.credentials.upsert(PROVIDER, { ...account("b"), access: "access-b-relogin" });

		expect(auth.oauth.accounts(PROVIDER).map(summary => summary.credentialId)).toEqual([ids.a]);
		expect(auth.oauth.pausedAccounts(PROVIDER).map(summary => summary.email)).toEqual(["b@example.com"]);
		expect(await key(auth, "s1")).toBe("api-a");
	});

	test("with every OAuth account paused, a stored API key still serves and none resolves to undefined", async () => {
		const withoutKey = await setup(PAUSE_BOTH);
		expect(await key(withoutKey.auth, "s1")).toBeUndefined();

		await withoutKey.auth.credentials.set(PROVIDER, [
			account("a"),
			account("b"),
			{ type: "api_key", key: "sk-ant-key" },
		]);
		expect(await key(withoutKey.auth, "s1")).toBe("sk-ant-key");
	});

	test("broker usage reports for a paused account are dropped; untagged reports stay", async () => {
		if (!store) throw new Error("test setup failed");
		const report = (credentialId: number | undefined, label: string): UsageReport => ({
			provider: PROVIDER,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { label, ...(credentialId === undefined ? {} : { credentialId }) },
		});
		const rows: { a: number; b: number } = { a: -1, b: -1 };
		const brokered: AuthCredentialStore = Object.assign(store, {
			fetchUsageReports: async (): Promise<UsageReport[]> => [
				report(rows.a, "a"),
				report(rows.b, "b"),
				report(undefined, "api-key"),
			],
		});
		const { auth, ids } = await setup(PAUSE_B, undefined, brokered);
		rows.a = ids.a;
		rows.b = ids.b;

		const reports = await auth.usage.reports();

		expect(reports?.map(entry => entry.metadata?.label)).toEqual(["a", "api-key"]);
	});
});
