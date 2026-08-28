/**
 * Regressions for the convergence and trust boundaries of shared-state
 * replication. Each case here corresponds to a way a replica could silently
 * lose, leak, or refuse to converge on data.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { StateBrokerClient } from "@oh-my-pi/pi-coding-agent/state-broker/client";
import {
	enumerateConfigFiles,
	isReplicableConfigRel,
	MAX_CONFIG_FILE_BYTES,
	readConfigFile,
} from "@oh-my-pi/pi-coding-agent/state-broker/config-files";
import { createConfigDomain } from "@oh-my-pi/pi-coding-agent/state-broker/domains/config";
import type { ReplicatedDomain } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { StateSyncStore } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { createStateBrokerRoutes } from "@oh-my-pi/pi-coding-agent/state-broker/server";
import { StateBrokerStore } from "@oh-my-pi/pi-coding-agent/state-broker/store";
import { StateSyncEngine } from "@oh-my-pi/pi-coding-agent/state-broker/sync";
import type { StateDomainId, StateEntry } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TOKEN = "t";

/** A controllable domain whose local rows are the same rows `applyRemote` writes. */
class FakeDomain implements ReplicatedDomain {
	readonly id: StateDomainId;
	#rows = new Map<string, StateEntry>();

	constructor(id: StateDomainId) {
		this.id = id;
	}

	setLocal(entry: StateEntry): void {
		this.#rows.set(entry.key, entry);
	}

	changedSince(afterRev: number, limit: number): StateEntry[] {
		return [...this.#rows.values()]
			.filter(e => e.rev > afterRev)
			.sort((a, b) => a.rev - b.rev)
			.slice(0, limit);
	}

	applyRemote(entries: readonly StateEntry[]): void {
		for (const entry of entries) {
			const existing = this.#rows.get(entry.key);
			if (existing == null || entry.rev > existing.rev) this.#rows.set(entry.key, entry);
		}
	}
}

describe("replication safety", () => {
	let tempDir = "";
	let authStore: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let brokerStore: StateBrokerStore | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let client: StateBrokerClient;
	const syncStores: StateSyncStore[] = [];
	let storeCounter = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-repl-safety-"));
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
		await removeWithRetries(tempDir);
	});

	function newSyncStore(): StateSyncStore {
		storeCounter += 1;
		const s = new StateSyncStore(path.join(tempDir, `state-sync-${storeCounter}.db`));
		syncStores.push(s);
		return s;
	}

	function engineFor(store: StateSyncStore, domains: ReplicatedDomain[]): StateSyncEngine {
		return new StateSyncEngine({ client, domains, store });
	}

	/**
	 * The clock-skew data-loss regression. A peer whose clock runs ahead
	 * publishes a rev far in the future; merging it must NOT advance this
	 * replica's outbound watermark, or every subsequent local write with a
	 * smaller rev is silently never pushed.
	 */
	test("a local write below a merged remote rev still reaches the broker", async () => {
		// A peer pushes an entry dated well into the future.
		const futureRev = Date.now() + 60 * 60 * 1000;
		const peerStore = newSyncStore();
		const peer = new FakeDomain("history");
		peer.setLocal({ key: "from-peer", rev: futureRev, value: { prompt: "peer" } });
		await engineFor(peerStore, [peer]).syncOnce();

		// We pull it, then make our own write stamped with our (correct) clock,
		// which is far BELOW the peer's rev.
		const localStore = newSyncStore();
		const local = new FakeDomain("history");
		await engineFor(localStore, [local]).syncOnce();
		const localRev = Date.now();
		expect(localRev).toBeLessThan(futureRev);
		local.setLocal({ key: "mine", rev: localRev, value: { prompt: "mine" } });
		await engineFor(localStore, [local]).syncOnce();

		// A third replica must be able to see our write.
		const observerStore = newSyncStore();
		const observer = new FakeDomain("history");
		await engineFor(observerStore, [observer]).syncOnce();
		const seen = observer.changedSince(0, 100).map(e => e.key);
		expect(seen).toContain("mine");
	});

