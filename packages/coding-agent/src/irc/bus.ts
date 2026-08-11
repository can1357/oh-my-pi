import { type IrcMessage, type IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/hub";
/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, REMOTE_ID_PREFIX } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { CustomMessage } from "../session/messages";

/**
 * Transport that carries a cross-process IRC send out of this process to the mesh behind it (e.g. the
 * murmur bridge). Installed per globally-unique `namespace` via {@link IrcBus.setRemoteTransport};
 * `send` routes any `@<namespace>/<name>` recipient to that namespace's transport (prefix-authoritative
 * — a registered proxy ref is optional). `opts.toName` is the recipient's bare mesh name (the `@ns/`
 * prefix stripped) so the transport never parses ids; `opts.expectsReply` is forwarded so an awaited
 * send gets the same side-channel auto-reply behaviour cross-process as a local send. Returns a
 * synthesized {@link IrcDeliveryReceipt} for a uniform outcome.
 */
export interface RemoteTransport {
	send(message: IrcMessage, opts?: { expectsReply?: boolean; toName?: string }): Promise<IrcDeliveryReceipt>;
}

/**
 * The remote agent id scheme: a cross-process peer is addressed as `@<namespace>/<name>` — a
 * globally-unique `namespace` (claimed by the installing extension) plus the peer's bare mesh
 * `name`. Because a local agent id can never start with `@` ({@link REMOTE_ID_PREFIX}), the remote
 * and local id spaces are disjoint and can never collide.
 */
const REMOTE_NAMESPACE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REMOTE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Whether `namespace` is a well-formed remote namespace (1-64 chars of letters, digits, `.`, `_`, `-`). */
export function isValidRemoteNamespace(namespace: string): boolean {
	return REMOTE_NAMESPACE_RE.test(namespace);
}

/** Whether `name` is a well-formed bare remote peer name (1-128 chars of letters, digits, `.`, `_`, `-`). */
export function isValidRemoteName(name: string): boolean {
	return REMOTE_NAME_RE.test(name);
}

/**
 * Compose a remote agent id `@<namespace>/<name>`. Throws on an invalid namespace/name so a
 * malformed id can never enter the registry or routing.
 */
export function composeRemoteId(namespace: string, name: string): string {
	if (!isValidRemoteNamespace(namespace)) {
		throw new Error(
			`Invalid remote namespace ${JSON.stringify(namespace)} (allowed: 1-64 chars of letters, digits, ".", "_", "-").`,
		);
	}
	if (!isValidRemoteName(name)) {
		throw new Error(
			`Invalid remote peer name ${JSON.stringify(name)} (allowed: 1-128 chars of letters, digits, ".", "_", "-").`,
		);
	}
	return `${REMOTE_ID_PREFIX}${namespace}/${name}`;
}

/** The namespace of a remote id `@<namespace>/<name>`, or undefined if `id` is not remote-prefixed. */
export function remoteNamespaceOf(id: string): string | undefined {
	if (!id.startsWith(REMOTE_ID_PREFIX)) return undefined;
	const sep = id.indexOf("/", REMOTE_ID_PREFIX.length);
	if (sep < REMOTE_ID_PREFIX.length + 1) return undefined;
	return id.slice(REMOTE_ID_PREFIX.length, sep);
}

/** The bare mesh name of a remote id `@<namespace>/<name>`, or undefined if `id` is not remote. */
export function remoteNameOf(id: string): string | undefined {
	const namespace = remoteNamespaceOf(id);
	if (namespace === undefined) return undefined;
	return id.slice(REMOTE_ID_PREFIX.length + namespace.length + 1);
}

