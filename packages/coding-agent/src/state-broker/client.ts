/**
 * HTTP client for the shared-state broker's `/v1/state` surface.
 *
 * Modeled on {@link AuthBrokerClient} (`packages/ai/src/auth-broker/client.ts`):
 * same constructor options, connection-error retry/backoff, per-request timeout
 * and injectable `fetchImpl`. It is the client half of the replication
 * transport — {@link StateSyncEngine} drives it, and every response is shape-
 * guarded before it is handed back so a malformed broker reply throws a clear
 * error instead of quietly corrupting a replica.
 */

import {
	isStateDomainId,
	STATE_API_PREFIX,
	type StateDeltaResponse,
	type StateDomainId,
	type StateEntry,
	type StatePushResponse,
	type StateSummaryResponse,
} from "./wire";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 1;

/**
 * The broker closes an in-flight long-poll with 499 when it is cancelled
 * host-side; like a 304 that carries no delta, we treat it as "nothing
 * changed" rather than an error worth surfacing.
 */
export const HTTP_CLIENT_CLOSED = 499;

export interface StateBrokerClientOptions {
	/** Base URL (e.g. `https://broker.tailnet:8765`). Trailing slashes are trimmed. */
	url: string;
	/** Bearer token forwarded on every request. */
	token: string;
	/** Per-request timeout in milliseconds. Default 10s. */
	timeoutMs?: number;
	/** Retry connection errors this many times. Default 1. */
	maxRetries?: number;
	/** Override fetch (used in tests). Default global `fetch`. */
	fetchImpl?: typeof fetch;
}

export class StateBrokerError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	constructor(message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
		super(message, { cause: opts.cause });
		this.name = "StateBrokerError";
		this.status = opts.status;
		this.body = opts.body;
	}
}

