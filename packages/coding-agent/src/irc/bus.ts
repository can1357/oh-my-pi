/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked and killed agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage).
 */

import { type IrcDeliveryReceipt, type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID, REMOTE_ID_PREFIX } from "../registry/agent-registry";
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
	filter: IrcWaitFilter;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Which messages a bus {@link IrcBusApi.wait} consumes. */
export interface IrcWaitFilter {
	/** Only messages from this agent. */
	from?: string;
	/**
	 * Skip broadcast legs and progress notes, which ask the waiter nothing: they
	 * reach it through ordinary delivery, a non-interrupting aside when it is busy.
	 */
	directOnly?: boolean;
	/**
	 * With `directOnly`, still take a broadcast from these agents: the waiter
	 * asked them something, so their news interrupts its wait without settling
	 * the outstanding direct question (see {@link IrcBusApi.unansweredSends}).
	 */
	repliesFrom?: readonly string[];
}

/** Whether a bus wait under `filter` consumes `msg`. */
function ircWaitAccepts(filter: IrcWaitFilter, msg: IrcMessage): boolean {
	if (filter.from !== undefined && msg.from !== filter.from) return false;
	if (!filter.directOnly || (!msg.broadcast && !msg.progress)) return true;
	return !msg.progress && (filter.repliesFrom?.includes(msg.from) ?? false);
}

/** When a send went out: wall-clock `ts`, and `seq` to order sends within one millisecond. */
interface SendMark {
	ts: number;
	seq: number;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

/** Public surface of the process-global IRC bus, implemented locally on main and by a proxy in workers. */
export interface IrcBusApi {
	/** Fire-and-forget delivery; the receipt reports how the message reached the recipient. */
	send(msg: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt>;
	/** Whether `from` successfully sent `to` anything, progress included, at or after `sinceTs`. */
	sentSince(from: string, to: string, sinceTs: number): boolean;
	/** Agents `from` messaged directly at or after `sinceTs` that have not answered since. */
	unansweredSends(from: string, sinceTs: number): Array<{ to: string; sentAt: number; promised: boolean }>;
	/** Block until a message for `agentId` that `filter` accepts arrives; null on timeout. */
	wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null>;
	/** Consume the oldest pending message for `agentId` (optionally from `from`). */
	take(agentId: string, from?: string): IrcMessage | undefined;
	/** Unread count for the local Agent Hub overlay. */
	unreadCount(agentId: string): number;
	/** Count a settled job of agent `from` owned by `to` as `from`'s reply to `to`. */
	recordReply(from: string, to: string): void;
}

export class IrcBus implements IrcBusApi {
	/** The process-global bus: lazily a local {@link IrcBus} over the global registry, or the proxy of
	 *  main's bus a worker installed. */
	static #global: IrcBusApi | undefined;
	/** One local IrcBus per isolated (non-global) AgentRegistry, with its own waiters, mailboxes, and
	 *  transports. Weak so a bus is collected with its registry. */
	static #buses = new WeakMap<AgentRegistryApi, IrcBus>();

