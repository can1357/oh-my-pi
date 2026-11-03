/**
 * Message-port RPC between the main thread and subagent worker threads.
 *
 * One {@link RpcLink} sits on each end of a main↔worker pair. Each side serves
 * the methods of its own {@link RpcApi} table and calls the other side's:
 *
 * - {@link RpcLink.call}: async request/response.
 * - {@link RpcLink.notify}: fire-and-forget; delivery order matches send order.
 * - {@link RpcLink.callSync}: worker → main only. The worker posts the request
 *   on the shared port (so it is ordered after every earlier notification),
 *   parks on a SharedArrayBuffer counter, and dequeues the reply from a
 *   dedicated reply port with `receiveMessageOnPort`. The main thread never
 *   blocks on a worker, so a sync call cannot deadlock; it only waits for the
 *   main event loop to reach the request.
 *
 * Values cross by structured clone after encoding the kinds the subagent
 * boundary needs:
 *
 * - functions → remote callables (async, or sync when the exporter wrapped
 *   them with {@link rpcSync} and the importer is a worker);
 * - `AbortSignal` → a mirrored signal that aborts with the sender's reason;
 * - `Promise` → a promise settled when the sender's settles;
 * - `Error` → rebuilt by name through {@link registerRpcError};
 * - instances of an exported class ({@link RpcLink.exportClass}) → the
 *   importer's canonical proxy for that object ({@link RpcLink.importClass});
 * - codec-registered values ({@link RpcLink.codec}) → whatever the receiving
 *   thread's codec decodes.
 *
 * Proxies received from the other side (functions, signals, objects) travel
 * back as references and decode to the original value, so identity survives a
 * round trip. Any other class instance is refused at the sender with
 * {@link RpcEncodeError}: live objects never silently degrade into
 * prototype-less copies. The one opt-in exception is a receiver declared
 * lossy ({@link rpcLossy} functions, `exportClass(…, { lossy: true })`
 * objects): arguments sent to it copy such instances as plain data (see
 * {@link rpcLossy}); everything above still crosses as described.
 *
 * Handle lifetimes: exported functions, signals, and objects are reference
 * counted across the link. The importer releases them when its proxy is
 * garbage collected; the exporter drops its entry once every import has been
 * released. Closing the link drops everything and rejects pending calls with
 * {@link RpcClosedError}.
 *
 * @example
 * ```ts ignore
 * type MainApi = { add: RpcMethod<[number, number], number> };
 * const link = new RpcLink<WorkerApi, MainApi>(endpoint, { name: "w1↔main", sync: { port, counter } });
 * const three = link.callSync("add", 1, 2);
 * ```
 */
import { receiveMessageOnPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";

/** One RPC method: argument tuple and result. */
export interface RpcMethod<A extends unknown[], R> {
	readonly args: A;
	readonly result: R;
}

/** Method table one side of a link (or one remote object class) serves. */
export type RpcApi = Record<string, RpcMethod<unknown[], unknown>>;

/** Opaque wire frame; only {@link RpcLink} produces and consumes these. */
export type RpcFrame =
	| { t: "call"; id: number; m: string; a: unknown[] }
	| { t: "sync"; id: number; m: string; a: unknown[] }
	| { t: "ok"; id: number; v: unknown }
	| { t: "err"; id: number; e: unknown }
	| { t: "note"; m: string; a: unknown[] }
	| { t: "abort"; sig: number; reason: unknown }
	| { t: "settle"; p: number; ok: boolean; v: unknown }
	| { t: "release"; ids: Array<[number, number]> };

/** Bidirectional message channel underneath a link. */
export interface RpcEndpoint {
	send(frame: RpcFrame): void;
	/** Attach the frame handler; returns a detach function. */
	listen(handler: (frame: RpcFrame) => void): () => void;
}

/** Shared memory and reply port that let a worker block on main-thread replies. */
export interface RpcSyncChannel {
	/** Reply port; only ever drained with `receiveMessageOnPort`, never listened to. */
	readonly port: MessagePort;
	/** Index 0 increments after every reply posted to {@link port}. */
	readonly counter: Int32Array;
}

/** Custom wire representation for a value type both threads can rebuild (e.g. session tokens). */
export interface RpcCodec<T> {
	/** Unique tag on the wire. */
	readonly kind: string;
	is(value: unknown): value is T;
	encode(value: T): unknown;
	decode(data: unknown): unknown;
}

/** Calls from a remote-object proxy to its target object on the other thread. */
export interface RemoteObject<P extends RpcApi> {
	/** Id of the target on this link; stable for the target's lifetime. */
	readonly id: number;
	call<K extends keyof P & string>(method: K, ...args: P[K]["args"]): Promise<P[K]["result"]>;
	/** Worker importers only; the exporter's method MUST be synchronous. */
	callSync<K extends keyof P & string>(method: K, ...args: P[K]["args"]): P[K]["result"];
	notify<K extends keyof P & string>(method: K, ...args: P[K]["args"]): void;
}

/** Options for {@link RpcLink.exportClass}. */
export interface RpcExportClassOptions {
	/** Importers send arguments of this class's methods lossily, as for {@link rpcLossy} functions. */
	readonly lossy?: boolean;
}

/** Exporter-side implementation of a remote-object protocol over target `T`. */
export type RpcServe<T, P extends RpcApi> = {
	[K in keyof P]: (target: T, ...args: P[K]["args"]) => P[K]["result"] | Promise<P[K]["result"]>;
};

/** Options for {@link RpcLink}. */
export interface RpcLinkOptions {
	/** Label for logs and error messages, e.g. `main↔w1`. */
	readonly name: string;
	/** Worker side: enables {@link RpcLink.callSync}. */
	readonly sync?: RpcSyncChannel;
	/** Main side: where sync replies go. */
	readonly syncReplies?: RpcSyncChannel;
	/** Upper bound for one sync call; a wedged main thread fails the call instead of hanging the worker. */
	readonly syncTimeoutMs?: number;
}

/** A value could not be encoded for the wire. */
export class RpcEncodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcEncodeError";
	}
}

