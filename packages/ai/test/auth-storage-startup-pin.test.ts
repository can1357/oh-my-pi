import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthAccountPolicies,
	AuthStorage,
	DEFAULT_USAGE_RESERVE_PCT,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

// `startup: "pin"` on an account policy: a new session starts explicitly pinned on that
// account, so ranking safety rules that would otherwise send it to a sibling (hot 5h window,
// reserve) do not apply at startup. Blocked accounts and existing session pins still win.

const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;
const A = "anthropic";

let tempDir = "";
let store: SqliteAuthCredentialStore | null = null;
const usage = new Map<string, UsageReport>();

function limit(windowId: "5h" | "7d", used: number): UsageLimit {
	return {
		id: `${A}:${windowId}`,
		label: windowId,
		scope: { provider: A, windowId, shared: true },
		window: {
			id: windowId,
			label: windowId,
			durationMs: windowId === "5h" ? 5 * HOUR : WEEK,
			resetsAt: Date.now() + 3 * HOUR,
		},
		amount: {
			unit: "percent",
			used: used * 100,
			limit: 100,
			remaining: 100 - used * 100,
			usedFraction: used,
			remainingFraction: 1 - used,
		},
		status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
	};
}

/** Report for `accountId` with its 5h window at `fiveUsed` and weekly window at `weekUsed`. */
function setUsage(accountId: string, fiveUsed: number, weekUsed: number): void {
	usage.set(accountId, {
		provider: A,
		fetchedAt: Date.now(),
		limits: [limit("5h", fiveUsed), limit("7d", weekUsed)],
		metadata: { accountId },
	});
}

async function setup(policies: AuthAccountPolicies, accounts: string[]): Promise<AuthStorage> {
	if (!store) throw new Error("test setup failed");
	const usageProvider: UsageProvider = {
		id: A,
		async fetchUsage(params) {
			const id = params.credential.accountId;
			return id ? (usage.get(id) ?? null) : null;
		},
	};
	const auth = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === A ? usageProvider : undefined),
		accountPolicies: policies,
	});
	await auth.credentials.set(
		A,
		accounts.map(accountId => {
			const credential: OAuthCredentials = {
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + WEEK,
				accountId,
				email: `${accountId}@example.com`,
			};
			return { type: "oauth" as const, ...credential };
		}),
	);
	return auth;
}

