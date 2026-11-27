/**
 * `provider-slots` daemon module: the per-provider in-flight request limits
 * (`providers.maxInFlightRequests`) shared by every omp process of a config
 * root, served to pi-ai as its {@link ProviderSlotBroker}.
 *
 * One unit per config root. A process attaches one tunnel (LF-delimited JSON)
 * and asks for a slot per request, naming the limit it applies. The unit
 * grants requests in the order they asked while fewer than their limit run
 * (a request with a higher limit passes one with a lower); a tunnel that
 * closes gives back every slot it held or waited for, so a process that died
 * never holds one.
 *
 * The client half ({@link DaemonProviderSlots}) lives here too so both ends of
 * the contract stay in one file. pi-ai bounds each process before asking it,
 * so without a daemon, or until a lost one is back, limits still hold per
 * process. After reattaching, the client announces the requests it still
 * runs, so the new unit counts them.
 *
 * @example
 * configureProviderSlotBroker(new DaemonProviderSlots());
 */
import type { ProviderSlotBroker } from "@oh-my-pi/pi-ai/provider-slots";
import { getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { isRecord, toError } from "@oh-my-pi/pi-utils/type-guards";
import { lineReader } from "../../irc/mesh-protocol";
import type { DaemonModule, ModuleTunnel, ModuleUnit } from "../module";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE, type UnitPolicy } from "../protocol";

/** Unit kind and `caps` key. */
export const PROVIDER_SLOTS_KIND = "provider-slots";
/** Bumped on incompatible changes to {@link SlotsUp} or {@link SlotsDown}. */
export const PROVIDER_SLOTS_VERSION = 1;
/** Bound on opening and attaching the unit once the daemon answered. */
const ATTACH_TIMEOUT_MS = 10_000;
/** After the unit could not be reached, requests go ahead without it for this long before a retry. */
const RETRY_MS = 60_000;

const POLICY: UnitPolicy = { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "none" };

/**
 * Process → unit. `release` gives a running request's slot back or withdraws
 * a pending `acquire`; `adopt` counts a request that already runs (it started
 * before this unit existed).
 */
type SlotsUp =
	| { t: "acquire"; id: number; provider: string; limit: number }
	| { t: "adopt"; id: number; provider: string }
	| { t: "release"; id: number };
/** Unit → process: request `id` may start. */
type SlotsDown = { t: "granted"; id: number };

function emit(tunnel: { send(data: string): boolean }, message: SlotsUp | SlotsDown): void {
	tunnel.send(`${JSON.stringify(message)}\n`);
}

/** A request waiting for a slot, with its tunnel's running requests (id → provider). */
interface Pending {
	tunnel: ModuleTunnel;
	running: Map<number, string>;
	id: number;
	provider: string;
	limit: number;
}

/** The slots of one config root. */
class ProviderSlotsUnit implements ModuleUnit {
	readonly label = "provider request slots";
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
	readonly #tunnels = new Set<ModuleTunnel>();
	/** Running requests per provider. */
	readonly #counts = new Map<string, number>();
	/** Requests waiting for a slot, in the order they asked. */
	#pending: Pending[] = [];

	constructor() {
		this.exited = this.#exit.promise;
	}

	pids(): number[] {
		return [];
	}

	busy(): boolean {
		return this.#counts.size > 0 || this.#pending.length > 0;
	}

	attach(tunnel: ModuleTunnel): void {
		const running = new Map<number, string>();
		this.#tunnels.add(tunnel);
		tunnel.start(
			lineReader(message => {
				if (!isRecord(message) || typeof message.id !== "number") return;
				const id = message.id;
				if (message.t === "release") {
					this.#release(tunnel, running, id);
					return;
				}
				if (typeof message.provider !== "string") return;
				if (message.t === "adopt") {
					this.#start(running, id, message.provider);
				} else if (message.t === "acquire" && typeof message.limit === "number" && message.limit >= 1) {
					this.#pending.push({ tunnel, running, id, provider: message.provider, limit: message.limit });
					this.#grant();
				}
			}),
			() => {
				this.#tunnels.delete(tunnel);
				for (const provider of running.values()) this.#finish(provider);
				running.clear();
				this.#pending = this.#pending.filter(request => request.tunnel !== tunnel);
				this.#grant();
			},
		);
	}

