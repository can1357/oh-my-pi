import { afterEach, describe, expect, test } from "bun:test";
import type { PsHost } from "@oh-my-pi/pi-natives";
import {
	acquirePsHost,
	disposeAllPsHosts,
	disposePsHostSession,
	setPsHostSpawnerForTests,
	spawnEphemeralPsHost,
} from "../../src/tools/pshost-manager";

interface FakeHost {
	pid: number;
	alive: boolean;
	disposed: boolean;
	dispose(): Promise<void>;
}

function makeFakeHost(pid: number, opts: { failDispose?: boolean } = {}): FakeHost {
	const fake: FakeHost = {
		pid,
		alive: true,
		disposed: false,
		async dispose() {
			if (opts.failDispose) throw new Error("dispose failed");
			fake.disposed = true;
		},
	};
	return fake;
}

const sleep = (ms: number) => Bun.sleep(ms);
const baseOpts = { cwd: process.cwd(), historyDepth: 5 };

// Pool bookkeeping tests run against fake hosts — no pwsh required, so this
// suite is not gated on shell availability like powershell.test.ts.
describe("pshost-manager pool (fake hosts)", () => {
	afterEach(async () => {
		await disposeAllPsHosts();
		setPsHostSpawnerForTests(null);
	});

	test("concurrent acquires single-flight the spawn", async () => {
		let spawns = 0;
		setPsHostSpawnerForTests(async () => {
			spawns++;
			await sleep(20);
			return makeFakeHost(spawns) as unknown as PsHost;
		});
		const opts = { ...baseOpts, sessionId: "race", idleTtlMs: 0 };
		const [a, b] = await Promise.all([acquirePsHost(opts), acquirePsHost(opts)]);
		expect(spawns).toBe(1);
		expect(a.host).toBe(b.host);
		a.release();
		b.release();
	});

	test("spawn failure rejects the waiters and clears the slot for retry", async () => {
		let calls = 0;
		setPsHostSpawnerForTests(async () => {
			calls++;
			if (calls === 1) throw new Error("spawn boom");
			return makeFakeHost(99) as unknown as PsHost;
		});
		const opts = { ...baseOpts, sessionId: "retry", idleTtlMs: 0 };
		await expect(acquirePsHost(opts)).rejects.toThrow("spawn boom");
		const lease = await acquirePsHost(opts);
		expect(calls).toBe(2);
		lease.release();
	});

	test("idle hosts are evicted on acquire; busy hosts and the acquirer's own are exempt", async () => {
		const hosts: FakeHost[] = [];
		setPsHostSpawnerForTests(async () => {
			const host = makeFakeHost(hosts.length + 1);
			hosts.push(host);
			return host as unknown as PsHost;
		});
		const ttl = { ...baseOpts, idleTtlMs: 10 };

		const idle = await acquirePsHost({ ...ttl, sessionId: "idle" });
		idle.release();
		const busy = await acquirePsHost({ ...ttl, sessionId: "busy" }); // never released
		await sleep(30);

		const own = await acquirePsHost({ ...ttl, sessionId: "own" });
		await sleep(5); // eviction disposal is fire-and-forget
		expect(hosts[0]?.disposed).toBe(true); // idle past TTL -> evicted
		expect(hosts[1]?.disposed).toBe(false); // in-flight run -> protected

		// The acquirer's own idle host is exempt from the sweep it triggers.
		await sleep(30);
		const ownAgain = await acquirePsHost({ ...ttl, sessionId: "own" });
		expect(ownAgain.host).toBe(own.host);
		expect(hosts[2]?.disposed).toBe(false);

		busy.release();
		own.release();
		ownAgain.release();
	});

	test("a dead pooled host is evicted and replaced on acquire", async () => {
		const hosts: FakeHost[] = [];
		setPsHostSpawnerForTests(async () => {
			const host = makeFakeHost(hosts.length + 1);
			hosts.push(host);
			return host as unknown as PsHost;
		});
		const opts = { ...baseOpts, sessionId: "dead", idleTtlMs: 0 };
		const first = await acquirePsHost(opts);
		first.release();

		// Simulate a crash / stop-ack force-kill: the pooled entry goes dead.
		if (hosts[0]) hosts[0].alive = false;
		const second = await acquirePsHost(opts);
		expect(second.host).not.toBe(first.host);
		expect(hosts).toHaveLength(2);
		second.release();
	});

	test("disposePsHostSession removes and disposes only that session's host", async () => {
		const hosts: FakeHost[] = [];
		setPsHostSpawnerForTests(async () => {
			const host = makeFakeHost(hosts.length + 1);
			hosts.push(host);
			return host as unknown as PsHost;
		});
		const a = await acquirePsHost({ ...baseOpts, sessionId: "a", idleTtlMs: 0 });
		const b = await acquirePsHost({ ...baseOpts, sessionId: "b", idleTtlMs: 0 });
		a.release();
		b.release();

		await disposePsHostSession("a");
		expect(hosts[0]?.disposed).toBe(true);
		expect(hosts[1]?.disposed).toBe(false);

		// A fresh acquire for the disposed session spawns a replacement.
		const again = await acquirePsHost({ ...baseOpts, sessionId: "a", idleTtlMs: 0 });
		expect(again.host).not.toBe(a.host);
		again.release();
	});

	test("disposePsHostSession waits for that session's in-flight spawn", async () => {
		const spawnedHosts: FakeHost[] = [];
		setPsHostSpawnerForTests(async () => {
			await sleep(30);
			const host = makeFakeHost(spawnedHosts.length + 1);
			spawnedHosts.push(host);
			return host as unknown as PsHost;
		});

		// Teardown races the session's FIRST call: the host lives only in
		// SPAWNING. Pre-fix, dispose returned without reaping and the spawn
		// resolved into HOSTS as a live sidecar afterwards.
		const acquiring = acquirePsHost({ ...baseOpts, sessionId: "race-dispose", idleTtlMs: 0 });
		await sleep(5); // the caller is now parked inside the spawner
		await disposePsHostSession("race-dispose");

		expect(spawnedHosts).toHaveLength(1);
		expect(spawnedHosts[0]?.disposed).toBe(true);
		// The racing acquire still settles; teardown simply wins.
		await Promise.allSettled([acquiring]);
	});

	test("disposeAll reaps pooled and ephemeral hosts, tolerating dispose failures", async () => {
		let spawned = 0;
		const good: FakeHost[] = [];
		setPsHostSpawnerForTests(async () => {
			spawned++;
			// First host's dispose throws; the rest must still be reaped.
			const host = spawned === 1 ? makeFakeHost(spawned, { failDispose: true }) : makeFakeHost(spawned);
			if (spawned > 1) good.push(host);
			return host as unknown as PsHost;
		});

		const failing = await acquirePsHost({ ...baseOpts, sessionId: "failing", idleTtlMs: 0 });
		failing.release();
		const pooled = await acquirePsHost({ ...baseOpts, sessionId: "pooled", idleTtlMs: 0 });
		pooled.release();
		const ephemeral = await spawnEphemeralPsHost(baseOpts);

		await disposeAllPsHosts(); // must not throw despite the failing dispose
		expect(good.every(host => host.disposed)).toBe(true);
		expect((ephemeral.host as unknown as FakeHost).disposed).toBe(true);
	});

	test("disposeAll waits for in-flight spawns and reaps their hosts", async () => {
		const spawnedHosts: FakeHost[] = [];
		setPsHostSpawnerForTests(async () => {
			await sleep(30);
			const host = makeFakeHost(spawnedHosts.length + 1);
			spawnedHosts.push(host);
			return host as unknown as PsHost;
		});

		// Kick off both spawn paths, then dispose-all while they are still
		// inside spawnHost(): pre-fix, the hosts registered *after* the
		// snapshot and survived dispose-all as live sidecars.
		const acquiring = acquirePsHost({ ...baseOpts, sessionId: "inflight", idleTtlMs: 0 });
		const ephemeralSpawning = spawnEphemeralPsHost(baseOpts);
		await sleep(5); // both callers are now parked inside the spawner
		await disposeAllPsHosts();

		expect(spawnedHosts).toHaveLength(2);
		expect(spawnedHosts.every(host => host.disposed)).toBe(true);
		// The racing callers still settle; shutdown simply wins.
		await Promise.allSettled([acquiring, ephemeralSpawning]);
	});

	test("ephemeral dispose is idempotent-safe alongside disposeAll", async () => {
		setPsHostSpawnerForTests(async () => makeFakeHost(1) as unknown as PsHost);
		const ephemeral = await spawnEphemeralPsHost(baseOpts);
		await ephemeral.dispose();
		expect((ephemeral.host as unknown as FakeHost).disposed).toBe(true);
		await disposeAllPsHosts(); // already-disposed ephemeral is no longer tracked
	});
});
