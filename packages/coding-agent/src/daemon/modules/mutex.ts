/**
 * `mutex` daemon module: named locks shared by every omp process, so work
 * whose result all of them share (a cached model answer) is done by one.
 *
 * One unit per namespace. A process that takes locks attaches one tunnel
 * (LF-delimited JSON) and sends `lock`/`unlock` per key. The unit grants a key
 * to one tunnel at a time, in the order they asked; a tunnel that closes gives
 * up what it held or waited for, so a process that died never blocks the rest.
 *
 * The client half ({@link DaemonMutex}) lives here too so both ends of the
 * contract stay in one file. It fails open: exclusion saves duplicate work, it
 * never guards correctness, so a caller is never stalled for lack of a daemon.
 *
 * @example
 * const release = await daemonMutex("routing-hints").lock(key);
 * try {
 *   if (!cached(key)) await compute(key);
 * } finally {
 *   release();
 * }
 */
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { lineReader } from "../../irc/mesh-protocol";
import { daemonClient } from "../client";
import type { DaemonModule, ModuleTunnel, ModuleUnit } from "../module";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE, type UnitPolicy } from "../protocol";

/** Unit kind and `caps` key. */
export const MUTEX_KIND = "mutex";
/** Bumped on incompatible changes to {@link MutexUp} or {@link MutexDown}. */
export const MUTEX_VERSION = 1;
/** How long a `lock` waits for another process before going ahead without the key. */
const LOCK_WAIT_MS = 60_000;
/** Bound on opening and attaching the unit once the daemon answered. */
const ATTACH_TIMEOUT_MS = 10_000;
/** After the unit could not be reached, locks go ahead without it for this long before a retry. */
const RETRY_MS = 60_000;

const POLICY: UnitPolicy = { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "none" };

/** Process → unit. `unlock` gives a held key back or withdraws a pending `lock`. */
type MutexUp = { t: "lock"; key: string } | { t: "unlock"; key: string };
/** Unit → process: the key is this tunnel's until it unlocks or closes. */
type MutexDown = { t: "locked"; key: string };

function emit(tunnel: { send(data: string): boolean }, message: MutexUp | MutexDown): void {
	tunnel.send(`${JSON.stringify(message)}\n`);
}

/** The keys of one namespace. */
class MutexUnit implements ModuleUnit {
	readonly label: string;
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
	readonly #tunnels = new Set<ModuleTunnel>();
	/** Per contended key: the tunnels that asked for it, in order; the first holds it. */
	readonly #queues = new Map<string, ModuleTunnel[]>();

	constructor(namespace: string) {
		this.label = `${namespace} locks`;
		this.exited = this.#exit.promise;
	}

	pids(): number[] {
		return [];
	}

	busy(): boolean {
		return this.#queues.size > 0;
	}

	attach(tunnel: ModuleTunnel): void {
		this.#tunnels.add(tunnel);
		tunnel.start(
			lineReader(message => {
				if (!isRecord(message) || typeof message.key !== "string") return;
				if (message.t === "lock") this.#enter(message.key, tunnel);
				else if (message.t === "unlock") this.#leave(message.key, tunnel);
			}),
			() => {
				this.#tunnels.delete(tunnel);
				// Deleting the current Map entry while iterating is safe.
				for (const key of this.#queues.keys()) this.#leave(key, tunnel);
			},
		);
	}

	#enter(key: string, tunnel: ModuleTunnel): void {
		const queue = this.#queues.get(key);
		if (!queue) {
			this.#queues.set(key, [tunnel]);
			emit(tunnel, { t: "locked", key });
		} else if (!queue.includes(tunnel)) {
			queue.push(tunnel);
		}
	}

	/** Take `tunnel` out of `key`'s queue; when it held the key, the next in line gets it. */
	#leave(key: string, tunnel: ModuleTunnel): void {
		const queue = this.#queues.get(key);
		const index = queue?.indexOf(tunnel) ?? -1;
		if (!queue || index < 0) return;
		queue.splice(index, 1);
		if (queue.length === 0) this.#queues.delete(key);
		else if (index === 0) emit(queue[0], { t: "locked", key });
	}

	async stop(reason: string): Promise<void> {
		this.#queues.clear();
		for (const tunnel of this.#tunnels) tunnel.close();
		this.#tunnels.clear();
		this.#exit.resolve({ reason });
	}
}

/** Named locks, one global unit per namespace (the unit key). */
export const mutexModule: DaemonModule = {
	kind: MUTEX_KIND,
	version: MUTEX_VERSION,
	policy: () => POLICY,
	open: (_context, request) => new MutexUnit(request.key),
};

// ── Client half ──────────────────────────────────────────────────────

/** What a {@link DaemonMutex} uses of the daemon connection. */
export type MutexDaemon = Pick<DaemonClient, "welcome" | "open" | "release" | "attach" | "onReconnect">;

/** How a {@link DaemonMutex} reaches the daemon and how long it waits; the defaults suit production. */
export interface DaemonMutexOptions {
	/** Reaches the daemon; default {@link daemonClient}. */
	connect?: () => Promise<MutexDaemon>;
	/** Limit of one `lock` wait on another process; default 60 s. */
	waitMs?: number;
}

interface MutexLink {
	daemon: MutexDaemon;
	tunnel: DaemonTunnel;
	lease: string | undefined;
	offReconnect: () => void;
}

const unheld = (): void => {};

/**
 * This process's side of one mutex namespace: {@link lock} takes a key that
 * every omp process on the machine contends for. Attaches to the unit on the
 * first lock and detaches when the last one is released.
 */
