import * as http2 from "node:http2";
import type { TLSSocket } from "node:tls";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { connectProxiedSocket, getProxyForUrl } from "../../utils/proxy";

/**
 * Pooled Cursor AI HTTP/2 transport owner. One place owns session lifetime:
 * reservation-before-connect, GOAWAY drain, a typed pre-dispatch ALPN outcome,
 * and proxy tunneling.
 *
 * A session is keyed by `baseUrl|proxyUrl` and reused for as many concurrent
 * streams as arrive. When the peer sends GOAWAY (or the session errors after
 * connect), the entry is marked draining: no new lease is issued from it, the
 * in-flight leases finish, and the session is destroyed once the last lease
 * releases.
 *
 * Reusable sessions are intentionally unreferenced while idle so the pool does
 * not keep short-lived consumers alive. This module registers no process-level
 * hooks; {@link disposeCursorH2Pool} remains available for deterministic
 * teardown and tests.
 */

/** Client wall-clock budget for establishing a proxy CONNECT tunnel + TLS. */
const PROXY_TUNNEL_TIMEOUT_MS = 30_000;
/**
 * Wall-clock budget for the direct h2 handshake — session creation through
 * the first `connect`/`error`. Independent of the optional caller
 * `AbortSignal`: an SDK caller that supplies none must never wait forever on
 * a peer that accepted TCP but never completes the handshake, and the shared
 * `connecting` reservation must be released so a later acquire reconnects.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** An h1-only peer answered the h2 handshake (typically an ALPN-stripping proxy). */
const H2_NOT_SUPPORTED = /h2 is not supported/i;

export interface CursorH2Lease {
	readonly request: http2.ClientHttp2Stream;
	release(): void;
}

export interface CursorH2AcquireOptions {
	baseUrl: string;
	/** Connect request path, e.g. `/agent.v1.AgentService/Run`. */
	requestPath: string;
	/** Full request headers. The pool owns `:method` / `:path` and adds both. */
	headers: http2.OutgoingHttpHeaders;
	provider: string;
	signal?: AbortSignal;
}

/**
 * A typed, pre-dispatch explanation of why HTTP/2 could not be used. This is
 * the ONLY input allowed to authorize the HTTP/1.1 fallback bridge; a timeout,
 * generic error, or user preference may never.
 */
export type CursorH2Unavailable = { reason: "alpn" | "connect-tunnel"; cause: unknown };
export type CursorH2Acquisition = { ok: true; lease: CursorH2Lease } | { ok: false; unavailable: CursorH2Unavailable };

interface PoolEntry {
	session: http2.ClientHttp2Session;
	outstanding: number;
	draining: boolean;
	/**
	 * Mirrors the live `ref()`/`unref()` state we drive on the session: true
	 * while at least one lease is outstanding, false once the session goes idle
	 * or is destroyed. Node/Bun expose `ref`/`unref` but no readable ref-state
	 * getter, so this tracked boolean IS the observable ref state — set only at
	 * the same points we call the underlying ref/unref, never independently.
	 */
	referenced: boolean;
	/**
	 * Wall-clock timestamp stamped when the entry last dropped to zero
	 * outstanding leases (or at creation), used by opportunistic idle
	 * eviction. Undefined while at least one lease is outstanding.
	 */
	idleSince: number | undefined;
}

/** Base-url → live (non-draining) session with its outstanding lease count. */
const pool = new Map<string, PoolEntry>();
/** Idle eviction window: a pooled session unused for this long is evicted. */
const IDLE_EVICT_MS = 60_000;
/** Hard cap on retained sessions. Age-based eviction alone lets rotating
 * origins accumulate live unref'd descriptors within the idle window. */
const MAX_RETAINED_SESSIONS = 8;

/**
 * An in-flight establishment alongside the handle that can terminate it.
 * Successful readiness publishes a live session but owns no request lease.
 * `cancel()` is destructive: it destroys the underlying session/socket so an
 * establishment whose peer accepted TCP but never completes the h2 handshake
 * still settles, instead of leaving disposal awaiting it forever.
 */
