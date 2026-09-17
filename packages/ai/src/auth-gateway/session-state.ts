/**
 * Server-owned provider session state for the auth-gateway.
 *
 * `SimpleStreamOptions.providerSessionState` is how a provider keeps what it
 * learned about an endpoint across turns of one conversation: Anthropic's
 * sticky `strictToolsDisabled` / `fastModeDisabled` /
 * `replayUnsignedThinkingDisabled` flags and dropped-thinking-prefix set,
 * OpenAI's strict-tools and reasoning-effort fallbacks, Codex's WebSocket and
 * turn-state sessions. An in-process omp session owns that `Map` for its whole
 * lifetime, so a grammar-too-large 400 or a fast-mode rejection costs one
 * wasted round-trip per session rather than one per turn.
 *
 * The map is deliberately non-serializable — `Set`/`Map` fields, live sockets,
 * a `close()` method — so `pi-native-client` strips it from the wire and
 * `pi-native-server` never accepts it. Gateway clients therefore cannot bring
 * their own, and without a server-side owner every containerized / robomp turn
 * re-learns every lesson from a fresh upstream rejection.
 *
 * A plain `Map<sessionId, …>` in a long-lived server process is a leak: nothing
 * ever reclaims an entry, and the entries own timers and sockets. This store is
 * an LRU with a hard entry ceiling that calls `close()` on everything it drops
 * and on everything it still holds at shutdown — but it only ever drops an
 * entry no request is holding, because `close()` on a live entry tears down
 * state an in-flight stream is still streaming through.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { resetAccountScopedProviderSessionState } from "../provider-session-state";
import type { Api, Context, Model, ProviderSessionState } from "../types";

/**
 * Retained logical sessions. Each entry is a handful of small provider records
 * plus, for Codex, a WebSocket session — cheap to keep, but not free, so the
 * ceiling is what turns "one entry per session id forever" into a bounded cost.
 * Eviction is least-recently-used, so the ceiling only ever drops sessions that
 * have been quiet longer than the 256 most recent ones.
 */
export const AUTH_GATEWAY_MAX_SESSION_STATES = 256;

/** Why an entry's provider records were closed. Logged on teardown failure. */
type SessionDisposeReason = "evict" | "shutdown";

/**
 * One request's claim on a retained session.
 *
 * `release()` is what makes the entry evictable again, so it MUST run for every
 * outcome of the request — a `finally` at the call site for the synchronous
 * paths, stream completion for the streaming ones. It is idempotent, so the
 * two can overlap.
 */
export interface AuthGatewaySessionStateLease {
	/** The map to hand to `streamSimple` as `providerSessionState`. */
	readonly states: Map<string, ProviderSessionState>;
	/** Reset account-scoped records if an in-request auth retry switches accounts. */
	updateAccount(account: string): void;
	/** Give up this request's claim. Idempotent. */
	release(): void;
}

/** Everything the store needs to place one request on a retained session. */
export interface AuthGatewaySessionStateRequest {
	/**
	 * The client's own session key (`prompt_cache_key` / `sessionId`), or
	 * `undefined` when it sent none — blank counts as none. A supplied key is
	 * authoritative: the client is telling us which conversation this is.
	 */
	clientKey: string | undefined;
	model: Model<Api>;
	/**
	 * System prompt, tools and message history of this request. Used only when
	 * `clientKey` is absent, to place the request on the conversation it
	 * continues.
	 */
	context: Context;
	/**
	 * Stable identity of the account this request's credential resolved to.
	 * A change means the gateway switched the session to a sibling credential,
	 * so the account-dependent lessons in the retained map are re-probed. The
	 * comparison happens on acquire and whenever an in-request auth retry
	 * resolves a sibling credential.
	 */
	account: string;
}

interface RetainedSession {
	/** Current index key. Advances as a keyless conversation grows. */
	key: string;
	states: Map<string, ProviderSessionState>;
	/** Account identity of the most recent request placed on this entry. */
	account: string;
	/** Requests currently holding this entry. Eviction never takes one of these. */
	leases: number;
}

/**
 * Close every provider record an evicted (or drained) session held.
 *
 * Anthropic's `close()` resets its sticky flags, Codex's tears down WebSockets
 * and GitLab Duo's stops the server-side workflow — so dropping an entry
 * without closing it leaks exactly the resources the bound exists to cap.
 */
