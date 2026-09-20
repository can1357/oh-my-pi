/**
 * Grok Bot sand credential minting shared by catalog discovery and the ai stream client.
 *
 * Auth is NOT Cursor OAuth, NOT xAI API keys, and NOT SuperGrok OAuth. A long-lived
 * renewal credential (obtained by `/login grokbot`, see `pi-ai/registry/oauth/grokbot`)
 * is exchanged for a short-lived JWT via POST /sand-box/inference-credential.
 * Machine id feeds `x-cursor-checksum`.
 */
import { $env, logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";
import { fingerprintGrokbotCustomHeaders } from "../provider-models/grokbot";
import {
	cancelGrokbotCatalogResponse,
	MAX_GROKBOT_CREDENTIAL_JSON_BODY_BYTES,
	readBoundedGrokbotCatalogJson,
} from "./grokbot-body";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_RENEWAL_PATH = "/sand-box/inference-credential";
export const GROKBOT_CLIENT_TYPE = "sand";

/**
 * Join a sand API path onto a configured backend while preserving any reverse-proxy
 * path prefix (e.g. `https://proxy.example/grokbot`). `new URL("/sand-box/…", base)`
 * resets the pathname; concatenating onto the trailing-slash-trimmed base keeps it.
 */
export function joinGrokbotBackendUrl(baseUrl: string, path: string): URL {
	const normalized = (baseUrl.trim() || GROKBOT_BACKEND).replace(/\/+$/, "") || GROKBOT_BACKEND;
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return new URL(`${normalized}${suffix}`);
}
/**
 * Stamped sand client app version (matches current sand-host client stamp).
 * Wire header uses the base (`0.30.0`) for prod, or base+`-dev`/`-lab`.
 */
export const GROKBOT_STAMPED_CLIENT_VERSION = "0.30.0-pre.16";
export const GROKBOT_DEFAULT_NAMESPACE = "prod";
export const GROKBOT_DEFAULT_TOKEN_TTL_MS = 10 * 60_000;
const STAMPED_VERSION_BASE = /^(\d+\.\d+\.\d+)(?:-.+)?$/;

export type GrokbotConfig = {
	/** Renewal credential; empty when the caller has not authenticated yet. */
	renewal: string;
	/** Client-owned checksum id; supplied per-request via the structured apiKey. */
	machineId?: string;
	namespace: string;
	clientVersion: string;
};

type CachedToken = {
	/** `type:"session"` JWT — account APIs only. */
	accessToken: string;
	/** `type:"grok_bot"` JWT — the only token InferenceService accepts. */
	grokBotToken: string;
	expiresAtMs: number;
};

/** JWT cache keyed by a hashed minting identity so renewal credentials never persist as map keys. */
const MAX_TOKEN_CACHE_ENTRIES = 64;
const tokenCache = new Map<string, CachedToken>();

function tokenCacheKey(
	cfg: Pick<GrokbotConfig, "renewal" | "namespace" | "clientVersion">,
	backend: string,
	requestHeaders: Readonly<Record<string, string>> | undefined,
): string {
	return new Bun.CryptoHasher("sha256")
		.update(cfg.renewal)
		.update("\0")
		.update(backend)
		.update("\0")
		.update(cfg.namespace)
		.update("\0")
		.update(cfg.clientVersion)
		.update("\0")
		.update(fingerprintGrokbotCustomHeaders(requestHeaders))
		.digest("hex");
}

function cacheToken(key: string, token: CachedToken): void {
	tokenCache.delete(key);
	tokenCache.set(key, token);
	if (tokenCache.size > MAX_TOKEN_CACHE_ENTRIES) {
		tokenCache.delete(tokenCache.keys().next().value!);
	}
}

/** Strip stamp suffix (`0.30.0-pre.16` → `0.30.0`), matching sand-host `stampedVersionBaseOf`. */
export function stampedVersionBaseOf(stamped: string | undefined | null): string | undefined {
	const match = STAMPED_VERSION_BASE.exec(stamped?.trim() ?? "");
	return match?.[1];
}

/**
 * Resolve `x-cursor-client-version` like sand-host `getSandClientVersion`:
 * prod → base; dev → `${base}-dev`; lab → `${base}-lab`. An explicit override
 * (env) is sent as-is.
 */
export function resolveGrokbotClientVersion(
	namespace: string,
	stamped = GROKBOT_STAMPED_CLIENT_VERSION,
	explicitOverride?: string,
): string {
	if (explicitOverride?.trim()) return explicitOverride.trim();
	const base = stampedVersionBaseOf(stamped) ?? stamped;
	switch (namespace) {
		case "dev":
			return `${base}-dev`;
		case "lab":
			return `${base}-lab`;
		default:
			return base;
	}
}

/** JWT `exp` (seconds) → ms, matching sand-host `getAccessTokenExpiryMs`. */
export function getAccessTokenExpiryMs(token: string): number | null {
	try {
		const payloadB64 = token.split(".")[1];
		if (!payloadB64) return null;
		const json = Buffer.from(payloadB64, "base64url").toString("utf8");
		const payload = JSON.parse(json) as { exp?: unknown };
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

/**
 * Resolve namespace + client version for discovery headers. Overrides ride on
 * ambient env (`GROKBOT_NAMESPACE` / `GROKBOT_CLIENT_VERSION`) so a Cursor
 * client-version bump can be patched without a code change; auth (renewer +
 * machine id) comes from the structured apiKey, never from ambient env.
 */
export function loadGrokbotConfig(renewalOverride?: string): GrokbotConfig {
	const namespace = $env.GROKBOT_NAMESPACE?.trim() || GROKBOT_DEFAULT_NAMESPACE;
	const clientVersion = resolveGrokbotClientVersion(
		namespace,
		GROKBOT_STAMPED_CLIENT_VERSION,
		$env.GROKBOT_CLIENT_VERSION?.trim() || undefined,
	);
	return {
		renewal: renewalOverride?.trim() || "",
		namespace,
		clientVersion,
	};
}

export function grokbotClientHeaders(cfg: Pick<GrokbotConfig, "clientVersion" | "namespace">): Record<string, string> {
	return {
		"x-cursor-client-type": GROKBOT_CLIENT_TYPE,
		"x-cursor-client-version": cfg.clientVersion,
		"x-sand-box-namespace": cfg.namespace,
	};
}

const GROKBOT_PROVIDER_OWNED_HEADERS = new Set([
	"accept",
	"authorization",
	"connect-protocol-version",
	"content-type",
	"x-cursor-checksum",
	"x-cursor-client-type",
	"x-cursor-client-version",
	"x-ghost-mode",
	"x-request-id",
	"x-sand-box-namespace",
]);

/** Merge header layers without allowing case variants to create duplicate names. */
export function mergeGrokbotHeaders(
	...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
	const merged: Record<string, string> = {};
	const spellingByLowercase = new Map<string, string>();
	for (const source of sources) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) {
			const lowercase = name.toLowerCase();
			const existing = spellingByLowercase.get(lowercase);
			if (existing) delete merged[existing];
			spellingByLowercase.set(lowercase, name);
			merged[name] = value;
		}
	}
	return merged;
}

/**
 * Overlay Sand-owned headers after caller layers. Reserved names are removed
 * even when this endpoint intentionally has no value for one (for example,
 * the renewal credential exchange does not accept a caller Authorization).
 */
export function mergeGrokbotProviderHeaders(
	callerSources: readonly (Readonly<Record<string, string>> | undefined)[],
	providerHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
	const merged = mergeGrokbotHeaders(...callerSources);
	for (const name of Object.keys(merged)) {
		if (GROKBOT_PROVIDER_OWNED_HEADERS.has(name.toLowerCase())) delete merged[name];
	}
	return mergeGrokbotHeaders(merged, providerHeaders);
}

function enhancedObfuscate(bytes: Uint8Array): Uint8Array {
	let lastByte = 165;
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (bytes[i] ^ lastByte) + (i % 256);
		lastByte = bytes[i];
	}
	return bytes;
}

