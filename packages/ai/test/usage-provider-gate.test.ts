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
	type AuthStorageOptions,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
// `report` and `cacheVersionFor` serve credential selection and the usage cache, not the public `UsageApi`.
import type { UsageService } from "@oh-my-pi/pi-ai/auth/usage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

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
async function makeStorage(rows: StoredAuthCredential[], options: AuthStorageOptions = {}): Promise<AuthStorage> {
	const storage = new AuthStorage(makeStore(rows), { usageProviderResolver: () => undefined, ...options });
	storages.push(storage);
	await storage.credentials.reload();
	return storage;
}

/** A key resolver that holds one reference until released, so a test can act while collection waits on it. */
function heldResolver(held: string, resolved: Record<string, string>) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		entered: entered.promise,
		release: () => release.resolve(),
		async resolve(config: string): Promise<string | undefined> {
			if (config === held) {
				entered.resolve();
				await release.promise;
			}
			return resolved[config];
		},
	};
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
		storage.usage.removeRegistration("ext-x", second.gate);
		expect(storage.usage.providerFor("ext-x")).toBe(c);
		storage.usage.removeRegistration("ext-x", first.gate);
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

describe("usage request collection selects after its awaits", () => {
	it("asks the live parent when the newest owner retires while a stored key resolves", async () => {
		const resolver = heldResolver("stored-ref", { "stored-ref": "stored-secret" });
		const row: StoredAuthCredential = {
			id: 1,
			provider: "ext-wait",
			credential: { type: "api_key", key: "stored-ref" },
			disabledCause: null,
		};
		const storage = await makeStorage([row], { configValueResolver: config => resolver.resolve(config) });
		const parent = makeGate();
		const child = makeGate();
		const calls: string[] = [];
		for (const [label, gate] of [
			["parent", parent.gate],
			["child", child.gate],
		] as const) {
			storage.usage.setProvider(
				"ext-wait",
				{
					id: "ext-wait",
					supports() {
						calls.push(`${label}.supports`);
						return true;
					},
					fetchUsage: async params => {
						calls.push(`${label}.fetch:${params.credential.apiKey}`);
						return usageReport("ext-wait", "account-1", label);
					},
				},
				undefined,
				gate,
			);
		}

		const pending = storage.usage.reports({ provider: "ext-wait" });
		await resolver.entered;
		child.retire();
		resolver.release();

		expect((await pending)?.map(report => report.metadata?.source)).toEqual(["parent"]);
		expect(calls.some(call => call.startsWith("child."))).toBe(false);
		expect(calls).toContain("parent.fetch:stored-secret");
	});

	it("uses the key configuration of the registration in force after the key resolves", async () => {
		const resolver = heldResolver("child-ref", { "child-ref": "child-secret", "parent-ref": "parent-secret" });
		const storage = await makeStorage([], { configValueResolver: config => resolver.resolve(config) });
		const parent = makeGate();
		const child = makeGate();
		const keys: string[] = [];
		for (const [label, apiKey, gate] of [
			["parent", "parent-ref", parent.gate],
			["child", "child-ref", child.gate],
		] as const) {
			storage.usage.setProvider(
				"ext-keyed",
				{
					id: "ext-keyed",
					fetchUsage: async params => {
						keys.push(`${label}:${params.credential.apiKey}`);
						return usageReport("ext-keyed", "account-1", label);
					},
				},
				apiKey,
				gate,
			);
		}

		const pending = storage.usage.reports({ provider: "ext-keyed" });
		await resolver.entered;
		child.retire();
		resolver.release();

		expect((await pending)?.map(report => report.metadata?.source)).toEqual(["parent"]);
		expect(keys).toEqual(["parent:parent-secret"]);
	});
});

