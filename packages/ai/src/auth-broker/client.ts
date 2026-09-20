/**
 * HTTP client for the omp auth-broker server.
 *
 * Used by {@link RemoteAuthCredentialStore} (snapshot pulls) and by
 * `omp auth-broker status` (liveness checks). All endpoints except
 * `/v1/healthz` require a bearer token.
 */

import { type } from "@oh-my-pi/omptype";
import { readSseEvents } from "@oh-my-pi/pi-utils";
import type { AuthCredential, DisabledCredentialSummary } from "../auth-storage";
import type {
	ClientUsageReportRequest,
	ClientUsageReportResponse,
	ClientUsageSummaryResponse,
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlocksDeleteResponse,
	CredentialDisableRequest,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	DisabledCredentialsResponse,
	HealthzResponse,
	SnapshotResponse,
	SnapshotStreamEvent,
	UsageHistoryResponse,
	UsageResponse,
	UsageStaleResponse,
} from "./types";
import { AUTH_BROKER_CAPABILITIES_HEADER, AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES } from "./types";
import {
	clientUsageReportResponseSchema,
	clientUsageSummaryResponseSchema,
	credentialBlockResponseSchema,
	credentialBlocksDeleteResponseSchema,
	credentialDisableResponseSchema,
	credentialRefreshResponseSchema,
	credentialUploadResponseSchema,
	disabledCredentialsResponseSchema,
	healthzResponseSchema,
	snapshotResponseSchema,
	snapshotStreamEventSchema,
	usageHistoryResponseSchema,
	usageResponseSchema,
	usageStaleResponseSchema,
} from "./wire-schemas";

/** Response schema per endpoint, keyed by the name `#request` callers pass. */
const RESPONSE_SCHEMAS = {
	clientUsageReportResponseSchema,
	clientUsageSummaryResponseSchema,
	credentialBlockResponseSchema,
	credentialBlocksDeleteResponseSchema,
	credentialDisableResponseSchema,
	credentialRefreshResponseSchema,
	credentialUploadResponseSchema,
	disabledCredentialsResponseSchema,
	healthzResponseSchema,
	usageHistoryResponseSchema,
	usageResponseSchema,
	usageStaleResponseSchema,
} as const;

type AuthBrokerResponseSchemaName = keyof typeof RESPONSE_SCHEMAS;

export interface AuthBrokerClientOptions {
	/** Base URL (e.g. `https://broker.tailnet:8765`). Trailing slashes are trimmed. */
	url: string;
	/** Bearer token used for everything except `healthz`. */
	token: string;
	/** Per-request timeout in milliseconds. Default 10s. */
	timeoutMs?: number;
	/** Retry connection errors this many times. Default 1. */
	maxRetries?: number;
	/** Override fetch (used in tests). Default global `fetch`. */
	fetchImpl?: typeof fetch;
}

export class AuthBrokerError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	constructor(message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
		super(message, { cause: opts.cause });
		this.name = "AuthBrokerError";
		this.status = opts.status;
		this.body = opts.body;
	}
}

/**
 * Thrown when a broker responds 404 to `GET /v1/snapshot/stream` — old
 * brokers that predate the SSE endpoint. Callers (`RemoteAuthCredentialStore`)
 * detect this sentinel to fall back to long-polling permanently.
 */
export class AuthBrokerStreamUnsupportedError extends AuthBrokerError {
	constructor(message = "Auth broker does not support /v1/snapshot/stream") {
		super(message, { status: 404 });
		this.name = "AuthBrokerStreamUnsupportedError";
	}
}

export interface FetchSnapshotOptions {
	ifGenerationGt?: number;
	waitMs?: number;
	signal?: AbortSignal;
}

export type FetchSnapshotResult =
	| { status: 200; snapshot: SnapshotResponse; generation: number }
	| { status: 304; generation: number };

function parseGenerationTag(header: string | null): number | undefined {
	if (!header) return undefined;
	let value = header.trim();
	if (value.startsWith("W/")) value = value.slice(2).trim();
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		value = value.slice(1, -1);
	}
	const generation = Number(value);
	if (!Number.isInteger(generation) || generation < 0) return undefined;
	return generation;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 1;