export class DaemonMutex {
	readonly #namespace: string;
	readonly #connect: () => Promise<MutexDaemon>;
	readonly #waitMs: number;
	/** The attached tunnel. */
	#link: MutexLink | undefined;
	/** The attempt to attach one, shared by the locks that started it. */
	#attaching: Promise<MutexLink | undefined> | undefined;
	/** No attach attempt before this time: the last one failed. */
	#retryAt = 0;
	/** Locks taken or being taken; the tunnel closes with the last release. */
	#users = 0;
	/** Per key: settles the lock that asked the unit and awaits `locked`. */
	readonly #waiting = new Map<string, (granted: boolean) => void>();
	/** Per key: resolves once this process's locks on it, up to the latest, are released. */
	readonly #turns = new Map<string, Promise<void>>();

	constructor(namespace: string, options: DaemonMutexOptions = {}) {
		this.#namespace = namespace;
		this.#connect = options.connect ?? daemonClient;
		this.#waitMs = options.waitMs ?? LOCK_WAIT_MS;
	}

	/**
	 * Take `key`, waiting while another process holds it, and resolve with its
	 * release. Resolves without the key (the release then does nothing) when
	 * the daemon cannot be reached, the tunnel is lost, or the wait on another
	 * process exceeds its limit; re-check for the shared result either way.
	 */
	async lock(key: string): Promise<() => void> {
		// The unit grants a key per tunnel, so locks of this process take turns among themselves.
		const previous = this.#turns.get(key);
		const turn = Promise.withResolvers<void>();
		const turns = (previous ?? Promise.resolve()).then(() => turn.promise);
		this.#turns.set(key, turns);
		this.#users++;
		await previous;
		const unlock = await this.#acquire(key);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			unlock();
			if (this.#turns.get(key) === turns) this.#turns.delete(key);
			turn.resolve();
			if (--this.#users === 0 && this.#link) this.#drop(this.#link);
		};
	}

	/** Ask the unit for `key`; resolves with what gives it back. */
	async #acquire(key: string): Promise<() => void> {
		const link = await this.#attach();
		if (!link || this.#link !== link) return unheld;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		this.#waiting.set(key, resolve);
		const timer = setTimeout(resolve, this.#waitMs, false);
		timer.unref();
		emit(link.tunnel, { t: "lock", key });
		const granted = await promise;
		clearTimeout(timer);
		this.#waiting.delete(key);
		const unlock = (): void => {
			// A tunnel dropped since took its keys with it.
			if (this.#link === link) emit(link.tunnel, { t: "unlock", key });
		};
		if (granted) return unlock;
		// Done waiting: withdraw, so the unit never grants a key nobody takes.
		unlock();
		return unheld;
	}

	#attach(): Promise<MutexLink | undefined> {
		if (this.#link) return Promise.resolve(this.#link);
		if (this.#attaching) return this.#attaching;
		if (Date.now() < this.#retryAt) return Promise.resolve(undefined);
		const attaching = this.#open()
			.catch((error: unknown) => {
				logger.debug("Daemon mutex unavailable; continuing without locks", {
					namespace: this.#namespace,
					error: toError(error).message,
				});
				return undefined;
			})
			.then(link => {
				this.#attaching = undefined;
				if (!link) this.#retryAt = Date.now() + RETRY_MS;
				return link;
			});
		this.#attaching = attaching;
		return attaching;
	}

	async #open(): Promise<MutexLink | undefined> {
		const daemon = await this.#connect();
		// A daemon of another build may not serve this module or this protocol.
		if (daemon.welcome.caps[MUTEX_KIND] !== MUTEX_VERSION) return undefined;
		const signal = AbortSignal.timeout(ATTACH_TIMEOUT_MS);
		const opened = await daemon.open({ kind: MUTEX_KIND, scope: GLOBAL_SCOPE, key: this.#namespace }, signal);
		let tunnel: DaemonTunnel;
		try {
			tunnel = await daemon.attach(opened.unit.id, undefined, signal);
		} catch (error) {
			// Not attached: the lease would keep the unit alive for nothing.
			if (opened.lease) void daemon.release(opened.lease).catch(() => {});
			throw error;
		}
		// Waiting for a key never keeps the process alive.
		tunnel.unref();
		const link: MutexLink = { daemon, tunnel, lease: opened.lease, offReconnect: () => {} };
		// Leases and tunnels die with the daemon connection.
		link.offReconnect = daemon.onReconnect(() => this.#drop(link));
		// Current before the tunnel can close, so a close is never missed.
		this.#link = link;
		tunnel.start(
			lineReader(message => {
				if (this.#link !== link || !isRecord(message)) return;
				if (message.t === "locked" && typeof message.key === "string") this.#waiting.get(message.key)?.(true);
			}),
			() => this.#drop(link),
		);
		return link;
	}

	/** Let go of `link`: its keys go back to the unit, and locks waiting on it go ahead without theirs. */
	#drop(link: MutexLink): void {
		if (this.#link !== link) return;
		this.#link = undefined;
		link.offReconnect();
		link.tunnel.close();
		if (link.lease) void link.daemon.release(link.lease).catch(() => {});
		for (const settle of this.#waiting.values()) settle(false);
	}
}

const mutexes = new Map<string, DaemonMutex>();

/** The {@link DaemonMutex} this process (or worker thread) shares for `namespace`. */
export function daemonMutex(namespace: string): DaemonMutex {
	let mutex = mutexes.get(namespace);
	if (!mutex) {
		mutex = new DaemonMutex(namespace);
		mutexes.set(namespace, mutex);
	}
	return mutex;
}