	#start(running: Map<number, string>, id: number, provider: string): void {
		running.set(id, provider);
		this.#counts.set(provider, (this.#counts.get(provider) ?? 0) + 1);
	}

	#finish(provider: string): void {
		const count = (this.#counts.get(provider) ?? 1) - 1;
		if (count > 0) this.#counts.set(provider, count);
		else this.#counts.delete(provider);
	}

	/** Give back request `id`'s slot, or take it out of the line. */
	#release(tunnel: ModuleTunnel, running: Map<number, string>, id: number): void {
		const provider = running.get(id);
		if (provider === undefined) {
			this.#pending = this.#pending.filter(request => request.tunnel !== tunnel || request.id !== id);
			return;
		}
		running.delete(id);
		this.#finish(provider);
		this.#grant();
	}

	/** Start every waiting request whose provider runs fewer than its limit, in the order they asked. */
	#grant(): void {
		const pending: Pending[] = [];
		for (const request of this.#pending) {
			if ((this.#counts.get(request.provider) ?? 0) >= request.limit) {
				pending.push(request);
				continue;
			}
			this.#start(request.running, request.id, request.provider);
			emit(request.tunnel, { t: "granted", id: request.id });
		}
		this.#pending = pending;
	}

	async stop(reason: string): Promise<void> {
		this.#pending = [];
		this.#counts.clear();
		for (const tunnel of this.#tunnels) tunnel.close();
		this.#tunnels.clear();
		this.#exit.resolve({ reason });
	}
}

/** Request slots per config root (the unit key). */
export const providerSlotsModule: DaemonModule = {
	kind: PROVIDER_SLOTS_KIND,
	version: PROVIDER_SLOTS_VERSION,
	policy: () => POLICY,
	open: () => new ProviderSlotsUnit(),
};

// ── Client half ──────────────────────────────────────────────────────

/** What a {@link DaemonProviderSlots} uses of the daemon connection. */
export type ProviderSlotsDaemon = Pick<DaemonClient, "welcome" | "open" | "release" | "attach" | "onReconnect">;

/** How a {@link DaemonProviderSlots} reaches the daemon and whose slots it shares; the defaults suit production. */
export interface DaemonProviderSlotsOptions {
	/** Reaches the daemon; default {@link daemonClient}, and none under the test runner. */
	connect?: () => Promise<ProviderSlotsDaemon | undefined>;
	/** Unit key naming the processes that share limits; default the config root. */
	key?: () => string;
}

/** A request of this process that holds or waits for a slot. */
interface SlotRequest {
	provider: string;
	/** Started: granted by the unit, or gone ahead without one. */
	running: boolean;
	/** Ends the wait for the unit's grant; set while waiting. */
	grant?: () => void;
}

interface SlotsLink {
	daemon: ProviderSlotsDaemon;
	tunnel: DaemonTunnel;
	lease: string | undefined;
}

/** The test runner must never reach, or spawn, the user's daemon. */
async function connectDaemon(): Promise<ProviderSlotsDaemon | undefined> {
	if (isBunTestRuntime()) return undefined;
	const { daemonClient } = await import("../client");
	return daemonClient();
}

/**
 * This process's side of the provider slots: each {@link acquire} waits until
 * fewer than its limit of requests to the provider run across the processes
 * of this config root. Attaches to the unit on the first request and detaches
 * once none holds or waits for a slot; the open tunnel keeps a waiting process alive.
 */
export class DaemonProviderSlots implements ProviderSlotBroker {
	readonly #connect: () => Promise<ProviderSlotsDaemon | undefined>;
	readonly #key: () => string;
	#link: SlotsLink | undefined;
	/** The attempt to attach one, shared by the requests that started it. */
	#attaching: Promise<SlotsLink | undefined> | undefined;
	/** No attach attempt before this time: the last one failed. */
	#retryAt = 0;
	/** Subscribed to the daemon connection's reconnects. */
	#watchingReconnects = false;
	#nextId = 0;
	/** Requests holding or waiting for a slot, by id. */
	readonly #requests = new Map<number, SlotRequest>();