/** The link closed before the call settled, or a call was attempted after close. */
export class RpcClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcClosedError";
	}

	static forLink(link: string, reason?: string): RpcClosedError {
		return new RpcClosedError(reason ? `RPC link ${link} closed: ${reason}` : `RPC link ${link} closed`);
	}
}

/** A synchronous call got no reply within its deadline. */
export class RpcTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcTimeoutError";
	}
}

const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
const TAG = "__rpc";
const FN_METHOD = "\u0000fn";
const OBJ_METHOD = "\u0000obj";

type ErrorFactory = (message: string) => Error;
const errorFactories = new Map<string, ErrorFactory>();

/**
 * Register how to rebuild an error class by its `name` on the receiving
 * thread, so `instanceof` checks (abort errors, busy errors) survive a hop.
 * Own enumerable cloneable fields are copied onto the rebuilt error.
 */
export function registerRpcError(name: string, create: ErrorFactory): void {
	errorFactories.set(name, create);
}

const kRpcSync = Symbol("rpc.sync");

/**
 * Mark a function so a worker importing it calls it synchronously. Only
 * meaningful for functions the main thread sends to a worker.
 */
export function rpcSync<F extends (...args: never[]) => unknown>(fn: F): F {
	Reflect.set(fn, kRpcSync, true);
	return fn;
}

const kRpcLossy = Symbol("rpc.lossy");

/**
 * Mark a function so importers send its arguments lossily: a class instance
 * no codec or exported class covers arrives as a plain record of its own
 * enumerable fields plus the values of the getters its prototypes define
 * (accessors are how classes expose data, e.g. a tool's `description`;
 * methods are behavior and are left out), copied recursively with shared
 * references and cycles preserved. Functions, proxies, signals, promises,
 * errors, exported-class objects, and codec values cross exactly as in
 * strict mode. For callbacks that must observe whatever in-process callers
 * pass (telemetry hooks); combine with {@link rpcSync} freely.
 */
export function rpcLossy<F extends (...args: never[]) => unknown>(fn: F): F {
	Reflect.set(fn, kRpcLossy, true);
	return fn;
}

const kRpcProxy = Symbol("rpc.proxy");

/**
 * Whether `value` is a proxy this thread imported over some link (a remote
 * function or an `importClass` object), so sending it back travels as a
 * reference to the other thread's original.
 */
export function isRpcProxy(value: unknown): boolean {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		Reflect.get(value, kRpcProxy) === true
	);
}

/** Per-link id this link wrote onto `value` under `key`, if any. */
function readTag(value: object, key: symbol): number | undefined {
	const tag: unknown = Reflect.get(value, key);
	return typeof tag === "number" ? tag : undefined;
}

type SyncReply = { id: number; ok: true; v: unknown } | { id: number; ok: false; e: unknown };

type ErrorTag = {
	[TAG]: "err";
	name: string;
	message: string;
	stack?: string;
	cause?: unknown;
	props?: Record<string, unknown>;
	/** Own non-enumerable data fields (e.g. pi-ai's classification `errorId`); restored non-enumerable. */
	hidden?: Record<string, unknown>;
};

type Tagged =
	| { [TAG]: "fn"; id: number; sync: boolean; lossy: boolean }
	| { [TAG]: "sig"; id: number; aborted: boolean; reason: unknown }
	| { [TAG]: "p"; id: number }
	| { [TAG]: "obj"; kind: string; id: number; lossy: boolean }
	| { [TAG]: "back"; id: number }
	| ErrorTag
	| { [TAG]: "codec"; kind: string; data: unknown }
	| EscapeTag;

/**
 * User record that itself carries an own {@link TAG} key: `v` is the record
 * with its fields encoded, marker key included, decoded field-by-field
 * without tag interpretation.
 */
type EscapeTag = { [TAG]: "esc"; v: Record<string, unknown> };

/** Wrap `record` in an {@link EscapeTag} when it has an own {@link TAG} key. */
function escapeRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.hasOwn(record, TAG) ? ({ [TAG]: "esc", v: record } satisfies EscapeTag) : record;
}

/**
 * Sole element of a lossy call's frame arguments when their copy reaches
 * some object twice (shared across or within arguments, or cyclic): the
 * whole argument vector, decoded cycle-safe. Never nested inside a value.
 */
type GraphArgs = { [TAG]: "graph"; v: unknown[] };

function isGraphArgs(value: unknown): value is GraphArgs {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, TAG) === "graph" &&
		Array.isArray(Reflect.get(value, "v"))
	);
}

