import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { StateBrokerClient } from "@oh-my-pi/pi-coding-agent/state-broker/client";
import type { ReplicatedDomain } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { StateSyncStore } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { createStateBrokerRoutes } from "@oh-my-pi/pi-coding-agent/state-broker/server";
import { StateBrokerStore } from "@oh-my-pi/pi-coding-agent/state-broker/store";
import { StateSyncEngine } from "@oh-my-pi/pi-coding-agent/state-broker/sync";
import type { StateDomainId, StateEntry } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { STATE_PAGE_LIMIT } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TOKEN = "t";

/**
 * A fully controllable {@link ReplicatedDomain} backed by a plain Map. It reads
 * and writes the same `#rows` map so an entry pulled via `applyRemote` becomes a
 * local row `changedSince` can see — the exact shape needed to exercise
 * echo suppression.
 */
class FakeDomain implements ReplicatedDomain {
	readonly id: StateDomainId;
	#rows = new Map<string, StateEntry>();
	/** afterRev arguments handed to changedSince, in call order. */
	readonly changedSinceCalls: number[] = [];
	/** Batches handed to applyRemote, in call order. */
	readonly applied: StateEntry[][] = [];
	drainCalls = 0;
	/** Optional hook run inside drain() (e.g. to flush a queued row). */
	onDrain?: () => void;

	constructor(id: StateDomainId) {
		this.id = id;
	}

	setLocal(entry: StateEntry): void {
		this.#rows.set(entry.key, entry);
	}

	get(key: string): StateEntry | undefined {
		return this.#rows.get(key);
	}

