import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport, UsageResetCredits } from "@oh-my-pi/pi-ai/usage";
import { fingerprintBearer } from "../src/auth/bearer-fingerprint";
import { usageCacheIdentity } from "../src/auth/usage-cache";
import { fakeStrategy, installFetchTripwire } from "./fixtures/usage-governor/harness";

installFetchTripwire();
const PROVIDER = "unit-expanded-plan";
const TARGET = { selector: `${PROVIDER}/coding`, provider: PROVIDER, modelId: "coding" };
const CONFIG = { enabled: true, lead: 0.25, interactiveReserve: "hold" as const };
const STALE = 24 * 60 * 60_000;

class World {
	dir = "";
	store!: SqliteAuthCredentialStore;
	auth!: AuthStorage;
	reports = new Map<string, UsageReport>();
	fetches = 0;
	resolution = new Map<string, string>();
	allowance: "included" | "metered" | "unknown" = "included";
	adapter: UsageProvider = {
		id: PROVIDER,
		fetchUsage: async params => {
			this.fetches++;
			const report = this.reports.get(params.credential.apiKey ?? "");
			return report ? structuredClone(report) : null;
		},
		governorAllowance: () =>
			this.allowance === "included" ? ["primary"] : this.allowance === "metered" ? [] : undefined,
	};
	async open(hasStrategy = true) {
		this.dir = await fs.mkdtemp(path.join(os.tmpdir(), "governor-expanded-account-"));
		this.store = await SqliteAuthCredentialStore.open(path.join(this.dir, "auth.db"));
		this.auth = new AuthStorage(this.store, {
			usageProviderResolver: id => (id === PROVIDER ? this.adapter : undefined),
			rankingStrategyResolver: id => (hasStrategy && id === PROVIDER ? fakeStrategy : undefined),
			configValueResolver: async value => this.resolution.get(value) ?? value,
			governor: { dbPath: path.join(this.dir, "governor.db"), config: CONFIG },
		});
		this.auth.governor.setRoutingScope({ id: "scope", revision: 1, roles: [{ role: "task", targets: [TARGET] }] });
		return this;
	}
	report(key: string, options: { observedAt?: number | null; resets?: UsageResetCredits; used?: number } = {}) {
		const now = Date.now();
		this.reports.set(key, {
			provider: PROVIDER,
			fetchedAt: now,
			limits: [
				{
					id: "primary",
					label: "Included",
					scope: { provider: PROVIDER },
					window: { id: "5h", label: "5 Hour", durationMs: 60_000, resetsAt: now + 30_000 },
					amount: { unit: "percent", usedFraction: options.used ?? 0.1 },
					...(options.observedAt === null ? {} : { observedAt: options.observedAt ?? now }),
				},
			],
			...(options.resets ? { resetCredits: options.resets } : {}),
		});
	}
	async seed(keys: string[]) {
		await this.auth.credentials.set(
			PROVIDER,
			keys.map(key => ({ type: "api_key" as const, key, source: "login" as const })),
		);
		for (const key of keys) this.report(this.resolution.get(key) ?? key);
		await this.auth.usage.reports({ provider: PROVIDER });
	}
	async refresh() {
		await this.auth.usage.invalidate(PROVIDER);
		await this.auth.usage.reports({ provider: PROVIDER });
	}
	storeReport(key: string, expired = false) {
		const report = this.reports.get(key);
		if (!report) throw new Error(`missing report for ${key}`);
		const identity = usageCacheIdentity({ type: "api_key", apiKey: key });
		const cacheKey = `usage_cache:report:${PROVIDER}:default:${identity}`;
		const expiresAt = Date.now() + (expired ? -1000 : 60_000);
		this.store.setCache(
			cacheKey,
			JSON.stringify({ value: report, expiresAt }),
			Math.floor((Date.now() + STALE) / 1000),
		);
	}
	async evaluate() {
		return (
			await this.auth.governor.evaluateRoutes({
				scopeId: "scope",
				revision: 1,
				role: "task",
				sessionId: "test",
				targets: [TARGET],
			})
		).accounts;
	}
	async admit(id: number | undefined, key?: string) {
		return this.auth.governor.admit({
			provider: PROVIDER,
			modelId: "coding",
			credentialId: id,
			...(key === undefined ? {} : { bearerFingerprint: fingerprintBearer(key) }),
		});
	}
	blockCount() {
		const db = new Database(path.join(this.dir, "auth.db"), { readonly: true });
		try {
			const row = db.query("SELECT count(*) AS n FROM auth_credential_blocks").get();
			if (!row || typeof row !== "object" || !("n" in row) || typeof row.n !== "number")
				throw new Error("missing block count");
			return row.n;
		} finally {
			db.close();
		}
	}
	async close() {
		this.auth?.close();
		this.store?.close();
		if (this.dir) await fs.rm(this.dir, { recursive: true, force: true });
	}
}
let world: World | undefined;
afterEach(async () => {
	await world?.close();
	world = undefined;
});
async function setup() {
	world = await new World().open();
	return world;
}

