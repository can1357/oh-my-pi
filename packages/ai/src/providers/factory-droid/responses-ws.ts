import { $env, $flag, logger, parseFlag } from "@oh-my-pi/pi-utils";
import type { FetchImpl, ProviderSessionState } from "../../types";
import { getProxyForUrl } from "../../utils/proxy";

/**
 * Factory Droid's Responses-over-WebSocket transport (`openai-responses-ws`).
 *
 * The droid CLI 0.203.0 upgrades `POST /api/llm/o/v1/responses` to
 * `GET /api/llm/o/v1/responses/ws` whenever the turn rides a registry model on
 * the `openai` upstream and the account carries the
 * `openai_responses_websocket_mode` gate. The socket then speaks the same
 * Responses event vocabulary as the SSE route, one JSON document per frame
 * instead of `data:`-framed lines, and the request rides a single
 * `{"type":"response.create", ...body}` frame.
 *
 * Shape of this port: rather than a second event decoder, the transport is a
 * {@link FetchImpl} wrapper. It intercepts the Responses POST, replays the body
 * over a socket, and hands the shared Responses transport an SSE-framed
 * `Response`. Every downstream layer — `readSseJson`, the Responses event
 * handlers, usage accounting, the idle watchdogs — stays byte-for-byte on the
 * HTTPS code path, so WebSocket turns cannot drift from SSE turns in shape.
 * It also makes the fallback exact: until the first frame arrives nothing has
 * been observed, so a handshake or first-frame failure simply performs the
 * HTTPS POST it was standing in for and the caller never learns a socket was
 * attempted.
 *
 * Manager semantics mirror `openai-codex-responses.ts` (the in-tree WebSocket
 * Responses precedent) and the CLI's own connection manager: one socket per
 * session, bound to the model id, a reuse-health ceiling for server-evicted
 * sockets, a heartbeat, an idle-close timer, and a transport-failure counter
 * that drops the session back to HTTPS for good.
 *
 * Frame fidelity is capture-derived (`/tmp/flows203/012-ws-frames.txt`): the
 * request frame is *flat* (`type` alongside the Responses body fields, not
 * nested under a `response` key), carries `_factory.assistantMessageId` in
 * place of the per-request headers a WebSocket cannot send, and omits `stream`.
 */

/** Per-wire suffix appended to the Responses base URL for the upgrade. */
const FACTORY_DROID_RESPONSES_WS_PATH = "/responses/ws";

/**
 * Body key carrying the request identity that HTTP sends as
 * `x-assistant-message-id`. WebSocket frames cannot carry per-request headers;
 * codex-rs mirrors its marker into `client_metadata`, Factory into `_factory`.
 */
const FACTORY_FRAME_METADATA_KEY = "_factory";

/**
 * Request headers dropped from the upgrade. `accept`/`content-type` describe a
 * JSON POST that no longer happens (and the CLI's upgrade carries neither), and
 * `x-stainless-timeout` advertises an HTTP read budget the socket does not use.
 */
const UPGRADE_HEADER_DENYLIST: Record<string, true> = {
	accept: true,
	"content-type": true,
	"content-length": true,
	"x-stainless-timeout": true,
};

const FACTORY_DROID_WS_DEBUG = $flag("PI_FACTORY_DROID_WS_DEBUG");

/** Upgrade budget. A WS-hostile network fails fast into the HTTPS POST. */
const CONNECT_TIMEOUT_MS = Number($env.PI_FACTORY_DROID_WS_CONNECT_TIMEOUT_MS || 10_000);

/**
 * Budget for `response.created`, the frame the proxy emits on accept. Well
 * under the shared transport's own first-event watchdog (300s) on purpose:
 * this timeout must fire while falling back is still free.
 */
const FIRST_FRAME_TIMEOUT_MS = Number($env.PI_FACTORY_DROID_WS_FIRST_FRAME_TIMEOUT_MS || 60_000);

/**
 * Steady-state liveness ceiling once frames are flowing. A socket can stay
 * TCP-open with a dead peer, in which case nothing else would ever wake the
 * reader.
 */
const IDLE_TIMEOUT_MS = Number($env.PI_FACTORY_DROID_WS_IDLE_TIMEOUT_MS || 300_000);

