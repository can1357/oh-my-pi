/**
 * Runtime usage providers are stored as their authors wrote them and admitted per call through
 * the registering session's gate. Contract under test:
 *
 *   1. Several owners may register one provider; the newest live one answers, a retired owner's
 *      registration stops being selected, and the earlier one answers again.
 *   2. Nothing on a retired owner's provider is read or called — not even a getter.
 *   3. Every read and call into a registered provider runs inside its gate, with the provider as
 *      the receiver (a class instance reading a private field works).
 *   4. One provider that throws (method or getter), or whose gate refuses, costs that provider
 *      only: `reports()`, `report()`, `ingestHeaders()` and `health.check()` still answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
// `report` and `cacheVersionFor` serve credential selection and the usage cache, not the public `UsageApi`.
import type { UsageService } from "@oh-my-pi/pi-ai/auth/usage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

function oauthRow(id: number, provider: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
	};
	return { id, provider, credential, disabledCause: null };
}

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return rows;
		},
		async upsertAuthCredential() {
			return rows;
		},
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry || entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

/** A session's gate as the host implements it: refuses once retired, and can be told to refuse
 *  while still reporting live, which is the window between selection and the call. */
function makeGate() {
	let retired = false;
	let refusing = false;
	let active = 0;
	const gate: ProviderCallGate = {
		get retired() {
			return retired;
		},
		run<R>(call: () => R): R {
			if (retired || refusing) throw new Error("session retired");
			active++;
			try {
				return call();
			} finally {
				active--;
			}
		},
	};
	return {
		gate,
		get inside() {
			return active > 0;
		},
		retire() {
			retired = true;
		},
		refuse() {
			refusing = true;
		},
	};
}

function usageReport(provider: string, accountId: string, source: string): UsageReport {
	return { provider, fetchedAt: Date.now(), limits: [], metadata: { accountId, source } };
}

const storages: AuthStorage[] = [];
async function makeStorage(rows: StoredAuthCredential[]): Promise<AuthStorage> {
	const storage = new AuthStorage(makeStore(rows), { usageProviderResolver: () => undefined });
	storages.push(storage);
	await storage.credentials.reload();
	return storage;
}

afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
});

describe("runtime usage provider selection", () => {
	it("answers with the newest live registration and falls back when its owner retires", async () => {
		const storage = await makeStorage([oauthRow(1, "ext-shared")]);
		const parent = makeGate();
		const child = makeGate();
		// Same cache version as the child, so both key their reports alike and only invalidation
		// keeps the child's cached report from answering for the parent.
		const parentProvider: UsageProvider = {
			id: "ext-shared",
			cacheVersion: 3,
			fetchUsage: async () => usageReport("ext-shared", "account-1", "parent"),
		};
		let childReads = 0;
		const childProvider = {
			id: "ext-shared",
			get supports() {
				childReads++;
				return () => true;
			},
			get cacheVersion() {
				childReads++;
				return 3;
			},
			get fetchUsage() {
				childReads++;
				return async () => usageReport("ext-shared", "account-1", "child");
			},
		} as UsageProvider;

		storage.usage.setProvider("ext-shared", parentProvider, undefined, parent.gate);
		storage.usage.setProvider("ext-shared", childProvider, undefined, child.gate);
		expect(storage.usage.providerFor("ext-shared")).toBe(childProvider);
		expect(storage.usage.providerEntryFor("ext-shared")?.gate).toBe(child.gate);
		expect((await storage.usage.reports())?.map(report => report.metadata?.source)).toEqual(["child"]);

		child.retire();
		const readsAtRetirement = childReads;
		expect(storage.usage.providerFor("ext-shared")).toBe(parentProvider);
		// The retired owner's cached report is not served: selection changed, so the cache was invalidated.
		expect((await storage.usage.reports())?.map(report => report.metadata?.source)).toEqual(["parent"]);
		expect(childReads).toBe(readsAtRetirement);

		parent.retire();
		expect(storage.usage.providerFor("ext-shared")).toBeUndefined();
		expect(await storage.usage.reports()).toEqual([]);
	});

	it("replaces a re-registration by the same owner in place and removes by owner", async () => {
		const storage = await makeStorage([]);
		const first = makeGate();
		const second = makeGate();
		const a: UsageProvider = { id: "ext-x", fetchUsage: async () => null };
		const b: UsageProvider = { id: "ext-x", fetchUsage: async () => null };
		const c: UsageProvider = { id: "ext-x", fetchUsage: async () => null };

		storage.usage.setProvider("ext-x", a, undefined, first.gate);
		storage.usage.setProvider("ext-x", b, undefined, second.gate);
		storage.usage.setProvider("ext-x", c, undefined, first.gate);
		// `first` re-registered in place: `second` is still the newest.
		expect(storage.usage.providerFor("ext-x")).toBe(b);
		storage.usage.removeProvider("ext-x", second.gate);
		expect(storage.usage.providerFor("ext-x")).toBe(c);
		storage.usage.removeProvider("ext-x", first.gate);
		expect(storage.usage.providerFor("ext-x")).toBeUndefined();

		storage.usage.setProvider("ext-x", a, undefined, first.gate);
		storage.usage.setProvider("ext-x", b, undefined, second.gate);
		storage.usage.removeProvider("ext-x");
		expect(storage.usage.providerFor("ext-x")).toBeUndefined();
	});
});