interface ConnectHandle {
	promise: Promise<CursorH2Readiness>;
	cancel(): void;
	/**
	 * Settles when the establishment body has FULLY exited — success, failure,
	 * and the done-teardown branches that destroy a session created after
	 * cancellation. Disposal awaits this, not just {@link promise} (which
	 * `cancel` settles immediately), so no teardown outlives disposal.
	 */
	settled: Promise<void>;
	/**
	 * Live acquisitions awaiting this establishment. Each waiter is bound to its
	 * own `options.signal`; this count is the single cancellation owner — only
	 * the LAST live waiter leaving before {@link finished} destroys the connect.
	 */
	waiters: number;
	/** True once {@link promise} has settled, so a late abort never cancels. */
	finished: boolean;
}
/**
 * Base-url → in-flight connect shared by concurrent acquisitions. This is the
 * reservation slot that stops a second acquisition from racing a duplicate
 * connect or grabbing a session that is about to be released.
 */
const connecting = new Map<string, ConnectHandle>();
/**
 * Disposal epoch. A connect started under one generation must not publish a
 * session after a later disposal cleared the pool. `establishSession` captures
 * the generation it began under and rejects if it no longer matches.
 */
let generation = 0;
/**
 * One-shot, test-only hook invoked synchronously with a just-connected fresh
 * entry before establishment readiness is published, so a test can force the
 * drained-before-first-lease retry branch deterministically (see
 * {@link __setCursorH2FreshSessionHook}).
 */
let __freshSessionHook: ((key: string, entry: PoolEntry | undefined) => void) | undefined;
/**
 * One-shot, test-only gate awaited by the establishment body immediately
 * before it creates its http2 session — the window where `cancel` has no
 * session to destroy — so a test can assert disposal awaits the body's
 * done-teardown (see {@link __setCursorH2EstablishBodyGate}).
 */
let __establishBodyGate: ((key: string) => Promise<void>) | undefined;
/**
 * Test-only handshake-deadline override (undefined = the production budget),
 * so the stalled-peer path is drivable in milliseconds; see
 * {@link __setCursorH2HandshakeTimeoutMs}.
 */
let __handshakeTimeoutMs: number | undefined;

function poolKey(baseUrl: string, proxyUrl: string | undefined): string {
	return `${baseUrl}|${proxyUrl ?? ""}`;
}

/** True when the raw connect error is the ALPN negotiation failure. */
function isAlpnUnavailable(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !(error instanceof Error)) return false;
	const code = "code" in error ? error.code : undefined;
	return code === "ERR_HTTP2_ERROR" && H2_NOT_SUPPORTED.test(error.message);
}

function destroyEntry(key: string, entry: PoolEntry): void {
	if (pool.get(key) === entry) {
		pool.delete(key);
	}
	entry.draining = true;
	try {
		entry.session.destroy();
	} catch {
		/* session already gone */
	}
}

function releaseEntryLease(key: string, entry: PoolEntry): void {
	entry.outstanding--;
	if (entry.outstanding !== 0) return;
	if (entry.draining) {
		destroyEntry(key, entry);
		return;
	}
	entry.session.unref();
	entry.referenced = false;
	entry.idleSince = Date.now();
	evictBeyondCap();
}

/** Evict oldest-idle entries while the pool holds more sessions than
 * {@link MAX_RETAINED_SESSIONS}. Never touches a leased or draining entry.
 * `protect` exempts a just-published session: it has no lease yet, so with
 * every older entry leased it would be the only candidate — evicting it
 * destroys the session the handshake is about to hand out, and reacquisition
 * reconnects straight into the same eviction until some lease releases. The
 * bound re-applies on the next release. */
function evictBeyondCap(protect?: string): void {
	while (pool.size > MAX_RETAINED_SESSIONS) {
		let victimKey: string | undefined;
		let victimSince: number | undefined;
		for (const [key, entry] of pool) {
			if (key === protect) continue;
			if (entry.outstanding > 0 || entry.draining || entry.idleSince === undefined) continue;
			if (victimSince === undefined || entry.idleSince < victimSince) {
				victimSince = entry.idleSince;
				victimKey = key;
			}
		}
		if (victimKey === undefined) return;
		const victim = pool.get(victimKey);
		if (victim) destroyEntry(victimKey, victim);
	}
}

