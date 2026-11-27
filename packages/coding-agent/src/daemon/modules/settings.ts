/**
 * `settings` daemon module: the one writer of the settings files of every omp
 * process, so no process locks, re-reads, or rewrites them itself.
 *
 * One global unit holds a {@link SettingsStore}. A process attaches one tunnel
 * (LF-delimited JSON) and multiplexes its subscriptions over it: each line
 * names a channel, and every channel is a store peer of its own, so the store
 * always sees one peer with one open document, however many subscriptions the
 * process holds on however many documents.
 *
 * The client half ({@link settingsLink}) lives here too so both ends of the
 * wire stay in one file. It never depends on the daemon being there: the
 * daemon itself, a test run, and a process whose daemon is unreachable or of
 * another build run the same store in-process behind the same channels.
 *
 * @example
 * const link = await settingsLink();
 * const doc = await link.open({ kind: "global", agentDir }, { mode: "write", watch: true });
 * doc.write([{ segments: ["theme"], value: "dark" }]);
 * doc.update.state; // already has the write
 * await doc.flush();
 */
import * as path from "node:path";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import {
	applySettingWrites,
	type GlobalDocState,
	type ProjectDocState,
	type SettingsDocKey,
	type SettingsDocUpdate,
	type SettingsDown,
	SettingsStore,
	type SettingsStorePeer,
	type SettingsUp,
	type SettingsWrite,
} from "../../config/settings-store";
import { lineReader } from "../../irc/mesh-protocol";
import { daemonClient } from "../client";
import type { DaemonModule, ModuleTunnel, ModuleUnit } from "../module";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE, type UnitPolicy } from "../protocol";

/** Unit kind and `caps` key. */
export const SETTINGS_KIND = "settings";
/** Bumped on incompatible changes to the store protocol or the tunnel lines that carry it. */
export const SETTINGS_VERSION = 1;
/** Key of the one unit. */
const UNIT_KEY = "store";
/** How long subscriptions wait for the daemon before the store runs in-process. */
const CONNECT_TIMEOUT_MS = 3_000;
/** How long an `open`, `flush` or `reload` waits for the store's answer before it rejects. */
export const SETTINGS_REPLY_TIMEOUT_MS = 30_000;
/** Delay before a failed daemon dial, store move or document re-open is tried again; doubles per failure in a row. */
export const SETTINGS_RETRY_MIN_MS = 250;
/** Longest delay between such retries. */
export const SETTINGS_RETRY_MAX_MS = 30_000;

const POLICY: UnitPolicy = {
	hold: "leases",
	idleMs: 5 * 60_000,
	onIdle: "flush-stop",
	restart: "no",
	survive: "none",
};

/** Tunnel line, process → unit: `m` for the store peer of channel `c`, or the end of that channel. */
type WireUp = { c: number; m: SettingsUp } | { c: number; end: true };
/** Tunnel line, unit → process: what the store sent the peer of channel `c`. */
interface WireDown {
	c: number;
	m: SettingsDown;
}

/** True in the daemon process, which serves the store instead of dialing itself. */
let servesStore = false;

/**
 * The store this process runs itself. The daemon's unit and an in-process link
 * share it, so a process is one writer however many of them it holds.
 */
let ownStore: { store: SettingsStore; users: number } | undefined;

function retainStore(): SettingsStore {
	ownStore ??= { store: new SettingsStore(), users: 0 };
	ownStore.users++;
	return ownStore.store;
}

/** Give back one {@link retainStore}; the last one stops the store's timers and file polls. */
function releaseStore(): void {
	if (!ownStore || --ownStore.users > 0) return;
	ownStore.store.dispose();
	ownStore = undefined;
}

/** The store, served to every attached process. */
class SettingsUnit implements ModuleUnit {
	readonly label = "settings store";
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
	readonly #store = retainStore();
	/** Per attached tunnel: the store peers of its channels. */
	readonly #tunnels = new Map<ModuleTunnel, Map<number, SettingsStorePeer>>();
	#stopped = false;

	constructor() {
		this.exited = this.#exit.promise;
	}

	pids(): number[] {
		return [];
	}

	busy(): boolean {
		return false;
	}

	attach(tunnel: ModuleTunnel): void {
		if (this.#stopped) {
			tunnel.close();
			return;
		}
		const peers = new Map<number, SettingsStorePeer>();
		this.#tunnels.set(tunnel, peers);
		tunnel.start(
			lineReader(line => this.#dispatch(tunnel, peers, line)),
			() => {
				if (this.#tunnels.delete(tunnel)) this.#drop(peers);
			},
		);
	}

	#dispatch(tunnel: ModuleTunnel, peers: Map<number, SettingsStorePeer>, line: unknown): void {
		if (this.#stopped || !isRecord(line) || typeof line.c !== "number") return;
		const channel = line.c;
		let peer = peers.get(channel);
		if (line.end === true) {
			if (peer) {
				peers.delete(channel);
				this.#store.removePeer(peer);
			}
			return;
		}
		const message = line.m;
		if (!isRecord(message) || typeof message.t !== "string") return;
		if (!peer) {
			peer = this.#store.addPeer(down => {
				const reply: WireDown = { c: channel, m: down };
				tunnel.send(`${JSON.stringify(reply)}\n`);
			});
			peers.set(channel, peer);
		}
		try {
			peer.handle(message as SettingsUp);
		} catch (error) {
			// One process's malformed message never takes the daemon, and everyone's settings, down.
			logger.warn("Settings store rejected a message", { error: toError(error).message });
		}
	}