/** Narrow an unknown value to a wire {@link StateEntry}. */
function isStateEntry(value: unknown): value is StateEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	// `value` may legitimately be `null` (a tombstone) but the key must be
	// present, so probe with `in` rather than truthiness.
	return (
		typeof entry.key === "string" && typeof entry.rev === "number" && Number.isFinite(entry.rev) && "value" in entry
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export class StateBrokerClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #fetch: typeof fetch;

	constructor(opts: StateBrokerClientOptions) {
		this.#baseUrl = opts.url.replace(/\/+$/, "");
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	/** `GET /v1/state` — per-domain sequence summary. */
	async summary(signal?: AbortSignal): Promise<StateSummaryResponse> {
		const response = await this.#fetchRaw("GET", STATE_API_PREFIX, { signal });
		const raw = this.#parseJson(await response.text(), response.status);
		return this.#validateSummary(raw, response.status);
	}

	/**
	 * `GET /v1/state/:domain?since=&wait=&limit=` — entries accepted after
	 * `sinceSeq`. A 304/499 (no delta) is normalized to an empty, no-change
	 * response so the caller never has to special-case it.
	 */
	async delta(
		domain: StateDomainId,
		sinceSeq: number,
		opts: { waitMs?: number; limit?: number; signal?: AbortSignal } = {},
	): Promise<StateDeltaResponse> {
		const params = new URLSearchParams();
		params.set("since", String(sinceSeq));
		if (opts.waitMs !== undefined) params.set("wait", String(opts.waitMs));
		if (opts.limit !== undefined) params.set("limit", String(opts.limit));
		const path = `${STATE_API_PREFIX}/${domain}?${params.toString()}`;
		// A long-poll holds the socket up to `waitMs`; grow the timeout past it
		// so our own deadline never pre-empts the server's wait window.
		const timeoutMs =
			opts.waitMs !== undefined && opts.waitMs > 0 ? Math.max(this.#timeoutMs, opts.waitMs + 1000) : undefined;
		const response = await this.#fetchRaw("GET", path, {
			signal: opts.signal,
			timeoutMs,
			acceptStatuses: [304, HTTP_CLIENT_CLOSED],
		});
		if (response.status === 304 || response.status === HTTP_CLIENT_CLOSED) {
			// Drain the (tiny) body so the socket can be reused, then report no change.
			await response.text().catch(() => {});
			return { domain, seq: sinceSeq, entries: [], more: false };
		}
		const raw = this.#parseJson(await response.text(), response.status);
		return this.#validateDelta(raw, domain, response.status);
	}

	/** `POST /v1/state/:domain` — push one page of local entries. */
	async push(domain: StateDomainId, entries: StateEntry[], signal?: AbortSignal): Promise<StatePushResponse> {
		const response = await this.#fetchRaw("POST", `${STATE_API_PREFIX}/${domain}`, {
			body: { entries },
			signal,
		});
		const raw = this.#parseJson(await response.text(), response.status);
		return this.#validatePush(raw, domain, response.status);
	}

	#validateSummary(raw: unknown, status: number): StateSummaryResponse {
		if (typeof raw !== "object" || raw === null) throw this.#malformed(status, "summary was not an object");
		const body = raw as Record<string, unknown>;
		if (!isFiniteNumber(body.generatedAt)) throw this.#malformed(status, "summary.generatedAt missing");
		if (!Array.isArray(body.domains)) throw this.#malformed(status, "summary.domains not an array");
		const domains: StateSummaryResponse["domains"] = [];
		for (const item of body.domains) {
			if (typeof item !== "object" || item === null) throw this.#malformed(status, "summary domain not an object");
			const entry = item as Record<string, unknown>;
			if (typeof entry.domain !== "string" || !isStateDomainId(entry.domain))
				throw this.#malformed(status, "summary domain id invalid");
			if (!isFiniteNumber(entry.seq) || !isFiniteNumber(entry.entries))
				throw this.#malformed(status, "summary domain counters invalid");
			domains.push({ domain: entry.domain, seq: entry.seq, entries: entry.entries });
		}
		return { generatedAt: body.generatedAt, domains };
	}

	#validateDelta(raw: unknown, expected: StateDomainId, status: number): StateDeltaResponse {
		if (typeof raw !== "object" || raw === null) throw this.#malformed(status, "delta was not an object");
		const body = raw as Record<string, unknown>;
		if (body.domain !== expected) throw this.#malformed(status, `delta domain mismatch: ${String(body.domain)}`);
		if (!isFiniteNumber(body.seq)) throw this.#malformed(status, "delta.seq missing");
		if (typeof body.more !== "boolean") throw this.#malformed(status, "delta.more not a boolean");
		if (!Array.isArray(body.entries) || !body.entries.every(isStateEntry))
			throw this.#malformed(status, "delta.entries malformed");
		// `epoch`/`head` are optional: a broker predating them omits them, and the
		// caller then simply has no rollback signal. Malformed values are dropped
		// rather than fatal, since they only ever trigger a conservative replay.
		return {
			domain: expected,
			seq: body.seq,
			entries: body.entries as StateEntry[],
			more: body.more,
			epoch: typeof body.epoch === "string" && body.epoch.length > 0 ? body.epoch : undefined,
			head: isFiniteNumber(body.head) ? body.head : undefined,
		};
	}

	#validatePush(raw: unknown, expected: StateDomainId, status: number): StatePushResponse {
		if (typeof raw !== "object" || raw === null) throw this.#malformed(status, "push response was not an object");
		const body = raw as Record<string, unknown>;
		if (body.domain !== expected) throw this.#malformed(status, `push domain mismatch: ${String(body.domain)}`);
		if (!isFiniteNumber(body.seq)) throw this.#malformed(status, "push.seq missing");
		if (!isFiniteNumber(body.accepted)) throw this.#malformed(status, "push.accepted missing");
		return { domain: expected, seq: body.seq, accepted: body.accepted };
	}

	#malformed(status: number, detail: string): StateBrokerError {
		return new StateBrokerError(`State broker response failed validation: ${detail}`, { status });
	}

	#parseJson(text: string, status: number): unknown {
		try {
			return text.length === 0 ? null : JSON.parse(text);
		} catch (parseError) {
			throw new StateBrokerError("State broker returned malformed JSON", {
				status,
				body: text,
				cause: parseError,
			});
		}
	}

	async #fetchRaw(
		method: "GET" | "POST" | "DELETE",
		path: string,
		opts: {
			body?: unknown;
			signal?: AbortSignal;
			timeoutMs?: number;
			/** Non-2xx statuses returned to the caller instead of throwing (e.g. 304/499). */
			acceptStatuses?: readonly number[];
		},
	): Promise<Response> {
		const url = `${this.#baseUrl}${path}`;
		const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${this.#token}` };
		let payload: string | undefined;
		if (opts.body !== undefined) {
			payload = JSON.stringify(opts.body);
			headers["Content-Type"] = "application/json";
		}

		// Fast-fail when the caller's signal is already aborted — avoids spinning
		// up a fetch + timer that the first `await` would just abort anyway.
		if (opts.signal?.aborted) {
			throw new StateBrokerError("State broker request aborted", { cause: opts.signal.reason });
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs);
			const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
			try {
				const response = await this.#fetch(url, { method, headers, body: payload, signal });
				if (!response.ok && response.status !== 304 && !(opts.acceptStatuses?.includes(response.status) ?? false)) {
					let text = "";
					try {
						text = await response.text();
					} catch (cause) {
						throw new StateBrokerError(`State broker request failed: ${response.status} ${response.statusText}`, {
							status: response.status,
							cause,
						});
					}
					throw new StateBrokerError(`State broker request failed: ${response.status} ${response.statusText}`, {
						status: response.status,
						body: text,
					});
				}
				return response;
			} catch (error) {
				lastError = error;
				// Caller-driven abort wins over retry — the caller said stop.
				if (opts.signal?.aborted) {
					if (error instanceof StateBrokerError && error.status !== undefined) throw error;
					throw new StateBrokerError("State broker request aborted", { cause: opts.signal.reason });
				}
				if (error instanceof StateBrokerError && error.status !== undefined) {
					// HTTP errors (4xx/5xx) don't retry — the status is deterministic.
					throw error;
				}
				if (attempt >= this.#maxRetries) break;
			}
		}
		throw new StateBrokerError(`State broker request failed after ${this.#maxRetries + 1} attempt(s)`, {
			cause: lastError,
		});
	}
}