/**
 * Reuse-health ceiling: Bun does not always surface server-side eviction, so a
 * socket silent longer than this is treated as suspect and replaced rather
 * than written into. Trades a sub-second handshake for a minutes-long stall.
 */
const MAX_IDLE_REUSE_MS = Number($env.PI_FACTORY_DROID_WS_MAX_IDLE_REUSE_MS || 30_000);

/** Idle-close timer: a socket nobody reused within this window is released. */
const IDLE_CLOSE_MS = Number($env.PI_FACTORY_DROID_WS_IDLE_CLOSE_MS || 120_000);

const PING_INTERVAL_MS = Number($env.PI_FACTORY_DROID_WS_PING_INTERVAL_MS || 10_000);
const PONG_TIMEOUT_MS = Number($env.PI_FACTORY_DROID_WS_PONG_TIMEOUT_MS || 60_000);

/**
 * Transport failures tolerated before the session stops attempting WebSocket
 * turns. One is a blip (a handshake racing an edge redeploy); two is a
 * property of this network or account, and every further attempt would just
 * buy another fallback delay.
 */
const MAX_TRANSPORT_FAILURES = Number($env.PI_FACTORY_DROID_WS_MAX_FAILURES || 2);

/** Feature-flag lookup budget; the HTTPS path is the answer when it lapses. */
const FLAGS_TIMEOUT_MS = Number($env.PI_FACTORY_DROID_WS_FLAGS_TIMEOUT_MS || 3_000);

/** Feature-flag cache lifetime. Statsig gates do not flip mid-session. */
const FLAGS_TTL_MS = Number($env.PI_FACTORY_DROID_WS_FLAGS_TTL_MS || 300_000);

/** Statsig gate that must be on for the account to ride the socket. */
const WS_FEATURE_FLAG = "openai_responses_websocket_mode";

const PROVIDER_SESSION_STATE_KEY = "factory-droid:responses-ws";

const encoder = new TextEncoder();

/** Response events that end a turn; nothing follows them on the socket. */
const TERMINAL_FRAME_TYPES: Record<string, true> = {
	"response.completed": true,
	"response.done": true,
	"response.incomplete": true,
	"response.failed": true,
	error: true,
};

class FactoryDroidWsTransportError extends Error {
	constructor(message: string) {
		super(`Factory Droid websocket transport error: ${message}`);
		this.name = "FactoryDroidWsTransportError";
	}
}

/** One decoded server frame plus the wire text it arrived as. */
interface FactoryDroidWsFrame {
	frame: Record<string, unknown>;
	text: string;
}

/**
 * WebSocket URL for a Responses POST URL: same origin and namespace with the
 * `/ws` suffix the CLI upgrades to, and the `http(s)`→`ws(s)` protocol swap it
 * performs at connect time. Derived from the request URL rather than a
 * constant so the EU host and test servers follow automatically.
 */