function closeSessionState(
	states: Map<string, ProviderSessionState>,
	sessionKey: string,
	reason: SessionDisposeReason,
): void {
	for (const [providerKey, state] of states) {
		try {
			state.close();
		} catch (error) {
			// One provider's teardown must not abort the rest: a throw here
			// propagates out of the eviction into whichever request happened to
			// trigger it, or abandons the remainder of the shutdown drain.
			logger.warn("auth-gateway provider session state close failed", {
				sessionKey,
				providerKey,
				reason,
				error: String(error),
			});
		}
	}
	states.clear();
}

/**
 * Index keys this request may be placed on, most specific first.
 *
 * With a client key there is exactly one: the client named its conversation, so
 * provider + model + that key is the identity.
 *
 * Without one the gateway has to infer the conversation, and the request's
 * message history is the only thing that can distinguish two of them. The
 * derived `sessionId` used for prefix caching and credential stickiness hashes
 * the model, system prompt, tools and *first* message, which is deliberately
 * prefix-shaped — two chats that open the same way share a cache bucket, which
 * is a cache hit rather than a leak, and share a sticky account, which is a
 * load-balancing hint. Retained provider state is neither: sharing it means one
 * chat's rejection silences another chat's request, and one chat's Codex
 * transport session answers another chat's turn. So provider state gets its own
 * key, and only provider state: `deriveSessionId` keeps its two other jobs.
 *
 * The key is therefore a running hash over (provider, model, system, tools) and
 * then every message, one key per message — the last of which identifies the
 * exact history this request presented. Turn N+1 of a conversation extends turn
 * N's history, so turn N's key is one of the earlier entries in turn N+1's
 * chain: the store finds the nearest ancestor and moves that entry forward onto
 * the new key. Two conversations that share an opening therefore share an entry
 * only until they diverge; after that the first branch to arrive keeps the
 * ancestor and the other starts clean. That is the most a stateless wire can
 * tell us — before divergence the two requests are byte-identical.
 *
 * System prompt and tools sit in the root rather than per-message because they
 * are not history: a client that re-stamps its system prompt every turn (a
 * date, a cwd) starts a new lineage, exactly as it already starts a new derived
 * `sessionId` today.
 */
function sessionKeys(request: AuthGatewaySessionStateRequest): string[] {
	const { model } = request;
	const scope = `${model.provider}\u0000${model.id}`;
	if (request.clientKey !== undefined) return [`c\u0000${scope}\u0000${request.clientKey}`];
	const { context } = request;
	// NUL separates the components so none of them can forge the boundary.
	let hash = Bun.hash(
		`${scope}\u0000${context.systemPrompt?.join("\n\n") ?? ""}\u0000${context.tools ? JSON.stringify(context.tools) : ""}`,
	);
	const keys: string[] = [];
	for (const message of context.messages) {
		// Role + content only: omp re-stamps `timestamp` and provider metadata on
		// every parsed message, so hashing those would break the chain on turn
		// two of every conversation.
		hash = Bun.hash(JSON.stringify({ role: message.role, content: message.content }), hash);
		keys.push(`h\u0000${scope}\u0000${hash.toString(36)}`);
	}
	// A request with no messages has no history to place; its root is the key.
	if (keys.length === 0) return [`h\u0000${scope}\u0000${hash.toString(36)}`];
	keys.reverse();
	return keys;
}

/**
 * Bounded per-session provider state, owned by one gateway server instance.
 *
 * Two gateways in the same process get separate stores, so neither can hand a
 * request another gateway's learned state or close it out from under one.
 *
 * The recency order is this class's own (a `Map` iterates in insertion order,
 * and every acquire re-inserts) rather than `LRUCache`'s, because the policy
 * needs two things a general cache cannot express: an entry that a request is
 * still holding must be skipped when picking a victim, and an entry must be
 * able to change key — `LRUCache` disposes on every removal, which is precisely
 * the `close()` we must not run here.
 */
export class AuthGatewaySessionStateStore {
	/** Least recently acquired first — insertion order is the LRU order. */
	readonly #sessions = new Map<string, RetainedSession>();
	readonly #max: number;

	constructor(max: number = AUTH_GATEWAY_MAX_SESSION_STATES) {
		if (!Number.isInteger(max) || max < 1) throw new TypeError("max must be a positive integer");
		this.#max = max;
	}

