/**
 * A TSP connection: the `hello` handshake and everything the terminal
 * negotiated (version, kinds, features, credits, APC limit), message output
 * through the driver, reassembly and decoding of the terminal's messages, the
 * terminal's environment (width, appearance, motion, visibility, features) as
 * signals, and blob delivery.
 *
 * Optimistic start: in a Tern pane the host renders on an assumed `hello`
 * ({@link TspConnection.assume}) instead of waiting for the reply; the real
 * reply, when it comes, replaces what was assumed ({@link TspConnection.onHello}).
 *
 * Blob delivery: on the connection's first frame, blobs are asked about with a
 * `blobs` query (when the terminal lists the `blobs` feature) so ones it kept
 * from an earlier session are not resent; unanswered for
 * {@link BLOB_REPLY_MS}, they are uploaded anyway. Later blobs are uploaded
 * inline ahead of their frame. A `gone` naming a held blob re-uploads it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	TSP_DEFAULT_APC_LIMIT,
	TSP_DEFAULT_CREDITS,
	TSP_KINDS,
	TSP_VERSION,
	type TspEvent,
	type TspVerb,
} from "@oh-my-pi/pi-wire";
import type { InputEvent, TerminalDriver } from "../driver/contract";
import { type Accessor, batch, type Signal, signal } from "../reactive";
import {
	decodeTspEvent,
	decodeTspReply,
	encodeHelloQuery,
	encodeTsp,
	type RawTspMessage,
	TspChunkReader,
	type TspHelloOptions,
	type TspHelloReply,
} from "./apc";
import { getBlob } from "./blobs";

/** How long the first frame's `blobs` query may stay unanswered before uploading anyway. */
export const BLOB_REPLY_MS = 3000;
/** How long {@link TspConnection.connect} waits for the `hello` reply by default. */
export const HELLO_TIMEOUT_MS = 300;

/**
 * The reply a v1 terminal is assumed to give before its real `hello` arrives
 * (the `TERM_PROGRAM=tern` optimistic start): the whole vocabulary, the
 * default APC limit and credits, the driver's width and appearance, full
 * motion, and `blobs`, so a resumed session's images are asked about rather
 * than resent before the reply comes.
 */
export function assumedHello(driver: TerminalDriver): TspHelloReply {
	return {
		r: "hello",
		v: TSP_VERSION,
		term: "tern",
		kinds: TSP_KINDS,
		features: ["blobs"],
		apc: TSP_DEFAULT_APC_LIMIT,
		credits: TSP_DEFAULT_CREDITS,
		cols: driver.columns,
		dark: driver.capabilities.dark,
		reduceMotion: false,
	};
}

/** Timers the native backend uses (injectable for deterministic tests). */
export interface NativeClock {
	now(): number;
	/** Run `fn` after `ms`; returns a cancel function. */
	setTimeout(fn: () => void, ms: number): () => void;
}