/**
 * Opportunistic idle eviction: destroys pooled entries that have had zero
 * outstanding leases for longer than {@link IDLE_EVICT_MS}. Called on each
 * acquisition so a process that rotates endpoints does not accumulate
 * retained sockets indefinitely. Never evicts an entry with live leases or
 * one that is draining; a waiter joins a `connecting` entry, not a pooled
 * one, so no waiter is about to join an evicted entry.
 */
function evictIdleEntries(): void {
	const now = Date.now();
	for (const [key, entry] of pool) {
		if (
			entry.outstanding === 0 &&
			!entry.draining &&
			entry.idleSince !== undefined &&
			now - entry.idleSince >= IDLE_EVICT_MS
		) {
			destroyEntry(key, entry);
		}
	}
}

/** Resolves on `close`; the listener is installed before `destroy()` because `close` fires exactly once. */
function closeSession(session: http2.ClientHttp2Session): Promise<void> {
	if (session.destroyed) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	session.once("close", () => resolve());
	try {
		session.destroy();
	} catch {
		resolve();
	}
	return promise;
}

/**
 * Issues one request stream on `entry`, reserving a lease slot, and installs
 * the abort listener synchronously after `request()` so there is no window in
 * which an abort leaves the stream leased but unreleasable.
 */
function issueLease(options: CursorH2AcquireOptions, key: string, entry: PoolEntry): CursorH2Lease {
	if (entry.outstanding === 0) {
		entry.session.ref();
		entry.referenced = true;
		entry.idleSince = undefined;
	}
	entry.outstanding++;
	let request: http2.ClientHttp2Stream;
	try {
		request = entry.session.request({ ...options.headers, ":method": "POST", ":path": options.requestPath });
	} catch (error) {
		// A synchronous stream-creation failure must not escape with the lease
		// slot or its zero-to-one session reference still held.
		releaseEntryLease(key, entry);
		throw error;
	}

	let released = false;
	function onAbort(): void {
		releaseLease();
	}
	function releaseLease(): void {
		if (released) return;
		released = true;
		options.signal?.removeEventListener("abort", onAbort);
		releaseEntryLease(key, entry);
		try {
			request.destroy();
		} catch {
			/* already closed */
		}
	}

	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) {
		// Aborted in the window between request creation and listener install.
		releaseLease();
	}

	return { request, release: releaseLease };
}

type CursorH2Readiness = { ok: true } | { ok: false; unavailable: CursorH2Unavailable };

/** An in-flight establishment paired with its destructive cancellation handle. */
interface CursorEstablishment {
	promise: Promise<CursorH2Readiness>;
	cancel(): void;
	/** Completion signal from {@link establishSession}; see {@link ConnectHandle.settled}. */
	settled: Promise<void>;
}