describe("stored coding-plan account admission", () => {
	test("paces a selected stored key even when no provider ranking strategy exists", async () => {
		world = await new World().open(false);
		const w = world;
		await w.seed(["account-a"]);
		const selected = await w.auth.keys.getWithCredential(PROVIDER, "session");
		expect(selected?.credentialId).toBeDefined();
		const grant = await w.admit(selected!.credentialId, selected!.apiKey);
		expect(grant?.id).toBeDefined();
		if (grant) w.auth.governor.settle(grant.id, "not-sent");
		expect(await w.admit(selected!.credentialId, "another-key")).toBeUndefined();
	});

	test("requires both the selected row and matching resolved bearer, and reads cache only", async () => {
		const w = await setup();
		await w.seed(["account-a"]);
		const selected = await w.auth.keys.getWithCredential(PROVIDER, "session");
		expect(selected?.credentialId).toBeDefined();
		const id = selected!.credentialId!;
		const before = w.fetches;
		const grant = await w.admit(id, selected!.apiKey);
		expect(grant?.id).toBeDefined();
		if (grant) w.auth.governor.settle(grant.id, "not-sent");
		expect(await w.admit(undefined, selected!.apiKey)).toBeUndefined();
		expect(await w.admit(id)).toBeUndefined();
		expect(await w.admit(id, "another-key")).toBeUndefined();
		expect(await w.admit(id + 9999, selected!.apiKey)).toBeUndefined();
		expect(w.fetches).toBe(before);
	});

	test("a changed reference cannot reuse the old observation or old bearer", async () => {
		const w = await setup();
		w.resolution.set("REF", "old-bearer");
		await w.seed(["REF"]);
		const old = await w.auth.keys.getWithCredential(PROVIDER, "old-session");
		expect(old?.credentialId).toBeDefined();
		w.resolution.set("REF", "new-bearer");
		const current = await w.auth.keys.getWithCredential(PROVIDER, "new-session");
		expect(current?.apiKey).toBe("new-bearer");
		const before = w.fetches;
		expect(await w.admit(old!.credentialId, "old-bearer")).toBeUndefined();
		expect(await w.admit(current!.credentialId, "new-bearer")).toBeUndefined();
		expect(w.fetches).toBe(before);
	});

	test("an environment bearer does not inherit a matching stored credential", async () => {
		const w = await setup();
		const previous = process.env.OPENAI_API_KEY;
		try {
			process.env.OPENAI_API_KEY = "same-bearer";
			await w.auth.credentials.set("openai", [{ type: "api_key", key: "same-bearer" }]);
			const selected = await w.auth.keys.getWithCredential("openai", "env-session");
			expect(selected?.apiKey).toBe("same-bearer");
			expect(selected?.credentialId).toBeUndefined();
			expect(
				await w.auth.governor.admit({
					provider: "openai",
					credentialId: selected?.credentialId,
					bearerFingerprint: fingerprintBearer("same-bearer"),
				}),
			).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});

	test("config and runtime bearers do not inherit the stored row even when bytes match", async () => {
		const w = await setup();
		await w.seed(["same-bearer"]);
		for (const source of ["config", "runtime"] as const) {
			if (source === "config") w.auth.keys.setConfig(PROVIDER, "same-bearer");
			else {
				w.auth.keys.removeConfig(PROVIDER);
				w.auth.keys.setRuntime(PROVIDER, "same-bearer");
			}
			const selected = await w.auth.keys.getWithCredential(PROVIDER, `session-${source}`);
			expect(selected?.apiKey).toBe("same-bearer");
			expect(selected?.credentialId).toBeUndefined();
			expect(await w.admit(selected?.credentialId, selected?.apiKey)).toBeUndefined();
		}
	});

	test("only explicit fresh included evidence is eligible; account quota keys are distinct", async () => {
		const w = await setup();
		await w.seed(["account-a", "account-b"]);
		const rowA = w.auth.credentials
			.list(PROVIDER)
			.find(row => row.credential.type === "api_key" && row.credential.key === "account-a");
		if (!rowA) throw new Error("missing account-a");
		const initial = await w.evaluate();
		expect(initial).toHaveLength(2);
		expect(initial.map(a => a.allowance)).toEqual(["included", "included"]);
		expect(initial[0]!.quotaKeys).toHaveLength(1);
		expect(initial[1]!.quotaKeys).toHaveLength(1);
		expect(initial[0]!.quotaKeys[0]).not.toBe(initial[1]!.quotaKeys[0]);
		for (const kind of ["metered", "unknown"] as const) {
			w.allowance = kind;
			expect((await w.evaluate()).map(a => a.allowance)).toEqual(["unknown", "unknown"]);
			const grant = await w.admit(rowA.id, "account-a");
			expect(grant?.id).toBeDefined();
			if (grant) w.auth.governor.settle(grant.id, "not-sent");
		}
		w.allowance = "included";
		for (const observedAt of [null, Date.now() - STALE, Date.now() + STALE]) {
			w.report("account-a", { observedAt });
			w.storeReport("account-a");
			const accounts = await w.evaluate();
			expect(accounts.find(a => a.credentialId === rowA.id)?.allowance).toBe("unknown");
			expect(await w.admit(rowA.id, "account-a")).toBeUndefined();
		}
	});
});

describe("banked reset tie-break evidence", () => {
	test("requires fresh eligible usable covered unexpired evidence and does not redeem or block", async () => {
		const w = await setup();
		await w.seed(["account-a"]);
		const now = Date.now();
		const expiry = now + 120_000;
		const credit = {
			id: "credit",
			usable: true,
			remainingCount: 1,
			clears: ["primary"],
			expiresAt: new Date(expiry).toISOString(),
		};
		const reset = {
			observedAt: now,
			eligible: true,
			availableCount: 1,
			credits: [credit],
		} satisfies UsageResetCredits;
		const check = async (resets: UsageResetCredits, expected?: number) => {
			w.report("account-a", { resets });
			w.storeReport("account-a");
			const before = w.fetches;
			const account = (await w.evaluate())[0]!;
			expect(account.allowance).toBe("included");
			expect(account.resetTieBreakExpiresAtMs).toBe(expected);
			expect(w.fetches).toBe(before);
			expect(w.blockCount()).toBe(0);
		};
		w.report("account-a", { observedAt: null, resets: { ...reset, observedAt: undefined } });
		await w.refresh();
		const fresh = (await w.evaluate())[0]!;
		expect(fresh.allowance).toBe("included");
		expect(fresh.resetTieBreakExpiresAtMs).toBe(expiry);
		await check(reset, expiry);
		await check({ ...reset, observedAt: now - STALE });
		await check({ ...reset, observedAt: now + STALE });
		await check({ ...reset, observedAt: undefined });
		// A failed refresh retains the legacy cache entry rather than observing it anew.
		w.report("account-a", { resets: { ...reset, observedAt: undefined } });
		w.storeReport("account-a", true);
		w.reports.delete("account-a");
		const beforeFailure = w.fetches;
		await w.auth.usage.reports({ provider: PROVIDER });
		expect(w.fetches).toBe(beforeFailure + 1);
		expect((await w.evaluate())[0]!.resetTieBreakExpiresAtMs).toBeUndefined();
		await check({ ...reset, eligible: false });
		await check({ ...reset, credits: [{ ...credit, clears: ["other"] }] });
		await check({ ...reset, credits: [{ ...credit, usable: false }] });
		await check({ ...reset, credits: [{ ...credit, remainingCount: 0 }] });
		await check({ ...reset, credits: [{ ...credit, expiresAt: new Date(now - 1000).toISOString() }] });
		await check({ ...reset, credits: [{ ...credit, expiresAt: "invalid" }] });
		await check(
			{ ...reset, credits: [{ ...credit, expiresAt: new Date(expiry + 20_000).toISOString() }, credit] },
			expiry,
		);
		expect(w.fetches).toBeGreaterThan(0);
	});

	test("control: a real limit mark is detected by the block query", async () => {
		const w = await setup();
		await w.seed(["account-a"]);
		await w.auth.keys.getWithCredential(PROVIDER, "block-control");
		expect(w.blockCount()).toBe(0);
		await w.auth.limits.markReached(PROVIDER, "block-control", { retryAfterMs: 60_000 });
		expect(w.blockCount()).toBe(1);
	});
});