	#drop(peers: Map<number, SettingsStorePeer>): void {
		for (const peer of peers.values()) this.#store.removePeer(peer);
		peers.clear();
	}

	flush(): Promise<void> {
		return this.#store.flush();
	}

	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const [tunnel, peers] of this.#tunnels) {
			this.#drop(peers);
			tunnel.close();
		}
		this.#tunnels.clear();
		// Only an idle stop and a daemon exit flush first; a manual stop or a replacement must not lose acked writes either.
		try {
			await this.#store.flush();
		} catch (error) {
			logger.warn("Settings could not be saved before the store stopped", { error: toError(error).message });
		}
		releaseStore();
		this.#exit.resolve({ reason });
	}
}

/** The settings store: one global unit shared by every omp process. */
export const settingsModule: DaemonModule = {
	kind: SETTINGS_KIND,
	version: SETTINGS_VERSION,
	policy: () => POLICY,
	init: () => {
		servesStore = true;
	},
	open: () => new SettingsUnit(),
};

// ── Client half ──────────────────────────────────────────────────────

/** One open settings document, kept current by the link: store state with this peer's unacked writes applied. */
export interface SettingsSubscription {
	readonly key: SettingsDocKey;
	/** Latest reconciled state; replaces wholesale on every push. */
	readonly update: SettingsDocUpdate;
	onUpdate(sink: (update: SettingsDocUpdate) => void): () => void;
	write(writes: readonly SettingsWrite[]): void;
	watch(watch: boolean): void;
	/** Resolves once the store saved, at once when closed; rejects on its error or with no answer in time. */
	flush(): Promise<void>;
	/** Resolves once the store read the files again; otherwise like {@link flush}. */
	reload(): Promise<void>;
	close(): void;
}

/** This process's connection to the settings store; every subscription it opens is a store peer of its own. */
export interface SettingsLink {
	open(key: SettingsDocKey, options: { mode: "read" | "write"; watch?: boolean }): Promise<SettingsSubscription>;
	close(): void;
}

/** What a link uses of the daemon connection. */
export type SettingsDaemon = Pick<DaemonClient, "welcome" | "open" | "release" | "attach" | "onReconnect">;

/** One subscription's connection to a store peer of its own. */
interface SettingsChannel {
	send(message: SettingsUp): void;
	/** A reply is awaited: keep the process alive until the matching {@link unref}. */
	ref(): void;
	unref(): void;
	/** Removes the store peer, after everything sent before. */
	close(): void;
}

/** What carries channels to a store: the daemon tunnel, or this process's own store. */
interface SettingsTransport {
	readonly closed: boolean;
	/** A new store peer; `onMessage` receives everything the store sends it. */
	channel(onMessage: (message: SettingsDown) => void): SettingsChannel;
	close(): void;
}

/**
 * Channels into this process's own store, delivered synchronously: the store
 * must take a write inside the call that made it, since that is when it reads
 * the file generation the write is based on. An answer can therefore arrive
 * inside the send that caused it.
 */
