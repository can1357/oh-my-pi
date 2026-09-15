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
 * and on everything it still holds at shutdown.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { type DisposeReason, LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { Api, Model, ProviderSessionState } from "../types";

/**
 * Retained logical sessions. Each entry is a handful of small provider records
 * plus, for Codex, a WebSocket session — cheap to keep, but not free, so the
 * ceiling is what turns "one entry per session id forever" into a bounded cost.
 * Eviction is least-recently-used, so the ceiling only ever drops sessions that
 * have been quiet longer than the 256 most recent ones.
 */
export const AUTH_GATEWAY_MAX_SESSION_STATES = 256;

/**
 * Close every provider record an evicted (or drained) session held.
 *
 * Anthropic's `close()` resets its sticky flags, Codex's tears down WebSockets
 * and GitLab Duo's stops the server-side workflow — so dropping an entry
 * without closing it leaks exactly the resources the bound exists to cap.
 */
function closeSessionState(states: Map<string, ProviderSessionState>, sessionKey: string, reason: DisposeReason): void {
	for (const [providerKey, state] of states) {
		try {
			state.close();
		} catch (error) {
			// One provider's teardown must not abort the rest: a throw here
			// propagates out of `LRUCache.set` into whichever request happened to
			// trigger the eviction, or abandons the remainder of the shutdown
			// drain.
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
 * Bounded per-session provider state, owned by one gateway server instance.
 *
 * Two gateways in the same process get separate stores, so neither can hand a
 * request another gateway's learned state or close it out from under one.
 */
export class AuthGatewaySessionStateStore {
	readonly #sessions: LRUCache<string, Map<string, ProviderSessionState>>;

	constructor(max: number = AUTH_GATEWAY_MAX_SESSION_STATES) {
		this.#sessions = new LRUCache({ max, dispose: closeSessionState });
	}

	/** Retained logical sessions. */
	get size(): number {
		return this.#sessions.size;
	}

	/**
	 * The provider-session map for one logical session on one model, created on
	 * first use and returned by reference so provider mutations persist into the
	 * next request.
	 *
	 * Keyed by session + provider + model id. The session is the identity that
	 * matters — it is the same identity used for credential stickiness and
	 * prefix-cache keying — but a client is free to reuse one session id across
	 * models, and the coarsest provider entries do not separate models
	 * themselves (`openai-responses` keys its strict-tools / history-replay
	 * record by provider alone, Antigravity by a single constant), so the model
	 * belongs in the key here. Endpoint is deliberately absent: every provider
	 * whose learning is endpoint-specific already sub-keys it internally
	 * (`anthropic-messages:${baseUrl}\0${modelId}`,
	 * `openai-completions:${provider}:${baseUrl}:${modelId}`), and repeating it
	 * would only fragment the map. NUL separates the components so none of them
	 * can forge the boundary.
	 */
	acquire(sessionId: string, model: Model<Api>): Map<string, ProviderSessionState> {
		const key = `${sessionId}\u0000${model.provider}\u0000${model.id}`;
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const created = new Map<string, ProviderSessionState>();
		this.#sessions.set(key, created);
		return created;
	}

	/** Close and drop every retained state. Called when the gateway shuts down. */
	close(): void {
		this.#sessions.clear();
	}
}