	constructor(options: DaemonProviderSlotsOptions = {}) {
		this.#connect = options.connect ?? connectDaemon;
		this.#key = options.key ?? getConfigRootDir;
	}

	/**
	 * Resolve with the slot's release once the unit grants it. Goes ahead at
	 * once when the daemon cannot be reached, and when the unit is lost while
	 * it waits. Rejects with the abort reason when `signal` aborts first.
	 */
	async acquire(provider: string, limit: number, signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted();
		const id = ++this.#nextId;
		const request: SlotRequest = { provider, running: false };
		this.#requests.set(id, request);
		const release = (): void => {
			if (!this.#requests.delete(id)) return;
			const link = this.#link;
			if (!link) return;
			emit(link.tunnel, { t: "release", id });
			if (this.#requests.size === 0) this.#drop(link);
		};
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		request.grant = () => {
			request.grant = undefined;
			request.running = true;
			resolve();
		};
		const onAbort = (): void => reject(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		void this.#attach().then(link => {
			// Aborted, or gone ahead when a link dropped, while attaching.
			if (!request.grant) return;
			if (link && this.#link === link) emit(link.tunnel, { t: "acquire", id, provider, limit });
			else request.grant();
		});
		try {
			await promise;
		} catch (error) {
			request.grant = undefined;
			release();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		return release;
	}

	#attach(): Promise<SlotsLink | undefined> {
		if (this.#link) return Promise.resolve(this.#link);
		if (this.#attaching) return this.#attaching;
		if (Date.now() < this.#retryAt) return Promise.resolve(undefined);
		const attaching = this.#open()
			.catch((error: unknown) => {
				logger.debug("Daemon provider slots unavailable; limiting requests per process", {
					error: toError(error).message,
				});
				return undefined;
			})
			.then(link => {
				this.#attaching = undefined;
				if (!link) this.#retryAt = Date.now() + RETRY_MS;
				// Every request that asked for it was aborted meanwhile.
				else if (this.#requests.size === 0) this.#drop(link);
				return link;
			});
		this.#attaching = attaching;
		return attaching;
	}

	async #open(): Promise<SlotsLink | undefined> {
		const daemon = await this.#connect();
		// A daemon of another build may not serve this module or this protocol.
		if (daemon?.welcome.caps[PROVIDER_SLOTS_KIND] !== PROVIDER_SLOTS_VERSION) return undefined;
		const { openTunnel } = await import("../client");
		const { tunnel, lease } = await openTunnel(
			daemon,
			{ kind: PROVIDER_SLOTS_KIND, scope: GLOBAL_SCOPE, key: this.#key() },
			AbortSignal.timeout(ATTACH_TIMEOUT_MS),
		);
		if (!this.#watchingReconnects) {
			this.#watchingReconnects = true;
			// A new daemon answers: the old one's leases and tunnels are gone.
			daemon.onReconnect(() => {
				this.#retryAt = 0;
				if (this.#link) this.#lost(this.#link);
				else if (this.#requests.size > 0) void this.#attach();
			});
		}
		const link: SlotsLink = { daemon, tunnel, lease };
		// Current before the tunnel can close, so a close is never missed.
		this.#link = link;
		tunnel.start(
			lineReader(message => {
				if (this.#link !== link || !isRecord(message) || message.t !== "granted") return;
				if (typeof message.id === "number") this.#requests.get(message.id)?.grant?.();
			}),
			() => this.#lost(link),
		);
		// Requests that went ahead without a unit, or outlived the last one, still run: count them.
		for (const [id, request] of this.#requests) {
			if (request.running) emit(tunnel, { t: "adopt", id, provider: request.provider });
		}
		return link;
	}

	/** The unit or its daemon went away: requests still running move to the next unit, so it counts them. */
	#lost(link: SlotsLink): void {
		if (this.#link !== link) return;
		this.#drop(link);
		if (this.#requests.size > 0) void this.#attach();
	}

	/** Let go of `link`: its slots go back to the unit, and requests waiting on it go ahead. */
	#drop(link: SlotsLink): void {
		if (this.#link !== link) return;
		this.#link = undefined;
		link.tunnel.close();
		if (link.lease) void link.daemon.release(link.lease).catch(() => {});
		for (const request of this.#requests.values()) request.grant?.();
	}
}