function factoryDroidResponsesWsUrl(postUrl: string): string {
	const url = new URL(postUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
	url.pathname = `${url.pathname.replace(/\/responses$/, "")}${FACTORY_DROID_RESPONSES_WS_PATH}`;
	return url.href;
}

/**
 * `GET /api/feature-flags` for the origin serving this model's Responses URL.
 * Derived rather than hardcoded so EU-resident accounts (whose discovery host
 * is `api.eu.factory.ai`) read their own gates.
 */
const FEATURE_FLAGS_PATH = "/api/feature-flags";

interface FlagCacheEntry {
	expiresAt: number;
	enabled: Promise<boolean>;
}

/**
 * Account-scoped gate cache. Also the in-flight dedupe: concurrent turns share
 * the pending promise instead of each issuing a flags request.
 */
const flagCache = new Map<string, FlagCacheEntry>();

/**
 * Reads the WebSocket gate from the account's Statsig flags.
 *
 * The provider fetches this itself rather than receiving it from discovery:
 * discovery's flags payload never reaches the stream layer (model specs carry
 * only availability and the resolved upstream rotation, and the shared model
 * cache strips anything header-shaped), and the transport already owns
 * account-state lookups on this API — the 403 path re-reads
 * `GET /api/billing/limits` the same way. Failures resolve `false`: an
 * unknown gate must never cost a turn.
 */
async function isWebSocketFlagEnabled(input: {
	accessToken: string;
	responsesUrl: string;
	orgId?: string;
	fetchImpl: FetchImpl;
	clientVersion: string;
	signal?: AbortSignal;
}): Promise<boolean> {
	const url = new URL(FEATURE_FLAGS_PATH, input.responsesUrl).href;
	const cacheKey = `${url}\u0000${input.accessToken}`;
	const now = Date.now();
	const cached = flagCache.get(cacheKey);
	if (cached && cached.expiresAt > now) return cached.enabled;
	const enabled = (async () => {
		try {
			const timeout = AbortSignal.timeout(FLAGS_TIMEOUT_MS);
			const response = await input.fetchImpl(url, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${input.accessToken}`,
					"X-Client-Version": input.clientVersion,
					"X-Factory-Client": "cli",
					...(input.orgId ? { "X-Factory-Org-Id": input.orgId } : {}),
				},
				signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
			});
			if (!response.ok) return false;
			const body: unknown = await response.json();
			if (body == null || typeof body !== "object" || !("flags" in body)) return false;
			const flags = body.flags;
			if (flags == null || typeof flags !== "object") return false;
			return (flags as Record<string, unknown>)[WS_FEATURE_FLAG] === true;
		} catch {
			return false;
		}
	})();
	flagCache.set(cacheKey, { expiresAt: now + FLAGS_TTL_MS, enabled });
	return enabled;
}

export interface FactoryDroidWsGateInput {
	accessToken: string;
	/** Responses POST URL for this turn (region- and override-resolved). */
	responsesUrl: string;
	/** Resolved `x-api-provider` upstream for the turn. */
	upstream: string;
	/** False for hand-registered custom ids; the CLI never upgrades those. */
	registered: boolean;
	orgId?: string;
	fetchImpl: FetchImpl;
	clientVersion: string;
	/** Absent when the caller shares no session state; without it, no socket. */
	providerSessionState?: Map<string, ProviderSessionState>;
	signal?: AbortSignal;
}

/**
 * The CLI's gate (bundle `G9`): registry model, `openai` upstream, Responses
 * wire, account gate on. `PI_FACTORY_DROID_WS` overrides the account gate in
 * both directions (kill switch in the field, opt-in while developing) but
 * never the structural conditions — a non-openai upstream has no socket to
 * connect to. A session already dropped back to HTTPS stays there.
 */
export async function shouldUseFactoryDroidResponsesWs(input: FactoryDroidWsGateInput): Promise<boolean> {
	if (!input.registered) return false;
	if (input.upstream !== "openai") return false;
	const state = input.providerSessionState;
	if (!state) return false;
	const wsState = state.get(PROVIDER_SESSION_STATE_KEY) as FactoryDroidWsProviderSessionState | undefined;
	if (wsState?.session.disabled === true) return false;
	const override = $env.PI_FACTORY_DROID_WS;
	if (override !== undefined) return parseFlag(override);
	return await isWebSocketFlagEnabled({
		accessToken: input.accessToken,
		responsesUrl: input.responsesUrl,
		orgId: input.orgId,
		fetchImpl: input.fetchImpl,
		clientVersion: input.clientVersion,
		signal: input.signal,
	});
}

/** Live socket plus the fallback bookkeeping for one agent session. */
interface FactoryDroidWsSession {
	/** The socket is bound to this model id; a switch invalidates it. */
	modelId?: string;
	disabled: boolean;
	/** A handshake is in flight; a concurrent turn must not race it. */
	connecting: boolean;
	failures: number;
	connection?: FactoryDroidWebSocketConnection;
	idleCloseTimer?: NodeJS.Timeout;
}

interface FactoryDroidWsProviderSessionState extends ProviderSessionState {
	session: FactoryDroidWsSession;
}

/**
 * Session-scoped transport state. Keyed per provider-session map rather than
 * per session id: the map itself is the session, and its `close()` is the only
 * hook that can release a socket when the agent session ends.
 */
function getWsSessionState(providerSessionState: Map<string, ProviderSessionState>): FactoryDroidWsSession {
	const existing = providerSessionState.get(PROVIDER_SESSION_STATE_KEY) as
		| FactoryDroidWsProviderSessionState
		| undefined;
	if (existing) return existing.session;
	const session: FactoryDroidWsSession = { disabled: false, connecting: false, failures: 0 };
	const created: FactoryDroidWsProviderSessionState = {
		session,
		close: () => {
			releaseConnection(session, "session-closed");
			session.disabled = false;
			session.failures = 0;
			session.modelId = undefined;
		},
	};
	providerSessionState.set(PROVIDER_SESSION_STATE_KEY, created);
	return session;
}

function releaseConnection(session: FactoryDroidWsSession, reason: string): void {
	clearTimeout(session.idleCloseTimer);
	session.idleCloseTimer = undefined;
	session.connection?.close(reason);
	session.connection = undefined;
}

/**
 * A socket left open between turns is the point of the transport, but an
 * abandoned session must not pin one forever. `unref` so a pending close never
 * holds the process open.
 */
function scheduleIdleClose(session: FactoryDroidWsSession): void {
	clearTimeout(session.idleCloseTimer);
	if (IDLE_CLOSE_MS <= 0) return;
	const timer = setTimeout(() => {
		session.idleCloseTimer = undefined;
		session.connection?.close("idle");
		session.connection = undefined;
	}, IDLE_CLOSE_MS);
	timer.unref();
	session.idleCloseTimer = timer;
}

function recordTransportFailure(session: FactoryDroidWsSession, error: unknown): void {
	releaseConnection(session, "transport-failure");
	session.failures += 1;
	if (session.failures >= MAX_TRANSPORT_FAILURES) session.disabled = true;
	FACTORY_DROID_WS_DEBUG &&
		logger.debug("[factory-droid] websocket transport failure", {
			error: error instanceof Error ? error.message : String(error),
			failures: session.failures,
			disabled: session.disabled,
		});
}

/**
 * Request frame for a Responses body: flat `type` + body fields, the
 * `_factory` identity block, and no `stream` (the socket streams by
 * construction, and the CLI's captured frame carries no such field).
 */
function buildFactoryDroidResponseCreateFrame(
	body: Record<string, unknown>,
	assistantMessageId: string,
): Record<string, unknown> {
	const { stream: _stream, ...rest } = body;
	return {
		type: "response.create",
		...rest,
		[FACTORY_FRAME_METADATA_KEY]: { assistantMessageId },
	};
}

function frameResponseId(frame: Record<string, unknown>): string | undefined {
	const response = frame.response;
	if (response == null || typeof response !== "object") return undefined;
	const id = (response as Record<string, unknown>).id;
	return typeof id === "string" ? id : undefined;
}

interface FactoryDroidWsConnectionOptions {
	proxy?: string;
}

/**
 * One reusable socket. Frames are decoded into a queue by the socket callbacks
 * and drained by {@link streamRequest}, which owns the per-request timeouts.
 */
class FactoryDroidWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#proxy?: string;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<FactoryDroidWsFrame | Error | null> = [];
	#waiters: Array<() => void> = [];
	#activeRequest = false;
	#heartbeat: NodeJS.Timeout | undefined;
	#removePongListener?: () => void;
	/** Wall-clock of the last inbound activity (frame, pong, or handshake). */
	#lastInboundAt = 0;
	#lastPingAt = 0;
	constructor(url: string, headers: Record<string, string>, options: FactoryDroidWsConnectionOptions = {}) {
		this.#url = url;
		this.#headers = headers;
		this.#proxy = options.proxy;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	/** True while a turn owns the socket; a second turn must not join it. */
	isBusy(): boolean {
		return this.#activeRequest;
	}

	/** Reuse gate: open, matching credential, and not suspiciously silent. */
	isHealthyForReuse(headers: Record<string, string>): boolean {
		if (!this.isOpen()) return false;
		if (this.#headers.Authorization !== headers.Authorization) return false;
		if (MAX_IDLE_REUSE_MS <= 0) return true;
		if (this.#lastInboundAt === 0) return false;
		return Date.now() - this.#lastInboundAt <= MAX_IDLE_REUSE_MS;
	}

	close(reason = "done"): void {
		const socket = this.#socket;
		this.#socket = null;
		this.#stopHeartbeat();
		if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return;
		try {
			socket.close(1000, reason);
		} catch (error) {
			FACTORY_DROID_WS_DEBUG &&
				logger.debug("[factory-droid] websocket close failed", {
					error: error instanceof Error ? error.message : String(error),
					reason,
				});
		}
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers, proxy: this.#proxy },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const onAbort = () => {
			this.close("aborted");
			if (settled) return;
			settled = true;
			clearPending();
			reject(new FactoryDroidWsTransportError("request was aborted"));
		};
		const clearPending = () => {
			clearTimeout(timeout);
			timeout = undefined;
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		if (!settled) {
			timeout = setTimeout(() => {
				this.close("connect-timeout");
				if (settled) return;
				settled = true;
				clearPending();
				reject(new FactoryDroidWsTransportError("connection timeout"));
			}, CONNECT_TIMEOUT_MS);
		}

		socket.onopen = () => {
			if (settled) return;
			settled = true;
			clearPending();
			this.#lastInboundAt = Date.now();
			this.#startHeartbeat(socket);
			resolve();
		};
		socket.onerror = event => {
			const record = event as unknown as Record<string, unknown>;
			const detail =
				(typeof record.message === "string" && record.message) ||
				(record.error instanceof Error && record.error.message) ||
				String(event.type);
			const error = new FactoryDroidWsTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			this.#stopHeartbeat();
			if (!settled) {
				settled = true;
				clearPending();
				reject(new FactoryDroidWsTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(new FactoryDroidWsTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			// Stamp before parsing: what reuse health measures is whether the peer
			// is still talking, not whether every frame is well-formed.
			this.#lastInboundAt = Date.now();
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				this.#push({ frame: JSON.parse(text) as Record<string, unknown>, text });
			} catch (error) {
				this.#push(new FactoryDroidWsTransportError(`malformed frame: ${String(error)}`));
			}
		};

		await promise;
	}

	/**
	 * Sends the request frame and yields server frames until the turn's
	 * terminal event. Throws {@link FactoryDroidWsTransportError} on socket
	 * death, timeout, or a frame belonging to another response.
	 */
	async *streamRequest(
		request: Record<string, unknown>,
		signal?: AbortSignal,
	): AsyncGenerator<FactoryDroidWsFrame, void, void> {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new FactoryDroidWsTransportError("websocket connection is unavailable");
		}
		if (this.#activeRequest) throw new FactoryDroidWsTransportError("websocket request already in progress");
		if (signal?.aborted) throw new FactoryDroidWsTransportError("request was aborted");
		this.#activeRequest = true;
		// Drop frames a previous turn left behind when its consumer broke on the
		// terminal event: a stale `response.completed` would end this turn with
		// empty output. Queued errors survive so the death signal still lands.
		this.#dropStaleFrames();
		const onAbort = () => {
			this.close("aborted");
			this.#push(new FactoryDroidWsTransportError("request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			try {
				socket.send(JSON.stringify(request));
			} catch (error) {
				throw new FactoryDroidWsTransportError(
					`websocket send failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			let sawFrame = false;
			let activeResponseId: string | undefined;
			for (;;) {
				const budgetMs = sawFrame ? IDLE_TIMEOUT_MS : FIRST_FRAME_TIMEOUT_MS;
				const next = await this.#nextFrame(
					budgetMs,
					sawFrame ? "idle timeout waiting for websocket frame" : "timeout waiting for first websocket frame",
				);
				if (next instanceof Error) throw next;
				if (next === null) throw new FactoryDroidWsTransportError("websocket closed before response completion");
				// Cross-response guard for the reused socket: lock onto the first
				// `response.id` this turn sees (only lifecycle frames carry one)
				// and fail closed if another response interleaves — the idless
				// deltas around it are indistinguishable, so continuing would
				// misattribute another turn's output to this one. Leftovers from a
				// completed turn are handled at send time by `#dropStaleFrames`;
				// this is deliberately not an id-dedupe, which would silently
				// swallow a legitimate turn whenever an id repeated.
				const id = frameResponseId(next.frame);
				if (id !== undefined) {
					if (activeResponseId === undefined) activeResponseId = id;
					else if (id !== activeResponseId) {
						this.close("stale-frame");
						throw new FactoryDroidWsTransportError(
							`websocket frame for response ${id} interleaved into active response ${activeResponseId}`,
						);
					}
				}
				sawFrame = true;
				yield next;
				if (typeof next.frame.type === "string" && TERMINAL_FRAME_TYPES[next.frame.type] === true) break;
			}
		} finally {
			this.#activeRequest = false;
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * Keeps an idle socket both alive and provably alive. Bun does not always
	 * surface server-side eviction, so inbound silence past the pong budget —
	 * pongs included — is the death signal.
	 */
	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		if (PING_INTERVAL_MS <= 0) return;
		this.#lastPingAt = 0;
		const target = socket as EventTarget;
		const onPong = () => {
			this.#lastInboundAt = Date.now();
		};
		if (typeof target.addEventListener === "function" && typeof target.removeEventListener === "function") {
			target.addEventListener("pong", onPong);
			this.#removePongListener = () => target.removeEventListener("pong", onPong);
		}
		const heartbeat = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}
			if (
				PONG_TIMEOUT_MS > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > PONG_TIMEOUT_MS
			) {
				this.#fail(new FactoryDroidWsTransportError("websocket pong timeout"), "pong-timeout");
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#fail(
					new FactoryDroidWsTransportError(
						`websocket ping failed: ${error instanceof Error ? error.message : String(error)}`,
					),
					"ping-failed",
				);
			}
		}, PING_INTERVAL_MS);
		heartbeat.unref();
		this.#heartbeat = heartbeat;
	}

	#stopHeartbeat(): void {
		clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		this.#removePongListener?.();
		this.#removePongListener = undefined;
		this.#lastPingAt = 0;
	}

	#fail(error: Error, reason: string): void {
		this.#queue.length = 0;
		this.#queue.push(error);
		this.close(reason);
		this.#wake();
	}

	#dropStaleFrames(): void {
		if (this.#queue.length === 0) return;
		const surviving = this.#queue.filter(item => item instanceof Error);
		if (surviving.length === this.#queue.length) return;
		this.#queue = surviving;
	}

	#wake(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: FactoryDroidWsFrame | Error | null): void {
		// Errors append rather than replace: a queued terminal frame followed by
		// an eager server close must still reach the consumer as a clean turn.
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextFrame(timeoutMs: number, timeoutReason: string): Promise<FactoryDroidWsFrame | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const index = this.#waiters.indexOf(resolve);
					if (index >= 0) this.#waiters.splice(index, 1);
					resolve();
				}, timeoutMs);
			}
			await promise;
			clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) return new FactoryDroidWsTransportError(timeoutReason);
		}
		return this.#queue.shift() ?? null;
	}
}

