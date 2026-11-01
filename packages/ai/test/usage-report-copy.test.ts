/**
 * A usage report a session's provider returns is that author's data: the host copies it by the
 * report's schema inside the admitted call, and reads only the copy afterwards. Contract under
 * test, at each site that receives one — `fetchUsage` through the usage service and the credential
 * health check, and `parseRateLimitHeaders` through header ingest:
 *
 *   1. Every read of the returned report runs as its session's work, and nothing reads the
 *      original once the copy is taken.
 *   2. The host never writes into the author's report: what it adds goes on the copy.
 *   3. The fields a report has survive, inherited or not; nothing else on the object is read.
 *   4. A function where data belongs is refused, with the field it was found at.
 *   5. A host registration's report is kept as it is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const PROVIDER = "usage-report-copy";
const sessionScope = new AsyncLocalStorage<object>();

interface SessionGate extends ProviderCallGate {
	readonly inside: boolean;
}

function sessionGate(): SessionGate {
	const session = {};
	return {
		retired: false,
		run<R>(call: () => R): R {
			return sessionScope.run(session, call);
		},
		get inside() {
			return sessionScope.getStore() === session;
		},
	};
}

function memoryStore(rows: StoredAuthCredential[]): AuthCredentialStore {
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
		getCache() {
			return null;
		},
		setCache() {},
		cleanExpiredCache() {},
	};
}

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
});

/** A storage with one OAuth row whose organization the host attaches to the report it serves. */
async function makeStorage(): Promise<AuthStorage> {
	const credential: AuthCredential = {
		type: "oauth",
		access: "oat",
		refresh: "refresh",
		expires: Date.now() + 3_600_000,
		accountId: "account",
		orgId: "org",
	};
	const storage = new AuthStorage(memoryStore([{ id: 1, provider: PROVIDER, credential, disabledCause: null }]), {
		usageProviderResolver: () => undefined,
	});
	storages.push(storage);
	await storage.credentials.reload();
	return storage;
}

function limit(): UsageLimit {
	return {
		id: "window",
		label: "Window",
		scope: { provider: PROVIDER },
		amount: { used: 1, limit: 10, unit: "requests" },
	};
}

/** Every access the host makes to an author's report, and where it ran. */
interface Watched {
	report: UsageReport;
	/** The author's own metadata object, which the host must leave as it was. */
	metadata: Record<string, unknown>;
	reads: Array<{ field: string; inside: boolean }>;
	writes: string[];
}

/** A report whose `metadata` and its limit's `label` are accessors that record each access. */
function watchedReport(gate: SessionGate): Watched {
	const metadata: Record<string, unknown> = { accountId: "account" };
	const reads: Watched["reads"] = [];
	const writes: string[] = [];
	const watchedLimit = limit();
	let label = watchedLimit.label;
	Object.defineProperty(watchedLimit, "label", {
		enumerable: true,
		get() {
			reads.push({ field: "limits[0].label", inside: gate.inside });
			return label;
		},
		set(value: string) {
			writes.push("limits[0].label");
			label = value;
		},
	});
	const report = { provider: PROVIDER, fetchedAt: 1, limits: [watchedLimit] } as UsageReport;
	Object.defineProperty(report, "metadata", {
		enumerable: true,
		get() {
			reads.push({ field: "metadata", inside: gate.inside });
			return metadata;
		},
		set() {
			writes.push("metadata");
		},
	});
	return { report, metadata, reads, writes };
}

function answering(report: () => UsageReport | null, parse?: () => UsageReport | null): UsageProvider {
	return {
		id: PROVIDER,
		supports: () => true,
		validatesCredentials: true,
		async fetchUsage() {
			return report();
		},
		...(parse ? { parseRateLimitHeaders: parse } : {}),
	};
}

