/**
 * Wire protocol for the shared-state broker.
 *
 * The state broker extends `omp auth-broker serve` (see
 * {@link BrokerRouteHandler}) with a generic, domain-agnostic replication
 * surface so a fleet of machines can share prompt history, session titles,
 * model/command usage ranking, and agent config files.
 *
 * Two distinct counters appear in this protocol; conflating them is the easiest
 * way to corrupt a replica, so they are named apart everywhere:
 *
 * - **`rev`** — a *per-entry logical clock* (epoch millis). Merge is
 *   last-writer-wins: an incoming entry is accepted only when its `rev` is
 *   strictly greater than the stored one. Domains pick a `rev` that already
 *   exists in their local schema (`history.created_at`,
 *   `session_titles.updated_at`, `model_usage.last_used_at`, config file
 *   mtime), so replication adds no new columns.
 * - **`seq`** — a *per-domain monotonic broker sequence*. Purely a delta cursor:
 *   a client pulls `?since=<seq>` and receives every entry the broker accepted
 *   after that point. Never used for merge decisions.
 *
 * Bulk content (session JSONL bodies, blob bytes) deliberately does NOT travel
 * over this protocol — it goes to object storage (see `./object-store`). This
 * surface carries only small, mergeable metadata rows.
 */

import { type FluentType, type } from "@oh-my-pi/omptype";

/** Path prefix for every state-broker route, mounted under the auth broker's listener. */
export const STATE_API_PREFIX = "/v1/state";

/**
 * Replicated state domains.
 *
 * `model-perf` is intentionally absent: those aggregates measure the *local*
 * machine's observed throughput to a provider endpoint (network path included),
 * and are consumed as a TPS estimate for model selection. Averaging one
 * machine's fiber link with another's tethered connection produces an estimate
 * that describes neither, so perf stays machine-local by design.
 */
export const STATE_DOMAIN_IDS = ["history", "titles", "model-usage", "command-usage", "config", "sessions"] as const;

export type StateDomainId = (typeof STATE_DOMAIN_IDS)[number];

export function isStateDomainId(value: string): value is StateDomainId {
	return (STATE_DOMAIN_IDS as readonly string[]).includes(value);
}

/**
 * One replicated row.
 *
 * `value: null` is a tombstone — the key was deleted at `rev`. Tombstones are
 * retained by the broker so a replica that was offline during the delete still
 * learns about it on its next pull.
 */
export interface StateEntry {
	/** Domain-unique merge key. */
	key: string;
	/** Per-entry logical clock (epoch millis). Greater wins. */
	rev: number;
	/** Domain payload, or `null` for a tombstone. */
	value: unknown;
}

/** `GET /v1/state` — domain sequence summary, for a cheap "anything changed?" probe. */
export interface StateSummaryResponse {
	generatedAt: number;
	domains: Array<{ domain: StateDomainId; seq: number; entries: number }>;
}

/** `GET /v1/state/:domain?since=&wait=&limit=` — entries accepted after `since`. */
export interface StateDeltaResponse {
	domain: StateDomainId;
	/** Broker sequence after the last returned entry; pass as the next `since`. */
	seq: number;
	entries: StateEntry[];
	/** True when `limit` truncated the delta — pull again immediately. */
	more: boolean;
	/**
	 * Identity of the broker database, minted on creation.
	 *
	 * `seq` is only monotonic within one database file, so a replica's persisted
	 * cursor is meaningless against a different one. Optional because a broker
	 * predating this field omits it, in which case rollback cannot be detected
	 * and behaviour is exactly as before.
	 */
	epoch?: string;
	/**
	 * The domain's authoritative sequence, independent of this page.
	 *
	 * Distinct from `seq`, which echoes the request's cursor when the page is
	 * empty and therefore cannot reveal that the cursor is impossible. A `head`
	 * below the replica's cursor means the broker's sequence moved backwards
	 * (recreated or restored database) and the cursor must be replayed.
	 */
	head?: number;
}

/** `POST /v1/state/:domain` request body. */
export interface StatePushRequest {
	entries: StateEntry[];
}

/** `POST /v1/state/:domain` response. */
export interface StatePushResponse {
	domain: StateDomainId;
	/** Broker sequence after applying this push. */
	seq: number;
	/** How many entries won their LWW comparison and were stored. */
	accepted: number;
}

/** Hard ceiling on entries per delta/push, protecting both peers from unbounded bodies. */
export const STATE_PAGE_LIMIT = 1000;

/** Upper bound on `?wait=` long-poll, matching the credential snapshot route. */
export const STATE_MAX_WAIT_MS = 30_000;

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const stateEntrySchema: FluentType<StateEntry> = type({
	key: type("string").atLeastLength(1).atMostLength(4096),
	rev: "number.integer >= 0",
	value: "unknown",
	"+": "reject",
});

export const statePushRequestSchema: FluentType<StatePushRequest> = type({
	entries: stateEntrySchema.array().atMostLength(STATE_PAGE_LIMIT),
	"+": "reject",
});