/** Wall clock with unref'd timers. */
export const SYSTEM_CLOCK: NativeClock = {
	now: () => performance.now(),
	setTimeout(fn, ms) {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

/** Options of {@link TspConnection.connect}. */
export interface TspConnectOptions extends TspHelloOptions {
	/** The driver already sends the `hello` query (with its startup probes): only wait for the reply. */
	readonly queried?: boolean;
	/** Reply deadline in ms. Default {@link HELLO_TIMEOUT_MS}. */
	readonly timeout?: number;
	readonly clock?: NativeClock;
	/**
	 * Subscribes to the moment no reply can come any more (the driver's
	 * `onHelloSettled`: the batch carrying the `hello` got its DA1 answer); the
	 * handshake then resolves null without waiting out the deadline.
	 */
	readonly settled?: (listener: () => void) => () => void;
}

type EventListener = (event: TspEvent) => void;

/**
 * Where a connection's `hello` stands: `assumed` ({@link TspConnection.assume},
 * no reply yet), `confirmed` (the terminal's reply governs the connection), or
 * `unsupported` (the terminal answered a protocol version this build does not speak).
 */
export type HelloConfirmation = "assumed" | "confirmed" | "unsupported";

function apcLimitOf(hello: TspHelloReply): number {
	return hello.apc !== undefined && hello.apc > 0 ? hello.apc : TSP_DEFAULT_APC_LIMIT;
}

function creditsOf(hello: TspHelloReply): number {
	return hello.credits !== undefined && hello.credits > 0 ? hello.credits : TSP_DEFAULT_CREDITS;
}

/** See the module docs. */
export class TspConnection {
	readonly driver: TerminalDriver;
	readonly clock: NativeClock;
	/** Width of the terminal's surfaces in cells. */
	readonly cols: Signal<number>;
	readonly cell: Signal<{ readonly w: number; readonly h: number } | null>;
	readonly dark: Signal<boolean>;
	readonly reduceMotion: Signal<boolean>;
	readonly visible: Signal<boolean>;
	readonly #features: Signal<ReadonlySet<string>>;
	readonly #reader = new TspChunkReader();
	readonly #listeners = new Set<EventListener>();
	readonly #helloListeners = new Set<(confirmed: boolean) => void>();
	#hello: TspHelloReply;
	#apcLimit: number;
	#credits: number;
	readonly #kinds: Signal<ReadonlySet<string>>;
	#confirmation: HelloConfirmation = "confirmed";
	/** The terminal reported its width in a `resize` event (it outranks a later `hello`). */
	#sawResize = false;
	/** While assumed: stop following the driver's width and appearance. */
	#unfollow: (() => void) | undefined;
	readonly #held = new Set<string>();
	readonly #asking = new Set<string>();
	#firstPass = true;
	#cancelBlobWait: (() => void) | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(driver: TerminalDriver, hello: TspHelloReply, clock: NativeClock = SYSTEM_CLOCK) {
		this.driver = driver;
		this.#hello = hello;
		this.clock = clock;
		this.#apcLimit = apcLimitOf(hello);
		this.#credits = creditsOf(hello);
		this.cols = signal(hello.cols ?? driver.columns);
		this.cell = signal(hello.cell ?? null);
		this.dark = signal(hello.dark ?? driver.capabilities.dark);
		this.reduceMotion = signal(hello.reduceMotion === true);
		this.visible = signal(true);
		this.#features = signal<ReadonlySet<string>>(new Set(hello.features ?? []));
		this.#kinds = signal<ReadonlySet<string>>(new Set(hello.kinds));
		this.#unsubscribe = driver.onInput(event => this.#onInput(event));
	}

	/**
	 * Handshake: send `hello` (unless the driver does) and wait for the reply.
	 * Resolves null when the terminal does not answer in time or speaks
	 * another version. With `queried`, call it before `driver.start()` so the
	 * reply to the driver's probe is not missed.
	 */
	static connect(driver: TerminalDriver, options: TspConnectOptions = {}): Promise<TspConnection | null> {
		const clock = options.clock ?? SYSTEM_CLOCK;
		const { promise, resolve } = Promise.withResolvers<TspConnection | null>();
		const reader = new TspChunkReader();
		let settled = false;
		const finish = (reply: TspHelloReply | null): void => {
			if (settled) return;
			settled = true;
			off();
			cancel();
			offSettled?.();
			if (reply && reply.v === TSP_VERSION) resolve(new TspConnection(driver, reply, clock));
			else {
				if (reply) logger.debug("TSP: unsupported protocol version", { version: reply.v, term: reply.term });
				resolve(null);
			}
		};
		const off = driver.onInput(event => {
			if (event.type !== "tsp" || event.verb !== "r") return;
			const message = reader.feed(event);
			if (!message) return;
			const reply = decodeTspReply(message.body);
			if (reply?.r === "hello") finish(reply);
		});
		const cancel = clock.setTimeout(() => finish(null), options.timeout ?? HELLO_TIMEOUT_MS);
		const offSettled = options.settled?.(() => finish(null));
		if (!options.queried) driver.writeRaw(encodeHelloQuery(options));
		return promise;
	}

	/**
	 * A connection on {@link assumedHello}, for a terminal that names itself
	 * Tern: usable at once. Create it before `driver.start()` (it reads the
	 * reply to the driver's `hello` probe). Until the reply arrives it follows
	 * the driver's width and appearance; the reply then replaces everything
	 * assumed ({@link onHello}).
	 */
	static assume(driver: TerminalDriver, clock: NativeClock = SYSTEM_CLOCK): TspConnection {
		const connection = new TspConnection(driver, assumedHello(driver), clock);
		connection.#confirmation = "assumed";
		const offResize = driver.onResize(columns => {
			if (!connection.#sawResize) connection.cols.set(columns);
		});
		const offCapabilities = driver.onCapabilities(capabilities => connection.dark.set(capabilities.dark));
		connection.#unfollow = () => {
			offResize();
			offCapabilities();
		};
		return connection;
	}

	/** The terminal's `hello` reply (the assumed one until the terminal confirms it). */
	get hello(): TspHelloReply {
		return this.#hello;
	}

	/** Largest APC body sent unchunked. */
	get apcLimit(): number {
		return this.#apcLimit;
	}

	/** Frames a surface may have unacknowledged. */
	get credits(): number {
		return this.#credits;
	}

	/** Where the `hello` stands (always `confirmed` for a {@link connect}ed connection). */
	get confirmation(): HelloConfirmation {
		return this.#confirmation;
	}

	/**
	 * `listener` runs once the terminal answers an assumed connection's
	 * `hello`: true when the reply replaced the assumed one, false when the
	 * terminal speaks a version this build does not (the connection is then unusable).
	 */
	onHello(listener: (confirmed: boolean) => void): () => void {
		this.#helloListeners.add(listener);
		return () => this.#helloListeners.delete(listener);
	}

	/** The terminal's current features (reactive). */
	get features(): ReadonlySet<string> {
		return this.#features();
	}

	/** Whether the terminal lists `name` (reactive). */
	hasFeature(name: string): boolean {
		return this.#features().has(name);
	}

	/** Whether the terminal draws `kind` (reactive: an optimistic start assumes every kind until the reply). */
	supports(kind: string): boolean {
		return this.#kinds().has(kind);
	}

	/** Subscribe to every decoded terminal event (after the connection handled its own). */
	onEvent(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Send one message, chunked to the APC limit. */
	send(verb: TspVerb, body: string, params?: Readonly<Record<string, string>>): void {
		this.driver.writeRaw(encodeTsp(verb, body, params, this.apcLimit));
	}

	sendJson(verb: TspVerb, value: unknown): void {
		this.send(verb, JSON.stringify(value));
	}

	/**
	 * Make sure the terminal gets every registered blob among `ids` (see the
	 * module docs). Call before sending the frame that references them.
	 */
	ensureBlobs(ids: Iterable<string>): void {
		const fresh: string[] = [];
		for (const id of ids) {
			if (this.#held.has(id) || this.#asking.has(id) || !getBlob(id)) continue;
			if (!fresh.includes(id)) fresh.push(id);
		}
		const first = this.#firstPass;
		this.#firstPass = false;
		if (fresh.length === 0) return;
		if (!first || !this.hasFeature("blobs")) {
			for (const id of fresh) this.#upload(id);
			return;
		}
		for (const id of fresh) this.#asking.add(id);
		this.sendJson("q", { q: "blobs", ids: fresh });
		this.#cancelBlobWait = this.clock.setTimeout(() => {
			this.#cancelBlobWait = undefined;
			this.#answerBlobs([]);
		}, BLOB_REPLY_MS);
	}

	/** Whether the terminal holds blob `id` as far as this connection knows. */
	holds(id: string): boolean {
		return this.#held.has(id);
	}

	/** Stop reading the terminal's messages. */
	close(): void {
		this.#unfollow?.();
		this.#unfollow = undefined;
		this.#helloListeners.clear();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#cancelBlobWait?.();
		this.#cancelBlobWait = undefined;
		this.#reader.clear();
		this.#listeners.clear();
	}

	/**
	 * Adopt the terminal's real `hello` after an optimistic start: its APC
	 * limit, credits, kinds, features, cell size, appearance and motion. A
	 * width the terminal already reported in a `resize` event wins over the reply's.
	 */
	#confirm(reply: TspHelloReply): void {
		this.#unfollow?.();
		this.#unfollow = undefined;
		const confirmed = reply.v === TSP_VERSION;
		this.#confirmation = confirmed ? "confirmed" : "unsupported";
		if (confirmed) {
			this.#hello = reply;
			this.#apcLimit = apcLimitOf(reply);
			this.#credits = creditsOf(reply);
			batch(() => {
				this.#kinds.set(new Set(reply.kinds));
				if (!this.#sawResize && reply.cols !== undefined) this.cols.set(reply.cols);
				if (reply.cell) this.cell.set(reply.cell);
				if (reply.dark !== undefined) this.dark.set(reply.dark);
				this.reduceMotion.set(reply.reduceMotion === true);
				this.#features.set(new Set(reply.features ?? []));
			});
		} else {
			logger.debug("TSP: unsupported protocol version", { version: reply.v, term: reply.term });
		}
		for (const listener of this.#helloListeners) listener(confirmed);
	}

	#upload(id: string): void {
		const blob = getBlob(id);
		if (!blob) return;
		this.#held.add(id);
		this.send("b", Buffer.from(blob.bytes).toString("base64"), { id, mime: blob.mime });
	}

	#answerBlobs(have: readonly string[]): void {
		this.#cancelBlobWait?.();
		this.#cancelBlobWait = undefined;
		for (const id of have) if (this.#asking.has(id)) this.#held.add(id);
		const missing = [...this.#asking].filter(id => !this.#held.has(id));
		this.#asking.clear();
		for (const id of missing) this.#upload(id);
	}

	#onInput(event: InputEvent): void {
		if (event.type !== "tsp") return;
		const message = this.#reader.feed(event);
		if (message) this.#onMessage(message);
	}

	#onMessage(message: RawTspMessage): void {
		if (message.verb === "r") {
			const reply = decodeTspReply(message.body);
			if (reply?.r === "blobs") this.#answerBlobs(reply.have);
			else if (reply?.r === "hello" && this.#confirmation === "assumed") this.#confirm(reply);
			return;
		}
		if (message.verb !== "e") return;
		const event = decodeTspEvent(message.body);
		if (!event) {
			logger.debug("TSP: ignored malformed or unknown event", { body: message.body.slice(0, 200) });
			return;
		}
		switch (event.ev) {
			case "resize":
				this.#sawResize = true;
				this.cols.set(event.cols);
				if (event.cell) this.cell.set(event.cell);
				if (event.visible !== undefined) this.visible.set(event.visible);
				break;
			case "theme":
				this.dark.set(event.dark);
				break;
			case "motion":
				this.reduceMotion.set(event.reduce);
				break;
			case "features":
				this.#features.set(new Set(event.features));
				break;
			case "visible":
				// `sf` names the pane's live surface; the visibility is that of the pane.
				this.visible.set(event.visible);
				break;
			case "gone":
				for (const id of event.ids) {
					if (!this.#held.delete(id)) continue;
					this.#upload(id);
				}
				break;
			case "error":
				logger.warn("TSP: terminal reported an error", { sf: event.sf, s: event.s, op: event.op, msg: event.msg });
				break;
		}
		for (const listener of this.#listeners) listener(event);
	}
}

/** The terminal environment a reconciler reads (reactive). */
export interface NativeEnvironment {
	readonly cols: Accessor<number>;
	/** The terminal's height in cells (a narrow pane's sheets fill it once their content is tall). */
	readonly rows: Accessor<number>;
	hasFeature(name: string): boolean;
}