describe("a report a session's provider returns is copied inside its admission", () => {
	test("usage.reports: every read runs as the session's work, the original is never written, and the copy is served", async () => {
		const gate = sessionGate();
		const storage = await makeStorage();
		const watched = watchedReport(gate);
		const getter = Object.getOwnPropertyDescriptor(watched.report, "metadata")!.get;
		let fetches = 0;
		storage.usage.setProvider(
			PROVIDER,
			// The watched report once; a fresh one on every later fetch.
			answering(() => (fetches++ === 0 ? watched.report : base())),
			undefined,
			gate,
		);

		const served = await storage.usage.reports({ provider: PROVIDER });
		const readsAfterCopy = watched.reads.length;
		const again = await storage.usage.reports({ provider: PROVIDER });

		expect(watched.reads.length).toBeGreaterThan(0);
		expect(watched.reads.filter(read => !read.inside)).toEqual([]);
		expect(watched.writes).toEqual([]);
		// The author's report is observably as it was handed over.
		expect(Object.getOwnPropertyDescriptor(watched.report, "metadata")!.get).toBe(getter);
		expect(watched.metadata).toEqual({ accountId: "account" });
		// What the host adds went on the copy it serves.
		expect(served).toHaveLength(1);
		expect(served![0]).not.toBe(watched.report);
		expect(served![0]!.metadata).toMatchObject({ accountId: "account", orgId: "org" });
		expect(served![0]!.limits[0]!.label).toBe("Window");
		// Nothing kept the author's report to read later: the next pass reads only its own answer.
		expect(again).toHaveLength(1);
		expect(watched.reads.length).toBe(readsAfterCopy);
	});

	test("health.check: every read runs as the session's work and the original is never written", async () => {
		const gate = sessionGate();
		const storage = await makeStorage();
		const watched = watchedReport(gate);
		storage.usage.setProvider(
			PROVIDER,
			answering(() => watched.report),
			undefined,
			gate,
		);

		const [result] = await storage.health.check();

		expect(result).toMatchObject({ provider: PROVIDER, ok: true, accountId: "account" });
		expect(watched.reads.length).toBeGreaterThan(0);
		expect(watched.reads.filter(read => !read.inside)).toEqual([]);
		expect(watched.writes).toEqual([]);
		expect(watched.metadata).toEqual({ accountId: "account" });
		expect(result!.report?.limits[0]?.label).toBe("Window");
	});

	test("ingestHeaders: a parsed report is read as the session's work and never written", async () => {
		const gate = sessionGate();
		const storage = await makeStorage();
		const watched = watchedReport(gate);
		storage.usage.setProvider(
			PROVIDER,
			answering(
				() => null,
				() => watched.report,
			),
			undefined,
			gate,
		);

		expect(storage.usage.ingestHeaders(PROVIDER, { "x-limit": "1" })).toBe(true);

		expect(watched.reads.length).toBeGreaterThan(0);
		expect(watched.reads.filter(read => !read.inside)).toEqual([]);
		expect(watched.writes).toEqual([]);
		expect(watched.metadata).toEqual({ accountId: "account" });
	});

	test("the fields a report has survive, inherited or not, and nothing else on it is read", async () => {
		const gate = sessionGate();
		const storage = await makeStorage();
		const extraReads: boolean[] = [];
		class Report {
			get provider(): string {
				return PROVIDER;
			}
			fetchedAt = 1;
			limits = [limit()];
			get extra(): string {
				extraReads.push(gate.inside);
				return "not a report field";
			}
		}
		const report = new Report();
		Object.defineProperty(report, "notes", { value: ["hidden note"], enumerable: false });
		storage.usage.setProvider(
			PROVIDER,
			answering(() => report as unknown as UsageReport),
			undefined,
			gate,
		);

		const [served] = (await storage.usage.reports({ provider: PROVIDER }))!;

		expect(served).toMatchObject({ provider: PROVIDER, fetchedAt: 1, notes: ["hidden note"] });
		expect(served!.limits[0]).toMatchObject({ id: "window", amount: { used: 1, limit: 10, unit: "requests" } });
		expect(served).not.toHaveProperty("extra");
		expect(extraReads).toEqual([]);
	});

	test.each([
		["metadata.compute", () => ({ ...base(), metadata: { compute: () => 1 } })],
		["limits[0].label", () => ({ ...base(), limits: [{ ...limit(), label: () => "late" }] })],
		["raw.payload[0]", () => ({ ...base(), raw: { payload: [() => "late"] } })],
	] as const)("a function at %s is refused, naming the field", async (field, make) => {
		const gate = sessionGate();
		const storage = await makeStorage();
		storage.usage.setProvider(
			PROVIDER,
			answering(() => make() as unknown as UsageReport),
			undefined,
			gate,
		);

		const [result] = await storage.health.check();
		const served = await storage.usage.reports({ provider: PROVIDER });

		expect(result).toMatchObject({ ok: false });
		expect(result!.reason).toBe(
			`Usage provider ${PROVIDER}: fetchUsage() result.${field} is a function, but it must be data. Compute the value before returning it.`,
		);
		expect(served).toEqual([]);
	});

	test("a host registration's report is kept as it is", async () => {
		const storage = await makeStorage();
		const report: UsageReport = { ...base(), metadata: { accountId: "account" } };
		storage.usage.setProvider(
			PROVIDER,
			answering(() => report),
		);

		const served = await storage.usage.reports({ provider: PROVIDER });

		expect(served).toHaveLength(1);
		expect(served![0]).toBe(report);
	});
});

function base(): UsageReport {
	return { provider: PROVIDER, fetchedAt: 1, limits: [limit()] };
}