async function next(auth: AuthStorage, session: string): Promise<string | undefined> {
	return (await auth.keys.get(A, session))?.replace(/^api-/, "");
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-startup-pin-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	usage.clear();
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

describe("accountPolicies startup: pin", () => {
	const pinned: AuthAccountPolicies = [{ provider: A, account: { accountId: "a" }, priority: 10, startup: "pin" }];
	const unpinned: AuthAccountPolicies = [{ provider: A, account: { accountId: "a" }, priority: 10 }];

	test("every new session starts on the pinned account regardless of store order", async () => {
		const auth = await setup(pinned, ["b", "a"]);
		setUsage("a", 0.2, 0.2);
		setUsage("b", 0.2, 0.2);
		for (const session of ["S1", "S2", "S3"]) expect(await next(auth, session)).toBe("a");
	});

	test("without startup a hot pinned account loses a new session to an idle sibling", async () => {
		setUsage("a", 0.95, 0.5);
		setUsage("b", 0, 0);
		const auth = await setup(unpinned, ["a", "b"]);
		expect(await next(auth, "S1")).toBe("b");
	});

	test("starts on the pinned account while its 5h window is hot and a sibling is idle", async () => {
		setUsage("a", 0.95, 0.5);
		setUsage("b", 0, 0);
		const auth = await setup(pinned, ["a", "b"]);
		expect(await next(auth, "S1")).toBe("a");
	});

	test("starts on the pinned account inside its reserve", async () => {
		const auth = await setup([{ ...pinned[0]!, reservePct: 15 }], ["a", "b"]);
		setUsage("a", 0.3, 0.9);
		setUsage("b", 0.1, 0.1);
		expect(await next(auth, "S1")).toBe("a");
	});

	test("a new session falls through to a sibling while the pinned account is blocked", async () => {
		const auth = await setup(pinned, ["a", "b"]);
		expect(await next(auth, "S1")).toBe("a");
		await auth.limits.markReached(A, "S1");
		expect(await next(auth, "S2")).toBe("b");
	});

	test("an account the user already pinned for the session is kept", async () => {
		const auth = await setup(pinned, ["a", "b"]);
		const backup = auth.oauth.accounts(A).find(account => account.accountId === "b");
		if (!backup) throw new Error("expected backup account");
		expect(auth.sessions.pin(A, "S1", backup.credentialId)).toBe(true);
		expect(await next(auth, "S1")).toBe("b");
		expect(await next(auth, "S1")).toBe("b");
		// Another session is unaffected by that choice.
		expect(await next(auth, "S2")).toBe("a");
	});

	test("a resumed session keeps the account its earlier process held", async () => {
		if (!store) throw new Error("test setup failed");
		const auth = await setup(pinned, ["a", "b"]);
		const backup = auth.oauth.accounts(A).find(account => account.accountId === "b");
		if (!backup) throw new Error("expected backup account");
		expect(auth.sessions.pin(A, "S1", backup.credentialId)).toBe(true);
		expect(await next(auth, "S1")).toBe("b");
		const restarted = new AuthStorage(store, { accountPolicies: pinned });
		await restarted.credentials.reload();
		expect(await next(restarted, "S1")).toBe("b");
		expect(await next(restarted, "S2")).toBe("a");
	});

	test("an account the session already holds is kept when a startup pin is configured later", async () => {
		const auth = await setup([{ provider: A, account: { accountId: "b" }, priority: 10 }], ["a", "b"]);
		expect(await next(auth, "S1")).toBe("b");
		auth.setAccountPolicies({
			accountPolicies: [
				{ provider: A, account: { accountId: "a" }, startup: "pin" },
				{ provider: A, account: { accountId: "b" }, priority: 10 },
			],
			defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
		});
		expect(await next(auth, "S1")).toBe("b");
		expect(await next(auth, "S2")).toBe("a");
	});

	test("does not pin other providers", async () => {
		const auth = await setup(pinned, ["b", "a"]);
		await auth.credentials.set("openai-codex", [
			{ type: "oauth", access: "x1", refresh: "r1", expires: Date.now() + WEEK, accountId: "x" },
			{ type: "oauth", access: "x2", refresh: "r2", expires: Date.now() + WEEK, accountId: "a" },
		]);
		expect(await next(auth, "S1")).toBe("a");
		await auth.keys.get("openai-codex", "S1");
		expect(auth.sessions.sticky?.("openai-codex", "S1")?.explicit).toBeUndefined();
	});

	test("an absent pinned account is ignored and the session ranks normally", async () => {
		const auth = await setup(
			[
				{ provider: A, account: { accountId: "ghost" }, startup: "pin" },
				{ provider: A, account: { accountId: "b" }, priority: 10 },
			],
			["a", "b"],
		);
		expect(await next(auth, "S1")).toBe("b");
	});

	test("rejects two startup pins for one provider and unknown startup values", async () => {
		if (!store) throw new Error("test setup failed");
		const activeStore = store;
		const build = (policies: AuthAccountPolicies) => new AuthStorage(activeStore, { accountPolicies: policies });
		expect(() =>
			build([
				{ provider: A, account: { accountId: "a" }, startup: "pin" },
				{ provider: A, account: { accountId: "b" }, startup: "pin" },
			]),
		).toThrow(
			"auth.accountPolicies[0] and auth.accountPolicies[1] both set startup for anthropic; only one account can be pinned at startup",
		);
		expect(() => build([{ provider: A, account: { accountId: "a" }, startup: "always" as never }])).toThrow(
			'auth.accountPolicies[0].startup must be "pin"',
		);
		// Different providers may each pin their own account.
		expect(() =>
			build([
				{ provider: A, account: { accountId: "a" }, startup: "pin" },
				{ provider: "openai-codex", account: { accountId: "b" }, startup: "pin" },
			]),
		).not.toThrow();
	});
});
