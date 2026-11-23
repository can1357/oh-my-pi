/**
 * A session's connection to one MCP server: a tunnel to the unit the MCP host
 * runs for it.
 *
 * The link is the only transport a session has. It speaks MCP 2026-07-28 as
 * newline-delimited JSON-RPC, owns request deadlines and cancellation, and
 * keeps itself attached: when the tunnel drops it takes a new one and tells
 * its owner, so nothing above it deals with processes, sockets or handshakes.
 */
import { type } from "@oh-my-pi/omptype";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { createMCPJsonRpcError, MCPTransportError, type MCPTransportKind } from "./errors";
import { mcpHostAccess } from "./host/access";
import {
	decodeHostError,
	encodeJsonLine,
	JsonLineDecoder,
	MCP_RESTART_METHOD,
	MCP_ROOTS_METHOD,
	MCP_STATUS_METHOD,
	type McpAttachment,
	type McpEra,
	type McpHostAccess,
	type McpServerSpec,
	type McpUpstreamStatus,
	mcpIdentity,
} from "./host/contract";
import { routeProgressNotification, withProgressToken } from "./progress";
import { MCP_SUBSCRIPTION_ACKNOWLEDGED, MCPErrorCode, subscriptionIdOf, withRequestMeta } from "./protocol";
import { isMCPTimeoutEnabled, type MCPRequestDeadline, resolveMCPRequestDeadline } from "./timeout";
import {
	type JsonRpcError,
	MCPNotificationMethods,
	type MCPRequestOptions,
	type MCPRoot,
	type MCPTransport,
} from "./types";

const LISTEN_METHOD = "subscriptions/listen";
const CANCELLED_METHOD = "notifications/cancelled";

const UpstreamStatus = type({
	era: "'modern' | 'legacy'",
	state: "'idle' | 'starting' | 'running' | 'failed'",
	"pid?": "number",
	links: "number",
	"exit?": { "code?": "number", "signal?": "number", stderr: "string" },
});

/** Construction parameters of a {@link HostLink}. */
export interface HostLinkOptions {
	/** Configured server name, for the host's board label and log lines. */
	name: string;
	spec: McpServerSpec;
	/** Id of the owning MCP manager: the owner of a handshake-era unit. */
	instance: string;
	/** Roots sent to the host on every attach and on {@link HostLink.setRoots}. */
	roots: () => MCPRoot[];
	/** Linger of an unleased modern unit, in milliseconds. */
	idleMs: number;
	/** The server's configured request timeout in milliseconds; absent selects the default deadlines. */
	timeout?: number;
	/** Where the units live; the process-wide host by default. */
	access?: McpHostAccess;
}

/** What a new attachment means for the link's owner. */
export interface HostLinkReattach {
	/**
	 * The link now reaches another server identity (other credentials, another
	 * working directory): nothing subscribed to or memoized from the previous
	 * one applies. False when the same unit was attached again.
	 */
	identityChanged: boolean;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	onProgress?: MCPRequestOptions["onProgress"];
	/** The host acknowledged this `subscriptions/listen`: it is a stream now and has no deadline. */
	acknowledged?: () => void;
}

/** One attachment and the lines waiting for its tunnel to drain. */
interface Attached {
	host: McpAttachment;
	era: McpEra;
	/** Unwritten lines in order; `id` names the request a line carries, so it can still be withdrawn. */
	backlog: { line: string; id?: number }[];
	draining: boolean;
}