/**
 * Grok Bot provider checksum: obfuscated floor(now/1e6) bytes + machine id.
 *
 * Intentionally matches the upstream client `createCursorChecksum` JS `>>` semantics:
 * shift counts are masked to 5 bits (`>> 40` ≡ `>> 8`, `>> 32` ≡ `>> 0`).
 */
export function createGrokbotChecksum(machineId: string, nowMs = Date.now()): string {
	const unixKiloSeconds = Math.floor(nowMs / 1e6);
	const bytes = Uint8Array.from([
		(unixKiloSeconds >> 8) & 255, // sand: >> 40 wraps to >> 8
		unixKiloSeconds & 255, // sand: >> 32 wraps to >> 0
		(unixKiloSeconds >> 24) & 255,
		(unixKiloSeconds >> 16) & 255,
		(unixKiloSeconds >> 8) & 255,
		unixKiloSeconds & 255,
	]);
	const checksum = Buffer.from(enhancedObfuscate(bytes)).toString("base64url");
	return `${checksum}${machineId}`;
}

export async function mintGrokbotAccessToken(
	cfg: GrokbotConfig,
	fetchImpl: FetchImpl = fetch,
	backend = GROKBOT_BACKEND,
	signal?: AbortSignal,
	/** Caller/model headers (e.g. reverse-proxy API key); provider-owned headers win. */
	requestHeaders?: Record<string, string>,
	/** Which JWT to return: `grok_bot` for InferenceService (default), `session` for account APIs like AvailableModels. */
	preference: "grok-bot" | "session" = "grok-bot",
): Promise<string> {
	if (!cfg.renewal) {
		throw new Error("Grok Bot renewer missing. Run `/login grokbot` to sign in and store the credential.");
	}
	const cacheKey = tokenCacheKey(cfg, backend, requestHeaders);
	const cached = tokenCache.get(cacheKey);
	const preferSession = preference === "session";
	if (cached) {
		const wanted = preferSession ? cached.accessToken : cached.grokBotToken;
		if (wanted && Date.now() < cached.expiresAtMs - 60_000) {
			// Refresh insertion order on hits so the bounded cache is LRU.
			tokenCache.delete(cacheKey);
			tokenCache.set(cacheKey, cached);
			return wanted;
		}
		tokenCache.delete(cacheKey);
	}
	const response = await fetchImpl(joinGrokbotBackendUrl(backend, GROKBOT_RENEWAL_PATH), {
		method: "POST",
		headers: mergeGrokbotProviderHeaders([requestHeaders], {
			"content-type": "application/json",
			...grokbotClientHeaders(cfg),
		}),
		body: JSON.stringify({ credential: cfg.renewal }),
		signal,
	});
	if (!response.ok) {
		await cancelGrokbotCatalogResponse(response);
		logger.warn("Grok Bot token renew failed", { status: response.status });
		throw new Error(`Grok Bot token renew failed (HTTP ${response.status})`);
	}
	// Renewal response carries two JWTs: `accessToken` (type "session") and
	// `grokBotToken` (type "grok_bot"). InferenceService rejects the session
	// token; AvailableModels rejects the grok_bot token. Each caller gets the
	// JWT its endpoint accepts.
	const parsed = (await readBoundedGrokbotCatalogJson(response, signal, MAX_GROKBOT_CREDENTIAL_JSON_BODY_BYTES)) as {
		accessToken?: unknown;
		grokBotToken?: unknown;
		expiresAtMs?: unknown;
	};
	const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : "";
	const grokBotToken = typeof parsed.grokBotToken === "string" ? parsed.grokBotToken : "";
	const selectedToken = preferSession ? accessToken : grokBotToken;
	if (!selectedToken) {
		throw new Error(`Grok Bot token renew returned no ${preferSession ? "accessToken" : "grokBotToken"}`);
	}
	const expiresAtMs =
		typeof parsed.expiresAtMs === "number" && Number.isFinite(parsed.expiresAtMs)
			? parsed.expiresAtMs
			: (getAccessTokenExpiryMs(selectedToken) ?? Date.now() + GROKBOT_DEFAULT_TOKEN_TTL_MS);
	cacheToken(cacheKey, { accessToken, grokBotToken, expiresAtMs });
	return selectedToken;
}

/** Test-only: clear cached JWTs. Also used after HTTP 401 so auth-retry remints. */
export function clearGrokbotTokenCache(): void {
	tokenCache.clear();
}