describe("a departing usage registration's failure", () => {
	/** Parent and child registered under one provider; the child's fetch waits for `finish`, then
	 *  ends as `outcome` decides. The parent reports, or fails once `failParent` is called. */
	async function departing(outcome: () => Promise<UsageReport | null>) {
		const storage = await makeStorage([oauthRow(1, "ext-depart")]);
		const parent = makeGate();
		const child = makeGate();
		const calls: string[] = [];
		const previous: unknown[] = [];
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let parentFails = false;
		storage.usage.setProvider(
			"ext-depart",
			{
				id: "ext-depart",
				fetchUsage: async (_params: UsageFetchParams, context: UsageFetchContext) => {
					calls.push("parent");
					previous.push(context.previousReport?.metadata?.source);
					return parentFails ? null : usageReport("ext-depart", "account-1", "parent");
				},
				parseRateLimitHeaders: () => usageReport("ext-depart", "account-1", "parent-headers"),
			},
			undefined,
			parent.gate,
		);
		storage.usage.setProvider(
			"ext-depart",
			{
				id: "ext-depart",
				fetchUsage: async () => {
					calls.push("child");
					entered.resolve();
					await finish.promise;
					return outcome();
				},
			},
			undefined,
			child.gate,
		);
		return {
			storage,
			child,
			calls,
			previous,
			entered: entered.promise,
			finish: () => finish.resolve(),
			failParent: () => {
				parentFails = true;
			},
		};
	}

	for (const action of ["retire", "withdraw"] as const) {
		it(`does not cool down the live successor (${action})`, async () => {
			const { storage, child, calls, entered, finish } = await departing(async () => null);
			const pending = storage.usage.reports({ provider: "ext-depart" });
			await entered;
			if (action === "withdraw") storage.usage.removeRegistration("ext-depart", child.gate);
			child.retire();
			finish();

			expect((await pending)?.map(report => report.metadata?.source)).toEqual(["parent"]);
			const next = await storage.usage.reports({ provider: "ext-depart" });
			expect(next?.map(report => report.metadata?.source)).toEqual(["parent"]);
			expect(calls).toEqual(["child", "parent"]);
		});
	}

	it("still cools down a provider that fails while it is the one in force", async () => {
		const { storage, calls, entered, finish } = await departing(async () => null);
		const pending = storage.usage.reports({ provider: "ext-depart" });
		await entered;
		finish();

		expect(await pending).toEqual([]);
		expect(await storage.usage.reports({ provider: "ext-depart" })).toEqual([]);
		expect(calls).toEqual(["child"]);
	});

	it("does not purge the successor's report when it ends in an auth failure", async () => {
		const { storage, child, calls, previous, entered, finish, failParent } = await departing(async () => {
			throw new ProviderHttpError("revoked", 401);
		});
		const pending = storage.usage.reports({ provider: "ext-depart" });
		await entered;
		child.retire();
		// The parent answers again and records header state under the shared report key.
		expect(storage.usage.ingestHeaders("ext-depart", { "x-limit": "1" })).toBe(true);
		failParent();
		finish();
		await pending;

		expect(calls).toEqual(["child", "parent"]);
		expect(previous).toEqual(["parent-headers"]);
	});

	it("cools down the successor that failed under its own cache version, not its predecessor's", async () => {
		const refreshing = Promise.withResolvers<void>();
		const refreshed = Promise.withResolvers<void>();
		const row = oauthRow(1, "ext-version");
		// Inside the refresh skew, so the probe awaits a token refresh before it selects.
		if (row.credential.type === "oauth") row.credential.expires = Date.now() + 10_000;
		const storage = await makeStorage([row], {
			refreshOAuthCredential: async () => {
				refreshing.resolve();
				await refreshed.promise;
				return { access: "oat-refreshed", refresh: "refresh-1", expires: Date.now() + 3_600_000 };
			},
		});
		const parent = makeGate();
		const child = makeGate();
		const calls: string[] = [];
		for (const [label, cacheVersion, gate] of [
			["parent", 2, parent.gate],
			["child", 1, child.gate],
		] as const) {
			storage.usage.setProvider(
				"ext-version",
				{
					id: "ext-version",
					cacheVersion,
					fetchUsage: async () => {
						calls.push(label);
						return null;
					},
				},
				undefined,
				gate,
			);
		}

		const pending = storage.usage.reports({ provider: "ext-version" });
		await refreshing.promise;
		child.retire();
		refreshed.resolve();

		expect(await pending).toEqual([]);
		// The parent's failure cooled down the parent's own key, so its successor probe waits it out.
		expect(calls).toEqual(["parent"]);
	});
});

describe("an authored property is read once per use", () => {
	it("health invokes a stateful supports getter's first answer on the provider", async () => {
		const storage = await makeStorage([oauthRow(1, "ext-stateful")]);
		let reads = 0;
		let fetches = 0;
		const receivers: unknown[] = [];
		const provider = {
			id: "ext-stateful",
			get supports() {
				reads++;
				return reads === 1
					? function (this: unknown) {
							receivers.push(this);
							return true;
						}
					: undefined;
			},
			fetchUsage: async () => {
				fetches++;
				return usageReport("ext-stateful", "account-1", "health");
			},
		} as UsageProvider;
		storage.usage.setProvider("ext-stateful", provider, undefined, makeGate().gate);

		const [result] = await storage.health.check();
		expect(result).toMatchObject({ provider: "ext-stateful", ok: true });
		expect({ reads, fetches }).toEqual({ reads: 1, fetches: 1 });
		expect(receivers).toEqual([provider]);
	});

	it("usage collection invokes the supports value it read, on the provider", async () => {
		const storage = await makeStorage([oauthRow(1, "ext-stateful")]);
		let reads = 0;
		const receivers: unknown[] = [];
		// Callable on odd reads only: a second read inside one support check finds nothing to call.
		const provider = {
			id: "ext-stateful",
			get supports() {
				reads++;
				return reads % 2 === 1
					? function (this: unknown) {
							receivers.push(this);
							return true;
						}
					: undefined;
			},
			fetchUsage: async () => usageReport("ext-stateful", "account-1", "collected"),
		} as UsageProvider;
		storage.usage.setProvider("ext-stateful", provider, undefined, makeGate().gate);

		expect((await storage.usage.reports())?.map(report => report.metadata?.source)).toEqual(["collected"]);
		expect(receivers.length).toBeGreaterThan(0);
		expect(receivers.every(receiver => receiver === provider)).toBe(true);
	});

	it("header ingest invokes the parser it read, once, on the provider", async () => {
		const storage = await makeStorage([oauthRow(1, "ext-stateful")]);
		let reads = 0;
		const receivers: unknown[] = [];
		const provider = {
			id: "ext-stateful",
			fetchUsage: async () => null,
			get parseRateLimitHeaders() {
				reads++;
				return reads === 1
					? function (this: unknown) {
							receivers.push(this);
							return usageReport("ext-stateful", "account-1", "headers");
						}
					: undefined;
			},
		} as UsageProvider;
		storage.usage.setProvider("ext-stateful", provider, undefined, makeGate().gate);

		expect(storage.usage.ingestHeaders("ext-stateful", { "x-limit": "1" })).toBe(true);
		expect(reads).toBe(1);
		expect(receivers).toEqual([provider]);
	});
});