function isRequestId(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

function isUnauthorized(error: unknown): boolean {
	return (
		error instanceof MCPTransportError &&
		error.failure === "http_status" &&
		(error.code === 401 || error.code === 403)
	);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

/** {@link MCPTransport} over a tunnel to the MCP host unit of one server. */
export class HostLink implements MCPTransport {
	readonly #name: string;
	readonly #instance: string;
	readonly #roots: () => MCPRoot[];
	readonly #idleMs: number;
	readonly #timeout: number | undefined;
	readonly #injectedAccess: McpHostAccess | undefined;
	readonly #pending = new Map<string | number, PendingRequest>();
	#spec: McpServerSpec;
	#access: McpHostAccess | undefined;
	#offReconnect: (() => void) | undefined;
	#attached: Attached | undefined;
	/**
	 * Bumped whenever the attachment is superseded: lost, retargeted, closed.
	 * Whatever was started for an earlier value — an attach, a credential
	 * refresh — finds itself stale after its next await and lets go of what it
	 * acquired instead of applying it.
	 */
	#generation = 0;
	/** Settles (never rejects) when the newest attachment being taken is decided; requests wait on it. */
	#retaking: Promise<void> | undefined;
	/** The credential refresh under way and the generation whose credentials were refused. */
	#authRefresh: { generation: number; outcome: Promise<boolean> } | undefined;
	/** The era re-probe under way and the generation whose modern attachment was rejected. */
	#eraRecovery: { generation: number; outcome: Promise<void> } | undefined;
	/**
	 * Generation attached by a credential refresh whose owner is still
	 * reloading the server. A refusal of those credentials ends the recovery
	 * instead of minting again.
	 */
	#recovering: number | undefined;
	#status: McpUpstreamStatus | undefined;
	#lastId = 0;
	#everAttached = false;
	#closed = false;

	/** The link lost its attachment and could not take a new one. */
	onClose?: () => void;
	onError?: (error: Error) => void;
	/** Every host notification except status, progress and the end of one of this link's requests. */
	onNotification?: (method: string, params: unknown) => void;
	/** The upstream's state as the host reports it: after each attach and on every change. */
	onStatus?: (status: McpUpstreamStatus) => void;
	/**
	 * A new attachment replaced a lost or retargeted one: every
	 * `subscriptions/listen` of the old one is over. After a credential
	 * refresh the link treats requests as part of that recovery until the
	 * returned promise settles: a 401/403 among them is final.
	 */
	onReattach?: (change: HostLinkReattach) => void | Promise<void>;
	/**
	 * Called on a 401/403 from a remote server, at the era probe of an attach
	 * or on a request; headers back retarget the link and retry once.
	 */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(options: HostLinkOptions) {
		this.#name = options.name;
		this.#spec = options.spec;
		this.#instance = options.instance;
		this.#roots = options.roots;
		this.#idleMs = options.idleMs;
		this.#timeout = options.timeout;
		this.#injectedAccess = options.access;
	}

	get connected(): boolean {
		return this.#attached !== undefined;
	}

	/** Whether the link lost its attachment and is taking a new one right now. */
	get reattaching(): boolean {
		return this.#retaking !== undefined;
	}

	/** The server this link currently reaches. */
	get spec(): McpServerSpec {
		return this.#spec;
	}

	/** The latest upstream status the host reported, if any. */
	get status(): McpUpstreamStatus | undefined {
		return this.#status;
	}

	/**
	 * Resolve the server's era and attach to its unit.
	 *
	 * @throws whatever the host reports: an `MCPTransportError` when the server cannot be probed, the abort reason of `signal`.
	 */
	async connect(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.#attached) return;
		await this.#attach(this.#generation, signal, true);
	}

	/**
	 * Send one request and resolve with its result. Waiting for the link to
	 * re-attach or for refreshed credentials counts against the request's own
	 * deadline and ends with its signal, as does re-probing a rejected era.
	 *
	 * @throws MCPTransportError on a server error, a host-reported failure, a deadline, a lost tunnel or params that cannot be serialized; the abort reason when `options.signal` aborts.
	 */
	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		const deadline = resolveMCPRequestDeadline(this.#timeout, method, params);
		const ran = { generation: this.#generation };
		try {
			return await this.#exchange<T>(method, params, options, deadline, ran);
		} catch (error) {
			if (!isUnauthorized(error)) throw error;
			const refreshed = await this.#awaitShared(
				this.#refreshAuth(ran.generation),
				options?.signal,
				deadline.timeoutMs,
				Date.now(),
			);
			if (!refreshed) throw error;
			return await this.#exchange<T>(method, params, options, deadline, ran);
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		const attached = this.#attached;
		if (!attached) throw this.#notConnected();
		this.#writeLine(attached, encodeJsonLine({ jsonrpc: "2.0", method, params: params ?? {} }));
	}

	/**
	 * Stop the upstream now and clear its crash history; the next request starts a fresh one.
	 *
	 * @throws MCPTransportError when the link is not attached.
	 */
	async restart(): Promise<void> {
		await this.notify(MCP_RESTART_METHOD);
	}

	/** Send the current roots to the host; a detached link sends them when it attaches. */
	setRoots(): void {
		const attached = this.#attached;
		if (attached) this.#sendRoots(attached);
	}

	/**
	 * Whether the process-wide host is now elsewhere than where this link is
	 * attached (`mcp.shared` was toggled, or the daemon came or went). Such a
	 * link moves with {@link retarget}; a restart would reach the old host.
	 */
	async hostMoved(): Promise<boolean> {
		if (this.#injectedAccess || !this.#access) return false;
		return (await mcpHostAccess()).shared !== this.#access.shared;
	}

	/**
	 * Point the link at `spec`: drop the current attachment, failing its
	 * in-flight requests, and attach to the unit of the new one. A retarget
	 * that starts before this one finished supersedes it.
	 *
	 * @throws when the new unit cannot be attached (the link is then detached and `onClose` has fired), or when a newer retarget or `close()` superseded this one.
	 */
	async retarget(spec: McpServerSpec, signal?: AbortSignal): Promise<void> {
		await this.#retarget(spec, signal, false);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#generation++;
		this.#retaking = undefined;
		this.#offReconnect?.();
		this.#offReconnect = undefined;
		const attached = this.#attached;
		this.#attached = undefined;
		attached?.host.tunnel.close();
		attached?.host.release();
		this.#failPending(this.#closedError("Transport closed"));
	}

	get #kind(): MCPTransportKind {
		return this.#spec.transport === "stdio" ? "stdio" : "http";
	}

	#notConnected(): MCPTransportError {
		return new MCPTransportError({
			transport: this.#kind,
			stage: "connect",
			failure: "closed",
			message: "Transport not connected",
			retryable: true,
		});
	}

	/** Failure of a request that was handed to the host and may have run. */
	#closedError(message: string): MCPTransportError {
		return new MCPTransportError({
			transport: this.#kind,
			stage: "receive",
			failure: "closed",
			message,
			retryable: false,
		});
	}

	#timeoutError(limitMs: number): MCPTransportError {
		return new MCPTransportError({
			transport: this.#kind,
			stage: "receive",
			failure: "timeout",
			message: `Request timeout after ${limitMs}ms`,
			retryable: false,
		});
	}

	#failPending(error: MCPTransportError): void {
		for (const [, pending] of this.#pending) pending.reject(error);
	}

	/** @throws when `generation` was superseded: the caller's work is for an attachment nobody wants any more. */
	#assertCurrent(generation: number): void {
		if (this.#generation === generation) return;
		throw this.#closedError(this.#closed ? "Transport closed" : "MCP server connection was replaced");
	}

	async #retarget(
		spec: McpServerSpec,
		signal: AbortSignal | undefined,
		recovery: boolean,
		era?: McpEra,
	): Promise<void> {
		if (this.#closed) throw this.#closedError("Transport closed");
		const replaced = this.#spec;
		const generation = ++this.#generation;
		this.#spec = spec;
		const previous = this.#attached;
		this.#attached = undefined;
		this.#failPending(this.#closedError("MCP server connection was replaced"));
		previous?.host.tunnel.close();
		previous?.host.release();
		await this.#retake(generation, undefined, signal, replaced, recovery, era);
	}

	/**
	 * Attach for `generation`. `mayRefresh` lets a 401/403 from the era probe
	 * refresh the credentials once; an attach that already carries refreshed
	 * credentials must not.
	 */
	async #attach(
		generation: number,
		signal: AbortSignal | undefined,
		mayRefresh: boolean,
		resolvedEra?: McpEra,
	): Promise<void> {
		const access = this.#injectedAccess ?? (await mcpHostAccess());
		// Checked before the listener is registered: a link closed meanwhile would never remove it.
		this.#assertCurrent(generation);
		if (access !== this.#access) {
			this.#offReconnect?.();
			this.#access = access;
			this.#offReconnect = access.onReconnect(() => this.#hostReplaced());
		}
		const era = resolvedEra ?? (await this.#resolveEra(access, generation, signal, mayRefresh));
		this.#assertCurrent(generation);
		const spec = this.#spec;
		const host = await access.attach(
			{ spec, era, name: this.#name, instance: this.#instance, idleMs: this.#idleMs },
			signal,
		);
		if (this.#generation !== generation) {
			host.tunnel.close();
			host.release();
			this.#assertCurrent(generation);
		}
		const attached: Attached = { host, era, backlog: [], draining: false };
		const decoder = new JsonLineDecoder();
		this.#attached = attached;
		this.#everAttached = true;
		host.tunnel.start(
			chunk => {
				for (const line of decoder.push(chunk)) this.#receive(attached, line);
			},
			reason => this.#lost(attached, reason),
		);
		this.#sendRoots(attached);
	}

	async #resolveEra(
		access: McpHostAccess,
		generation: number,
		signal: AbortSignal | undefined,
		mayRefresh: boolean,
	): Promise<McpEra> {
		const spec = this.#spec;
		try {
			return (await access.resolve(spec, signal)).era;
		} catch (error) {
			if (!mayRefresh || !isUnauthorized(error)) throw error;
			const refreshed = await this.#refreshedSpec(generation, spec);
			if (!refreshed) throw error;
			this.#spec = refreshed;
			return (await access.resolve(refreshed, signal)).era;
		}
	}

	/**
	 * `spec` with freshly resolved credentials, for the server that refused the
	 * old ones. Undefined when there is nothing to refresh, or when the link
	 * was pointed elsewhere while the owner resolved them: credentials obtained
	 * for one server are never applied to another.
	 */
	async #refreshedSpec(generation: number, spec: McpServerSpec): Promise<McpServerSpec | undefined> {
		const refresh = this.onAuthError;
		if (!refresh || spec.transport === "stdio") return undefined;
		const headers = await refresh();
		if (!headers || this.#generation !== generation || this.#spec !== spec) return undefined;
		return { ...spec, headers };
	}

	/**
	 * Take a new attachment for `generation` while requests wait for the
	 * outcome, then let go of `previous`: releasing it only afterwards keeps a
	 * unit that is still alive from stopping in between. `replaced` is the spec
	 * the link reached before, which tells the owner whether the identity
	 * changed. An attempt superseded meanwhile ends quietly; its successor reports.
	 */
	#retake(
		generation: number,
		previous: Attached | undefined,
		signal: AbortSignal | undefined,
		replaced: McpServerSpec,
		recovery: boolean,
		era?: McpEra,
	): Promise<void> {
		const attempt = (async () => {
			try {
				await this.#attach(generation, signal, !recovery, era);
			} catch (error) {
				if (this.#generation === generation) {
					this.#retaking = undefined;
					logger.debug("MCP host link could not re-attach", { path: `mcp:${this.#name}`, error });
					this.onError?.(error instanceof Error ? error : new Error(String(error)));
					this.onClose?.();
				}
				throw error;
			} finally {
				previous?.host.tunnel.close();
				previous?.host.release();
			}
			this.#retaking = undefined;
			// Compared after the attach: its era probe may have refreshed the credentials too.
			const identityChanged = mcpIdentity(this.#spec) !== mcpIdentity(replaced);
			let reloaded: Promise<void> = Promise.resolve();
			try {
				reloaded = Promise.resolve(this.onReattach?.({ identityChanged }));
			} catch (error) {
				logger.debug("MCP re-attach handler failed", { path: `mcp:${this.#name}`, error });
			}
			if (!recovery) return;
			this.#recovering = generation;
			const recovered = (): void => {
				if (this.#recovering === generation) this.#recovering = undefined;
			};
			reloaded.then(recovered, recovered);
		})();
		this.#retaking = attempt.then(undefined, () => {});
		return attempt;
	}

	#lost(attached: Attached, reason: string | null): void {
		if (this.#attached !== attached) return;
		const generation = ++this.#generation;
		this.#attached = undefined;
		this.#failPending(this.#closedError(reason ? `MCP host connection lost: ${reason}` : "MCP host connection lost"));
		void this.#retake(generation, attached, undefined, this.#spec, false).catch(() => {});
	}

	#hostReplaced(): void {
		if (this.#closed || !this.#everAttached) return;
		const attached = this.#attached;
		if (attached) {
			this.#lost(attached, "host restarted");
		} else if (!this.#retaking) {
			void this.#retake(++this.#generation, undefined, undefined, this.#spec, false).catch(() => {});
		}
	}

	#sendRoots(attached: Attached): void {
		this.#writeLine(
			attached,
			encodeJsonLine({ jsonrpc: "2.0", method: MCP_ROOTS_METHOD, params: { roots: this.#roots() } }),
		);
	}

	/**
	 * Hand `line` to the tunnel in order, never writing past its high-water
	 * mark. A line that has to wait keeps `id`, the request it carries, so the
	 * request can be withdrawn before the host ever sees it.
	 */
	#writeLine(attached: Attached, line: string, id?: number): void {
		if (attached.draining) {
			attached.backlog.push({ line, id });
			return;
		}
		if (!attached.host.tunnel.send(line)) void this.#drain(attached);
	}

	async #drain(attached: Attached): Promise<void> {
		attached.draining = true;
		try {
			for (;;) {
				await attached.host.tunnel.drained();
				let full = false;
				while (!full) {
					const next = attached.backlog.shift();
					if (next === undefined) break;
					full = !attached.host.tunnel.send(next.line);
				}
				if (!full) return;
			}
		} catch (error) {
			logger.debug("MCP host tunnel write failed", { path: `mcp:${this.#name}`, error });
		} finally {
			attached.draining = false;
		}
	}

	#receive(attached: Attached, line: string): void {
		try {
			const message: unknown = JSON.parse(line);
			if (!isRecord(message)) return;
			const id = message.id;
			if (typeof message.method === "string") {
				if (isRequestId(id)) {
					// 2026-07-28 has no server-to-client requests; asks arrive as `input_required` results.
					this.#writeLine(
						attached,
						encodeJsonLine({
							jsonrpc: "2.0",
							id,
							error: { code: MCPErrorCode.MethodNotFound, message: "Method not found" },
						}),
					);
					return;
				}
				this.#notified(message.method, message.params);
				return;
			}
			if (!isRequestId(id)) return;
			const pending = this.#pending.get(id);
			if (!pending) return;
			if (message.error === undefined) pending.resolve(message.result);
			else pending.reject(this.#responseError(message.error));
		} catch (error) {
			logger.debug("MCP host message dropped", { path: `mcp:${this.#name}`, error });
		}
	}

	#responseError(error: unknown): MCPTransportError {
		if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
			return new MCPTransportError({
				transport: this.#kind,
				stage: "decode",
				failure: "malformed_response",
				message: "MCP host sent a malformed error response",
				retryable: false,
			});
		}
		const rpc: JsonRpcError = { code: error.code, message: error.message, data: error.data };
		return decodeHostError(rpc) ?? createMCPJsonRpcError(this.#kind, rpc);
	}

	#notified(method: string, params: unknown): void {
		if (method === MCP_STATUS_METHOD) {
			const status = UpstreamStatus(params);
			if (status instanceof type.errors) return;
			this.#status = status;
			this.onStatus?.(status);
			return;
		}
		if (method === MCPNotificationMethods.PROGRESS) {
			routeProgressNotification(method, params, token => this.#pending.get(token)?.onProgress);
			return;
		}
		if (method === CANCELLED_METHOD) {
			// The host's only cancellation: it tore down one of this link's listen streams.
			const requestId = isRecord(params) ? params.requestId : undefined;
			if (isRequestId(requestId)) {
				this.#pending.get(requestId)?.reject(this.#closedError("MCP host ended the subscription"));
			}
			return;
		}
		if (method === MCP_SUBSCRIPTION_ACKNOWLEDGED) {
			const listen = subscriptionIdOf(params);
			if (listen !== undefined) this.#pending.get(listen)?.acknowledged?.();
		}
		this.onNotification?.(method, params);
	}

	/**
	 * Refresh the credentials the attachment of `generation` was refused with
	 * and retarget to them: one recovery for every request refused on the same
	 * credentials. False when nothing was refreshed.
	 */
	#refreshAuth(generation: number): Promise<boolean> {
		// These credentials were minted by a recovery that is still under way; minting again would not end.
		if (generation !== this.#generation || generation === this.#recovering) return Promise.resolve(false);
		const running = this.#authRefresh;
		if (running?.generation === generation) return running.outcome;
		const spec = this.#spec;
		const outcome = (async () => {
			const refreshed = await this.#refreshedSpec(generation, spec);
			if (!refreshed) return false;
			await this.#retarget(refreshed, undefined, true);
			return true;
		})().finally(() => {
			if (this.#authRefresh?.outcome === outcome) this.#authRefresh = undefined;
		});
		this.#authRefresh = { generation, outcome };
		return outcome;
	}

	/**
	 * Re-probe the server whose modern attachment of `generation` rejected this
	 * revision, and move the link to its handshake-era unit when the probe
	 * confirms one: one recovery for every request rejected on the same
	 * attachment. It belongs to the link, not to a caller, so a request that
	 * gives up meanwhile cannot leave the link detached. Never rejects.
	 */
	#recoverEra(generation: number): Promise<void> {
		const access = this.#access;
		if (!access || generation !== this.#generation) return Promise.resolve();
		const running = this.#eraRecovery;
		if (running?.generation === generation) return running.outcome;
		const spec = this.#spec;
		const outcome = (async () => {
			try {
				const { era } = await access.resolve(spec);
				if (era !== "legacy" || generation !== this.#generation) return;
				await this.#retarget(spec, undefined, false, era);
			} catch (error) {
				// Whoever was rejected still reports the server's own answer.
				logger.debug("MCP era recovery failed", { path: `mcp:${this.#name}`, error });
			}
		})().finally(() => {
			if (this.#eraRecovery?.outcome === outcome) this.#eraRecovery = undefined;
		});
		this.#eraRecovery = { generation, outcome };
		return outcome;
	}

	/**
	 * Wait for work other callers share for as long as this caller's own signal
	 * and deadline allow. Giving up leaves the work running for the others.
	 */
	async #awaitShared<T>(
		shared: Promise<T>,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		startedAt: number,
	): Promise<T> {
		if (signal?.aborted) throw abortReason(signal);
		const { promise: gaveUp, reject } = Promise.withResolvers<never>();
		const onAbort = (): void => {
			if (signal) reject(abortReason(signal));
		};
		let timer: NodeJS.Timeout | undefined;
		if (isMCPTimeoutEnabled(timeoutMs)) {
			const remaining = startedAt + timeoutMs - Date.now();
			if (remaining <= 0) throw this.#timeoutError(timeoutMs);
			timer = setTimeout(() => reject(this.#timeoutError(timeoutMs)), remaining);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([shared, gaveUp]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #exchange<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
		deadline: MCPRequestDeadline,
		ran: { generation: number },
	): Promise<T> {
		const signal = options?.signal;
		const startedAt = Date.now();
		// A newer attachment may start being taken while this one is awaited.
		while (this.#retaking) await this.#awaitShared(this.#retaking, signal, deadline.timeoutMs, startedAt);
		const attached = this.#attached;
		if (!attached) throw this.#notConnected();
		if (signal?.aborted) throw abortReason(signal);

		const id = ++this.#lastId;
		const generation = this.#generation;
		ran.generation = generation;
		const progressSink = options?.onProgress;
		let line: string;
		try {
			line = encodeJsonLine({
				jsonrpc: "2.0",
				id,
				method,
				params: withRequestMeta(progressSink ? withProgressToken(params, id) : params),
			});
		} catch (error) {
			// Nothing was sent and sending it again cannot go better.
			throw new MCPTransportError({
				transport: this.#kind,
				stage: "send",
				failure: "unknown",
				message: `MCP request could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
				retryable: false,
				cause: error,
			});
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let expiresAt = Number.POSITIVE_INFINITY;
		let settled = false;
		let sent = false;

		const settle = (error?: Error, value?: unknown): boolean => {
			if (settled) return false;
			settled = true;
			clearTimeout(timer);
			timer = undefined;
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
			if (error) reject(error);
			else resolve(value as T);
			return true;
		};

		const sendCancellation = (reason: string): void => {
			if (!sent || this.#attached !== attached) return;
			// Still waiting for the tunnel: withdraw it, so the host never runs what its caller gave up on.
			const queued = attached.backlog.findIndex(entry => entry.id === id);
			if (queued !== -1) {
				attached.backlog.splice(queued, 1);
				return;
			}
			this.#writeLine(
				attached,
				encodeJsonLine({ jsonrpc: "2.0", method: CANCELLED_METHOD, params: { requestId: id, reason } }),
			);
		};

		const onAbort = (): void => {
			if (signal && settle(abortReason(signal))) sendCancellation("Request cancelled by the client");
		};

		// Progress restarts the deadline, never past the request's hard cap.
		const armTimer = (): void => {
			const now = Date.now();
			const delay = Math.min(deadline.timeoutMs, startedAt + deadline.maxTotalMs - now);
			expiresAt = now + delay;
			if (delay <= 0) return;
			const limit = delay < deadline.timeoutMs ? deadline.maxTotalMs : deadline.timeoutMs;
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (settle(this.#timeoutError(limit))) sendCancellation(`Request timed out after ${limit}ms`);
			}, delay);
		};

		this.#pending.set(id, {
			onProgress: progressSink
				? progress => {
						if (timer) armTimer();
						progressSink(progress);
					}
				: undefined,
			// Until acknowledged a listen is a request like any other; afterwards it is a stream one side ends.
			acknowledged:
				method === LISTEN_METHOD
					? () => {
							clearTimeout(timer);
							timer = undefined;
						}
					: undefined,
			resolve: value => {
				settle(undefined, value);
			},
			reject: error => {
				settle(error);
			},
		});
		if (isMCPTimeoutEnabled(deadline.timeoutMs)) armTimer();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			options?.onRequestId?.(id);
			this.#writeLine(attached, line, id);
			sent = true;
		} catch (error) {
			settle(
				new MCPTransportError({
					transport: this.#kind,
					stage: "send",
					failure: "closed",
					message: `MCP host tunnel rejected the request: ${error instanceof Error ? error.message : String(error)}`,
					retryable: true,
					cause: error,
				}),
			);
		}

		try {
			return await promise;
		} catch (error) {
			if (
				attached.era !== "modern" ||
				!(error instanceof MCPTransportError) ||
				error.rpc?.code !== MCPErrorCode.UnsupportedProtocolVersion
			) {
				throw error;
			}
			// The request is not replayed: its caller waits only so that its next one finds the link moved.
			const recovery = this.#recoverEra(generation);
			const remaining = expiresAt - Date.now();
			if (remaining > 0) {
				try {
					await this.#awaitShared(recovery, signal, Number.isFinite(remaining) ? remaining : 0, Date.now());
				} catch {
					// Out of time: the server's own answer below is still what this request came to.
				}
			}
			if (signal?.aborted) throw abortReason(signal);
			throw error;
		}
	}
}