	/** The installed bus; lazily a local {@link IrcBus} unless a worker installed a proxy. */
	static global(): IrcBusApi {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** The bus serving `registry`: the global bus for the global registry (the root session and its
	 *  subagents, wherever they run), otherwise that registry's own local bus, created on first use.
	 *  Delivery resolves recipients in that one registry, so an isolated session registry is isolated
	 *  by construction (no cross-registry leak). */
	static forRegistry(registry: AgentRegistryApi): IrcBusApi {
		if (registry === AgentRegistry.global()) return IrcBus.global();
		let bus = IrcBus.#buses.get(registry);
		if (!bus) {
			bus = new IrcBus(registry);
			IrcBus.#buses.set(registry, bus);
		}
		return bus;
	}

	/** Install the process-global bus. Worker bootstrap only. */
	static installGlobal(api: IrcBusApi): void {
		IrcBus.#global = api;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	/**
	 * Count a settled job of agent `from` owned by `to` as `from`'s reply to
	 * `to` on `registry`'s bus: the job delivers that agent's outcome, so it
	 * answers what `to` asked it before now (see {@link unansweredSends}). With
	 * no bus yet no message was ever sent, so there is nothing to answer.
	 */
	static recordReply(from: string, to: string, registry: AgentRegistryApi = AgentRegistry.global()): void {
		const bus = registry === AgentRegistry.global() ? IrcBus.#global : IrcBus.#buses.get(registry);
		bus?.recordReply(from, to);
	}

	readonly #registry: AgentRegistryApi;
	readonly #lifecycle: () => AgentLifecycleApi;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** The latest successful non-progress send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, SendMark>>();
	/** The latest non-broadcast, non-progress reply per `from` → `to`, including wake relays. */
	readonly #lastReply = new Map<string, Map<string, SendMark>>();
	/** The latest direct (non-broadcast, non-progress, non-relay) send per `from` → `to`; see {@link unansweredSends}. */
	readonly #lastDirect = new Map<string, Map<string, SendMark>>();
	/** The latest progress message per `from` → `to`: a promise that a reply will follow. */
	readonly #lastProgress = new Map<string, Map<string, SendMark>>();
	/** The latest job-carried reply per agent → owner; see {@link IrcBus.recordReply}. */
	readonly #lastJobReply = new Map<string, Map<string, SendMark>>();
	/** Last {@link SendMark.seq} handed out, taken when a send starts. */
	#sendSeq = 0;
	/** Outbound transports keyed by globally-unique NAMESPACE (the `@<namespace>/` routing prefix). */
	readonly #transports = new Map<string, RemoteTransport>();
	/** namespace -> the load that claimed it: `ownerToken` (owner-scoped release) + `source` extension
	 *  path — a re-load of the SAME extension (e.g. inherited by a subagent) shares the claim; a
	 *  DIFFERENT extension is rejected (single-owner across the process). */
	readonly #namespaceOwners = new Map<string, { ownerToken: string; source: string }>();

	constructor(registry: AgentRegistryApi = AgentRegistry.global(), lifecycle?: AgentLifecycleApi) {
		this.#registry = registry;
		// Lazy + registry-paired: default to THIS registry's lifecycle manager (mirrors the
		// bus<->registry pairing) so a custom-registry bus revives its own parked peers instead
		// of consulting the global manager. Only touched when a parked recipient needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.forRegistry(this.#registry);
	}

	/**
	 * Install, update, or clear the outbound transport for a globally-unique `namespace`, claimed by
	 * the installing extension load's `ownerToken` (and its `source` extension path):
	 * - unclaimed namespace: claim it for `ownerToken` and install `transport`;
	 * - claimed by the SAME `ownerToken`: update `transport`, or (with `undefined`) clear ROUTING while
	 *   KEEPING the claim + any registered peers, so the owner can reinstall after a reconnect;
	 * - claimed by a DIFFERENT load of the SAME `source` extension (e.g. the bridge re-loaded in a
	 *   spawned subagent sharing this registry): a no-op keeping the original claim + transport, so the
	 *   child inherits routing and — being a non-owner — never releases the shared transport on its own
	 *   teardown (only the original owner's {@link releaseTransportsForOwner} does, #7401 review);
	 * - claimed by a DIFFERENT `source` extension: throw — a namespace is single-owner across the
	 *   process, so two distinct bridges to the same external cluster must pick distinct namespaces.
	 *
	 * `source` defaults to `ownerToken` (each caller its own extension) so a plain 3-arg call keeps the
	 * strict single-owner behaviour; the ExtensionAPI passes the extension path to enable sharing.
	 */
	setRemoteTransport(
		namespace: string,
		transport: RemoteTransport | undefined,
		ownerToken: string,
		source: string = ownerToken,
	): void {
		const existing = this.#namespaceOwners.get(namespace);
		if (existing !== undefined && existing.ownerToken !== ownerToken) {
			// A different load claims a namespace someone else owns: same extension re-loading shares
			// (keep the original owner + transport); a genuinely different extension is rejected.
			if (existing.source !== source) {
				throw new Error(
					`IRC namespace "${namespace}" is already claimed by another extension; choose a distinct namespace.`,
				);
			}
			return;
		}
		if (transport) {
			this.#namespaceOwners.set(namespace, { ownerToken, source });
			this.#transports.set(namespace, transport);
		} else {
			// A clear is only meaningful for a namespace this load already claimed (install → clear →
			// reinstall, the reconnect flow). Reject a clear of an UNCLAIMED namespace so a
			// clear-before-install can't mark it claimed on the ExtensionAPI side with no owner here.
			if (existing === undefined) {
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

	/** The `ownerToken` currently claiming `namespace`, or undefined if unclaimed (owner-scoped clear). */
	namespaceOwner(namespace: string): string | undefined {
		return this.#namespaceOwners.get(namespace)?.ownerToken;
	}

	/**
	 * Release every namespace claimed by `ownerToken`: drop its transport AND its claim (freeing the
	 * namespace for re-claim). Owner-scoped, so sibling loads are untouched; called on extension
	 * load-failure rollback and runtime teardown. Distinct from a plain `setRemoteTransport(ns,
	 * undefined, owner)` clear, which keeps the claim for reconnect.
	 */
	releaseTransportsForOwner(ownerToken: string): void {
		for (const [namespace, owner] of this.#namespaceOwners) {
			if (owner.ownerToken === ownerToken) {
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
	 */
	async send(msg: Omit<IrcMessage, "id" | "ts">, opts?: { expectsReply?: boolean }): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		// Taken before delivery: a reply sent while this message is still being
		// delivered must still order after it.
		const mark: SendMark = { ts: message.ts, seq: ++this.#sendSeq };
		const receipt = await this.#deliver(message, opts);
		if (receipt.outcome !== "failed") {
			if (message.progress) {
				this.#record(this.#lastProgress, message.from, message.to, mark);
			} else {
				this.#record(this.#lastSent, message.from, message.to, mark);
				if (!message.broadcast) {
					this.#record(this.#lastReply, message.from, message.to, mark);
					if (!message.wakeRelay) this.#record(this.#lastDirect, message.from, message.to, mark);
				}
			}
		}
		return receipt;
	}

	#record(table: Map<string, Map<string, SendMark>>, from: string, to: string, mark: SendMark): void {
		let sent = table.get(from);
		if (!sent) {
			sent = new Map();
			table.set(from, sent);
		}
		// Deliveries can settle out of order; keep the latest send.
		if ((sent.get(to)?.seq ?? 0) < mark.seq) sent.set(to, mark);
	}

	/** Instance half of {@link IrcBus.recordReply}: records the job-carried reply on this bus. */
	recordReply(from: string, to: string): void {
		this.#record(this.#lastJobReply, from, to, { ts: Date.now(), seq: ++this.#sendSeq });
	}

	/**
	 * Whether `from` successfully sent `to` anything, progress included, at or
	 * after `sinceTs`. The wake-turn relay uses it to skip agents that already
	 * answered their waker themselves, or promised it a later answer.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		return [this.#lastSent, this.#lastProgress].some(table => (table.get(from)?.get(to)?.ts ?? -1) >= sinceTs);
	}

	/**
	 * Agents `from` messaged directly at or after `sinceTs` that have not
	 * answered since, with when the latest of those messages went out: the
	 * replies a `wait` can block for. A non-broadcast message back answers, and
	 * so does a settled job of the agent `from` owns, which delivers its result.
	 * Progress answers nothing; it marks the request `promised`, and from then on only
	 * an explicit message answers it (a job settling the turn that sent the
	 * progress must not). "Since" is by send order, not timestamp, so an answer
	 * to an earlier question never settles a later one sent within the same
	 * millisecond.
	 */
	unansweredSends(from: string, sinceTs: number): Array<{ to: string; sentAt: number; promised: boolean }> {
		const sends = this.#lastDirect.get(from);
		if (!sends) return [];
		const unanswered: Array<{ to: string; sentAt: number; promised: boolean }> = [];
		for (const [to, sent] of sends) {
			if (sent.ts < sinceTs) continue;
			const after = (table: Map<string, Map<string, SendMark>>) => (table.get(to)?.get(from)?.seq ?? 0) > sent.seq;
			const promised = after(this.#lastProgress);
			if (after(this.#lastReply) || (!promised && after(this.#lastJobReply))) continue;
			unanswered.push({ to, sentAt: sent.ts, promised });
		}
		return unanswered;
	}

	async #deliver(message: IrcMessage, opts?: { expectsReply?: boolean }): Promise<IrcDeliveryReceipt> {
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
				if (receipt.outcome !== "failed") this.#relayToMainUi(message);
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
				error: `Unknown agent "${message.to}" — check the subagent roster or read history:// for known peers.`,
			};
		}
		return this.#deliverToLocalRef(ref, message);
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
		_opts?: { expectsReply?: boolean },
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
		const receipt = await this.#deliverToLocalRef(ref, message);
		return { receipt, id: message.id };
	}

	/**
	 * In-process delivery core shared by `send` and `deliverInbound`: the recipient `ref` is
	 * present in this process's registry; resolve the advisor / parked-or-aborted revive / waiter
	 * / live-session paths and return the outcome. Never touches the remote transport.
	 */
	async #deliverToLocalRef(ref: AgentRef, message: IrcMessage): Promise<IrcDeliveryReceipt> {
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` or killed (`aborted`) recipient always needs the lifecycle to
		// revive it from its transcript — this is read from *this* bus's registry,
		// so it holds for any registry. The mid-park / adopted checks below query
		// the lifecycle's own state, which only describes the registry it manages:
		// consult them only when the lifecycle owns this bus's registry, otherwise
		// a custom-registry bus (fallen back to the global manager) would gate a
		// live recipient on unrelated global park state. Main/non-adopted live
		// peers skip the gate, and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			ref.status === "aborted" ||
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

		// A pending bus wait from the recipient consumes the message directly
		// and never hits the inbox; the `wait` tool hands it to its own session,
		// which injects it as a user turn.
		const waiter = this.#takeMatchingWaiter(message);
		if (waiter) {
			waiter.resolve(message);
			this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message);
			this.#relayToMainUi(message);
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
	 * Block until a message for `agentId` that `filter` accepts arrives;
	 * consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, msg => ircWaitAccepts(filter, msg));
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

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
		};

		const waiter: IrcWaiter = {
			filter,
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

		return promise;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block without draining the entire backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, msg => from === undefined || msg.from === from);
	}

	/** Unread count for the local Agent Hub overlay. */
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

	/** Resolve the OLDEST waiter for the recipient whose filter accepts `message`. */
	#takeMatchingWaiter(message: IrcMessage): IrcWaiter | undefined {
		const waiters = this.#waiters.get(message.to);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => ircWaitAccepts(waiter.filter, message));
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(message.to);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, accepts: (msg: IrcMessage) => boolean): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = mailbox.findIndex(accepts);
		if (index === -1) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent (or agent↔remote) traffic as a display-only card on the ROOT session's
	 * UI — the `main`-kind root of the LOCAL participant's tree ({@link #rootMainFor}): "Main" for
	 * the in-repo default, a custom id (e.g. ACP's `acp:<sessionId>`) for an embedder-supplied
	 * registry, and — when several top-level sessions share one registry — the sender's OWN root.
	 * Skipped when that root is itself an endpoint: as recipient its own `deliverIrcMessage` already
	 * shows the message, and as sender the irc send tool call already rendered it.
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
