/**
 * Hermetic harness for the usage-governor contract tests (spec 7.1).
 *
 * Everything that could reach the network is a recording fake: the usage provider behind
 * `usageProviderResolver`, the `usageFetch` seam that carries reset list and consume calls, and
 * `globalThis.fetch`, which throws. Each test gets a real `AuthStorage` over a temp `agent.db`
 * and a ledger at a temp path. Tests call `createHarness()` in a hook or body and
 * `disposeHarness()` in `afterEach`.
 */
import { afterEach, beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageProvider,
	UsageReport,
	UsageResetCredits,
} from "@oh-my-pi/pi-ai/usage";
import { configureUsageAdmission } from "@oh-my-pi/pi-ai/usage-governor/admission";
import type { UsageGovernorConfig } from "@oh-my-pi/pi-ai/usage-governor/types";

/** Custom provider id for the policy and selection tests (no built-in usage or reset behaviour). */
export const PROVIDER = "unit-governor";
/** Provider id the reset redemption path treats as Codex. */
export const CODEX = "openai-codex";

export const ENABLED: UsageGovernorConfig = { enabled: true, lead: 0.25, interactiveReserve: "hold" };
export const DISABLED: UsageGovernorConfig = { enabled: false, lead: 0.25, interactiveReserve: "hold" };

/** A test-owned primary window. `used` is the fraction the next usage snapshot reports. */
export interface FakeWindow {
	used: number;
	resetsAt: number;
	durationMs: number;
}

export interface FakeAccount {
	accountId: string;
	email: string;
	window: FakeWindow;
	resetCredits?: UsageResetCredits;
}

export interface UsageFetchRecord {
	method: string;
	path: string;
	at: number;
}

/** Recording usage source. `reportFetches` counts provider snapshot fetches; status and admit must add none. */
export class FakeUsage {
	readonly accounts = new Map<string, FakeAccount>();
	readonly fetchLog: UsageFetchRecord[] = [];
	reportFetches = 0;

	/** Replace one account's primary window. The next `usage.reports` call after `invalidate` picks it up. */
	setWindow(accountId: string, patch: Partial<FakeWindow>): void {
		const account = this.accounts.get(accountId);
		if (!account) throw new Error(`no fake account ${accountId}`);
		account.window = { ...account.window, ...patch };
	}

	provider(id: string): UsageProvider {
		return {
			id,
			cacheVersion: 1,
			fetchUsage: async (params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> => {
				const account = this.accounts.get(params.credential.accountId ?? "");
				if (!account) return null;
				this.reportFetches += 1;
				return reportFor(id, account);
			},
		};
	}
}

function reportFor(provider: string, account: FakeAccount): UsageReport {
	const { window } = account;
	const report: UsageReport = {
		provider,
		fetchedAt: Date.now(),
		limits: [
			{
				id: "primary",
				label: "primary",
				scope: { provider, accountId: account.accountId },
				window: { id: "5h", label: "5 Hour", durationMs: window.durationMs, resetsAt: window.resetsAt },
				amount: { unit: "percent", usedFraction: window.used },
			},
		],
		metadata: { accountId: account.accountId, email: account.email },
	};
	if (account.resetCredits) report.resetCredits = account.resetCredits;
	return report;
}

/** Ranking for the fake meters: the single `primary` limit is the window that paces. */
export const fakeStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		return { primary: report.limits.find(limit => limit.id === "primary") };
	},
	windowDefaults: { primaryMs: 60_000, secondaryMs: 604_800_000 },
};

export function oauthCredential(accountId: string, email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 60 * 60_000,
		accountId,
		email,
	};
}

export interface AuthRow {
	id: number;
	provider: string;
	disabled_cause: string | null;
}

export interface CountRow {
	n: number;
}

export interface ReservationRow {
	grant_id: string;
	quota_key: string;
	created_at_ms: number;
	settled_at_ms: number | null;
}

export interface Harness {
	dir: string;
	agentDbPath: string;
	ledgerPath: string;
	store: SqliteAuthCredentialStore;
	storage: AuthStorage;
	usage: FakeUsage;
	/** Every call that reached the throwing `globalThis.fetch`. Must stay empty. */
	strayFetchCalls: unknown[][];
	ledgerExists(): boolean;
	authRows(): AuthRow[];
	blockRowCount(): number;
	reservations(): ReservationRow[];
	/** Recorded redemption POSTs (the consume route). */
	redemptionPosts(): UsageFetchRecord[];
}

interface Live {
	harness: Harness;
	tripwire: FetchTripwire;
}

/** The throwing `globalThis.fetch` for one test: the calls it swallowed and how to restore it. */
export interface FetchTripwire {
	readonly calls: unknown[][];
	restore(): void;
}

let live: Live | undefined;

function strayFetch(calls: unknown[][]): typeof fetch {
	const trip = (input: string | URL | Request): Promise<Response> => {
		calls.push([input]);
		throw new Error(`stray network call: ${String(input)}`);
	};
	return Object.assign(trip, { preconnect: (_input: string | URL, _options?: unknown): void => {} }) as typeof fetch;
}

/**
 * Create the per-test world: temp dir, real `AuthStorage`, recording fakes, and a `globalThis.fetch`
 * that throws. `governorConfig` defaults to enabled; pass {@link DISABLED} for the inactive path.
 */