export interface FactoryDroidResponsesWsFetchInput {
	/** HTTPS transport this stands in for, and the fallback target. */
	baseFetch: FetchImpl;
	/** `model.provider`, for proxy resolution. */
	provider: string;
	/** Socket binding key: a model switch invalidates the connection. */
	modelId: string;
	/** Mirrored into the frame as `_factory.assistantMessageId`. */
	assistantMessageId: string;
	providerSessionState: Map<string, ProviderSessionState>;
}

/**
 * Wraps the Responses POST in the WebSocket transport.
 *
 * Non-Responses requests, a disabled session, a socket a sibling turn already
 * owns, and every pre-first-frame failure delegate to
 * {@link FactoryDroidResponsesWsFetchInput.baseFetch}, so the caller's HTTPS
 * behavior is preserved exactly. Once the first frame lands
 * the turn is committed to the socket: a later failure errors the stream and
 * counts against the session's WebSocket budget, which is what drops
 * subsequent turns back to HTTPS.
 */
export function createFactoryDroidResponsesWsFetch(input: FactoryDroidResponsesWsFetchInput): FetchImpl {
	const session = getWsSessionState(input.providerSessionState);
	return async (url, init) => {
		const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		const body = init?.body;
		if (session.disabled || typeof body !== "string" || !target.endsWith("/responses")) {
			return await input.baseFetch(url, init);
		}
		// A sibling turn already owns the socket, or is still establishing it
		// (side-channel requests share the session's state). The protocol carries
		// one response at a time, so this turn takes the HTTPS route rather than
		// stealing, multiplexing, or tearing down a live stream — and it is not a
		// transport failure.
		if (session.connecting || session.connection?.isBusy() === true) {
			return await input.baseFetch(url, init);
		}
		const headers = upgradeHeaders(init?.headers);
		const signal = init?.signal ?? undefined;
		let frames: AsyncGenerator<FactoryDroidWsFrame, void, void> | undefined;
		let first: FactoryDroidWsFrame;
		try {
			const frame = buildFactoryDroidResponseCreateFrame(
				JSON.parse(body) as Record<string, unknown>,
				input.assistantMessageId,
			);
			const connection = await acquireConnection(session, input, target, headers, signal);
			frames = connection.streamRequest(frame, signal);
			const opened = await frames.next();
			if (opened.done) throw new FactoryDroidWsTransportError("websocket closed before the first frame");
			first = opened.value;
		} catch (error) {
			await frames?.return();
			// Nothing has been observed yet, so the HTTPS POST this stood in for
			// is still exactly equivalent.
			recordTransportFailure(session, error);
			return await input.baseFetch(url, init);
		}
		const activeFrames = frames;
		const sse = new ReadableStream<Uint8Array>({
			start: controller => {
				controller.enqueue(encoder.encode(`data: ${first.text}\n\n`));
			},
			pull: async controller => {
				try {
					const next = await activeFrames.next();
					if (next.done) {
						controller.close();
						scheduleIdleClose(session);
						return;
					}
					controller.enqueue(encoder.encode(`data: ${next.value.text}\n\n`));
				} catch (error) {
					recordTransportFailure(session, error);
					controller.error(error);
				}
			},
			cancel: async () => {
				await activeFrames.return();
				scheduleIdleClose(session);
			},
		});
		const responseId = frameResponseId(first.frame);
		return new Response(sse, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				// Synthetic markers, not wire headers: the transport a turn rode is
				// otherwise unobservable from the response.
				"x-factory-droid-transport": "websocket",
				...(responseId ? { "x-request-id": responseId } : {}),
			},
		});
	};
}

