/**
 * Session-keyed pool of persistent PowerShell hosts, plus tracking for
 * ephemeral (single-call, never pooled) hosts.
 *
 * Each agent session gets at most one warm `pwsh` sidecar (one shared runspace),
 * lazily spawned on first use and reused across tool calls so command state
 * persists. The performance-critical path (`PsHost.run`) and call serialization
 * live in the native layer; this manager is pure coordination: lazy spawn,
 * reuse, idle eviction, and graceful disposal.
 *
 * Lifecycle guarantees:
 * - Hosts unused beyond `idleTtlMs` are evicted on the next acquire (no timers).
 *   A host with an in-flight run is never evicted, however long it takes; its
 *   idle clock restarts when the lease is released.
 * - An ephemeral host lives for exactly one run; its `dispose()` resolves only
 *   when the process is fully gone, so file locks and loaded assemblies are
 *   deterministically released before the caller continues.
 * - The native host carries a parent-PID watchdog, so a hard omp crash can never
 *   orphan a sidecar — it self-terminates when this process dies. {@link
 *   disposeAllPsHosts} is the graceful path for an orderly shutdown.
 */

import { PsHost } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

interface HostEntry {
	host: PsHost;
	lastUsed: number;
	/** In-flight run count; a busy host is never idle-evicted. */
	activeRuns: number;
}

const HOSTS = new Map<string, HostEntry>();
/** In-flight spawns, so concurrent acquires for one session share one host. */
const SPAWNING = new Map<string, Promise<HostEntry>>();
/** Live ephemeral hosts, tracked only so orderly shutdown can reap them. */
const EPHEMERAL_HOSTS = new Set<PsHost>();
/** In-flight ephemeral spawns, so shutdown can wait for hosts not yet in the set. */
const EPHEMERAL_SPAWNING = new Set<Promise<PsHost>>();

export interface SpawnPsHostOptions {
	/** Initial working directory for the spawned host. */
	cwd: string;
	/** Override for the pwsh executable; defaults to `pwsh` on PATH. */
	shellPath?: string;
	/** Retained-result history cap for the spawned host. */
	historyDepth: number;
}

export interface AcquirePsHostOptions extends SpawnPsHostOptions {
	/** Stable per-session key; distinct sessions get distinct hosts. */
	sessionId: string;
	/** Evict hosts idle longer than this (ms); `<= 0` disables eviction. */
	idleTtlMs: number;
}

export interface PsHostLease {
	host: PsHost;
	/** Return the host to the pool; refreshes its idle timestamp. */
	release(): void;
}

export interface EphemeralPsHostLease {
	host: PsHost;
	/** Terminate the host; resolves only once the process is fully gone. */
	dispose(): Promise<void>;
}

type PsHostSpawner = (options: SpawnPsHostOptions) => Promise<PsHost>;

const spawnRealHost: PsHostSpawner = async options => {
	// Workspace loads skip the version-sentinel check, so a stale local `.node`
	// still boots — but the JS re-export is then `undefined` and `new PsHost`
	// becomes "undefined is not a constructor". Fail with the rebuild path.
	if (typeof PsHost !== "function") {
		throw new Error(
			"@oh-my-pi/pi-natives does not export PsHost — the loaded native addon is stale or incomplete. " +
				"Rebuild with: bun --cwd=packages/natives run build:bindings (or bun run build:native).",
		);
	}
	const host = new PsHost({
		parentPid: process.pid,
		shellPath: options.shellPath,
		cwd: options.cwd,
		historyDepth: options.historyDepth,
	});
	try {
		await host.start();
	} catch (err) {
		await safeDispose(host);
		throw err;
	}
	return host;
};

let spawnHost: PsHostSpawner = spawnRealHost;

/**
 * Test seam: replace the spawner so pool bookkeeping (single-flight, idle
 * eviction, dispose-all) can be exercised with fake hosts and no real pwsh
 * processes. Pass `null` to restore the real spawner.
 */
export function setPsHostSpawnerForTests(spawner: PsHostSpawner | null): void {
	spawnHost = spawner ?? spawnRealHost;
}