export async function createHarness(
	governorConfig: UsageGovernorConfig = ENABLED,
	ledgerRelative = "usage-governor.db",
): Promise<Harness> {
	if (live) throw new Error("harness already created; call disposeHarness() first");
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ai-governor-"));
	const agentDbPath = path.join(dir, "agent.db");
	const ledgerPath = path.join(dir, ledgerRelative);
	const usage = new FakeUsage();
	const tripwire = armFetchTripwire();
	const strayFetchCalls = tripwire.calls;

	const usageFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		usage.fetchLog.push({ method, path: url.pathname, at: Date.now() });
		if (method === "GET" && url.pathname.endsWith("/wham/rate-limit-reset-credits")) {
			const account = [...usage.accounts.values()][0];
			const credits = account?.resetCredits?.credits ?? [];
			return Response.json({
				available_count: account?.resetCredits?.availableCount ?? 0,
				credits: credits.map(credit => ({
					id: credit.id,
					status: credit.status ?? "available",
					expires_at: credit.expiresAt,
					reset_type: "codex_rate_limits",
				})),
			});
		}
		if (method === "POST" && url.pathname.endsWith("/wham/rate-limit-reset-credits/consume")) {
			return Response.json({ code: "reset" });
		}
		return new Response("unexpected route", { status: 404 });
	}) as typeof fetch;

	const store = await SqliteAuthCredentialStore.open(agentDbPath);
	const storage = new AuthStorage(store, {
		usageFetch,
		usageProviderResolver: id => (id === PROVIDER || id === CODEX ? usage.provider(id) : undefined),
		rankingStrategyResolver: id => (id === PROVIDER || id === CODEX ? fakeStrategy : undefined),
		governor: { dbPath: ledgerPath, config: governorConfig },
	});

	const readOnly = <T>(file: string, run: (db: Database) => T): T => {
		const db = new Database(file, { readonly: true });
		try {
			return run(db);
		} finally {
			db.close();
		}
	};

	const harness: Harness = {
		dir,
		agentDbPath,
		ledgerPath,
		store,
		storage,
		usage,
		strayFetchCalls,
		ledgerExists: () => fs.existsSync(ledgerPath),
		authRows: () =>
			readOnly(
				agentDbPath,
				db =>
					db.prepare("SELECT id, provider, disabled_cause FROM auth_credentials ORDER BY id").all() as AuthRow[],
			),
		blockRowCount: () =>
			readOnly(agentDbPath, db => {
				const row = db.prepare("SELECT COUNT(*) AS n FROM auth_credential_blocks").get() as CountRow;
				return row.n;
			}),
		reservations: () => {
			if (!fs.existsSync(ledgerPath)) return [];
			return readOnly(
				ledgerPath,
				db =>
					db
						.prepare("SELECT grant_id, quota_key, created_at_ms, settled_at_ms FROM reservations ORDER BY id")
						.all() as ReservationRow[],
			);
		},
		redemptionPosts: () => usage.fetchLog.filter(entry => entry.method === "POST" && entry.path.endsWith("/consume")),
	};
	live = { harness, tripwire };
	return harness;
}

/** Tear down the per-test world: restore fetch, clear the admission seam, close storage, remove files. */
export async function disposeHarness(): Promise<void> {
	configureUsageAdmission(undefined);
	const current = live;
	live = undefined;
	if (!current) return;
	current.tripwire.restore();
	current.harness.storage.close();
	await fsp.rm(current.harness.dir, { recursive: true, force: true });
}

/** Add OAuth accounts for a provider and register their fake snapshots. */
export async function seedAccounts(
	h: Harness,
	provider: string,
	accounts: Array<{ accountId: string; email: string; window: FakeWindow; resetCredits?: UsageResetCredits }>,
): Promise<void> {
	for (const account of accounts) {
		h.usage.accounts.set(account.accountId, {
			accountId: account.accountId,
			email: account.email,
			window: account.window,
			resetCredits: account.resetCredits,
		});
	}
	await h.storage.credentials.set(
		provider,
		accounts.map(account => oauthCredential(account.accountId, account.email)),
	);
}

/** Stored row id the pool assigned to an account. */
export function credentialIdOf(h: Harness, provider: string, accountId: string): number {
	const account = h.storage.oauth.accounts(provider).find(entry => entry.accountId === accountId);
	if (!account) throw new Error(`no stored row for ${accountId}`);
	return account.credentialId;
}

/** Fetch and cache usage for a provider so governed admission has a snapshot to read. */
export async function seedReports(h: Harness, provider: string): Promise<void> {
	const reports = await h.storage.usage.reports({ provider });
	if (!reports || reports.length === 0) throw new Error(`no usage reports for ${provider}`);
}

/** A primary window that resets `offsetMs` from now and lasts `durationMs`. */
export function windowAt(offsetMs: number, durationMs: number, used: number): FakeWindow {
	return { used, resetsAt: Date.now() + offsetMs, durationMs };
}

/** Assert the throwing fetch was never hit. */
export function expectNoStrayFetch(h: Harness): void {
	if (h.strayFetchCalls.length !== 0) throw new Error(`stray network calls: ${h.strayFetchCalls.length}`);
}

/** Arm the throwing `globalThis.fetch`. Any call is recorded in `calls` and then throws. */
export function armFetchTripwire(): FetchTripwire {
	const calls: unknown[][] = [];
	const spy = spyOn(globalThis, "fetch").mockImplementation(strayFetch(calls));
	return { calls, restore: () => spy.mockRestore() };
}

/**
 * For files that build no harness: arm the tripwire before each test and restore it after. Returns a
 * reader for the calls that reached it, so a test can assert none did.
 */
export function installFetchTripwire(): () => unknown[][] {
	let tripwire: FetchTripwire | undefined;
	beforeEach(() => {
		tripwire = armFetchTripwire();
	});
	afterEach(() => {
		tripwire?.restore();
		tripwire = undefined;
	});
	return () => tripwire?.calls ?? [];
}