class LocalTransport implements SettingsTransport {
	readonly #store = retainStore();
	readonly #peers = new Set<SettingsStorePeer>();
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	channel(onMessage: (message: SettingsDown) => void): SettingsChannel {
		const peer: SettingsStorePeer = this.#store.addPeer(message => {
			// A peer this link dropped may still be sent to.
			if (this.#peers.has(peer)) this.#deliver(message, onMessage);
		});
		this.#peers.add(peer);
		return {
			send: message => {
				if (this.#peers.has(peer)) this.#deliver(message, up => peer.handle(up));
			},
			ref() {},
			unref() {},
			close: () => {
				if (this.#peers.delete(peer)) this.#store.removePeer(peer);
			},
		};
	}

	/**
	 * Hand `message` over at once, as a private copy, so store and subscription
	 * never share a tree. A structured clone, not JSON: a write that removes a
	 * path carries `undefined`.
	 */
	#deliver<T>(message: T, sink: (message: T) => void): void {
		if (this.#closed) return;
		try {
			sink(structuredClone(message));
		} catch (error) {
			logger.warn("Settings store message failed", { error: toError(error).message });
		}
	}

	/** Saves what the store holds. */
	flush(): Promise<void> {
		return this.#store.flush();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		// The store may live on for the daemon's unit; this link's peers must not.
		for (const peer of this.#peers) this.#store.removePeer(peer);
		this.#peers.clear();
		releaseStore();
	}
}

/** Channels multiplexed over one tunnel to the daemon's unit. */
class TunnelTransport implements SettingsTransport {
	/** The link's count of daemon reconnects when the unit lease was taken: a later reconnect took the lease away. */
	readonly leaseEpoch: number;
	readonly #tunnel: DaemonTunnel;
	readonly #release: () => void;
	readonly #channels = new Map<number, (message: SettingsDown) => void>();
	#lastChannel = 0;
	/** Replies awaited across all channels; the tunnel holds the process only while there are some. */
	#refs = 0;
	#closed = false;

	/** `release` gives the unit lease back; `onLost` fires when the tunnel closes other than by {@link close}. */
	constructor(
		tunnel: DaemonTunnel,
		release: () => void,
		onLost: (transport: TunnelTransport) => void,
		leaseEpoch: number,
	) {
		this.leaseEpoch = leaseEpoch;
		this.#tunnel = tunnel;
		this.#release = release;
		// An idle settings tunnel never keeps a short-lived omp process alive.
		tunnel.unref();
		tunnel.start(
			lineReader(line => {
				if (this.#closed || !isRecord(line) || typeof line.c !== "number" || !isRecord(line.m)) return;
				this.#channels.get(line.c)?.(line.m as SettingsDown);
			}),
			() => {
				if (this.#closed) return;
				this.close();
				onLost(this);
			},
		);
	}

	get closed(): boolean {
		return this.#closed;
	}

	channel(onMessage: (message: SettingsDown) => void): SettingsChannel {
		const id = ++this.#lastChannel;
		this.#channels.set(id, onMessage);
		return {
			send: message => {
				// Nothing follows a channel's end: the unit would take it for a new peer.
				if (this.#channels.has(id)) this.#send({ c: id, m: message });
			},
			ref: () => {
				if (this.#refs++ === 0 && !this.#closed) this.#tunnel.ref();
			},
			unref: () => {
				if (--this.#refs === 0 && !this.#closed) this.#tunnel.unref();
			},
			close: () => {
				if (this.#channels.delete(id)) this.#send({ c: id, end: true });
			},
		};
	}

	#send(line: WireUp): void {
		if (!this.#closed) this.#tunnel.send(`${JSON.stringify(line)}\n`);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#channels.clear();
		this.#tunnel.close();
		this.#release();
	}
}

/** A write the store has not acked. */
interface JournalEntry {
	seq: number;
	writes: SettingsWrite[];
}

/** A request awaiting the store's reply. */
interface PendingReply {
	channel: SettingsChannel;
	/** The `open` of its channel: its answer makes the subscription live. */
	open: boolean;
	/** Rejects the request when the store leaves it unanswered. */
	timer: NodeJS.Timeout;
	/** True once answered; false when the channel went away first. */
	resolve(answered: boolean): void;
	reject(error: Error): void;
}

type SettingsRequest = Extract<SettingsUp, { id: string }>;

const TIMED_OUT = Symbol("timed out");
const UNREACHABLE = Symbol("unreachable");

/** The error of a request no store answered within {@link SETTINGS_REPLY_TIMEOUT_MS}. */
function unanswered(request: SettingsRequest["t"]): Error {
	return new Error(`Settings store did not answer "${request}" within ${SETTINGS_REPLY_TIMEOUT_MS / 1000}s`);
}

/** How long to wait before the retry that follows `failures` failures in a row. */
function retryDelay(failures: number): number {
	return Math.min(SETTINGS_RETRY_MAX_MS, SETTINGS_RETRY_MIN_MS * 2 ** (failures - 1));
}

/** Runs a teardown step whose failure must not stop the steps after it. */
function guarded(step: () => void): void {
	try {
		step();
	} catch (error) {
		logger.debug("Settings link teardown step failed", { error: toError(error).message });
	}
}

/** The state of a document nothing was read of yet. */
function emptyUpdate(doc: SettingsDocKey): SettingsDocUpdate {
	const state: GlobalDocState | ProjectDocState =
		doc.kind === "global"
			? { configPath: null, settings: {} }
			: { items: [], nativeModelRoles: undefined, warnings: [] };
	return { doc, state, acked: 0 };
}

/** `base` as the store will report it once it applied `journal`. */
function reconcile(base: SettingsDocUpdate, journal: readonly JournalEntry[]): SettingsDocUpdate {
	if (journal.length === 0) return base;
	const writes = journal.flatMap(entry => entry.writes);
	if (base.doc.kind === "global") {
		const state = base.state as GlobalDocState;
		return { ...base, state: { ...state, settings: applySettingWrites(state.settings, writes) } };
	}
	// A project document takes writes to its native `modelRoles` only; that subtree is all it reports of the file.
	const state = base.state as ProjectDocState;
	const tree = applySettingWrites(
		state.nativeModelRoles === undefined ? {} : { modelRoles: state.nativeModelRoles },
		writes,
	);
	return { ...base, state: { ...state, nativeModelRoles: tree.modelRoles } };
}

/** `key` with its directory absolute: the store may run in a process with another cwd. */
function resolveKey(key: SettingsDocKey): SettingsDocKey {
	return key.kind === "global"
		? { kind: "global", agentDir: path.resolve(key.agentDir) }
		: { kind: "project", cwd: path.resolve(key.cwd) };
}

/**
 * One open document on a store peer of its own. It outlives its channel:
 * while the link has none it serves the last known state and journals writes,
 * and on the next channel it opens the document again and replays them.
 */
class StoreSubscription implements SettingsSubscription {
	readonly key: SettingsDocKey;
	readonly #mode: "read" | "write";
	readonly #onClose: (subscription: StoreSubscription) => void;
	#watch: boolean;
	/** The watch state the store was last told on the current channel. */
	#armed = false;
	/** The last state the store sent. */
	#base: SettingsDocUpdate;
	#update: SettingsDocUpdate;
	/** Writes the store has not acked, oldest first. */
	readonly #journal: JournalEntry[] = [];
	#lastSeq = 0;
	#lastRequest = 0;
	/** What the current channel is on, and what a refused re-open takes its next channel from. */
	#transport: SettingsTransport | undefined;
	#channel: SettingsChannel | undefined;
	/** The store answered `open` on the current channel: writes and requests go straight out. */
	#live = false;
	/** True once any channel went live: a later failed `open` is a re-open nobody awaits, so it is tried again. */
	#opened = false;
	/** Why the first `open` failed; {@link opened} rejects with it. */
	#refused: Error | undefined;
	/** Re-opens that failed in a row on the current transport; sets the delay of the next try. */
	#failures = 0;
	/** The next try of a failed re-open. */
	#retry: NodeJS.Timeout | undefined;
	/** Resolves when the subscription goes live, closes, or has its first `open` fail. */
	#changed = Promise.withResolvers<void>();
	readonly #pending = new Map<string, PendingReply>();
	readonly #sinks = new Set<(update: SettingsDocUpdate) => void>();
	/** Counts {@link #publish} runs: tells whether a send was answered, and published, before it returned. */
	#published = 0;
	#closed = false;

	constructor(
		key: SettingsDocKey,
		options: { mode: "read" | "write"; watch?: boolean },
		onClose: (subscription: StoreSubscription) => void,
	) {
		this.key = key;
		this.#mode = options.mode;
		this.#watch = options.watch === true;
		this.#onClose = onClose;
		this.#base = emptyUpdate(key);
		this.#update = this.#base;
	}

	get update(): SettingsDocUpdate {
		return this.#update;
	}

	onUpdate(sink: (update: SettingsDocUpdate) => void): () => void {
		this.#sinks.add(sink);
		return () => {
			this.#sinks.delete(sink);
		};
	}

	/** Applies `writes` to {@link update} at once and sends them to the store, now or when a channel is live. */
	write(writes: readonly SettingsWrite[]): void {
		if (this.#closed) throw new Error("Settings subscription is closed");
		if (writes.length === 0) return;
		const entry: JournalEntry = { seq: ++this.#lastSeq, writes: [...writes] };
		this.#journal.push(entry);
		// Journaled before it is sent: an in-process store answers inside `send`, and that state reconciles against
		// the journal. Sent before the sinks run: one that writes again must not get its write out ahead of this one.
		const published = this.#published;
		if (this.#live) this.#channel?.send({ t: "write", doc: this.key, seq: entry.seq, writes: entry.writes });
		// An answer inside `send` already published a state with this write in it.
		if (this.#published === published) this.#publish();
	}

	watch(watch: boolean): void {
		this.#watch = watch;
		this.#syncWatch();
	}

	flush(): Promise<void> {
		return this.#request("flush");
	}

	reload(): Promise<void> {
		return this.#request("reload");
	}

	/** Leaves the store. Writes it never took (no channel since) are dropped: flush first. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const channel = this.#channel;
		// Requests in flight end here; whoever waits on them sees the close.
		this.detach();
		this.#notify();
		this.#sinks.clear();
		this.#onClose(this);
		if (channel) {
			channel.send({ t: "close", doc: this.key });
			channel.close();
		}
	}

	/**
	 * Resolves once the store answered the document's `open`.
	 *
	 * @throws Error when the store refused, nothing answered within {@link SETTINGS_REPLY_TIMEOUT_MS}, or the
	 * subscription closed first.
	 */
	async opened(): Promise<void> {
		const channel = await this.#liveChannel("open", Date.now() + SETTINGS_REPLY_TIMEOUT_MS);
		if (!channel) throw new Error("Settings subscription is closed");
	}

	/** Become a new store peer on `transport`: open the document there, then replay the unacked writes. */
	attach(transport: SettingsTransport): void {
		if (this.#closed) return;
		this.detach();
		this.#transport = transport;
		this.#openChannel(transport);
	}

	/** The store is gone: serve the last known state until the next {@link attach}. */
	detach(): void {
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#failures = 0;
		this.#refused = undefined;
		this.#transport = undefined;
		this.#channel = undefined;
		this.#live = false;
		this.#abandon();
	}

	/** Requests in flight get no answer any more; each is sent again on the next channel. */
	#abandon(): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: `#take` removes from `#pending`
		for (const id of [...this.#pending.keys()]) this.#take(id)?.resolve(false);
	}

	/** Takes the request `id` off the books, its timer and its hold on the process with it. */
	#take(id: string): PendingReply | undefined {
		const pending = this.#pending.get(id);
		if (!pending) return undefined;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.channel.unref();
		return pending;
	}

	/** A new store peer on `transport`, and the document's `open` on it. */
	#openChannel(transport: SettingsTransport): void {
		const channel: SettingsChannel = transport.channel(message => {
			// A channel left behind may still deliver.
			if (this.#channel === channel) this.#receive(channel, message);
		});
		this.#channel = channel;
		void this.#open(channel);
	}

	/** Never rejects: an `open` that failed is handed to {@link #openFailed}. */
	async #open(channel: SettingsChannel): Promise<void> {
		this.#armed = this.#watch;
		try {
			await this.#ask(
				channel,
				{ t: "open", id: String(++this.#lastRequest), doc: this.key, mode: this.#mode, watch: this.#watch },
				Date.now() + SETTINGS_REPLY_TIMEOUT_MS,
				true,
			);
		} catch (error) {
			this.#openFailed(channel, toError(error));
		}
	}

	/** `channel` got no document: the first open's failure is its caller's, a re-open is tried again. */
	#openFailed(channel: SettingsChannel, error: Error): void {
		// Closed, or moved to another channel since: the open that counts is not this one.
		if (this.#channel !== channel) return;
		// Whatever the store made of that open, the next one goes to a peer of its own.
		this.#channel = undefined;
		guarded(() => channel.close());
		if (this.#opened) {
			this.#reopenLater(error);
			return;
		}
		this.#refused = error;
		this.#notify();
	}

	/** Open the document again on a new channel of the same transport, later with each failure in a row. */
	#reopenLater(error: Error): void {
		const delay = retryDelay(++this.#failures);
		logger.warn("Settings document could not be re-opened; serving its last known state until a retry succeeds", {
			doc: this.key,
			error: error.message,
			retryInMs: delay,
		});
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			const transport = this.#transport;
			if (this.#closed || !transport || transport.closed) return;
			try {
				this.#openChannel(transport);
			} catch (failure) {
				this.#reopenLater(toError(failure));
			}
		}, delay);
		// Never holds the process: a `flush` or `reload` waiting on the retry does, until its own deadline.
		this.#retry.unref();
	}

	/**
	 * The current channel once the document is open on it; undefined once the subscription closed.
	 * Waits out a link without a store and a re-open still being retried, but not past `until`.
	 *
	 * @throws Error when the first open failed, or `until` passed.
	 */
	async #liveChannel(request: SettingsRequest["t"], until: number): Promise<SettingsChannel | undefined> {
		for (;;) {
			if (this.#closed) return undefined;
			if (this.#live && this.#channel) return this.#channel;
			if (this.#refused) throw this.#refused;
			const expired = Promise.withResolvers<typeof TIMED_OUT>();
			// Not unref'd: the process must not exit under whoever awaits this.
			const timer = setTimeout(expired.resolve, Math.max(0, until - Date.now()), TIMED_OUT);
			const outcome = await Promise.race([this.#changed.promise, expired.promise]);
			clearTimeout(timer);
			if (outcome === TIMED_OUT) throw unanswered(request);
		}
	}

	/** Wake whoever waits in {@link #liveChannel}. */
	#notify(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<void>();
		changed.resolve();
	}

	/**
	 * Ask the store; a request that lost its channel is asked again on the next, after the journal's replay.
	 * Resolves without an answer once the subscription closed: nothing is left to save or read then.
	 *
	 * @throws Error with the store's error, or when nothing answered within {@link SETTINGS_REPLY_TIMEOUT_MS}.
	 */
	async #request(t: "flush" | "reload"): Promise<void> {
		const until = Date.now() + SETTINGS_REPLY_TIMEOUT_MS;
		for (;;) {
			const channel = await this.#liveChannel(t, until);
			if (!channel) return;
			// Read again: the channel may have gone while this resumed.
			if (channel !== this.#channel || !this.#live) continue;
			if (await this.#ask(channel, { t, id: String(++this.#lastRequest), doc: this.key }, until)) return;
		}
	}

	/**
	 * Resolves true once answered and false when the channel went away first. Rejects with the store's
	 * error, or once `until` passed without an answer.
	 */
	#ask(channel: SettingsChannel, message: SettingsRequest, until: number, open = false): Promise<boolean> {
		const { promise, resolve, reject } = Promise.withResolvers<boolean>();
		const { id, t } = message;
		// Not unref'd, like the channel below: whoever awaits the answer gets this rejection, not a process exit.
		const timer = setTimeout(() => this.#take(id)?.reject(unanswered(t)), Math.max(0, until - Date.now()));
		this.#pending.set(id, { channel, open, timer, resolve, reject });
		// The tunnel is unref'd; without this a process could exit under an awaited flush.
		channel.ref();
		try {
			channel.send(message);
		} catch (error) {
			this.#take(id)?.reject(toError(error));
		}
		return promise;
	}

	#receive(channel: SettingsChannel, message: SettingsDown): void {
		if (message.t === "doc") {
			this.#accept(message.doc);
			return;
		}
		if (message.t !== "reply") return;
		const pending = this.#take(message.id);
		if (!pending) return;
		if (message.error !== undefined) {
			pending.reject(new Error(message.error));
			return;
		}
		if (pending.open && !message.doc) {
			pending.reject(new Error("Settings store opened a document without its state"));
			return;
		}
		if (message.doc) this.#accept(message.doc);
		if (pending.open) this.#goLive(channel);
		pending.resolve(true);
	}

	/**
	 * The document is open on `channel`. Its peer is new to the store, so every
	 * write still in the journal goes again: the store that took it may be gone
	 * with it unsaved, and setting or removing a path twice changes nothing.
	 */
	#goLive(channel: SettingsChannel): void {
		// By seq, not by position: an in-process store acks inside `send`, which shortens the journal, and a sink
		// run by that ack may write. Such a write is not live yet, so it joins the journal and goes out here, in order.
		let sent = 0;
		for (;;) {
			// Before every send, the first too: a sink run by the open's state or by an ack may have closed the
			// subscription or moved it to another channel, and nothing may follow a channel's end.
			if (this.#channel !== channel) return;
			const entry = this.#journal.find(candidate => candidate.seq > sent);
			if (!entry) break;
			sent = entry.seq;
			channel.send({ t: "write", doc: this.key, seq: entry.seq, writes: entry.writes });
		}
		this.#opened = true;
		this.#live = true;
		this.#failures = 0;
		// `watch` may have changed while the open was in flight.
		this.#syncWatch();
		this.#notify();
	}

	#syncWatch(): void {
		if (!this.#live || !this.#channel || this.#armed === this.#watch) return;
		this.#armed = this.#watch;
		this.#channel.send({ t: "watch", doc: this.key, watch: this.#watch });
	}

	/** A state from the store: the new base, with every write up to its `acked` already in it. */
	#accept(update: SettingsDocUpdate): void {
		this.#base = update;
		let acked = 0;
		while (acked < this.#journal.length && this.#journal[acked].seq <= update.acked) acked++;
		if (acked > 0) this.#journal.splice(0, acked);
		this.#publish();
	}

	#publish(): void {
		this.#published++;
		this.#update = reconcile(this.#base, this.#journal);
		for (const sink of this.#sinks) {
			try {
				// Read per sink: one that writes publishes a newer state before the next runs.
				sink(this.#update);
			} catch (error) {
				logger.warn("Settings update sink failed", { doc: this.key, error: toError(error).message });
			}
		}
	}
}

/** An attempt to reach the daemon's store; it outlives the wait a pass grants it. */
interface DaemonAttempt {
	/** Never rejects: undefined when the daemon lacks this protocol, {@link UNREACHABLE} when the dial failed. */
	transport: Promise<TunnelTransport | typeof UNREACHABLE | undefined>;
	/** A pass gave up waiting; the attempt schedules another when it settles. */
	late: boolean;
}

/** The subscriptions of this process and the store they are on: the daemon's via `connect`, else its own. */
export class SettingsStoreLink implements SettingsLink {
	/** Reaches the daemon; undefined keeps the store in-process for good. */
	readonly #connect: (() => Promise<SettingsDaemon>) | undefined;
	readonly #subscriptions = new Set<StoreSubscription>();
	/** Where subscriptions attach; undefined while a pass is choosing. */
	#transport: SettingsTransport | undefined;
	/** The daemon connection whose reconnects are followed. */
	#daemon: SettingsDaemon | undefined;
	#offReconnect: (() => void) | undefined;
	/** Reconnects of the followed connection so far; each one took the leases of the tunnels before it. */
	#reconnects = 0;
	#attempt: DaemonAttempt | undefined;
	/** Something changed since the running pass last dialed. */
	#stale = false;
	#settling: Promise<void> | undefined;
	/** Dials and moves that failed in a row; sets the delay of the next retry. */
	#failures = 0;
	/** The pass that retries a failed dial or move. */
	#retry: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(connect: (() => Promise<SettingsDaemon>) | undefined) {
		this.#connect = connect;
	}

	/** Resolves once subscriptions have a store to open on. */
	async start(): Promise<void> {
		if (!this.#connect) {
			this.#transport = new LocalTransport();
			return;
		}
		this.#schedule();
		await this.#settling;
	}

	async open(
		key: SettingsDocKey,
		options: { mode: "read" | "write"; watch?: boolean },
	): Promise<SettingsSubscription> {
		if (this.#closed) throw new Error("Settings link is closed");
		const subscription = new StoreSubscription(resolveKey(key), options, closed => {
			this.#subscriptions.delete(closed);
		});
		// Listed before it opens, so a pass that moves the link meanwhile attaches it.
		this.#subscriptions.add(subscription);
		try {
			if (this.#transport) subscription.attach(this.#transport);
			await subscription.opened();
		} catch (error) {
			subscription.close();
			throw error;
		}
		return subscription;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#offReconnect?.();
		this.#offReconnect = undefined;
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: `close` removes the subscription
		for (const subscription of [...this.#subscriptions]) subscription.close();
		this.#transport?.close();
		this.#transport = undefined;
		// A dial still in flight lands on a closed link.
		void this.#attempt?.transport.then(outcome => {
			if (outcome instanceof TunnelTransport) outcome.close();
		});
		this.#attempt = undefined;
	}

	/** Dial the daemon (again) and settle on a store; triggers during a pass run one more. */
	#schedule(): void {
		if (this.#closed) return;
		this.#stale = true;
		this.#settling ??= this.#settle();
	}

	/**
	 * One pass: settle on a store until no trigger is left unanswered. Never rejects.
	 *
	 * With a daemon to reach, the store is the daemon's whenever it answers:
	 * after a lost tunnel or a reconnect the link dials again and moves every
	 * subscription onto the new tunnel. Only while the daemon stays unreachable
	 * past {@link CONNECT_TIMEOUT_MS}, fails the dial, or is of a build without
	 * this protocol, do they run on a store of this process instead. That is
	 * best-effort: this process and a daemon serving others then both write the
	 * files, each noticing the other's saves like any outside edit. A slow dial
	 * goes on and a failed one is made again, {@link SETTINGS_RETRY_MIN_MS} to
	 * {@link SETTINGS_RETRY_MAX_MS} apart, and the subscriptions move back once
	 * one lands.
	 */
	async #settle(): Promise<void> {
		try {
			while (this.#stale && !this.#closed) {
				this.#stale = false;
				// One reconnect triggers twice, by the tunnel it took down and by the connection coming back, and
				// one dial answers both: the tunnel the first trigger's pass took is leased on the new connection.
				if (!this.#attempt && this.#leased()) continue;
				const daemon = await this.#dial();
				if (daemon) {
					await this.#switchTo(daemon);
				} else if (!this.#transport && !this.#closed) {
					// No daemon in time. A tunnel that is still up stays; with nothing, the store runs here.
					await this.#switchTo(new LocalTransport());
				}
			}
		} catch (error) {
			logger.warn("Settings link could not settle on a store; trying again", { error: toError(error).message });
			this.#retryLater();
		} finally {
			// Same tick as the loop's last check, so no trigger falls between a finished pass and this.
			this.#settling = undefined;
		}
	}

	/** True on a tunnel whose lease is of the daemon connection as it is now: no trigger needs another. */
	#leased(): boolean {
		const transport = this.#transport;
		return transport instanceof TunnelTransport && !transport.closed && transport.leaseEpoch === this.#reconnects;
	}

	/** A dial or a move failed: run another pass later, later still with each failure in a row. */
	#retryLater(): void {
		if (this.#closed || this.#retry) return;
		const delay = retryDelay(++this.#failures);
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			this.#schedule();
		}, delay);
		// Never holds the process: whoever awaits a subscription does, until its own deadline.
		this.#retry.unref();
	}

	/** A fresh tunnel to the daemon's store, or undefined when none came within {@link CONNECT_TIMEOUT_MS}. */
	async #dial(): Promise<TunnelTransport | undefined> {
		const connect = this.#connect;
		if (!connect) return undefined;
		this.#attempt ??= { transport: this.#attachDaemon(connect), late: false };
		const attempt = this.#attempt;
		const timeout = Promise.withResolvers<typeof TIMED_OUT>();
		// Not unref'd: whoever awaits this link must not see the process exit under it.
		const timer = setTimeout(timeout.resolve, CONNECT_TIMEOUT_MS, TIMED_OUT);
		const outcome = await Promise.race([attempt.transport, timeout.promise]);
		clearTimeout(timer);
		if (outcome === TIMED_OUT) {
			// The attempt goes on: once it lands, another pass picks its tunnel up here.
			if (!attempt.late) {
				attempt.late = true;
				void attempt.transport.then(() => this.#schedule());
			}
			return undefined;
		}
		if (this.#attempt === attempt) this.#attempt = undefined;
		if (outcome === UNREACHABLE) {
			// Whichever pass learns of the failure books the retry, so a failed dial is never the last one.
			this.#retryLater();
			return undefined;
		}
		if (!outcome) return undefined;
		if (this.#closed || outcome.closed) {
			// Lost before any pass took it: that loss scheduled the next dial.
			outcome.close();
			return undefined;
		}
		if (outcome.leaseEpoch !== this.#reconnects) {
			// The connection it was leased on is gone, and the lease with it: dial on the new one.
			outcome.close();
			this.#stale = true;
			return undefined;
		}
		return outcome;
	}

	/** Never rejects: undefined when the daemon lacks this protocol, {@link UNREACHABLE} when the dial failed. */
	async #attachDaemon(
		connect: () => Promise<SettingsDaemon>,
	): Promise<TunnelTransport | typeof UNREACHABLE | undefined> {
		try {
			const daemon = await connect();
			if (this.#closed) return undefined;
			this.#follow(daemon);
			// A daemon of another build may not serve this module or this protocol.
			if (daemon.welcome.caps[SETTINGS_KIND] !== SETTINGS_VERSION) {
				logger.debug("Daemon lacks the settings module; running the settings store in-process");
				return undefined;
			}
			const opened = await daemon.open({ kind: SETTINGS_KIND, scope: GLOBAL_SCOPE, key: UNIT_KEY });
			// The lease is of the connection as it is now: a reconnect counted after this took it away.
			const epoch = this.#reconnects;
			const release = (): void => {
				if (opened.lease) void daemon.release(opened.lease).catch(() => {});
			};
			let tunnel: DaemonTunnel;
			try {
				tunnel = await daemon.attach(opened.unit.id);
			} catch (error) {
				// A failed attempt never keeps the unit alive.
				release();
				throw error;
			}
			return new TunnelTransport(tunnel, release, transport => this.#lost(transport), epoch);
		} catch (error) {
			logger.debug("Settings daemon unavailable", { error: toError(error).message });
			return UNREACHABLE;
		}
	}

	/** Dial again whenever `daemon` reconnects: the lease died with the old connection, the unit maybe too. */
	#follow(daemon: SettingsDaemon): void {
		if (this.#daemon === daemon) return;
		this.#offReconnect?.();
		this.#daemon = daemon;
		this.#offReconnect = daemon.onReconnect(() => {
			this.#reconnects++;
			this.#schedule();
		});
	}

	/** The unit stopped or the daemon went away: subscriptions keep their state while a pass finds a store. */
	#lost(transport: TunnelTransport): void {
		if (this.#closed) return;
		logger.debug("Settings daemon tunnel closed; reconnecting");
		if (this.#transport === transport) {
			this.#transport = undefined;
			for (const subscription of this.#subscriptions) subscription.detach();
		}
		this.#schedule();
	}

	/**
	 * Move every subscription onto `next`. A store of this process saves what it
	 * holds first, so the store taking over reads it from the files. Never
	 * throws: a move that failed leaves every store, and a later pass makes it again.
	 */
	async #switchTo(next: SettingsTransport): Promise<void> {
		const previous = this.#transport;
		try {
			this.#transport = undefined;
			for (const subscription of this.#subscriptions) subscription.detach();
			if (previous instanceof LocalTransport) {
				try {
					await previous.flush();
				} catch (error) {
					logger.warn("Settings could not be saved before moving to the daemon", {
						error: toError(error).message,
					});
				}
			}
			previous?.close();
			// Closed, or lost while the previous store was saving: the pass that loss scheduled chooses again.
			if (this.#closed || next.closed) {
				next.close();
				return;
			}
			this.#transport = next;
			// A copy: an open that a sink makes during these attaches lists, and attaches, its own subscription.
			// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: `attach` may add a subscription
			for (const subscription of [...this.#subscriptions]) subscription.attach(next);
			if (next instanceof TunnelTransport) {
				// On the daemon: nothing is left to retry.
				clearTimeout(this.#retry);
				this.#retry = undefined;
				this.#failures = 0;
			}
		} catch (error) {
			logger.warn("Settings link could not change stores; trying again", { error: toError(error).message });
			// Half a move serves nobody: with no store at all, subscriptions keep their state and the next pass
			// attaches every one of them again.
			this.#transport = undefined;
			for (const subscription of this.#subscriptions) guarded(() => subscription.detach());
			guarded(() => previous?.close());
			guarded(() => next.close());
			this.#retryLater();
		}
	}
}

let shared: { link: SettingsStoreLink; ready: Promise<SettingsLink> } | undefined;

/** Process-wide link: the daemon's `settings` module when reachable, else an in-process store. */
export function settingsLink(): Promise<SettingsLink> {
	if (!shared) {
		// The daemon serves itself, and a test run never touches the user's daemon.
		const link = new SettingsStoreLink(servesStore || isBunTestRuntime() ? undefined : daemonClient);
		shared = { link, ready: link.start().then(() => link) };
	}
	return shared.ready;
}

/** Test seam: closes the shared link (and its in-process store). */
export function disposeSettingsLinkForTest(): void {
	shared?.link.close();
	shared = undefined;
}