function establishSession(options: CursorH2AcquireOptions, key: string): CursorEstablishment {
	const proxyUrl = getProxyForUrl(options.provider, new URL(options.baseUrl));

	// Establishment-local abort controller. Caller signals never abort the
	// shared tunnel: a waiter leaving while others still await must not cancel
	// the connect. `cancel` (disposal, or the last live waiter's abort) is the
	// sole owner of this controller. While the tunnel is pending `session` is
	// not yet assigned, so aborting the controller is what tears
	// `connectProxiedSocket` down immediately instead of leaving it until its
	// own timeout.
	const controller = new AbortController();
	const tunnelSignal = controller.signal;

	// The externally visible establishment result, settled exactly once by
	// `finish` (readiness / unavailable) or `fail` / `cancel` (rejection).
	const { promise, resolve, reject } = Promise.withResolvers<CursorH2Readiness>();
	let done = false;
	let session: http2.ClientHttp2Session | undefined;
	/**
	 * The tunneled `TLSSocket` handed to `http2.connect` as its
	 * `createConnection`. It is retained at establishment scope — not just
	 * inside `runBody` — so the top-level rejection arm can destroy it when
	 * `http2.connect` throws synchronously before `session` is assigned. On
	 * the normal path ownership transfers to the HTTP/2 session (which owns
	 * the underlying socket); this is only the fallback owner for the
	 * synchronous-setup-failure exit.
	 */
	let tunneledSocket: TLSSocket | undefined;

	const finish = (readiness: CursorH2Readiness): void => {
		if (done) return;
		done = true;
		resolve(readiness);
	};
	const fail = (error: unknown): void => {
		if (done) return;
		done = true;
		reject(error);
	};
	/**
	 * Destructive cancellation, invoked by disposal for every in-flight
	 * establishment. Terminates a connect whose peer accepted TCP but never
	 * completes the h2 handshake — without this, disposal would await an
	 * establishment that can never settle on its own.
	 *
	 * Race-safe: only an *unsettled* establishment is cancelled, and an
	 * unsettled establishment has not published its session into the pool
	 * (publish and settle are atomic in onConnect). Disposal bumps the
	 * generation before it calls `cancel`, so the session destroyed here is
	 * never one a later (post-disposal) acquisition legitimately holds — the
	 * generation guard keeps such a session out of the pool to begin with.
	 */
	const cancel = (): void => {
		if (done) return;
		done = true;
		// Abort the establishment controller FIRST: while the establish is still
		// inside `connectProxiedSocket` (tunnel resolving), `session` is undefined
		// and aborting the composed tunnel signal is what makes the tunnel tear
		// its socket down immediately instead of lingering until its own timeout.
		// A tunnel that completes in the meantime still hits `done` (and the
		// generation guard) and cannot publish.
		controller.abort();
		try {
			session?.destroy();
		} catch {
			/* already closed */
		}
		try {
			session?.socket?.destroy();
		} catch {
			/* already closed */
		}
		reject(new Error("HTTP/2 pool disposed during connect"));
	};

	// Establishment completion signal: settles when the async body has FULLY
	// exited — success, every `return`, and the done-teardown branches that
	// destroy a session created after cancellation. Disposal awaits THIS, not
	// just `promise` (which `cancel` settles immediately), so no teardown can
	// outlive disposal. It is a teardown signal, not a result: it always
	// resolves and never rejects, so nothing awaiting it can surface an
	// unhandled rejection.
	const settled = Promise.withResolvers<void>();
	const runBody = async (): Promise<void> => {
		let createConnection: (() => TLSSocket) | undefined;
		if (proxyUrl) {
			let socket: TLSSocket;
			try {
				socket = await connectProxiedSocket(proxyUrl, options.baseUrl, {
					signal: tunnelSignal,
					timeoutMs: PROXY_TUNNEL_TIMEOUT_MS,
				});
			} catch (cause) {
				logger.warn("cursor h2 proxy tunnel failed", {
					baseUrl: options.baseUrl,
					reason: "connect-tunnel",
					error: String(cause),
				});
				finish({ ok: false, unavailable: { reason: "connect-tunnel", cause } });
				return;
			}
			if (socket.alpnProtocol !== "h2") {
				socket.destroy();
				logger.warn("cursor h2 tunnel did not negotiate h2", {
					baseUrl: options.baseUrl,
					negotiated: socket.alpnProtocol ?? "<none>",
				});
				finish({
					ok: false,
					unavailable: {
						reason: "alpn",
						cause: new Error(`TLS negotiated ${socket.alpnProtocol ?? "<none>"}, expected h2`),
					},
				});
				return;
			}
			createConnection = () => socket;
			// Retain at establishment scope so the top-level rejection arm can
			// destroy it if `http2.connect` throws synchronously before `session`
			// is assigned and takes ownership.
			tunneledSocket = socket;
		}

		const gen = generation;
		// Test-only gate: suspends the body immediately before it creates its
		// session, i.e. the exact window in which `cancel` has no session to
		// destroy (`session` is not yet assigned). Lets a test hold the body open
		// and assert disposal waits for this done-teardown, not just the outward
		// reject.
		if (__establishBodyGate) {
			const gate = __establishBodyGate;
			__establishBodyGate = undefined;
			await gate(key);
		}
		const connect = http2.connect(options.baseUrl, createConnection ? { createConnection } : undefined);
		session = connect;
		// Ownership of the tunneled socket transfers to the HTTP/2 session
		// here. Clear the establishment-scope fallback so the rejection arm
		// does not double-destroy a socket the session now owns;
		// `destroy()` is idempotent but this keeps the ownership rule
		// explicit.
		tunneledSocket = undefined;
		// Bind cancel to the raw TCP/TLS socket as well as the http2 session.
		// During Bun TLS/preface, `session.destroy()` may not emit error/connect
		// and may not close the accepted peer socket.
		let rawSocket: { destroy(): void } | undefined;
		try {
			rawSocket = connect.socket;
		} catch {
			// Bun can throw from `session.socket` during handshake.
		}
		if (rawSocket) {
			const destroyRaw = (): void => {
				try {
					rawSocket.destroy();
				} catch {
					/* already closed */
				}
			};
			if (controller.signal.aborted) destroyRaw();
			else controller.signal.addEventListener("abort", destroyRaw, { once: true });
		}
		if (done) {
			// Cancelled while the body was suspended before `session` existed (a
			// tunnel still resolving, or the test gate above). `cancel` saw no
			// session to destroy, so THIS branch is the sole owner of this
			// session's lifetime: it destroys it and exits. When `cancel` instead
			// destroyed an already-assigned session (the handshake-pending
			// window), the two teardown paths overlap harmlessly — `destroy()` is
			// idempotent — but at no interleaving does more than one real teardown
			// leave a live session behind; never fewer than one.
			connect.destroy();
			return;
		}

		// The handshake promise settles when the socket connects (or errors)
		// before readiness can be published. It is separate from `done` so a
		// drained session can still publish readiness and let each live waiter
		// retry acquisition after the reservation is removed.
		type HandshakeResult =
			| { kind: "ok"; session: http2.ClientHttp2Session }
			| { kind: "unavailable"; unavailable: CursorH2Unavailable };
		let handshakeDone = false;
		const handshake = Promise.withResolvers<HandshakeResult>();

		const onConnect = (): void => {
			if (handshakeDone) return;
			handshakeDone = true;
			if (gen !== generation) {
				// Disposal began while this connect was in flight: never publish
				// a live session into a pool that has already been cleared.
				connect.destroy();
				handshake.reject(new Error("HTTP/2 pool disposed during connect"));
				return;
			}
			// Register in the pool before resolving so a waiter never observes a
			// missing entry for a session that is already live. Unref immediately:
			// Node/Bun leave a just-connected session referenced, and a first-lease
			// issuance failure must not pin a zero-outstanding idle entry.
			connect.unref();
			pool.set(key, { session: connect, outstanding: 0, draining: false, referenced: false, idleSince: Date.now() });
			evictBeyondCap(key);
			handshake.resolve({ kind: "ok", session: connect });
		};
		const onGoaway = (): void => {
			const entry = pool.get(key);
			if (entry && entry.session === connect) {
				entry.draining = true;
				if (entry.outstanding === 0) destroyEntry(key, entry);
			}
		};
		const onClose = (): void => {
			const existing = pool.get(key);
			if (existing && existing.session === connect) {
				existing.draining = true;
				pool.delete(key);
			}
		};
		const onError = (error: unknown): void => {
			if (handshakeDone) {
				// Post-connect session failure (connection reset, GOAWAY-ish
				// teardown): stop issuing new leases and let in-flight work drain.
				const existing = pool.get(key);
				if (existing && existing.session === connect) {
					existing.draining = true;
					if (existing.outstanding === 0) destroyEntry(key, existing);
				}
				return;
			}
			handshakeDone = true;
			connect.destroy();
			if (isAlpnUnavailable(error)) {
				handshake.resolve({ kind: "unavailable", unavailable: { reason: "alpn", cause: error } });
				return;
			}
			handshake.reject(error);
		};

		connect.once("connect", onConnect);
		connect.on("error", onError);
		connect.on("goaway", onGoaway);
		connect.on("close", onClose);

		// `session.destroy()` during TLS/h2 preface does not always surface
		// `error`/`connect` on Bun, so a cancelled handshake would hang the
		// establishment body (and disposal). Bind the handshake to the same
		// establishment controller that `cancel` already aborts.
		const onCancelHandshake = (): void => {
			if (handshakeDone) return;
			handshakeDone = true;
			try {
				connect.destroy();
			} catch {
				/* already closed */
			}
			try {
				connect.socket?.destroy();
			} catch {
				/* already closed */
			}
			handshake.reject(new Error("HTTP/2 connect cancelled"));
		};
		if (controller.signal.aborted) onCancelHandshake();
		else controller.signal.addEventListener("abort", onCancelHandshake, { once: true });

		// Bound the handshake independently of the optional caller signal: a
		// peer that accepts TCP but never completes the h2 handshake would
		// otherwise leave this await — and the `connecting` reservation every
		// later acquisition for the key joins — pending forever. The teardown
		// reuses the establishment's single destructive owner: aborting the
		// controller destroys the raw socket, and the session is destroyed
		// directly. `onCancelHandshake` no-ops (handshakeDone is already set),
		// so the deadline-specific rejection below is what surfaces.
		const handshakeTimeoutMs = __handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
		const onHandshakeTimeout = (): void => {
			if (handshakeDone) return;
			handshakeDone = true;
			logger.warn("cursor h2 handshake timed out", {
				baseUrl: options.baseUrl,
				timeoutMs: handshakeTimeoutMs,
			});
			controller.abort();
			try {
				connect.destroy();
			} catch {
				/* already closed */
			}
			try {
				connect.socket?.destroy();
			} catch {
				/* already closed */
			}
			handshake.reject(new Error(`HTTP/2 handshake timed out after ${handshakeTimeoutMs}ms`));
		};
		const handshakeTimer = setTimeout(onHandshakeTimeout, handshakeTimeoutMs);
		handshakeTimer.unref();
		let result!: HandshakeResult;
		try {
			result = await handshake.promise;
		} catch (error) {
			clearTimeout(handshakeTimer);
			controller.signal.removeEventListener("abort", onCancelHandshake);
			// The connect failed, was cancelled, or missed the deadline; the
			// failing path has already destroyed the socket. If cancellation
			// already settled the establishment, `fail` is a no-op.
			fail(error);
			return;
		}
		clearTimeout(handshakeTimer);
		controller.signal.removeEventListener("abort", onCancelHandshake);

		if (result.kind === "unavailable") {
			finish({ ok: false, unavailable: result.unavailable });
			return;
		}

		if (gen !== generation) {
			// Disposal interleaved after connect but before this turn published
			// readiness; destroy the session and report instead of re-establishing
			// into a pool that has already been cleared.
			connect.destroy();
			fail(new Error("HTTP/2 pool disposed during connect"));
			return;
		}

		if (__freshSessionHook) {
			// One-shot test seam: lets a test simulate a GOAWAY landing in the
			// pre-readiness window (which a real fixture cannot place because Node
			// delivers goaway only after this continuation's microtask), driving the
			// drained-before-first-lease retry through normal acquisition.
			const hook = __freshSessionHook;
			__freshSessionHook = undefined;
			hook(key, pool.get(key));
		}
		// Readiness never owns a request stream. Once the reservation wrapper has
		// removed this handle, every still-live waiter re-enters acquireCursorH2
		// with its own signal. If the entry drained in this window, that normal
		// acquisition reserves and establishes a replacement without speculation.
		finish({ ok: true });
	};
	// runBody settles its result on every internal exit path, but a top-level
	// throw — e.g. `http2.connect` throwing synchronously — is not caught
	// inside the body. The rejection arm MUST also reject the outward
	// readiness result: otherwise the error is swallowed, the acquisition
	// stays pending forever, and the `connecting` reservation remains
	// installed for the key, hanging every subsequent acquisition for it.
	// When the throw is from `http2.connect` itself, `session` is still
	// undefined and the tunneled `TLSSocket` (retained at establishment
	// scope) has no owner — destroy it here so no proxy socket survives a
	// synchronous setup failure. On every other throw `tunneledSocket` is
	// already undefined (ownership transferred to the session) so this is a
	// no-op. `settled` always resolves on both arms so no teardown await can
	// surface an unhandled rejection.
	void runBody().then(
		() => settled.resolve(),
		(error: unknown) => {
			try {
				session?.destroy();
			} catch {
				/* already closed */
			}
			if (tunneledSocket) {
				try {
					tunneledSocket.destroy();
				} catch {
					/* already closed */
				}
			}
			fail(error);
			settled.resolve();
		},
	);

	return { promise, cancel, settled: settled.promise };
}