/** Upgrade headers: the POST's identity set minus the HTTP-only entries. */
function upgradeHeaders(source: RequestInit["headers"]): Record<string, string> {
	const headers: Record<string, string> = {};
	const entries =
		source instanceof Headers
			? source.entries()
			: Array.isArray(source)
				? source
				: Object.entries((source ?? {}) as Record<string, string>);
	for (const [key, value] of entries) {
		if (UPGRADE_HEADER_DENYLIST[key.toLowerCase()] === true) continue;
		headers[key] = value;
	}
	return headers;
}

/**
 * The session's socket, reconnecting when it is unhealthy, credential-rotated,
 * or bound to a different model. Model binding is the only invalidation this
 * transport needs: every frame carries the full `input` history, so unlike the
 * codex path there is no server-side chaining to diverge from.
 */
async function acquireConnection(
	session: FactoryDroidWsSession,
	input: FactoryDroidResponsesWsFetchInput,
	postUrl: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<FactoryDroidWebSocketConnection> {
	clearTimeout(session.idleCloseTimer);
	session.idleCloseTimer = undefined;
	const existing = session.connection;
	if (existing) {
		if (session.modelId === input.modelId && existing.isHealthyForReuse(headers)) return existing;
		releaseConnection(session, session.modelId === input.modelId ? "unhealthy" : "model-changed");
	}
	const url = factoryDroidResponsesWsUrl(postUrl);
	const connection = new FactoryDroidWebSocketConnection(url, headers, {
		proxy: getProxyForUrl(input.provider, new URL(url)),
	});
	session.connection = connection;
	session.modelId = input.modelId;
	session.connecting = true;
	try {
		await connection.connect(signal);
	} catch (error) {
		session.connection = undefined;
		throw error;
	} finally {
		session.connecting = false;
	}
	return connection;
}