/** Get the session's warm host, spawning and starting one on first use. */
export async function acquirePsHost(options: AcquirePsHostOptions): Promise<PsHostLease> {
	sweepIdle(options.idleTtlMs, options.sessionId);

	let entry = HOSTS.get(options.sessionId);
	if (entry && !entry.host.alive) {
		// The sidecar died — a crash, or a wedged pipeline force-killed after
		// an unacknowledged stop. Evict it and fall through to a fresh spawn.
		HOSTS.delete(options.sessionId);
		void safeDispose(entry.host);
		entry = undefined;
	}
	if (!entry) {
		// Single-flight the spawn: without this, concurrent acquires for the
		// same session would each see an empty slot, spawn their own host, and
		// leak every loser untracked. The tool's exclusive concurrency makes
		// that unlikely today, but the pool must be safe on its own terms.
		let spawning = SPAWNING.get(options.sessionId);
		if (!spawning) {
			spawning = spawnHost(options)
				.then(host => {
					const created: HostEntry = { host, lastUsed: Date.now(), activeRuns: 0 };
					HOSTS.set(options.sessionId, created);
					return created;
				})
				.finally(() => {
					SPAWNING.delete(options.sessionId);
				});
			SPAWNING.set(options.sessionId, spawning);
		}
		entry = await spawning;
	}

	entry.lastUsed = Date.now();
	entry.activeRuns++;
	let released = false;
	return {
		host: entry.host,
		release: () => {
			if (released) return;
			released = true;
			entry.activeRuns--;
			entry.lastUsed = Date.now();
		},
	};
}

/**
 * Spawn a throwaway host for a single run. Never pooled and invisible to the
 * session host; the caller must await `dispose()` when the run completes.
 */
export async function spawnEphemeralPsHost(options: SpawnPsHostOptions): Promise<EphemeralPsHostLease> {
	// Register the host inside the promise chain (not after an await in this
	// function) so `disposeAllPsHosts` awaiting the tracked promise observes
	// the host in EPHEMERAL_HOSTS the moment the spawn settles — a spawn racing
	// shutdown can then never resolve into an untracked live sidecar.
	const spawning = spawnHost(options).then(host => {
		EPHEMERAL_HOSTS.add(host);
		return host;
	});
	EPHEMERAL_SPAWNING.add(spawning);
	try {
		const host = await spawning;
		return {
			host,
			dispose: async () => {
				EPHEMERAL_HOSTS.delete(host);
				await safeDispose(host);
			},
		};
	} finally {
		EPHEMERAL_SPAWNING.delete(spawning);
	}
}

/** Dispose one session's host (e.g. on session teardown). */
export async function disposePsHostSession(sessionId: string): Promise<void> {
	// Drain an in-flight spawn for this session first: until spawnHost()
	// settles the host exists only in SPAWNING, and its .then would insert a
	// live sidecar into HOSTS after this cleanup returned (mirrors
	// disposeAllPsHosts). Awaiting the tracked promise guarantees the HOSTS
	// insert has happened; a failed spawn just resolves to nothing to dispose.
	for (;;) {
		const spawning = SPAWNING.get(sessionId);
		if (!spawning) break;
		await spawning.catch(() => {});
		// Same (settled) promise still registered means only its .finally
		// cleanup is pending — nothing new to wait for.
		if (SPAWNING.get(sessionId) === spawning) break;
	}
	const entry = HOSTS.get(sessionId);
	if (!entry) return;
	HOSTS.delete(sessionId);
	await safeDispose(entry.host);
}

/** Dispose every pooled and ephemeral host. Wire into the app's orderly-shutdown path. */
export async function disposeAllPsHosts(): Promise<void> {
	// Drain in-flight spawns first: a host still inside spawnHost()/start()
	// lives only in SPAWNING/EPHEMERAL_SPAWNING and would otherwise resolve
	// into HOSTS/EPHEMERAL_HOSTS *after* the snapshot below, surviving as a
	// live pwsh sidecar past a dispose-all that promised to reap everything.
	// Loop: a spawn settling during the wait registers its host, and the next
	// pass picks it up.
	while (SPAWNING.size > 0 || EPHEMERAL_SPAWNING.size > 0) {
		await Promise.allSettled([...SPAWNING.values(), ...EPHEMERAL_SPAWNING]);
	}
	const hosts = [...HOSTS.values()].map(entry => entry.host).concat([...EPHEMERAL_HOSTS]);
	HOSTS.clear();
	EPHEMERAL_HOSTS.clear();
	await Promise.allSettled(hosts.map(host => safeDispose(host)));
}

/**
 * Evict hosts idle beyond the TTL. The acquiring session's own host (`keep`)
 * is exempt — it is about to be used, so evicting and respawning it would only
 * discard warm state — as is any host with a run still in flight.
 */
function sweepIdle(ttlMs: number, keep: string): void {
	if (ttlMs <= 0) return;
	const now = Date.now();
	for (const [id, entry] of HOSTS) {
		if (id === keep || entry.activeRuns > 0) continue;
		if (now - entry.lastUsed > ttlMs) {
			HOSTS.delete(id);
			void safeDispose(entry.host);
		}
	}
}

async function safeDispose(host: PsHost): Promise<void> {
	try {
		await host.dispose();
	} catch (err) {
		logger.warn("PowerShell host dispose failed", { error: String(err) });
	}
}