/**
 * Preserves a caller's abort reason when it is an Error; otherwise a concrete
 * abort Error. An abort is never authority to downgrade to the typed
 * ALPN/tunnel-unavailable outcome, so a bounded acquisition rejects with this.
 */
function acquisitionAbortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	return reason instanceof Error ? reason : new Error("HTTP/2 acquisition aborted");
}

/**
 * Binds one acquisition to shared establishment readiness under its own
 * `options.signal`. {@link ConnectHandle.waiters} is the single cancellation
 * owner: an aborted waiter rejects promptly and leaves, but only the LAST live
 * waiter's abort — before establishment settles — destructively cancels the
 * connect and synchronously releases its reservation. A settled establishment
 * reaches every still-live waiter unchanged, and the abort listener is always
 * removed on settle.
 */
function joinEstablishment(handle: ConnectHandle, options: CursorH2AcquireOptions): Promise<CursorH2Readiness> {
	const signal = options.signal;
	const { promise, resolve, reject } = Promise.withResolvers<CursorH2Readiness>();
	handle.waiters++;
	let settled = false;
	const onAbort = (): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", onAbort);
		reject(acquisitionAbortError(signal));
		handle.waiters--;
		// The last live waiter leaving before the establishment settles destroys
		// the connect and synchronously clears only this handle's reservation; an
		// earlier waiter leaving keeps the shared connect alive for the others.
		if (handle.waiters <= 0 && !handle.finished) handle.cancel();
	};
	void handle.promise.then(
		readiness => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			handle.waiters--;
			resolve(readiness);
		},
		(error: unknown) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			handle.waiters--;
			reject(error);
		},
	);
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	}
	return promise;
}