describe("calls into a registered usage provider", () => {
	it("run inside the owner's gate with the provider as receiver", async () => {
		const storage = await makeStorage([oauthRow(1, "ext-class")]);
		const owner = makeGate();
		const seen: string[] = [];
		class ClassUsage implements UsageProvider {
			readonly id = "ext-class";
			#account = "account-1";
			get cacheVersion(): number {
				seen.push(`cacheVersion:${owner.inside}`);
				return 1;
			}
			supports(): boolean {
				seen.push(`supports:${owner.inside}`);
				return this.#account === "account-1";
			}
			async fetchUsage(): Promise<UsageReport | null> {
				seen.push(`fetchUsage:${owner.inside}`);
				return usageReport(this.id, this.#account, "class");
			}
			parseRateLimitHeaders(): UsageReport | null {
				seen.push(`parse:${owner.inside}`);
				return usageReport(this.id, this.#account, "headers");
			}
		}
		storage.usage.setProvider("ext-class", new ClassUsage(), undefined, owner.gate);

		expect((await storage.usage.reports())?.map(report => report.metadata?.source)).toEqual(["class"]);
		expect(storage.usage.ingestHeaders("ext-class", { "x-limit": "1" })).toBe(true);
		const [health] = await storage.health.check();
		expect(health).toMatchObject({ provider: "ext-class", ok: true });
		// Every kind of read and call happened, and none of them outside the gate.
		expect(new Set(seen)).toEqual(new Set(["cacheVersion:true", "supports:true", "fetchUsage:true", "parse:true"]));
	});
});

describe("one failing usage provider", () => {
	const healthy: UsageProvider = {
		id: "ext-good",
		fetchUsage: async () => usageReport("ext-good", "account-1", "good"),
	};
	const rows = () => [oauthRow(1, "ext-good"), oauthRow(2, "ext-bad")];

	it("with a throwing supports getter costs only that provider", async () => {
		const storage = await makeStorage(rows());
		const bad = {
			id: "ext-bad",
			get supports(): () => boolean {
				throw new Error("getter boom");
			},
			fetchUsage: async () => usageReport("ext-bad", "account-2", "bad"),
		} as UsageProvider;
		storage.usage.setProvider("ext-good", healthy);
		storage.usage.setProvider("ext-bad", bad, undefined, makeGate().gate);

		expect((await storage.usage.reports())?.map(report => report.provider)).toEqual(["ext-good"]);
		const badCredential = oauthRow(2, "ext-bad").credential;
		await expect((storage.usage as UsageService).report("ext-bad", badCredential)).resolves.toBeNull();
		const results = await storage.health.check();
		expect(results.find(result => result.provider === "ext-good")?.ok).toBe(true);
		expect(results.find(result => result.provider === "ext-bad")).toMatchObject({ ok: false, reason: "getter boom" });
	});

	it("whose host supports method throws costs only that provider", async () => {
		const storage = await makeStorage(rows());
		const bad: UsageProvider = {
			id: "ext-bad",
			supports() {
				throw new Error("supports boom");
			},
			fetchUsage: async () => usageReport("ext-bad", "account-2", "bad"),
		};
		storage.usage.setProvider("ext-good", healthy);
		storage.usage.setProvider("ext-bad", bad);

		expect((await storage.usage.reports())?.map(report => report.provider)).toEqual(["ext-good"]);
	});

	it("whose gate refuses after selection costs only that provider", async () => {
		const storage = await makeStorage(rows());
		const owner = makeGate();
		let badCalls = 0;
		const bad = {
			id: "ext-bad",
			get cacheVersion(): number {
				badCalls++;
				return 1;
			},
			parseRateLimitHeaders: () => {
				badCalls++;
				return null;
			},
			fetchUsage: async () => {
				badCalls++;
				return usageReport("ext-bad", "account-2", "bad");
			},
		} as UsageProvider;
		storage.usage.setProvider("ext-good", healthy);
		storage.usage.setProvider("ext-bad", bad, undefined, owner.gate);
		owner.refuse();
		// Registration read `cacheVersion` through the then-admitting gate; nothing may run after.
		const callsBeforeRefusal = badCalls;

		expect(storage.usage.providerFor("ext-bad")).toBe(bad);
		expect((await storage.usage.reports())?.map(report => report.provider)).toEqual(["ext-good"]);
		const badCredential = oauthRow(2, "ext-bad").credential;
		await expect((storage.usage as UsageService).report("ext-bad", badCredential)).resolves.toBeNull();
		expect(storage.usage.ingestHeaders("ext-bad", { "x-limit": "1" })).toBe(false);
		const results = await storage.health.check();
		expect(results.find(result => result.provider === "ext-good")?.ok).toBe(true);
		expect(results.find(result => result.provider === "ext-bad")).toMatchObject({
			ok: false,
			reason: "session retired",
		});
		expect(badCalls).toBe(callsBeforeRefusal);
	});

	it("with a throwing cacheVersion getter is keyed without a version", async () => {
		const storage = await makeStorage([oauthRow(1, "ext-good")]);
		const versioned = {
			id: "ext-good",
			get cacheVersion(): number {
				throw new Error("version boom");
			},
			fetchUsage: async () => usageReport("ext-good", "account-1", "good"),
		} as UsageProvider;
		storage.usage.setProvider("ext-good", versioned, undefined, makeGate().gate);

		expect((storage.usage as UsageService).cacheVersionFor("ext-good")).toBeUndefined();
		expect((await storage.usage.reports())?.map(report => report.provider)).toEqual(["ext-good"]);
	});
});