	/**
	 * Echo suppression must not be mistaken for the watermark's job: after
	 * merging remote rows, the cursor stays below them so later local writes are
	 * still discovered, and the merged rows are not pushed back endlessly.
	 */
	test("merging a remote entry leaves the outbound cursor untouched", async () => {
		const futureRev = Date.now() + 60 * 60 * 1000;
		const peerStore = newSyncStore();
		const peer = new FakeDomain("titles");
		peer.setLocal({ key: "s1", rev: futureRev, value: { sessionId: "s1", title: "t", updatedAt: 1 } });
		await engineFor(peerStore, [peer]).syncOnce();

		const localStore = newSyncStore();
		const local = new FakeDomain("titles");
		await engineFor(localStore, [local]).syncOnce();

		expect(localStore.get("titles").outboundRev).toBeLessThan(futureRev);
	});

	/**
	 * A peer chooses the config key, so the outbound policy has to be enforced
	 * on the way in. Without this a peer can write or delete `.env`,
	 * `auth-broker.token`, `projects.yml` or a live `agent.db` — all of which sit
	 * inside the agent dir and so pass the traversal guard.
	 */
	test.each([
		[".env", "SECRET=1"],
		["auth-broker.token", "bearer"],
		["projects.yml", "version: 1"],
		["agent.db", "sqlite"],
		["secrets.yml", "k: v"],
	])("config merge refuses to write %s", async (rel, content) => {
		const agentDir = path.join(tempDir, "agent-inbound");
		await fs.mkdir(agentDir, { recursive: true });
		const domain = createConfigDomain(agentDir);

		domain.applyRemote([{ key: rel, rev: Date.now(), value: { rel, content, mtimeMs: Date.now() } }]);

		expect(isReplicableConfigRel(rel)).toBe(false);
		expect(await fs.exists(path.join(agentDir, rel))).toBe(false);
	});

	/** The same gate must cover deletion, or a peer can unlink protected files. */
	test("config merge refuses to delete a protected file", async () => {
		const agentDir = path.join(tempDir, "agent-del");
		await fs.mkdir(agentDir, { recursive: true });
		const victim = path.join(agentDir, "auth-broker.token");
		await Bun.write(victim, "bearer-token");
		const domain = createConfigDomain(agentDir);

		domain.applyRemote([{ key: "auth-broker.token", rev: Date.now() + 1000, value: null }]);

		expect(await Bun.file(victim).text()).toBe("bearer-token");
	});

	/**
	 * The outbound scan skips files over the cap, but inbound `content` is an
	 * unbounded string from a peer the trust model treats as authenticated rather
	 * than trusted, and it is written straight to disk. Worse than the write
	 * itself: an oversized file is then invisible to every later outbound scan,
	 * so replication can never correct or retract what it just wrote.
	 */
	test("config merge refuses an oversized remote value", async () => {
		const agentDir = path.join(tempDir, "agent-huge");
		await fs.mkdir(agentDir, { recursive: true });
		const domain = createConfigDomain(agentDir);
		const rev = Date.now();
		const oversized = "x".repeat(MAX_CONFIG_FILE_BYTES + 1);

		domain.applyRemote([{ key: "config.yml", rev, value: { rel: "config.yml", content: oversized, mtimeMs: rev } }]);
		expect(await fs.exists(path.join(agentDir, "config.yml"))).toBe(false);

		// The cap counts BYTES, not code units: a multi-byte payload that fits in
		// fewer characters than the cap must still be refused.
		const multibyte = "é".repeat(MAX_CONFIG_FILE_BYTES - 1);
		expect(multibyte.length).toBeLessThan(MAX_CONFIG_FILE_BYTES);
		domain.applyRemote([{ key: "mcp.json", rev, value: { rel: "mcp.json", content: multibyte, mtimeMs: rev } }]);
		expect(await fs.exists(path.join(agentDir, "mcp.json"))).toBe(false);

		// A value AT the cap still lands, so the guard is a bound and not a ban.
		const atCap = "y".repeat(MAX_CONFIG_FILE_BYTES);
		domain.applyRemote([{ key: "config.yml", rev, value: { rel: "config.yml", content: atCap, mtimeMs: rev } }]);
		expect((await Bun.file(path.join(agentDir, "config.yml")).text()).length).toBe(MAX_CONFIG_FILE_BYTES);
	});