export function acquireCursorH2(options: CursorH2AcquireOptions): Promise<CursorH2Acquisition> {
	return acquireCursorH2AtGeneration(options, generation);
}

async function acquireCursorH2AtGeneration(
	options: CursorH2AcquireOptions,
	acquisitionGeneration: number,
): Promise<CursorH2Acquisition> {
	const key = poolKey(options.baseUrl, getProxyForUrl(options.provider, new URL(options.baseUrl)));
	if (acquisitionGeneration !== generation) {
		throw new Error("HTTP/2 pool disposed during acquire");
	}
	// An already-aborted signal rejects before any pooled or connecting path,
	// so an abort never receives a pooled lease or joins a shared connect.
	if (options.signal?.aborted) throw acquisitionAbortError(options.signal);

	// Opportunistic idle eviction: drop entries idle beyond the window before
	// consulting the pool, so a process that rotates endpoints does not
	// accumulate retained sockets indefinitely.
	evictIdleEntries();

	const entry = pool.get(key);
	if (entry && !entry.draining) {
		return { ok: true, lease: issueLease(options, key, entry) };
	}

	// Past the pooled fast path, every wait — the reservation owner's own
	// handshake and every shared-connect joiner — is bounded by the caller's
	// signal. A signal that aborts mid-wait is handled by joinEstablishment's
	// listener.

	// Reserve before connect: while a new session is being created the key is
	// marked connecting so a concurrent acquisition awaits the same connect
	// instead of racing to a duplicate or a session about to be released.
	const inFlight = connecting.get(key);
	if (inFlight) {
		// Joiner: wait bounded by our own signal. An unavailable outcome (ALPN /
		// tunnel) propagates as-is — never retry a doomed connect. Readiness means
		// the reservation is gone and the session is pooled, so re-acquire to issue
		// a lease under this caller's still-live signal.
		const readiness = await joinEstablishment(inFlight, options);
		if (!readiness.ok) return readiness;
		return acquireCursorH2AtGeneration(options, acquisitionGeneration);
	}

	// Owner: establish and reserve the slot, then await bounded by its own signal.
	// Establishment publishes only readiness; after the matching reservation is
	// removed, the owner follows the same acquisition path as every joiner and
	// issues its own request lease under its own still-live signal.
	const establishment = establishSession(options, key);
	const handle: ConnectHandle = {
		promise: establishment.promise,
		cancel: () => {
			establishment.cancel();
			if (connecting.get(key) === handle) connecting.delete(key);
		},
		settled: establishment.settled,
		waiters: 0,
		finished: false,
	};
	handle.promise = establishment.promise.then(
		readiness => {
			handle.finished = true;
			if (connecting.get(key) === handle) connecting.delete(key);
			return readiness;
		},
		(error: unknown) => {
			handle.finished = true;
			if (connecting.get(key) === handle) connecting.delete(key);
			throw error;
		},
	);
	// Observe cancellation when the final waiter has already left, while still
	// preserving rejection for any waiter currently joined to this handle.
	void handle.promise.catch(() => {});
	connecting.set(key, handle);
	const readiness = await joinEstablishment(handle, options);
	if (!readiness.ok) return readiness;
	return acquireCursorH2AtGeneration(options, acquisitionGeneration);
}

