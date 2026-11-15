import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

// `reserveReleaseHours` on the preferred Anthropic account A (priority 10,
// reservePct 20) with B as backup: A's reserve shrinks linearly to zero over the
// last N hours before a window resets, so quota that would expire unused is spent.

const A = "anthropic" as const;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function limit(windowId: "5h" | "7d", used: number, resetsIn: number): UsageLimit {
	return {
		id: `${A}:${windowId}`,
		label: windowId,
		scope: { provider: A, windowId, shared: true },
		window: {
			id: windowId,
			label: windowId,
			durationMs: windowId === "5h" ? 5 * HOUR : 7 * DAY,
			resetsAt: Date.now() + resetsIn,
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

let tempDir = "";
let store: SqliteAuthCredentialStore | null = null;
const usage = new Map<string, UsageReport>();
const base = Date.now();
let clock = 0;

type Windows = { fiveUsed: number; fiveResetsIn?: number; weekUsed: number; weekResetsIn: number };

function setUsage(accountId: string, windows: Windows): void {
	usage.set(accountId, {
		provider: A,
		fetchedAt: Date.now(),
		limits: [
			limit("5h", windows.fiveUsed, windows.fiveResetsIn ?? 3 * HOUR),
			limit("7d", windows.weekUsed, windows.weekResetsIn),
		],
		metadata: { accountId },
	});
}

const policies = (release: { reserveReleaseHours?: number } = { reserveReleaseHours: 24 }): AuthAccountPolicies => [
	{ provider: A, account: { accountId: "a" }, priority: 10, reservePct: 20, ...release },
	{ provider: A, account: { accountId: "b" }, priority: 5 },
];

async function setup(accountPolicies: AuthAccountPolicies): Promise<AuthStorage> {
	if (!store) throw new Error("test setup failed");
	const usageProvider: UsageProvider = {
		id: A,
		async fetchUsage(params) {
			const id = params.credential.accountId;
			return id ? (usage.get(id) ?? null) : null;
		},
	};
	const auth = new AuthStorage(store, {
		usageProviderResolver: p => (p === A ? usageProvider : undefined),
		accountPolicies,
	});
	await auth.credentials.set(
		A,
		["a", "b"].map(accountId => {
			const credential: OAuthCredentials = {
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 7 * DAY,
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

async function advance(auth: AuthStorage, ms: number): Promise<void> {
	clock += ms;
	await auth.usage.invalidate(A);
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reserve-release-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	usage.clear();
	clock = 0;
	vi.spyOn(Date, "now").mockImplementation(() => base + clock);
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

describe("accountPolicies reserveReleaseHours", () => {
	const B_USAGE: Windows = { fiveUsed: 0.1, weekUsed: 0.1, weekResetsIn: 4 * DAY };

	test("keeps the full reserve while the window's reset is further away than the release span", async () => {
		const auth = await setup(policies());
		// A: 15% weekly left, inside its 20% reserve; reset in two days.
		setUsage("a", { fiveUsed: 0.1, weekUsed: 0.85, weekResetsIn: 2 * DAY });
		setUsage("b", B_USAGE);
		expect(await next(auth, "S1")).toBe("b");
	});

	test("spends the reserve as the reset approaches, shrinking it linearly", async () => {
		const auth = await setup(policies());
		setUsage("b", B_USAGE);
		// 18h before reset the reserve is 15%: A's 15% left is still inside it.
		setUsage("a", { fiveUsed: 0.1, weekUsed: 0.85, weekResetsIn: 18 * HOUR });
		expect(await next(auth, "S1")).toBe("b");
		// 12h before reset the reserve is 10%: A's 15% left is routable again.
		await advance(auth, 0);
		setUsage("a", { fiveUsed: 0.1, weekUsed: 0.85, weekResetsIn: 12 * HOUR });
		expect(await next(auth, "S2")).toBe("a");
	});

	test("without reserveReleaseHours the reserve holds until the reset", async () => {
		const auth = await setup(policies({}));
		setUsage("a", { fiveUsed: 0.1, weekUsed: 0.85, weekResetsIn: 1 * HOUR });
		setUsage("b", B_USAGE);
		expect(await next(auth, "S1")).toBe("b");
	});

	test("keeps a running session on the preferred account while it drains into the released reserve", async () => {
		const auth = await setup(policies());
		setUsage("b", B_USAGE);
		setUsage("a", { fiveUsed: 0.1, weekUsed: 0.7, weekResetsIn: 6 * HOUR });
		expect(await next(auth, "S1")).toBe("a");
		// A drops to 8% left: inside the configured 20%, outside the released 5%.
		await advance(auth, 10 * MIN);
		setUsage("a", { fiveUsed: 0.3, weekUsed: 0.92, weekResetsIn: 6 * HOUR - 10 * MIN });
		setUsage("b", B_USAGE);
		expect(await next(auth, "S1")).toBe("a");
	});

	test("releases each window by its own reset", async () => {
		const auth = await setup(policies());
		setUsage("b", B_USAGE);
		// The 5h window holds A inside its reserve (16% left) but resets in an hour:
		// released to under 1%. The weekly window is far from its reserve.
		setUsage("a", { fiveUsed: 0.84, fiveResetsIn: 1 * HOUR, weekUsed: 0.3, weekResetsIn: 3 * DAY });
		expect(await next(auth, "S1")).toBe("a");
		// The weekly window resets in three days, so its reserve holds in full.
		await advance(auth, 0);
		setUsage("a", { fiveUsed: 0.1, fiveResetsIn: 1 * HOUR, weekUsed: 0.85, weekResetsIn: 3 * DAY });
		expect(await next(auth, "S2")).toBe("b");
	});

	test("rejects a non-positive span", async () => {
		if (!store) throw new Error("test setup failed");
		const activeStore = store;
		const build = (reserveReleaseHours: number) =>
			new AuthStorage(activeStore, {
				accountPolicies: [{ provider: A, account: { accountId: "a" }, reserveReleaseHours }],
			});
		expect(() => build(0)).toThrow("auth.accountPolicies[0].reserveReleaseHours must be a finite number above 0");
		expect(() => build(Number.NaN)).toThrow("reserveReleaseHours must be a finite number above 0");
	});

	test("requires a usage provider", async () => {
		if (!store) throw new Error("test setup failed");
		const auth = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			accountPolicies: [{ provider: A, account: { accountId: "a" }, reserveReleaseHours: 24 }],
		});
		await auth.credentials.set(A, [
			{ type: "oauth", access: "x", refresh: "y", expires: Date.now() + 7 * DAY, accountId: "a" },
		]);
		await expect(auth.keys.get(A, "S1")).rejects.toThrow(
			"auth.accountPolicies[0].reserveReleaseHours requires a usage provider for anthropic",
		);
	});
});