/** Whether `id` is a well-formed remote id `@<namespace>/<name>` (valid namespace + bare name). */
export function isValidRemoteId(id: string): boolean {
	const namespace = remoteNamespaceOf(id);
	if (namespace === undefined || !isValidRemoteNamespace(namespace)) return false;
	const name = remoteNameOf(id);
	return name !== undefined && isValidRemoteName(name);
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/**
 * Rejection reason for a `send await:true` whose awaited peer reached a
 * terminal stop (ended its turn, parked, was aborted, or unregistered)
 * without ever replying. Distinct from a plain timeout so the sender can
 * surface "they stopped" instead of stranding the caller on the full
 * `irc.timeoutMs` window.
 */
export class IrcAwaitTargetStopped extends Error {
	constructor(target: string) {
		super(`Awaited peer "${target}" stopped without replying.`);
		this.name = "IrcAwaitTargetStopped";
	}
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	/** One IrcBus per AgentRegistry: the root + its subagents share the global registry (one bus, so
	 *  Main<->Scout works), while an isolated session registry gets its own bus with its own waiters,
	 *  mailboxes, and transports. Weak so a bus is collected with its registry. */
	static #buses = new WeakMap<AgentRegistry, IrcBus>();

	/** The bus serving `registry`, created on first use. Delivery resolves recipients in that one
	 *  registry, so a custom session registry is isolated by construction (no cross-registry leak). */
	static forRegistry(registry: AgentRegistry): IrcBus {
		let bus = IrcBus.#buses.get(registry);
		if (!bus) {
			bus = new IrcBus(registry);
			IrcBus.#buses.set(registry, bus);
		}
		return bus;
	}

	/** The bus for the process-global registry — the default for the root session and its subagents. */
	static global(): IrcBus {
		return IrcBus.forRegistry(AgentRegistry.global());
	}

	/** Reset the global registry's bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#buses.delete(AgentRegistry.global());
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** Timestamp of the latest successful send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, number>>();
	/** Outbound transports keyed by globally-unique NAMESPACE (the `@<namespace>/` routing prefix). */
	readonly #transports = new Map<string, RemoteTransport>();
	/** namespace -> the extension load `ownerToken` that claimed it (clash guard + owner-scoped release). */
	readonly #namespaceOwners = new Map<string, string>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy + registry-paired: default to THIS registry's lifecycle manager (mirrors the
		// bus<->registry pairing) so a custom-registry bus revives its own parked peers instead
		// of consulting the global manager. Only touched when a parked recipient needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.forRegistry(this.#registry);
	}

	/**
	 * Install, update, or clear the outbound transport for a globally-unique `namespace`, claimed by
	 * the installing extension load's `ownerToken`:
	 * - unclaimed namespace: claim it for `ownerToken` and install `transport`;
	 * - claimed by the SAME `ownerToken`: update `transport`, or (with `undefined`) clear ROUTING while
	 *   KEEPING the claim + any registered peers, so the owner can reinstall after a reconnect;
	 * - claimed by a DIFFERENT `ownerToken`: throw — a namespace is single-owner across the process, so
	 *   two bridges to the same external cluster must each pick a distinct namespace.
	 *
	 * Full release of the claim (freeing the namespace) happens via {@link releaseTransportsForOwner}
	 * on extension teardown / load-failure rollback, never on a plain clear.
	 */
	setRemoteTransport(namespace: string, transport: RemoteTransport | undefined, ownerToken: string): void {
		const owner = this.#namespaceOwners.get(namespace);
		if (owner !== undefined && owner !== ownerToken) {
			throw new Error(
				`IRC namespace "${namespace}" is already claimed by another extension load; choose a distinct namespace.`,
			);
		}
		if (transport) {
			this.#namespaceOwners.set(namespace, ownerToken);
			this.#transports.set(namespace, transport);
		} else {
			// A clear is only meaningful for a namespace this load already claimed (install → clear →
			// reinstall, the reconnect flow). Reject a clear of an UNCLAIMED namespace: otherwise a
			// clear-before-install marks the namespace claimed on the ExtensionAPI side (#claimedNamespace)
			// while recording NO owner here, letting a later load claim it and steal this load's @ns/*
			// routing (PR #7401 codex).
			if (owner === undefined) {
				throw new Error(`IRC namespace "${namespace}" is not claimed; install a transport before clearing.`);
			}
			// Clear ROUTING only; the claim survives (reconnect-friendly). releaseTransportsForOwner drops it.
			this.#transports.delete(namespace);
		}
	}

	/** Whether any outbound transport is installed (murmur-q00p): a leaf agent then still has peers. */
	hasRemoteTransport(): boolean {
		return this.#transports.size > 0;
	}

	/**
	 * Whether any namespace is currently CLAIMED (murmur-q00p): true while an extension owns a
	 * namespace, even across a reconnect `setRemoteTransport(ns, undefined)` clear that drops routing
	 * but keeps the claim and its registered remote peers. The durable "this session is bridged"
	 * signal — unlike `hasRemoteTransport`, which reports only a transport installed right now.
	 */
	hasClaimedNamespace(): boolean {
		return this.#namespaceOwners.size > 0;
	}

	/**
	 * Release every namespace claimed by `ownerToken`: drop its transport AND its claim (freeing the
	 * namespace for re-claim). Owner-scoped, so sibling loads are untouched; called on extension
	 * load-failure rollback and runtime teardown. Distinct from a plain `setRemoteTransport(ns,
	 * undefined, owner)` clear, which keeps the claim for reconnect.
	 */
	releaseTransportsForOwner(ownerToken: string): void {
		for (const [namespace, owner] of this.#namespaceOwners) {
			if (owner === ownerToken) {
				this.#namespaceOwners.delete(namespace);
				this.#transports.delete(namespace);
			}
		}
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		const receipt = await this.#deliver(message, opts);
		if (receipt.outcome !== "failed") {
			let sent = this.#lastSent.get(message.from);
			if (!sent) {
				sent = new Map();
				this.#lastSent.set(message.from, sent);
			}
			sent.set(message.to, message.ts);
		}
		return receipt;
	}

	/**
	 * Whether `from` successfully sent `to` anything at or after `sinceTs`.
	 * The wake-turn relay uses it to skip agents that already answered their
	 * waker themselves.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		const ts = this.#lastSent.get(from)?.get(to);
		return ts !== undefined && ts >= sinceTs;
	}

	async #deliver(
		message: IrcMessage,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const namespace = remoteNamespaceOf(message.to);
		if (namespace !== undefined) {
			// Reach-by-name still must honor the @ns/name contract: reject a malformed name (empty,
			// whitespace, or an extra "/") locally so a mistyped id never reaches the transport as a
			// bogus opts.toName.
			const toName = remoteNameOf(message.to);
			if (toName === undefined || !isValidRemoteName(toName)) {
				return {
					to: message.to,
					outcome: "failed",
					error: `Invalid remote recipient "${message.to}" — the name after "@${namespace}/" must match the @ns/name contract (letters, digits, ".", "_", "-").`,
				};
			}
			// Prefix-authoritative: an `@<namespace>/<name>` recipient is unambiguously remote and routes
			// to its namespace's transport — a registered proxy ref is optional (reach-by-name). A ref is
			// consulted ONLY to honor an `aborted` tombstone, matching a local hard-aborted agent.
			const ref = this.#registry.get(message.to);
			if (ref?.status === "aborted") {
				return {
					to: message.to,
					outcome: "failed",
					error: `Agent "${message.to}" was aborted and cannot be messaged.`,
				};
			}
			const transport = this.#transports.get(namespace);
			if (!transport) {
				return {
					to: message.to,
					outcome: "failed",
					error: `Remote agent "${message.to}" is unreachable — no transport for namespace "@${namespace}".`,
				};
			}
			try {
				const receipt = await transport.send(message, {
					expectsReply: opts?.expectsReply,
					toName,
				});
				// Relay a successful outbound send to the root UI — symmetric with local agent↔agent
				// delivery (§#deliverToLocalRef) and inbound remote→local (deliverInbound). Display-only
				// and skips Main-as-endpoint, so no echo loop (murmur-ffh4).
				if (receipt.outcome !== "failed" && !opts?.suppressRelay) this.#relayToMainUi(message);
				return receipt;
			} catch (error) {
				// A transport that rejects (transient network/proxy failure) must not escape IrcBus.send
				// and turn a whole (possibly broadcast) `hub send` into a tool exception — surface it as a
				// failed receipt, symmetric with local delivery.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		// A non-namespaced id is local. A bare miss is a genuine unknown recipient and gets the
		// actionable local error even with transports installed — a mistyped local id never leaks out.
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		return this.#deliverToLocalRef(ref, message, opts);
	}

	/**
	 * Local-only inbound delivery for the murmur bridge (murmur-4e7n). Shares `send`'s
	 * in-process delivery core (revive / waiter / aside / wake, full
	 * `injected|woken|revived|failed` outcome), but a local-registry MISS returns `failed` and
	 * NEVER consults the remote transport — a message that arrived FROM murmur must not bounce
	 * back onto the bus (contract omp-bridge.md §8). Returns omp's freshly-minted native id so
	 * the bridge can correlate it with the murmur msgId without conflating id namespaces.
	 */
	async deliverInbound(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<{ receipt: IrcDeliveryReceipt; id: string }> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		// Inbound arrives FROM the mesh, so the sender MUST be a well-formed remote id
		// (@namespace/name). Reject a bare local id (e.g. "Main") or a malformed remote id before the
		// local delivery path: msg.from feeds wait filters, IrcBridge.deliver, and #runAutoReply's
		// side-channel reply, so an unvalidated sender could impersonate a local agent and route a
		// reply back to that id on the local bus.
		if (!isValidRemoteId(message.from)) {
			return {
				receipt: {
					to: message.to,
					outcome: "failed",
					error: `Inbound sender "${message.from}" is not a remote id (@namespace/name).`,
				},
				id: message.id,
			};
		}
		const ref = this.#registry.get(message.to);
		if (!ref || ref.kind === "remote") {
			return {
				receipt: { to: message.to, outcome: "failed", error: `Unknown agent "${message.to}" — not on this node.` },
				id: message.id,
			};
		}
		const receipt = await this.#deliverToLocalRef(ref, message, opts);
		return { receipt, id: message.id };
	}

	/**
	 * In-process delivery core shared by `send` and `deliverInbound`: the recipient `ref` is
	 * present in this process's registry; resolve the aborted / advisor / parked-revive / waiter
	 * / live-session paths and return the outcome. Never touches the remote transport.
	 */
	async #deliverToLocalRef(
		ref: AgentRef,
		message: IrcMessage,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` recipient always needs the lifecycle to revive it — this is
		// read from *this* bus's registry, so it holds for any registry. The
		// mid-park / adopted checks below query the lifecycle's own state, which
		// only describes the registry it manages: consult them only when the
		// lifecycle owns this bus's registry, otherwise a custom-registry bus
		// (fallen back to the global manager) would gate a live recipient on
		// unrelated global park state. Main/non-adopted live peers skip the gate,
		// and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: {
			drainPending?: boolean;
			liveness?: { registry: AgentRegistry; senderId: string };
			awaitTarget?: { registry: AgentRegistry; target: string };
		},
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;
		let unsubscribeAwaitTarget: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
			unsubscribeAwaitTarget?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasWaitableSender = (from?: string): boolean =>
				registry
					.listVisibleTo(senderId)
					.some(ref => (ref.kind === "remote" || registry.isRunning(ref)) && (!from || ref.id === from));
			const check = filter.from ? () => hasWaitableSender(filter.from) : () => hasWaitableSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		// `send await:true`: settle the sender promptly once the awaited peer
		// reaches a terminal stop without replying, instead of stranding it on
		// the full timeout. Unlike `liveness`, this tolerates a peer that is
		// idle/parked when the send lands (the send is about to wake or revive
		// it): it only aborts once the peer has actually been observed running
		// and then stopped, or is unambiguously gone (unregistered / aborted).
		// A real reply resolves the waiter first (the recipient sends it mid-turn,
		// before the turn-end idle transition), so cleanup tears this down.
		const awaitTarget = options?.awaitTarget;
		if (awaitTarget) {
			const { registry, target } = awaitTarget;
			let subscribedSession: AgentSession | null = null;
			let unsubscribeSession: (() => void) | undefined;
			let active = true;
			// The peer's terminal `agent_end` is the authoritative "stopped" signal.
			// It is emitted only after the peer's prompt fully unwinds (see
			// AgentSession#flushPendingAgentEnd) and supersedes scheduled
			// continuations. A side-channel auto-reply may outlive that main turn,
			// though, so wait for it before declaring the peer stopped: its bus send
			// resolves this waiter first; an empty/failed reply then falls through to
			// the clean stopped result.
			const onSessionEvent = (event: AgentSessionEvent): void => {
				if (event.type !== "agent_end" || event.isTerminal === false) return;
				const session = subscribedSession;
				if (!session) {
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
					return;
				}
				void session.waitForIrcReplies().then(() => {
					if (!active || registry.get(target)?.session !== session) return;
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
				});
			};
			const sync = (): void => {
				const ref = registry.get(target);
				// Gone or hard-aborted: no reply will ever come.
				if (!ref || ref.status === "aborted") {
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
					return;
				}
				// Follow the live session across a park→revive rebuild; tolerate a
				// parked peer with no session yet (the send is about to revive it).
				const session = ref.session;
				if (session && session !== subscribedSession) {
					unsubscribeSession?.();
					subscribedSession = session;
					unsubscribeSession = session.subscribe(onSessionEvent);
				}
			};
			const unsubscribeChange = registry.onChange(sync);
			unsubscribeAwaitTarget = () => {
				active = false;
				unsubscribeChange();
				unsubscribeSession?.();
			};
			sync();
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(agentId);
		return mailbox;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block: peeking with `inbox` and consuming afterwards would open a window
	 * for a concurrent consumer of the same mailbox to take the message in
	 * between, and a plain `inbox` drain would swallow the whole backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, from);
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent (or agent↔remote) traffic as a display-only card on the ROOT session's
	 * UI — the `main`-kind root of the LOCAL participant's tree ({@link #rootMainFor}): "Main" for
	 * the in-repo default, a custom id (e.g. ACP's `acp:<sessionId>`) for an embedder-supplied
	 * registry, and — when several top-level sessions share one registry — the sender's OWN root.
	 * Skipped when that root is itself an endpoint: as recipient its own `deliverIrcMessage`/`wait`
	 * result already shows the message, and as sender the irc send tool call already rendered it.
	 */
	#relayToMainUi(message: IrcMessage): void {
		// The local participant is the non-remote endpoint (a remote `@ns/name` peer has no local
		// transcript to relay into).
		const localId = remoteNamespaceOf(message.from) === undefined ? message.from : message.to;
		const root = this.#rootMainFor(localId);
		if (!root || message.to === root.id || message.from === root.id) return;
		const rootSession = root.session;
		if (!rootSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			rootSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: root UI relay failed", { to: message.to, error: String(error) });
		}
	}

	/**
	 * The `main`-kind root of `id`'s tree — walk its parentId chain to the first `main` ref, so in a
	 * shared registry a subagent's traffic lands on ITS root, not whichever main registered first.
	 * Falls back to the registry's main when the chain isn't registered (a synthetic/unregistered
	 * sender) so the relay still surfaces instead of being dropped.
	 */
	#rootMainFor(id: string): AgentRef | undefined {
		let ref = this.#registry.get(id);
		const seen = new Set<string>();
		while (ref && ref.kind !== "main" && ref.parentId && !seen.has(ref.id)) {
			seen.add(ref.id);
			ref = this.#registry.get(ref.parentId);
		}
		return ref?.kind === "main" ? ref : this.#registry.list().find(candidate => candidate.kind === "main");
	}
}