	/** Retained logical sessions. */
	get size(): number {
		return this.#sessions.size;
	}

	/**
	 * Claim the provider-session map for one request, created on first use and
	 * returned by reference so provider mutations persist into the next request.
	 *
	 * Keyed by provider + model + conversation (see {@link sessionKeys}). A
	 * client is free to reuse one session id across models, and the coarsest
	 * provider entries do not separate models themselves (`openai-responses`
	 * keys its strict-tools / history-replay record by provider alone,
	 * Antigravity by a single constant), so the model belongs in the key here.
	 * Endpoint is deliberately absent: every provider whose learning is
	 * endpoint-specific already sub-keys it internally
	 * (`anthropic-messages:${baseUrl}\0${modelId}`,
	 * `openai-completions:${provider}:${baseUrl}:${modelId}`), and repeating it
	 * would only fragment the map. The credential is absent for the same reason
	 * — most of what is retained is true of the endpoint whoever calls it, and
	 * Codex already sub-keys its transport by account and bearer — so a
	 * credential switch resets the account-dependent subset instead of
	 * splitting the entry (see `resetAccountScopedProviderSessionState`).
	 *
	 * The returned lease MUST be released; until then the entry cannot be
	 * evicted.
	 */
	acquire(request: AuthGatewaySessionStateRequest): AuthGatewaySessionStateLease {
		const session = this.#claim(sessionKeys(request), request.account);
		let released = false;
		return {
			states: session.states,
			updateAccount: (account: string): void => {
				if (session.account === account) return;
				resetAccountScopedProviderSessionState(session.states);
				session.account = account;
			},
			release: (): void => {
				if (released) return;
				released = true;
				session.leases--;
				// This entry may be the victim the bound has been waiting for.
				if (session.leases === 0) this.#evict();
			},
		};
	}

	/** Close and drop every retained state. Called when the gateway shuts down. */
	close(): void {
		// The only place a leased entry is torn down: the listener is already
		// down, every in-flight stream is being cancelled with it, and the
		// process cannot settle while a Codex WebSocket or Duo workflow is open.
		for (const session of this.#sessions.values()) closeSessionState(session.states, session.key, "shutdown");
		this.#sessions.clear();
	}

	/**
	 * Resolve `keys` to an entry — reusing the nearest ancestor when a keyless
	 * conversation has grown — mark it most recently used, and hand the caller
	 * the claim. The claim is taken before the ceiling is enforced: a brand-new
	 * entry belongs to the request that just created it, and is not a candidate
	 * for making room for itself.
	 */
	#claim(keys: readonly string[], account: string): RetainedSession {
		const key = keys[0] ?? "";
		for (const candidate of keys) {
			const session = this.#sessions.get(candidate);
			if (session === undefined) continue;
			// Re-insert at the tail for recency, under this request's own key so
			// the next turn of this conversation finds it as its ancestor. A
			// sibling branch of the same ancestor no longer matches, which is the
			// point: it gets an entry of its own.
			this.#sessions.delete(candidate);
			session.key = key;
			this.#sessions.set(key, session);
			session.leases++;
			if (session.account !== account) {
				resetAccountScopedProviderSessionState(session.states);
				session.account = account;
			}
			return session;
		}
		const created: RetainedSession = { key, states: new Map(), account, leases: 1 };
		this.#sessions.set(key, created);
		this.#evict();
		return created;
	}

	/**
	 * Enforce the ceiling against entries no request is holding.
	 *
	 * A long-running stream is exactly the entry LRU order would pick — it was
	 * acquired when the stream opened and not touched since — so blind eviction
	 * would `close()` the sockets and flags that stream is still using. Live
	 * entries are skipped instead, and the store sits above its bound until
	 * their requests release; the excess is therefore capped by the number of
	 * concurrent requests, each of which holds a client connection.
	 */
	#evict(): void {
		if (this.#sessions.size <= this.#max) return;
		// Deleting during Map iteration is well-defined: the current and later
		// keys stay consistent, so this walks least-recently-acquired first.
		for (const session of this.#sessions.values()) {
			if (this.#sessions.size <= this.#max) return;
			if (session.leases > 0) continue;
			this.#sessions.delete(session.key);
			closeSessionState(session.states, session.key, "evict");
		}
	}
}