/**
 * Write `key` onto a fresh copy as an own data property. Plain assignment
 * would run `Object.prototype`'s `__proto__` setter for that key (a field
 * JSON parsing can produce) instead of copying it.
 */
function putField(copy: Record<string, unknown>, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		copy[key] = value;
	}
}

/** Encode state of one lossy call's argument vector. */
class PlainCopies {
	/** Source object → its encoded copy, so shared references and cycles map to one copy. */
	readonly copies = new Map<object, unknown>();
	/** Some copy was reached again: the encoded value is a graph, not a tree. */
	revisited = false;
}

/** Settles one awaited value; method syntax keeps typed resolvers assignable. */
interface Settler {
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

/** Served method; method syntax lets a typed handler stand in for the untyped dispatcher. */
interface Handler {
	invoke(args: unknown[]): unknown;
}

/** Served remote-object method; method syntax lets typed `serve` entries stand in. */
interface ObjectHandler {
	invoke(target: unknown, args: unknown[]): unknown;
}

interface ExportedClass {
	is(value: unknown): boolean;
	methods: Map<string, ObjectHandler>;
	lossy: boolean;
}

/** One value this side sent: a function, signal, or exported-class object. */
interface ExportEntry {
	value: unknown;
	/** Exported-class methods; absent for functions and signals. */
	methods?: Map<string, ObjectHandler>;
	/** Sends not yet released by the importer. */
	refs: number;
	detach?: () => void;
}

/** Proxy this side holds for a value the other side sent. */
interface ImportEntry {
	ref: WeakRef<object>;
	/** Receipts since the last release, returned to the exporter on release. */
	receipts: number;
	/** Mirrored signals: the controller that aborts the proxy signal. */
	controller?: AbortController;
}

/** One end of a main↔worker RPC channel. See the module doc. */
export class RpcLink<Local extends RpcApi, Remote extends RpcApi> {
	readonly name: string;
	readonly #endpoint: RpcEndpoint;
	readonly #sync: RpcSyncChannel | undefined;
	readonly #syncReplies: RpcSyncChannel | undefined;
	readonly #syncTimeoutMs: number;
	readonly #handlers = new Map<string, Handler>();
	readonly #notes = new Map<string, Handler>();
	readonly #pending = new Map<number, Settler>();
	readonly #codecs: RpcCodec<unknown>[] = [];
	readonly #exportedClasses = new Map<string, ExportedClass>();
	readonly #importedClasses = new Map<string, (remote: RemoteObject<RpcApi>) => object>();
	readonly #detach: () => void;
	/** This link's id on values it exported; one value can be exported over several links. */
	readonly #exportKey: symbol;
	/** This link's id on proxies it imported; encoding one sends a back-reference. */
	readonly #importKey: symbol;
	#nextId = 1;
	#closed: string | undefined;

	readonly #exports = new Map<number, ExportEntry>();
	readonly #imports = new Map<number, ImportEntry>();
	readonly #promiseImports = new Map<number, Settler>();
	readonly #finalizer = new FinalizationRegistry<number>(id => this.#queueRelease(id));
	#releaseQueue: Map<number, number> | undefined;

	constructor(endpoint: RpcEndpoint, options: RpcLinkOptions) {
		this.name = options.name;
		this.#endpoint = endpoint;
		this.#sync = options.sync;
		this.#syncReplies = options.syncReplies;
		this.#syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
		this.#exportKey = Symbol(`rpc.export.${options.name}`);
		this.#importKey = Symbol(`rpc.import.${options.name}`);
		this.#detach = endpoint.listen(frame => this.#receive(frame));
	}

	/** Whether {@link close} ran (locally or because the transport died). */
	get closed(): boolean {
		return this.#closed !== undefined;
	}

	/** Whether this end can make {@link callSync} calls (worker ends only). */
	get canCallSync(): boolean {
		return this.#sync !== undefined;
	}

	/** Serve `method` for {@link call} and {@link callSync} from the other side. */
	handle<K extends keyof Local & string>(
		method: K,
		fn: (...args: Local[K]["args"]) => Local[K]["result"] | Promise<Local[K]["result"]>,
	): void {
		this.#handlers.set(method, { invoke: (args: Local[K]["args"]) => fn(...args) });
	}

	/** Serve `method` for {@link notify} from the other side; the return value is ignored. */
	onNotify<K extends keyof Local & string>(method: K, fn: (...args: Local[K]["args"]) => void): void {
		this.#notes.set(method, { invoke: (args: Local[K]["args"]) => fn(...args) });
	}

	/** Register a codec; the other side must register one with the same `kind`. */
	codec<T>(codec: RpcCodec<T>): void {
		this.#codecs.push(codec);
	}

	/**
	 * Send instances matching `is` by reference: the other side, having called
	 * {@link importClass} with the same `kind`, receives one canonical proxy per
	 * object and calls `serve` through it.
	 */
	exportClass<T, P extends RpcApi>(
		kind: string,
		is: (value: unknown) => value is T,
		serve: RpcServe<T, P>,
		options?: RpcExportClassOptions,
	): void {
		const methods = new Map<string, ObjectHandler>();
		const bind = <K extends keyof P & string>(method: K): ObjectHandler => ({
			invoke: (target: T, args: P[K]["args"]) => serve[method](target, ...args),
		});
		for (const method in serve) methods.set(method, bind(method));
		this.#exportedClasses.set(kind, { is, methods, lossy: options?.lossy === true });
	}