	changedSince(afterRev: number, limit: number): StateEntry[] {
		this.changedSinceCalls.push(afterRev);
		return [...this.#rows.values()]
			.filter(e => e.rev > afterRev)
			.sort((a, b) => a.rev - b.rev)
			.slice(0, limit);
	}

	applyRemote(entries: readonly StateEntry[]): void {
		this.applied.push([...entries]);
		for (const entry of entries) {
			const existing = this.#rows.get(entry.key);
			// LWW merge, mirroring the real domains.
			if (existing == null || entry.rev > existing.rev) this.#rows.set(entry.key, entry);
		}
	}

	async drain(): Promise<void> {
		this.drainCalls += 1;
		this.onDrain?.();
	}
}

/** A domain whose changedSince always throws, to test failure isolation. */
class ThrowingDomain implements ReplicatedDomain {
	readonly id: StateDomainId;
	constructor(id: StateDomainId) {
		this.id = id;
	}
	changedSince(): StateEntry[] {
		throw new Error("boom");
	}
	applyRemote(): void {}
}

describe("StateSyncEngine", () => {
	let tempDir = "";
	let authStore: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let brokerStore: StateBrokerStore | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let client: StateBrokerClient;
	const syncStores: StateSyncStore[] = [];
	let storeCounter = 0;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-broker-sync-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		authStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(authStore);
		await storage.reload();
		brokerStore = StateBrokerStore.open(path.join(tempDir, "state.db"));
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
			routes: [createStateBrokerRoutes(brokerStore)],
		});
		client = new StateBrokerClient({ url: handle.url, token: TOKEN, maxRetries: 0 });
	});

	afterEach(async () => {
		for (const s of syncStores) s.close();
		syncStores.length = 0;
		await handle?.close();
		brokerStore?.close();
		storage?.close();
		authStore?.close();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		await removeWithRetries(tempDir);
	});

	/** A fresh sync-cursor store on its own temp file (= one machine's replica). */
	function newSyncStore(): StateSyncStore {
		storeCounter += 1;
		const s = new StateSyncStore(path.join(tempDir, `state-sync-${storeCounter}.db`));
		syncStores.push(s);
		return s;
	}

	/**
	 * A FRESH engine per cycle: `#idle` starts false, so `syncOnce` never enters
	 * the 30s long-poll path (that only triggers after a cycle observed no
	 * change). Reusing a StateSyncStore keeps cursors across the "cycles".
	 */
	function engineFor(
		store: StateSyncStore,
		domains: ReplicatedDomain[],
		c: StateBrokerClient = client,
	): StateSyncEngine {
		return new StateSyncEngine({ client: c, domains, store });
	}

	test("push/pull round trip between two engines sharing one broker", async () => {
		const storeA = newSyncStore();
		const storeB = newSyncStore();
		const domainA = new FakeDomain("history");
		const domainB = new FakeDomain("history");
		domainA.setLocal({ key: "k1", rev: 10, value: "one" });
		domainA.setLocal({ key: "k2", rev: 11, value: null });

		// A pushes its local rows up.
		await engineFor(storeA, [domainA]).syncOnce();
		expect(brokerStore!.currentSeq("history")).toBe(2);

		// B pulls them down.
		await engineFor(storeB, [domainB]).syncOnce();
		expect(domainB.applied).toHaveLength(1);
		expect(domainB.get("k1")).toEqual({ key: "k1", rev: 10, value: "one" });
		// Tombstone round-trips through the whole path.
		expect(domainB.get("k2")).toEqual({ key: "k2", rev: 11, value: null });
	});

	test("echo suppression: B does not re-push what it applied from A", async () => {
		const storeA = newSyncStore();
		const storeB = newSyncStore();
		const domainA = new FakeDomain("history");
		const domainB = new FakeDomain("history");
		domainA.setLocal({ key: "k1", rev: 10, value: "one" });

		await engineFor(storeA, [domainA]).syncOnce();
		await engineFor(storeB, [domainB]).syncOnce();
		expect(domainB.get("k1")).toBeDefined();

		const seqBefore = brokerStore!.currentSeq("history");
		domainB.applied.length = 0;

		// Second B cycle: the applied row is now local, but outboundRev was
		// advanced past its rev, so changedSince excludes it and nothing is
		// pushed back.
		await engineFor(storeB, [domainB]).syncOnce();
		expect(brokerStore!.currentSeq("history")).toBe(seqBefore);
	});

	test("convergence stability: further idle cycles change no broker seq", async () => {
		const storeA = newSyncStore();
		const storeB = newSyncStore();
		const domainA = new FakeDomain("history");
		const domainB = new FakeDomain("history");
		domainA.setLocal({ key: "k1", rev: 10, value: "one" });

		await engineFor(storeA, [domainA]).syncOnce();
		await engineFor(storeB, [domainB]).syncOnce();
		const converged = brokerStore!.currentSeq("history");

		for (let i = 0; i < 3; i += 1) {
			await engineFor(storeA, [domainA]).syncOnce();
			await engineFor(storeB, [domainB]).syncOnce();
			expect(brokerStore!.currentSeq("history")).toBe(converged);
		}
	});

	test("paging: a backlog over STATE_PAGE_LIMIT drains with a monotonic watermark", async () => {
		const storeA = newSyncStore();
		const domainA = new FakeDomain("history");
		const total = STATE_PAGE_LIMIT + 5;
		for (let i = 1; i <= total; i += 1) domainA.setLocal({ key: `k${i}`, rev: i, value: i });

		await engineFor(storeA, [domainA]).syncOnce();

		// Every row reached the broker across multiple pages.
		expect(brokerStore!.currentSeq("history")).toBe(total);
		// changedSince was called more than once (paged) with a strictly
		// increasing afterRev watermark.
		expect(domainA.changedSinceCalls.length).toBeGreaterThan(1);
		for (let i = 1; i < domainA.changedSinceCalls.length; i += 1) {
			expect(domainA.changedSinceCalls[i]!).toBeGreaterThan(domainA.changedSinceCalls[i - 1]!);
		}
		expect(storeA.get("history").outboundRev).toBe(total);

		// A fresh puller drains the whole backlog too, advancing inboundSeq to
		// the broker head.
		const storeB = newSyncStore();
		const domainB = new FakeDomain("history");
		await engineFor(storeB, [domainB]).syncOnce();
		const appliedCount = domainB.applied.reduce((n, batch) => n + batch.length, 0);
		expect(appliedCount).toBe(total);
		expect(storeB.get("history").inboundSeq).toBe(total);
	});

	/**
	 * A group of rows sharing one `rev` can straddle a page boundary. Every scan
	 * filters `rev > outboundRev` STRICTLY, so advancing the cursor onto that
	 * shared rev permanently skips whatever part of the group did not fit.
	 *
	 * Not exotic: four domains derive their rev from a whole-second column, and
	 * a bulk copy or archive extraction stamps many config files with one mtime.
	 */
	test("a rev tie straddling the page boundary is not skipped", async () => {
		const storeA = newSyncStore();
		const domainA = new FakeDomain("history");
		const total = STATE_PAGE_LIMIT + 5;
		// Distinct revs except the pair at the page boundary: row 1000 (the last
		// of page one) and row 1001 (the first of page two) share rev 1000.
		for (let i = 1; i <= total; i += 1) {
			domainA.setLocal({ key: `k${i}`, rev: i === STATE_PAGE_LIMIT + 1 ? STATE_PAGE_LIMIT : i, value: i });
		}

		await engineFor(storeA, [domainA]).syncOnce();

		// The tied row must not be lost, so every key reaches the broker.
		expect(brokerStore!.currentSeq("history")).toBe(total);
		const storeB = newSyncStore();
		const domainB = new FakeDomain("history");
		await engineFor(storeB, [domainB]).syncOnce();
		const keys = new Set(domainB.applied.flat().map(entry => entry.key));
		expect(keys.size).toBe(total);
		expect(keys.has(`k${STATE_PAGE_LIMIT + 1}`)).toBe(true);
	});

	/**
	 * The degenerate shape: a saturated page entirely at one rev. A rev-only
	 * cursor cannot page within a single rev, so the engine must push what it
	 * has and STALL rather than advance and drop the remainder. Asserting
	 * termination matters as much as the rows: the guard that prevents the skip
	 * must not turn into a spin.
	 */
	test("a full page sharing one rev is pushed without advancing the cursor", async () => {
		const storeA = newSyncStore();
		const domainA = new FakeDomain("history");
		for (let i = 1; i <= STATE_PAGE_LIMIT + 5; i += 1) {
			domainA.setLocal({ key: `k${i}`, rev: 7, value: i });
		}

		await engineFor(storeA, [domainA]).syncOnce();

		// A page's worth was delivered, and the cursor stayed put so nothing was
		// silently skipped past.
		expect(brokerStore!.currentSeq("history")).toBe(STATE_PAGE_LIMIT);
		expect(storeA.get("history").outboundRev).toBe(0);
	});

	test("failure isolation: a throwing domain does not stop a sibling from syncing", async () => {
		const store = newSyncStore();
		const good = new FakeDomain("history");
		const bad = new ThrowingDomain("titles");
		good.setLocal({ key: "k1", rev: 10, value: "one" });

		// Must not throw despite `bad.changedSince` throwing.
		await engineFor(store, [bad, good]).syncOnce();

		// The healthy sibling still synced.
		expect(brokerStore!.currentSeq("history")).toBe(1);
		expect(brokerStore!.currentSeq("titles")).toBe(0);
		expect(store.get("history").outboundRev).toBe(10);
	});

	test("dead broker: syncOnce resolves without throwing and leaves cursors unchanged", async () => {
		const store = newSyncStore();
		const domain = new FakeDomain("history");
		domain.setLocal({ key: "k1", rev: 10, value: "one" });
		// Port 1 refuses connections immediately; no retries, short timeout.
		const deadClient = new StateBrokerClient({
			url: "http://127.0.0.1:1",
			token: TOKEN,
			maxRetries: 0,
			timeoutMs: 250,
		});

		await engineFor(store, [domain], deadClient).syncOnce();

		// Push failed -> cursor never advanced.
		expect(store.get("history")).toEqual({ inboundSeq: 0, outboundRev: 0 });
	});

	test("drain() flushes deferred writes then performs a final push", async () => {
		const store = newSyncStore();
		const domain = new FakeDomain("history");
		// drain() must run BEFORE the final push, so a row it flushes still ships.
		domain.onDrain = () => domain.setLocal({ key: "queued", rev: 99, value: "late" });

		const engine = engineFor(store, [domain]);
		await engine.drain();

		expect(domain.drainCalls).toBe(1);
		// The row queued during drain reached the broker via the final push.
		const delta = brokerStore!.delta("history", 0, 10).entries;
		expect(delta).toEqual([{ key: "queued", rev: 99, value: "late" }]);
		expect(store.get("history").outboundRev).toBe(99);
	});
});