	/** A replicable file still merges, so the gate is not simply refusing everything. */
	test("config merge accepts a replicable file", async () => {
		const agentDir = path.join(tempDir, "agent-ok");
		await fs.mkdir(agentDir, { recursive: true });
		const domain = createConfigDomain(agentDir);
		const rev = Date.now();

		domain.applyRemote([
			{ key: "config.yml", rev, value: { rel: "config.yml", content: "theme:\n  dark: x\n", mtimeMs: rev } },
			{
				key: "agents/reviewer.md",
				rev,
				value: { rel: "agents/reviewer.md", content: "# reviewer\n", mtimeMs: rev },
			},
		]);

		expect(readConfigFile(agentDir, "config.yml")).toBe("theme:\n  dark: x\n");
		expect(readConfigFile(agentDir, path.join("agents", "reviewer.md"))).toBe("# reviewer\n");
	});

	/**
	 * A live file enumeration can only report what exists, so without remembered
	 * publications a deletion is invisible and peers keep the stale copy forever.
	 */
	test("deleting a published config file emits a tombstone", async () => {
		const agentDir = path.join(tempDir, "agent-tomb");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "models.yml");
		await Bun.write(target, "models: []\n");
		const store = newSyncStore();
		const domain = createConfigDomain(agentDir, store);

		// Publish it first, so the domain remembers the key.
		const published = domain.changedSince(0, 100);
		expect(published.map(e => e.key)).toContain("models.yml");
		expect(enumerateConfigFiles(agentDir).map(f => f.rel)).toContain("models.yml");

		// Now delete it and rescan from the same watermark the engine would hold.
		const watermark = published[published.length - 1].rev;
		await fs.rm(target);
		const afterDelete = domain.changedSince(watermark, 100);

		const tombstone = afterDelete.find(e => e.key === "models.yml");
		expect(tombstone).toBeDefined();
		expect(tombstone?.value).toBeNull();
		expect(tombstone?.rev).toBeGreaterThan(watermark);
	});

	/**
	 * The tombstone must survive a failed push. It is re-offered until the
	 * watermark proves delivery, rather than being dropped after one attempt.
	 */
	test("a tombstone is re-offered until the watermark passes it", async () => {
		const agentDir = path.join(tempDir, "agent-retry");
		await fs.mkdir(agentDir, { recursive: true });
		const target = path.join(agentDir, "keybindings.yml");
		await Bun.write(target, "bindings: {}\n");
		const store = newSyncStore();
		const domain = createConfigDomain(agentDir, store);

		const published = domain.changedSince(0, 100);
		const watermark = published[published.length - 1].rev;
		await fs.rm(target);

		const first = domain.changedSince(watermark, 100).find(e => e.key === "keybindings.yml");
		expect(first?.value).toBeNull();
		// Simulating a failed push: the watermark did not move, so the same
		// tombstone must come back at the same rev.
		const second = domain.changedSince(watermark, 100).find(e => e.key === "keybindings.yml");
		expect(second?.value).toBeNull();
		expect(second?.rev).toBe(first?.rev);

		// Once the watermark passes it, the domain stops re-offering it.
		const third = domain.changedSince(first?.rev ?? 0, 100).find(e => e.key === "keybindings.yml");
		expect(third).toBeUndefined();
	});

	/** A tombstone the broker accepted must actually propagate and delete. */
	test("a config deletion propagates to another replica", async () => {
		const senderDir = path.join(tempDir, "agent-a");
		const receiverDir = path.join(tempDir, "agent-b");
		await fs.mkdir(senderDir, { recursive: true });
		await fs.mkdir(receiverDir, { recursive: true });
		const target = path.join(senderDir, "mcp.json");
		await Bun.write(target, '{"servers":{}}');

		const senderStore = newSyncStore();
		const sender = createConfigDomain(senderDir, senderStore);
		await engineFor(senderStore, [sender]).syncOnce();

		const receiverStore = newSyncStore();
		const receiver = createConfigDomain(receiverDir, receiverStore);
		await engineFor(receiverStore, [receiver]).syncOnce();
		expect(readConfigFile(receiverDir, "mcp.json")).toBe('{"servers":{}}');

		await fs.rm(target);
		await engineFor(senderStore, [sender]).syncOnce();
		await engineFor(receiverStore, [receiver]).syncOnce();

		expect(readConfigFile(receiverDir, "mcp.json")).toBeNull();
	});
});