/**
 * Destroys every pooled session and clears the pool for deterministic teardown.
 * No process-level hooks are installed at import time; callers opt into this.
 */
export async function disposeCursorH2Pool(): Promise<void> {
	// Bump the generation BEFORE touching any state: a connect that began under
	// an earlier generation must reject at connect (and destroy the session it
	// created) rather than publish a live session into a pool this returned from.
	generation++;
	const inFlight = [...connecting.values()];
	connecting.clear();

	const entries = [...pool.values()];
	pool.clear();

	// Cancel every in-flight establishment BEFORE awaiting settlement: a peer
	// that accepts TCP but never completes the h2 handshake leaves the connect
	// pending forever, so awaiting it would hang disposal. `cancel` destroys the
	// underlying session/socket, guaranteeing each establishment settles.
	for (const handle of inFlight) handle.cancel();

	await Promise.all([
		// Wait for establishments that started before disposal so they can
		// settle (the cancellation handle destroys any session they create, and
		// the generation guard in `establishSession` blocks any re-publish).
		// Swallow so disposal itself never rejects.
		...inFlight.map(async handle => {
			try {
				await handle.promise;
			} catch {
				/* disposed during connect — nothing to settle */
			}
		}),
		// Await each establishment's COMPLETION, not just its outward result.
		// `cancel` settles `promise` (the outward acquisition) immediately, but
		// the establishment body may still be in flight — a tunnel that resolved
		// a microtask before `cancel` leaves the body to create an http2 session
		// afterwards, observe `done`, and destroy it. Disposal must not return
		// until that teardown has actually happened.
		...inFlight.map(async handle => {
			try {
				await handle.settled;
			} catch {
				/* settled never rejects; defensive */
			}
		}),
		...entries.map(async entry => {
			entry.draining = true;
			await closeSession(entry.session);
		}),
	]);
}