export class AuthBrokerClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #fetch: typeof fetch;

	constructor(opts: AuthBrokerClientOptions) {
		this.#baseUrl = opts.url.replace(/\/+$/, "");
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	healthz(signal?: AbortSignal): Promise<HealthzResponse> {
		return this.#request<HealthzResponse>("GET", "/v1/healthz", {
			schema: "healthzResponseSchema",
			auth: false,
			signal,
		});
	}

	async fetchSnapshot(opts: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> {
		return this.#fetchSnapshotResult(opts);
	}
	async #fetchSnapshotResult(opts: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
		const query = new URLSearchParams();
		if (opts.waitMs !== undefined) query.set("wait", String(opts.waitMs));
		const path = `/v1/snapshot${query.size > 0 ? `?${query.toString()}` : ""}`;
		const headers: Record<string, string> = {
			[AUTH_BROKER_CAPABILITIES_HEADER]: AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES,
		};
		if (opts.ifGenerationGt !== undefined) headers["If-None-Match"] = `"${opts.ifGenerationGt}"`;
		const timeoutMs =
			opts.waitMs !== undefined && opts.waitMs > 0 ? Math.max(this.#timeoutMs, opts.waitMs + 1000) : undefined;
		const response = await this.#fetchRaw("GET", path, {
			auth: true,
			headers,
			signal: opts.signal,
			timeoutMs,
		});
		const etagGeneration = parseGenerationTag(response.headers.get("etag"));
		if (response.status === 304) {
			return { status: 304, generation: etagGeneration ?? opts.ifGenerationGt ?? 0 };
		}
		const text = await response.text();
		const raw = this.#parseJson(text, response.status);
		const validated = snapshotResponseSchema(raw);
		if (validated instanceof type.errors) {
			throw new AuthBrokerError("Auth broker response failed schema validation", {
				status: response.status,
				body: validated.summary,
			});
		}
		const snapshot = validated as SnapshotResponse;
		return { status: 200, snapshot, generation: etagGeneration ?? snapshot.generation };
	}

	/**
	 * Subscribe to the broker's SSE snapshot stream. The first frame is always
	 * a full `snapshot`; subsequent frames are `entry` upserts / refreshes or
	 * `removed` deletes. Caller controls lifecycle via `opts.signal`.
	 *
	 * Throws {@link AuthBrokerStreamUnsupportedError} when the broker responds
	 * 404 — older brokers predate this endpoint and the caller should fall back
	 * to long-polling for the remainder of its lifetime.
	 */
	async *openSnapshotStream(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
		const url = `${this.#baseUrl}/v1/snapshot/stream`;
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			Authorization: `Bearer ${this.#token}`,
			[AUTH_BROKER_CAPABILITIES_HEADER]: AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES,
		};
		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}
		// No timeout: this connection is intentionally long-lived. Caller's signal
		// is the only cancel path.
		const response = await this.#fetch(url, { method: "GET", headers, signal: opts.signal });
		if (response.status === 404) {
			// Drain the body so the socket can be reused; tiny payload.
			await response.text().catch(() => {});
			throw new AuthBrokerStreamUnsupportedError();
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new AuthBrokerError(`Auth broker stream failed: ${response.status} ${response.statusText}`, {
				status: response.status,
				body: text,
			});
		}
		if (!response.body) {
			throw new AuthBrokerError("Auth broker stream response had no body", { status: response.status });
		}
		const contentType = response.headers.get("content-type")?.toLowerCase();
		if (contentType?.split(";", 1)[0].trim() !== "text/event-stream") {
			await response.body.cancel().catch(() => {});
			throw new AuthBrokerError("Auth broker stream returned non-SSE response", {
				status: response.status,
				body: contentType ?? "",
			});
		}

		let sawFirstEvent = false;
		for await (const sse of readSseEvents(response.body, opts.signal)) {
			if (sse.event === null && sse.data === "") continue; // keepalive comment frames
			let parsed: unknown;
			try {
				parsed = JSON.parse(sse.data);
			} catch (err) {
				throw new AuthBrokerError("Auth broker stream returned malformed JSON", {
					body: sse.data,
					cause: err,
				});
			}
			const validated = snapshotStreamEventSchema(parsed);
			if (validated instanceof type.errors) {
				throw new AuthBrokerError("Auth broker stream event failed schema validation", {
					body: validated.summary,
				});
			}
			const event = validated as SnapshotStreamEvent;
			if (!sawFirstEvent) {
				sawFirstEvent = true;
				if (event.kind !== "snapshot") {
					throw new AuthBrokerError("Auth broker stream did not start with snapshot", { body: sse.data });
				}
			}
			yield event;
		}
		if (!opts.signal?.aborted) {
			throw new AuthBrokerError(
				sawFirstEvent
					? "Auth broker stream ended unexpectedly"
					: "Auth broker stream ended before initial snapshot",
				{ status: response.status },
			);
		}
	}

	/**
	 * Fetch aggregate broker usage with a timeout sized for serialized
	 * same-provider account probes.
	 */
	fetchUsage(options: { signal?: AbortSignal; maxAccountsPerProvider?: number } = {}): Promise<UsageResponse> {
		const requestedAccountCount = options.maxAccountsPerProvider;
		const accountCount =
			typeof requestedAccountCount === "number" && Number.isFinite(requestedAccountCount)
				? Math.max(1, Math.floor(requestedAccountCount))
				: 1;
		const perAccountTimeoutMs = Math.max(DEFAULT_TIMEOUT_MS, this.#timeoutMs);
		const timeoutMs = perAccountTimeoutMs * (accountCount + 1);
		return this.#request<UsageResponse>("GET", "/v1/usage", {
			schema: "usageResponseSchema",
			signal: options.signal,
			timeoutMs,
		});
	}

	/** Recorded usage-limit snapshots from the broker host, oldest first. */
	fetchUsageHistory(
		query?: { sinceMs?: number; provider?: string },
		signal?: AbortSignal,
	): Promise<UsageHistoryResponse> {
		const params = new URLSearchParams();
		if (query?.sinceMs !== undefined) params.set("sinceMs", String(query.sinceMs));
		if (query?.provider) params.set("provider", query.provider);
		const path = `/v1/usage/history${params.size > 0 ? `?${params.toString()}` : ""}`;
		return this.#request<UsageHistoryResponse>("GET", path, { schema: "usageHistoryResponseSchema", signal });
	}

	/** Report this client's batched observed request usage for per-install burn tracking. */
	reportClientUsage(report: ClientUsageReportRequest, signal?: AbortSignal): Promise<ClientUsageReportResponse> {
		return this.#request<ClientUsageReportResponse>("POST", "/v1/usage/observed", {
			body: report,
			schema: "clientUsageReportResponseSchema",
			signal,
		});
	}

	/** Per-client token burn aggregates recorded by the broker host. */
	fetchClientUsageSummary(query?: { sinceMs?: number }, signal?: AbortSignal): Promise<ClientUsageSummaryResponse> {
		const params = new URLSearchParams();
		if (query?.sinceMs !== undefined) params.set("sinceMs", String(query.sinceMs));
		const path = `/v1/usage/clients${params.size > 0 ? `?${params.toString()}` : ""}`;
		return this.#request<ClientUsageSummaryResponse>("GET", path, {
			schema: "clientUsageSummaryResponseSchema",
			signal,
		});
	}

	notifyUsageStale(signal?: AbortSignal): Promise<UsageStaleResponse> {
		return this.#request<UsageStaleResponse>("POST", "/v1/usage/stale", {
			schema: "usageStaleResponseSchema",
			signal,
		});
	}

	async refreshCredential(id: number, signal?: AbortSignal): Promise<CredentialRefreshResponse> {
		return this.#request<CredentialRefreshResponse>("POST", `/v1/credential/${id}/refresh`, {
			schema: "credentialRefreshResponseSchema",
			signal,
		});
	}

	async disableCredential(id: number, cause: string, signal?: AbortSignal): Promise<CredentialDisableResponse> {
		const body: CredentialDisableRequest = { cause };
		return this.#request<CredentialDisableResponse>("POST", `/v1/credential/${id}/disable`, {
			body,
			schema: "credentialDisableResponseSchema",
			signal,
		});
	}

	/**
	 * Disabled-credential tombstones (identity + cause, no token material).
	 * Returns an empty list against brokers predating `GET
	 * /v1/credentials/disabled` (404).
	 */
	async listDisabledCredentials(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		const params = new URLSearchParams();
		if (provider) params.set("provider", provider);
		const path = `/v1/credentials/disabled${params.size > 0 ? `?${params.toString()}` : ""}`;
		try {
			const response = await this.#request<DisabledCredentialsResponse>("GET", path, {
				schema: "disabledCredentialsResponseSchema",
				signal,
			});
			return response.disabled;
		} catch (error) {
			if (error instanceof AuthBrokerError && error.status === 404) return [];
			throw error;
		}
	}

	async uploadCredential(
		provider: string,
		credential: AuthCredential,
		signal?: AbortSignal,
	): Promise<CredentialUploadResponse> {
		const body: CredentialUploadRequest = { provider, credential };
		return this.#request<CredentialUploadResponse>("POST", "/v1/credential", {
			body,
			schema: "credentialUploadResponseSchema",
			signal,
		});
	}

	async upsertCredentialBlock(
		id: number,
		block: CredentialBlockRequest,
		signal?: AbortSignal,
	): Promise<CredentialBlockResponse> {
		const body: CredentialBlockRequest = block;
		return this.#request<CredentialBlockResponse>("POST", `/v1/credential/${id}/block`, {
			body,
			schema: "credentialBlockResponseSchema",
			signal,
		});
	}

	async deleteCredentialBlocks(id: number, signal?: AbortSignal): Promise<CredentialBlocksDeleteResponse> {
		return this.#request<CredentialBlocksDeleteResponse>("DELETE", `/v1/credential/${id}/blocks`, {
			schema: "credentialBlocksDeleteResponseSchema",
			signal,
		});
	}

	async #request<t>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		opts: {
			schema: AuthBrokerResponseSchemaName;
			auth?: boolean;
			body?: unknown;
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	): Promise<t> {
		const response = await this.#fetchRaw(method, path, opts);
		const text = await response.text();
		const raw = this.#parseJson(text, response.status);
		const validated = RESPONSE_SCHEMAS[opts.schema](raw);
		if (validated instanceof type.errors) {
			throw new AuthBrokerError("Auth broker response failed schema validation", {
				status: response.status,
				body: validated.summary,
			});
		}
		return validated as t;
	}

	#parseJson(text: string, status: number): unknown {
		try {
			return text.length === 0 ? null : JSON.parse(text);
		} catch (parseError) {
			throw new AuthBrokerError("Auth broker returned malformed JSON", {
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
			auth?: boolean;
			body?: unknown;
			signal?: AbortSignal;
			headers?: Record<string, string>;
			timeoutMs?: number;
		},
	): Promise<Response> {
		const auth = opts.auth ?? true;
		const url = `${this.#baseUrl}${path}`;
		const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
		if (auth) headers.Authorization = `Bearer ${this.#token}`;
		let payload: string | undefined;
		if (opts.body !== undefined) {
			payload = JSON.stringify(opts.body);
			headers["Content-Type"] = "application/json";
		}

		// Fast-fail when the caller's signal is already aborted — avoids spinning
		// up a fetch + timer that the first `await` would just abort anyway.
		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs);
			const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
			try {
				const response = await this.#fetch(url, {
					method,
					headers,
					body: payload,
					signal,
				});
				if (!response.ok && response.status !== 304) {
					let text = "";
					try {
						text = await response.text();
					} catch (cause) {
						throw new AuthBrokerError(`Auth broker request failed: ${response.status} ${response.statusText}`, {
							status: response.status,
							cause,
						});
					}
					throw new AuthBrokerError(`Auth broker request failed: ${response.status} ${response.statusText}`, {
						status: response.status,
						body: text,
					});
				}
				return response;
			} catch (error) {
				lastError = error;
				// Caller-driven abort wins over retry — the caller said stop.
				if (opts.signal?.aborted) {
					if (error instanceof AuthBrokerError && error.status !== undefined) throw error;
					throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
				}
				if (error instanceof AuthBrokerError && error.status !== undefined) {
					// HTTP errors (4xx/5xx) don't retry — caller knows what to do.
					throw error;
				}
				if (attempt >= this.#maxRetries) break;
			}
		}
		throw new AuthBrokerError(`Auth broker request failed after ${this.#maxRetries + 1} attempt(s)`, {
			cause: lastError,
		});
	}
}
