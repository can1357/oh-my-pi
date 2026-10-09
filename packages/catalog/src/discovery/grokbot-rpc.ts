/** Session-authenticated Sand metadata/control-plane RPCs, never inference-token RPCs. */
import { frameConnectPayload } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";
import {
	clearGrokbotTokenCache,
	createGrokbotChecksum,
	GROKBOT_BACKEND,
	grokbotClientHeaders,
	grokbotMetadataHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mergeGrokbotHeaders,
	mintGrokbotAccessToken,
	type GrokbotConfig,
} from "./grokbot-auth";

export type GrokbotRpcRecord = Record<string, unknown>;

export class GrokbotRpcError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(status: number, code?: unknown) {
		const safeCode = rpcCode(code);
		const mappedStatus = status < 400 ? (CONNECT_STATUS[safeCode ?? ""] ?? 502) : status;
		super(`Grok Bot RPC failed (HTTP ${mappedStatus}${safeCode ? `, ${safeCode}` : ""})`);
		this.name = "GrokbotRpcError";
		this.status = mappedStatus;
		this.code = safeCode;
	}
}

export interface GrokbotRpcOptions {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface GrokbotRpcRequestOptions {
	stream?: boolean;
	timeoutMs?: number;
	/** null permits cleanup of a newly created resource after the caller aborts. */
	signal?: AbortSignal | null;
}

const CONNECT_STATUS: Record<string, number> = {
	canceled: 499,
	unknown: 500,
	invalid_argument: 400,
	deadline_exceeded: 504,
	not_found: 404,
	already_exists: 409,
	permission_denied: 403,
	resource_exhausted: 429,
	failed_precondition: 400,
	aborted: 409,
	out_of_range: 400,
	unimplemented: 501,
	internal: 500,
	unavailable: 503,
	data_loss: 500,
	unauthenticated: 401,
	invalid_response: 502,
	turn_failed: 502,
};

function rpcCode(value: unknown): string | undefined {
	const code = typeof value === "string" ? value.toLowerCase() : "";
	return Object.hasOwn(CONNECT_STATUS, code) ? code : undefined;
}

function clientOs(): string {
	switch (process.platform) {
		case "darwin":
			return "CLIENT_OS_MACOS";
		case "win32":
			return "CLIENT_OS_WINDOWS";
		case "linux":
			return "CLIENT_OS_LINUX";
		default:
			return "CLIENT_OS_UNSPECIFIED";
	}
}

export class GrokbotRpcClient {
	readonly #cfg: GrokbotConfig;
	readonly #options: GrokbotRpcOptions;
	readonly #fetch: FetchImpl;
	readonly #backend: string;

	constructor(cfg: GrokbotConfig, options: GrokbotRpcOptions = {}) {
		this.#cfg = cfg;
		this.#options = options;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#backend = options.baseUrl?.trim() || GROKBOT_BACKEND;
	}

	get machineId(): string {
		return this.#cfg.machineId;
	}

	/** Join the two Sand transports' allowance without merging unrelated credentials. */
	get quotaGroup(): string {
		return `grokbot:sand:${Bun.SHA256.hash(JSON.stringify([this.#backend, this.#cfg.namespace, this.#cfg.renewal]), "hex")}`;
	}

	async request(path: string, payload: GrokbotRpcRecord, options: GrokbotRpcRequestOptions = {}): Promise<Response> {
		const timeoutMs = options.timeoutMs ?? 30_000;
		const caller = options.signal === null ? undefined : (options.signal ?? this.#options.signal);
		const deadline = AbortSignal.timeout(timeoutMs);
		const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
		const callerHeaders = grokbotMetadataHeaders(this.#options.headers);
		const bytes = Buffer.from(JSON.stringify(payload));
		const body = options.stream ? frameConnectPayload(bytes) : bytes;
		const post = (bearer: string) =>
			this.#fetch(joinGrokbotBackendUrl(this.#backend, path), {
				method: "POST",
				redirect: "error",
				headers: mergeGrokbotHeaders(callerHeaders, grokbotClientHeaders(this.#cfg), {
					authorization: `Bearer ${bearer}`,
					"x-cursor-checksum": createGrokbotChecksum(this.#cfg.machineId),
					"x-cursor-client-source": "sand-desktop",
					"x-cursor-client-os": clientOs(),
					"x-ghost-mode": "true",
					"x-request-id": crypto.randomUUID(),
					"content-type": options.stream ? "application/connect+json" : "application/json",
					"connect-protocol-version": "1",
					"connect-timeout-ms": String(timeoutMs),
				}),
				body,
				signal,
			});
		let bearer = await mintGrokbotAccessToken(this.#cfg, this.#fetch, this.#backend, signal, callerHeaders);
		let response = await post(bearer);
		// Authentication rejection is safe to retry. Never retry uncertain deliveries,
		// permission errors, rate limits, or transport failures here.
		if (response.status === 401) {
			await response.body?.cancel();
			clearGrokbotTokenCache();
			bearer = await mintGrokbotAccessToken(this.#cfg, this.#fetch, this.#backend, signal, callerHeaders);
			response = await post(bearer);
		}
		return response;
	}

	async rpc(
		path: string,
		payload: GrokbotRpcRecord = {},
		options: GrokbotRpcRequestOptions = {},
	): Promise<GrokbotRpcRecord> {
		const response = await this.request(path, payload, options);
		const raw: unknown = await response.json().catch(() => undefined);
		const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as GrokbotRpcRecord) : undefined;
		// Bodies/messages can echo credentials. Only an allowlisted-shaped error code
		// enters the error; never persist or print the raw failed response.
		if (!response.ok) throw new GrokbotRpcError(response.status, rpcCode(value?.code));
		if (!value) throw new GrokbotRpcError(response.status, "invalid_response");
		return value;
	}
}

export async function createGrokbotRpcClient(options: GrokbotRpcOptions = {}): Promise<GrokbotRpcClient> {
	const cfg = await loadGrokbotConfig(options.apiKey);
	if (!cfg.renewal || !cfg.machineId) throw new Error("Grok Bot renewal credential and machine id are required");
	return new GrokbotRpcClient(cfg, options);
}