/**
 * Test seam: per-key pool introspection. Reference state is the tracked
 * mirror of our `ref()`/`unref()` calls; no mutable transport object escapes.
 */
export function __cursorH2PoolSnapshot(): Array<{
	key: string;
	outstanding: number;
	draining: boolean;
	referenced: boolean;
}> {
	return [...pool.entries()].map(([key, entry]) => ({
		key,
		outstanding: entry.outstanding,
		draining: entry.draining,
		referenced: entry.referenced,
	}));
}
/**
 * Test seam: in-flight establishment introspection — the reserved keys and the
 * live waiter count each shares. Exposes no socket or session.
 */
export function __cursorH2ConnectingSnapshot(): Array<{ key: string; waiters: number }> {
	return [...connecting.entries()].map(([key, handle]) => ({ key, waiters: handle.waiters }));
}
/**
 * Test seam: install (or clear) the one-shot fresh-session hook. When set, the
 * hook runs synchronously with the freshly connected pooled entry before
 * readiness is published, so a test can mark the entry draining / destroy its
 * session to force the drained-before-first-lease retry path that the real
 * GOAWAY ordering cannot reach.
 */
export function __setCursorH2FreshSessionHook(
	fn: ((key: string, entry: PoolEntry | undefined) => void) | undefined,
): void {
	__freshSessionHook = fn;
}
/**
 * Test seam: install (or clear) a one-shot gate the establishment body awaits
 * immediately before creating its session. At that point `session` is not yet
 * assigned — exactly the window where cancellation has no session to destroy —
 * so a test can hold the body open and assert disposal does not resolve until
 * the body's done-teardown fully runs, instead of returning the moment `cancel`
 * rejects the outward acquisition promise.
 */
export function __setCursorH2EstablishBodyGate(fn: ((key: string) => Promise<void>) | undefined): void {
	__establishBodyGate = fn;
}
/**
 * Test seam: override (or restore) the direct-handshake deadline so the
 * stalled-peer path can be driven deterministically instead of waiting out
 * the production budget.
 */
export function __setCursorH2HandshakeTimeoutMs(ms: number | undefined): void {
	__handshakeTimeoutMs = ms;
}