	/** Build proxies for objects the other side exports under `kind` (see {@link exportClass}). */
	importClass<R extends object, P extends RpcApi>(kind: string, create: (remote: RemoteObject<P>) => R): void {
		this.#importedClasses.set(kind, create);
	}

	/** Call `method` on the other side. Rejects with the remote error, or {@link RpcClosedError}. */
	call<K extends keyof Remote & string>(method: K, ...args: Remote[K]["args"]): Promise<Remote[K]["result"]> {
		const { promise, resolve, reject } = Promise.withResolvers<Remote[K]["result"]>();
		this.#request(method, args, { resolve, reject });
		return promise;
	}

	/** Fire-and-forget `method` on the other side. Dropped silently after close. */
	notify<K extends keyof Remote & string>(method: K, ...args: Remote[K]["args"]): void {
		this.#notifyRaw(method, args);
	}

	/**
	 * Worker only: call `method` on the main thread and block until it replies.
	 * The main-side handler MUST be synchronous.
	 *
	 * @throws {RpcClosedError} after close.
	 * @throws {RpcTimeoutError} when main does not reply within the deadline.
	 * @throws the remote handler's error, rebuilt.
	 */
	callSync<K extends keyof Remote & string>(method: K, ...args: Remote[K]["args"]): Remote[K]["result"] {
		return typedResult<Remote[K]["result"]>(this.#requestSync(method, args));
	}

	/** Close the link: reject pending calls, drop handles, detach the endpoint. Idempotent. */
	close(reason = "closed"): void {
		if (this.#closed !== undefined) return;
		this.#closed = reason;
		this.#detach();
		const error = RpcClosedError.forLink(this.name, reason);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		for (const pending of this.#promiseImports.values()) pending.reject(error);
		this.#promiseImports.clear();
		for (const entry of this.#exports.values()) entry.detach?.();
		this.#exports.clear();
		for (const entry of this.#imports.values()) entry.controller?.abort(error);
		this.#imports.clear();
	}

	#request(method: string, args: unknown[], settler: Settler, lossy = false): void {
		if (this.#closed !== undefined) {
			settler.reject(RpcClosedError.forLink(this.name, this.#closed));
			return;
		}
		let encoded: unknown[];
		try {
			encoded = this.#encodeArgs(args, lossy);
		} catch (error) {
			settler.reject(error);
			return;
		}
		const id = this.#nextId++;
		this.#pending.set(id, settler);
		try {
			this.#endpoint.send({ t: "call", id, m: method, a: encoded });
		} catch (error) {
			// DataCloneError: fail this one call, never the link.
			this.#pending.delete(id);
			settler.reject(error);
		}
	}

	#notifyRaw(method: string, args: unknown[], lossy = false): void {
		if (this.#closed !== undefined) return;
		this.#endpoint.send({ t: "note", m: method, a: this.#encodeArgs(args, lossy) });
	}

	#requestSync(method: string, args: unknown[], lossy = false): unknown {
		const sync = this.#sync;
		if (!sync) throw new Error(`RPC link ${this.name} has no sync channel`);
		if (this.#closed !== undefined) throw RpcClosedError.forLink(this.name, this.#closed);
		const id = this.#nextId++;
		this.#endpoint.send({ t: "sync", id, m: method, a: this.#encodeArgs(args, lossy) });
		const deadline = performance.now() + this.#syncTimeoutMs;
		for (;;) {
			// Load before draining: a reply posted after the drain bumps the counter and voids the wait.
			const seen = Atomics.load(sync.counter, 0);
			const received = receiveMessageOnPort(sync.port);
			if (received) {
				const reply: SyncReply = received.message;
				// A late reply to an earlier call that timed out; its caller already gave up.
				if (reply.id !== id) continue;
				if (!reply.ok) throw this.#decode(reply.e);
				return this.#decode(reply.v);
			}
			const remaining = deadline - performance.now();
			if (remaining <= 0) {
				throw new RpcTimeoutError(
					`Sync RPC ${method} on ${this.name} got no reply within ${this.#syncTimeoutMs}ms`,
				);
			}
			Atomics.wait(sync.counter, 0, seen, remaining);
		}
	}

	#receive(frame: RpcFrame): void {
		if (this.#closed !== undefined) return;
		switch (frame.t) {
			case "call":
				this.#serveAsync(frame.id, frame.m, frame.a);
				return;
			case "sync":
				this.#serveSync(frame.id, frame.m, frame.a);
				return;
			case "ok":
			case "err": {
				const pending = this.#pending.get(frame.id);
				if (!pending) return;
				this.#pending.delete(frame.id);
				try {
					if (frame.t === "ok") pending.resolve(this.#decode(frame.v));
					else pending.reject(this.#decode(frame.e));
				} catch (error) {
					pending.reject(error);
				}
				return;
			}
			case "note":
				try {
					if (frame.m === OBJ_METHOD) {
						this.#dispatch(frame.m, this.#decodeArgs(frame.a));
						return;
					}
					const handler = this.#notes.get(frame.m);
					if (!handler) {
						logger.warn("RPC notification has no handler", { link: this.name, method: frame.m });
						return;
					}
					handler.invoke(this.#decodeArgs(frame.a));
				} catch (error) {
					logger.error("RPC notification handler threw", { link: this.name, method: frame.m, error });
				}
				return;
			case "abort": {
				const imported = this.#imports.get(frame.sig);
				imported?.controller?.abort(this.#decode(frame.reason));
				return;
			}
			case "settle": {
				const pending = this.#promiseImports.get(frame.p);
				if (!pending) return;
				this.#promiseImports.delete(frame.p);
				try {
					const value = this.#decode(frame.v);
					if (frame.ok) pending.resolve(value);
					else pending.reject(value);
				} catch (error) {
					pending.reject(error);
				}
				return;
			}
			case "release":
				for (const [id, count] of frame.ids) this.#unref(id, count);
				return;
		}
	}

	#serveAsync(id: number, method: string, rawArgs: unknown[]): void {
		const fail = (error: unknown): void => {
			if (this.#closed !== undefined) return;
			this.#endpoint.send({ t: "err", id, e: this.#encodeError(error) });
		};
		let result: unknown;
		try {
			result = this.#dispatch(method, this.#decodeArgs(rawArgs));
		} catch (error) {
			fail(error);
			return;
		}
		Promise.resolve(result).then(value => {
			if (this.#closed !== undefined) return;
			try {
				this.#endpoint.send({ t: "ok", id, v: this.#encode(value) });
			} catch (error) {
				// The result could not be encoded or cloned: report that instead of leaving the caller hanging.
				fail(error);
			}
		}, fail);
	}

	#serveSync(id: number, method: string, rawArgs: unknown[]): void {
		const channel = this.#syncReplies;
		if (!channel) {
			logger.error("Sync RPC received without a reply channel", { link: this.name, method });
			return;
		}
		let reply: SyncReply;
		try {
			const result = this.#dispatch(method, this.#decodeArgs(rawArgs));
			if (result instanceof Promise) {
				result.catch(() => {});
				throw new Error(`Sync RPC ${method} has an async handler`);
			}
			reply = { id, ok: true, v: this.#encode(result) };
		} catch (error) {
			reply = { id, ok: false, e: this.#encodeError(error) };
		}
		try {
			channel.port.postMessage(reply);
		} catch (error) {
			channel.port.postMessage({ id, ok: false, e: this.#encodeError(error) } satisfies SyncReply);
		}
		Atomics.add(channel.counter, 0, 1);
		Atomics.notify(channel.counter, 0);
	}

	#dispatch(method: string, args: unknown[]): unknown {
		if (method === FN_METHOD) {
			const [fnId, ...rest] = args;
			const entry = typeof fnId === "number" ? this.#exports.get(fnId) : undefined;
			if (!entry || typeof entry.value !== "function") {
				throw new Error(`Remote function ${String(fnId)} was released`);
			}
			return entry.value(...rest);
		}
		if (method === OBJ_METHOD) {
			const [objId, name, ...rest] = args;
			const entry = typeof objId === "number" ? this.#exports.get(objId) : undefined;
			const handler = typeof name === "string" ? entry?.methods?.get(name) : undefined;
			if (!entry || !handler) throw new Error(`Remote object ${String(objId)} has no method ${String(name)}`);
			return handler.invoke(entry.value, rest);
		}
		const handler = this.#handlers.get(method);
		if (!handler) throw new Error(`RPC method ${method} is not served by ${this.name}`);
		return handler.invoke(args);
	}

	#encodeArgs(args: unknown[], lossy: boolean): unknown[] {
		if (lossy) {
			// One copy table for the whole vector: an object passed in two positions arrives as one object.
			const copies = new PlainCopies();
			const encoded: unknown[] = [];
			for (const arg of args) encoded.push(this.#encode(arg, copies));
			return copies.revisited ? [{ [TAG]: "graph", v: encoded } satisfies GraphArgs] : encoded;
		}
		const encoded = this.#encode(args);
		return Array.isArray(encoded) ? encoded : args;
	}

	#decodeArgs(args: unknown[]): unknown[] {
		const [only] = args;
		if (args.length === 1 && isGraphArgs(only)) return this.#decodeGraph(only.v);
		const decoded = this.#decode(args);
		return Array.isArray(decoded) ? decoded : [];
	}

	/**
	 * Copy-on-write encode: returns `value` itself when nothing inside needed
	 * encoding. With `copies` (lossy mode), containers are always copied and
	 * otherwise-refused class instances become plain copies.
	 */
	#encode(value: unknown, copies?: PlainCopies): unknown {
		if (typeof value === "function") {
			const back = readTag(value, this.#importKey);
			if (back !== undefined) return { [TAG]: "back", id: back } satisfies Tagged;
			const id = this.#export(value);
			return {
				[TAG]: "fn",
				id,
				sync: Reflect.get(value, kRpcSync) === true,
				lossy: Reflect.get(value, kRpcLossy) === true,
			} satisfies Tagged;
		}
		if (typeof value === "symbol") {
			if (copies) return undefined;
			throw new RpcEncodeError(`Cannot send symbol ${String(value)} across threads`);
		}
		if (value === null || typeof value !== "object") return value;
		const back = readTag(value, this.#importKey);
		if (back !== undefined) return { [TAG]: "back", id: back } satisfies Tagged;
		for (const codec of this.#codecs) {
			if (codec.is(value)) {
				return { [TAG]: "codec", kind: codec.kind, data: this.#encode(codec.encode(value), copies) };
			}
		}
		for (const [kind, exported] of this.#exportedClasses) {
			if (exported.is(value)) {
				return {
					[TAG]: "obj",
					kind,
					id: this.#export(value, exported.methods),
					lossy: exported.lossy,
				} satisfies Tagged;
			}
		}
		if (copies) {
			const known = copies.copies.get(value);
			if (known !== undefined) {
				copies.revisited = true;
				return known;
			}
			if (Array.isArray(value)) {
				const copy: unknown[] = [];
				copies.copies.set(value, copy);
				for (const item of value) copy.push(this.#encode(item, copies));
				return copy;
			}
			if (isPlainRecord(value)) {
				const copy: Record<string, unknown> = {};
				// Revisits must reach the escape wrapper, never the bare marker-bearing copy.
				const wire = Object.hasOwn(value, TAG) ? ({ [TAG]: "esc", v: copy } satisfies EscapeTag) : copy;
				copies.copies.set(value, wire);
				for (const key in value) putField(copy, key, this.#encode(value[key], copies));
				return wire;
			}
		}
		if (Array.isArray(value)) {
			let copy: unknown[] | undefined;
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				const encoded = this.#encode(item);
				if (encoded !== item && !copy) copy = value.slice(0, i);
				copy?.push(encoded);
			}
			return copy ?? value;
		}
		if (isPlainRecord(value)) {
			let copy: Record<string, unknown> | undefined;
			for (const key in value) {
				const item = value[key];
				const encoded = this.#encode(item);
				if (encoded !== item && !copy) copy = { ...value };
				if (copy) copy[key] = encoded;
			}
			return escapeRecord(copy ?? value);
		}
		if (value instanceof Error) return this.#encodeError(value);
		if (value instanceof AbortSignal) return this.#exportSignal(value);
		if (value instanceof Promise) return this.#exportPromise(value);
		if (isStructuredData(value)) return value;
		// A proxy imported over another link is live; a copy of it would be meaningless.
		if (copies && Reflect.get(value, kRpcProxy) !== true) return this.#plainCopy(value, copies);
		throw new RpcEncodeError(
			`Cannot send ${value.constructor?.name ?? "object"} instance across threads (${this.name})`,
		);
	}

	/**
	 * Lossy copy of class instance `value` (see {@link rpcLossy}): own
	 * enumerable fields, then getter values from the prototype chain below
	 * `Object.prototype` (nearest definition wins). A field or getter that
	 * throws is left out.
	 */
	#plainCopy(value: object, copies: PlainCopies): Record<string, unknown> {
		const copy: Record<string, unknown> = {};
		// Escape conservatively: any `__rpc` field or getter may land in the copy.
		const wire = TAG in value ? ({ [TAG]: "esc", v: copy } satisfies EscapeTag) : copy;
		copies.copies.set(value, wire);
		const copyField = (key: string): void => {
			let item: unknown;
			try {
				item = Reflect.get(value, key);
			} catch {
				return;
			}
			putField(copy, key, this.#encode(item, copies));
		};
		for (const key in value) {
			if (Object.hasOwn(value, key)) copyField(key);
		}
		// Keys a nearer prototype already defines shadow a farther getter of the same name.
		const seen = new Set<string>();
		for (
			let proto: object | null = Object.getPrototypeOf(value);
			proto !== null && proto !== Object.prototype;
			proto = Object.getPrototypeOf(proto)
		) {
			for (const key of Object.getOwnPropertyNames(proto)) {
				if (seen.has(key) || Object.hasOwn(value, key)) continue;
				seen.add(key);
				if (typeof Object.getOwnPropertyDescriptor(proto, key)?.get === "function") copyField(key);
			}
		}
		return wire;
	}

	/** Decode a {@link GraphArgs} vector in place, stopping at objects already decoded. */
	#decodeGraph(args: unknown[]): unknown[] {
		const visited = new Map<object, unknown>();
		for (let i = 0; i < args.length; i++) args[i] = this.#decode(args[i], visited);
		return args;
	}

	/**
	 * Decode in place; `visited` (graph arguments only) maps each wire object
	 * already reached to its decoded value, so shared and cyclic references
	 * decode once.
	 */
	#decode(value: unknown, visited?: Map<object, unknown>): unknown {
		if (value === null || typeof value !== "object") return value;
		if (visited) {
			if (visited.has(value)) return visited.get(value);
			visited.set(value, value);
		}
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) value[i] = this.#decode(value[i], visited);
			return value;
		}
		if (!isPlainRecord(value)) return value;
		if (isTagged(value)) return this.#decodeTagged(value, visited);
		return this.#decodeFields(value, visited);
	}

	/** Decode each field of `record` in place, without reading `record` itself as a tag. */
	#decodeFields(record: Record<string, unknown>, visited: Map<object, unknown> | undefined): Record<string, unknown> {
		for (const key in record) record[key] = this.#decode(record[key], visited);
		return record;
	}

	#decodeTagged(tagged: Tagged, visited: Map<object, unknown> | undefined): unknown {
		switch (tagged[TAG]) {
			case "esc": {
				const record = tagged.v;
				if (visited) {
					// Map the wrapper first: a cycle through this record re-enters via the wrapper.
					visited.set(tagged, record);
					if (visited.has(record)) return record;
					visited.set(record, record);
				}
				return this.#decodeFields(record, visited);
			}
			case "fn":
				return this.#importFunction(tagged.id, tagged.sync, tagged.lossy);
			case "sig":
				return this.#importSignal(tagged.id, tagged.aborted, tagged.reason);
			case "p":
				return this.#importPromise(tagged.id);
			case "obj":
				return this.#importObject(tagged.kind, tagged.id, tagged.lossy);
			case "back": {
				const entry = this.#exports.get(tagged.id);
				if (!entry) throw new Error(`Back-reference ${tagged.id} on ${this.name} names a released value`);
				return entry.value;
			}
			case "err":
				return this.#decodeError(tagged);
			case "codec": {
				const codec = this.#codecs.find(candidate => candidate.kind === tagged.kind);
				if (!codec) throw new Error(`No RPC codec for ${tagged.kind} on ${this.name}`);
				return codec.decode(this.#decode(tagged.data, visited));
			}
		}
	}

	#encodeError(error: unknown): unknown {
		if (!(error instanceof Error)) {
			try {
				const encoded = this.#encode(error);
				structuredClone(encoded);
				return encoded;
			} catch {
				return String(error);
			}
		}
		const tag: ErrorTag = { [TAG]: "err", name: error.name, message: error.message, stack: error.stack };
		// Own data fields only: inherited WebIDL accessors (DOMException `code`/`name`) cannot be reassigned.
		for (const key of Object.getOwnPropertyNames(error)) {
			if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
			const descriptor = Object.getOwnPropertyDescriptor(error, key);
			if (!descriptor || !("value" in descriptor)) continue;
			try {
				const encoded = this.#encode(descriptor.value);
				structuredClone(encoded);
				const bucket = descriptor.enumerable ? (tag.props ??= {}) : (tag.hidden ??= {});
				bucket[key] = encoded;
			} catch {
				// Unsendable field (live handle, socket): drop it, keep the error.
			}
		}
		if (error.cause !== undefined) tag.cause = this.#encodeError(error.cause);
		return tag;
	}

	#decodeError(tagged: ErrorTag): Error {
		const factory = errorFactories.get(tagged.name);
		const error = factory ? factory(tagged.message) : new Error(tagged.message);
		if (!factory && tagged.name !== "Error") error.name = tagged.name;
		if (tagged.stack) Reflect.set(error, "stack", tagged.stack);
		if (tagged.cause !== undefined) Reflect.set(error, "cause", this.#decode(tagged.cause));
		// Field buckets are protocol containers: an error field named `__rpc` must not read as a tag.
		const hidden = tagged.hidden === undefined ? undefined : this.#decodeFields(tagged.hidden, undefined);
		if (hidden !== undefined) {
			for (const key in hidden) {
				try {
					Object.defineProperty(error, key, {
						value: hidden[key],
						enumerable: false,
						configurable: true,
						writable: true,
					});
				} catch {
					// Non-configurable on the rebuilt class; the constructor already set it.
				}
			}
		}
		const props = tagged.props === undefined ? undefined : this.#decodeFields(tagged.props, undefined);
		if (props !== undefined) {
			for (const key in props) {
				try {
					Reflect.set(error, key, props[key]);
				} catch {
					// Read-only on the rebuilt class; the constructor already set it.
				}
			}
		}
		return error;
	}

	/** Register `value` (or bump its count) in the export table; returns its id on this link. */
	#export(value: object, methods?: Map<string, ObjectHandler>): number {
		const known = readTag(value, this.#exportKey);
		const existing = known === undefined ? undefined : this.#exports.get(known);
		if (existing && known !== undefined) {
			existing.refs++;
			return known;
		}
		const id = this.#nextId++;
		Reflect.set(value, this.#exportKey, id);
		this.#exports.set(id, { value, methods, refs: 1 });
		return id;
	}

	/** Canonical proxy per id: reuse a live one, else build it and arm release-on-GC. */
	#adopt<T extends object>(id: number, build: () => T, controller?: AbortController): T {
		const known = this.#imports.get(id);
		const existing = known?.ref.deref();
		if (known && existing) {
			known.receipts++;
			return typedResult<T>(existing);
		}
		const proxy = build();
		Reflect.set(proxy, this.#importKey, id);
		Reflect.set(proxy, kRpcProxy, true);
		this.#imports.set(id, { ref: new WeakRef(proxy), receipts: (known?.receipts ?? 0) + 1, controller });
		this.#finalizer.register(proxy, id);
		return proxy;
	}

	#importFunction(id: number, sync: boolean, lossy: boolean): (...args: unknown[]) => unknown {
		return this.#adopt(id, () =>
			sync && this.#sync
				? (...args: unknown[]): unknown => this.#requestSync(FN_METHOD, [id, ...args], lossy)
				: (...args: unknown[]): Promise<unknown> => {
						const { promise, resolve, reject } = Promise.withResolvers<unknown>();
						this.#request(FN_METHOD, [id, ...args], { resolve, reject }, lossy);
						return promise;
					},
		);
	}

	#importObject(kind: string, id: number, lossy: boolean): object {
		const create = this.#importedClasses.get(kind);
		if (!create) throw new Error(`No imported class ${kind} on ${this.name}`);
		return this.#adopt(id, () => create(this.#remoteObject(id, lossy)));
	}

	#remoteObject(id: number, lossy: boolean): RemoteObject<RpcApi> {
		return {
			id,
			call: (method, ...args) => {
				const { promise, resolve, reject } = Promise.withResolvers<unknown>();
				this.#request(OBJ_METHOD, [id, method, ...args], { resolve, reject }, lossy);
				return promise;
			},
			callSync: (method, ...args) => this.#requestSync(OBJ_METHOD, [id, method, ...args], lossy),
			notify: (method, ...args) => this.#notifyRaw(OBJ_METHOD, [id, method, ...args], lossy),
		};
	}

	#exportSignal(signal: AbortSignal): Tagged {
		const known = readTag(signal, this.#exportKey);
		const fresh = known === undefined || !this.#exports.has(known);
		const id = this.#export(signal);
		const entry = this.#exports.get(id);
		if (fresh && entry && !signal.aborted) {
			const onAbort = (): void => {
				if (this.#closed !== undefined) return;
				this.#endpoint.send({ t: "abort", sig: id, reason: this.#encodeError(signal.reason) });
			};
			signal.addEventListener("abort", onAbort, { once: true });
			entry.detach = () => signal.removeEventListener("abort", onAbort);
		}
		return {
			[TAG]: "sig",
			id,
			aborted: signal.aborted,
			reason: signal.aborted ? this.#encodeError(signal.reason) : undefined,
		};
	}

	#importSignal(id: number, aborted: boolean, reason: unknown): AbortSignal {
		const known = this.#imports.get(id);
		const existing = known?.ref.deref();
		if (known && existing instanceof AbortSignal) {
			known.receipts++;
			return existing;
		}
		const controller = new AbortController();
		if (aborted) controller.abort(this.#decode(reason));
		return this.#adopt(id, () => controller.signal, controller);
	}

	#exportPromise(promise: Promise<unknown>): Tagged {
		const known = readTag(promise, this.#exportKey);
		if (known !== undefined) return { [TAG]: "p", id: known };
		const id = this.#nextId++;
		Reflect.set(promise, this.#exportKey, id);
		const settle = (ok: boolean, value: unknown): void => {
			if (this.#closed !== undefined) return;
			try {
				const encoded = ok ? this.#encode(value) : this.#encodeError(value);
				this.#endpoint.send({ t: "settle", p: id, ok, v: encoded });
			} catch (error) {
				this.#endpoint.send({ t: "settle", p: id, ok: false, v: this.#encodeError(error) });
			}
		};
		promise.then(
			value => settle(true, value),
			error => settle(false, error),
		);
		return { [TAG]: "p", id };
	}

	#importPromise(id: number): Promise<unknown> {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#promiseImports.set(id, { resolve, reject });
		return promise;
	}

	#queueRelease(id: number): void {
		if (this.#closed !== undefined) return;
		const imported = this.#imports.get(id);
		// A newer proxy for the same id is alive; it carries the receipts forward.
		if (!imported || imported.ref.deref()) return;
		this.#imports.delete(id);
		if (!this.#releaseQueue) {
			this.#releaseQueue = new Map();
			queueMicrotask(() => this.#flushReleases());
		}
		this.#releaseQueue.set(id, (this.#releaseQueue.get(id) ?? 0) + imported.receipts);
	}

	#flushReleases(): void {
		const queue = this.#releaseQueue;
		this.#releaseQueue = undefined;
		if (!queue || this.#closed !== undefined) return;
		this.#endpoint.send({ t: "release", ids: [...queue] });
	}

	#unref(id: number, count: number): void {
		const entry = this.#exports.get(id);
		if (!entry) return;
		entry.refs -= count;
		if (entry.refs > 0) return;
		entry.detach?.();
		this.#exports.delete(id);
	}
}

/**
 * Trust-boundary conversion: a decoded wire value is the type its protocol
 * declares. Method-parameter bivariance lets the typed sink accept `unknown`.
 */
function typedResult<T>(value: unknown): T {
	let result!: T;
	const sink: { put(item: unknown): void } = {
		put: (item: T) => {
			result = item;
		},
	};
	sink.put(value);
	return result;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isTagged(value: Record<string, unknown>): value is Tagged {
	return typeof value[TAG] === "string";
}

/** Built-in structured-clone types passed through without walking. */
function isStructuredData(value: object): boolean {
	return (
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof Map ||
		value instanceof Set ||
		value instanceof ArrayBuffer ||
		value instanceof SharedArrayBuffer ||
		ArrayBuffer.isView(value) ||
		value instanceof Blob
	);
}

registerRpcError("AbortError", message => new DOMException(message, "AbortError"));
registerRpcError("TimeoutError", message => new DOMException(message, "TimeoutError"));
registerRpcError("RpcClosedError", message => new RpcClosedError(message));
registerRpcError("RpcTimeoutError", message => new RpcTimeoutError(message));
registerRpcError("RpcEncodeError", message => new RpcEncodeError(message));
