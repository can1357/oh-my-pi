/**
 * Grok Bot sand credential minting shared by catalog discovery and the ai stream client.
 *
 * Auth is NOT Cursor OAuth, NOT xAI API keys, and NOT SuperGrok OAuth. A long-lived
 * renewal credential is exchanged for a short-lived JWT via POST
 * /sand-box/inference-credential. Machine id feeds `x-cursor-checksum`.
 */
import * as path from "node:path";
import { $env, getAgentDir, logger, parseEnvFile, parseEnvFileAsync } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";

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
/** @deprecated Prefer GROKBOT_STAMPED_CLIENT_VERSION; kept for callers that want the stamp string. */
export const GROKBOT_DEFAULT_CLIENT_VERSION = GROKBOT_STAMPED_CLIENT_VERSION;
export const GROKBOT_DEFAULT_NAMESPACE = "prod";
export const GROKBOT_DEFAULT_TOKEN_TTL_MS = 10 * 60_000;
const STAMPED_VERSION_BASE = /^(\d+\.\d+\.\d+)(?:-.+)?$/;

export type GrokbotConfig = {
	renewal: string;
	machineId: string;
	namespace: string;
	clientVersion: string;
};

type CachedToken = {
	accessToken: string;
	expiresAtMs: number;
};

/** JWT cache keyed by minting configuration so concurrent accounts/backends do not bleed. */
const tokenCache = new Map<string, CachedToken>();

/** Stable fingerprint of caller/proxy headers for JWT cache scoping (case-normalized). */
function fingerprintRequestHeaders(headers?: Record<string, string>): string {
	if (!headers) return "";
	const entries = Object.entries(headers)
		.map(([key, value]) => [key.toLowerCase(), value] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	if (entries.length === 0) return "";
	return entries.map(([key, value]) => `${key}=${value}`).join("\u0001");
}

function tokenCacheKey(
	cfg: Pick<GrokbotConfig, "renewal" | "namespace" | "clientVersion">,
	backend: string,
	requestHeaders?: Record<string, string>,
): string {
	return `${cfg.renewal}\0${backend}\0${cfg.namespace}\0${cfg.clientVersion}\0${fingerprintRequestHeaders(requestHeaders)}`;
}

/** Strip stamp suffix (`0.30.0-pre.16` → `0.30.0`), matching sand-host `stampedVersionBaseOf`. */
export function stampedVersionBaseOf(stamped: string | undefined | null): string | undefined {
	const match = STAMPED_VERSION_BASE.exec(stamped?.trim() ?? "");
	return match?.[1];
}

/**
 * Resolve `x-cursor-client-version` like sand-host `getSandClientVersion`:
 * prod → base; dev → `${base}-dev`; lab → `${base}-lab`.
 * An explicit override (env/file) is sent as-is.
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

export function grokbotSecretsPath(): string {
	return path.join(getAgentDir(), "secrets", "grokbot.env");
}

export async function loadGrokbotSecretFile(filePath = grokbotSecretsPath()): Promise<Record<string, string>> {
	return parseEnvFileAsync(filePath);
}

export function loadGrokbotSecretFileSync(filePath = grokbotSecretsPath()): Record<string, string> {
	return parseEnvFile(filePath);
}

/**
 * Namespace + client-version used for AvailableModels headers and model-cache
 * scoping. Mirrors {@link loadGrokbotConfig}: env overrides secrets file, then
 * stamped defaults.
 *
 * When both overrides are already resolved, skips the secrets file so callers
 * that loaded identity asynchronously can pass it through without a second
 * synchronous read (TUI refresh must not block on agent-dir I/O).
 */
export function resolveGrokbotDiscoveryIdentity(overrides?: { namespace?: string; clientVersion?: string }): {
	namespace: string;
	clientVersion: string;
} {
	const overrideNs = overrides?.namespace?.trim();
	const overrideVer = overrides?.clientVersion?.trim();
	if (overrideNs && overrideVer) {
		return { namespace: overrideNs, clientVersion: overrideVer };
	}
	const file = loadGrokbotSecretFileSync();
	const namespace = overrideNs || $env.GROKBOT_NAMESPACE || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = overrideVer || $env.GROKBOT_CLIENT_VERSION || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		namespace,
		clientVersion: resolveGrokbotClientVersion(namespace, GROKBOT_STAMPED_CLIENT_VERSION, explicitVersion),
	};
}

/**
 * Async counterpart of {@link resolveGrokbotDiscoveryIdentity} for catalog
 * refresh / discovery prep — reads `secrets/grokbot.env` via
 * {@link loadGrokbotSecretFile} so the TUI event loop is not blocked.
 */
export async function resolveGrokbotDiscoveryIdentityAsync(overrides?: {
	namespace?: string;
	clientVersion?: string;
}): Promise<{ namespace: string; clientVersion: string }> {
	const overrideNs = overrides?.namespace?.trim();
	const overrideVer = overrides?.clientVersion?.trim();
	if (overrideNs && overrideVer) {
		return { namespace: overrideNs, clientVersion: overrideVer };
	}
	const file = await loadGrokbotSecretFile();
	const namespace = overrideNs || $env.GROKBOT_NAMESPACE || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = overrideVer || $env.GROKBOT_CLIENT_VERSION || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		namespace,
		clientVersion: resolveGrokbotClientVersion(namespace, GROKBOT_STAMPED_CLIENT_VERSION, explicitVersion),
	};
}

/** Sync resolver for registry `envKeys` / AuthStorage availability. */
/**
 * Sync resolver for registry `envKeys` / AuthStorage availability.
 *
 * Process-env renewal credentials are returned literally so broker migrate
 * `--include-env` can upload them. Host-secret *file* credentials only advertise
 * that auth is available via the shared `<authenticated>` sentinel — migrate
 * skips that sentinel, so a file-backed renewer is never uploaded without the
 * paired machine id.
 */
export function resolveGrokbotEnvApiKey(): string | undefined {
	const fromEnv = $env.GROKBOT_RENEWAL_CREDENTIAL || $env.SAND_INFERENCE_RENEWAL_CREDENTIAL || undefined;
	if (fromEnv) return fromEnv;
	const file = loadGrokbotSecretFileSync();
	const fromFile = file.GROKBOT_RENEWAL_CREDENTIAL || file.SAND_INFERENCE_RENEWAL_CREDENTIAL || "";
	return fromFile ? "<authenticated>" : undefined;
}

export async function loadGrokbotConfig(renewalOverride?: string): Promise<GrokbotConfig> {
	const file = await loadGrokbotSecretFile();
	const namespace = $env.GROKBOT_NAMESPACE || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = $env.GROKBOT_CLIENT_VERSION || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		renewal:
			renewalOverride ||
			$env.GROKBOT_RENEWAL_CREDENTIAL ||
			$env.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			file.GROKBOT_RENEWAL_CREDENTIAL ||
			file.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			"",
		machineId: $env.GROKBOT_MACHINE_ID || file.GROKBOT_MACHINE_ID || "",
		namespace,
		clientVersion: resolveGrokbotClientVersion(namespace, GROKBOT_STAMPED_CLIENT_VERSION, explicitVersion),
	};
}

export function grokbotClientHeaders(cfg: Pick<GrokbotConfig, "clientVersion" | "namespace">): Record<string, string> {
	return {
		"x-cursor-client-type": GROKBOT_CLIENT_TYPE,
		"x-cursor-client-version": cfg.clientVersion,
		"x-sand-box-namespace": cfg.namespace,
	};
}

/**
 * Case-insensitive header merge: later sources win and keep their casing.
 * A plain Object.assign would let `authorization` and `Authorization` coexist,
 * and Bun's Headers constructor then joins both values comma-separated on the wire.
 */
export function mergeGrokbotHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
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
): Promise<string> {
	if (!cfg.renewal) {
		throw new Error(`Grok Bot renewer missing. Set GROKBOT_RENEWAL_CREDENTIAL or write ${grokbotSecretsPath()}`);
	}
	const cacheKey = tokenCacheKey(cfg, backend, requestHeaders);
	const cached = tokenCache.get(cacheKey);
	if (cached?.accessToken && Date.now() < cached.expiresAtMs - 60_000) {
		return cached.accessToken;
	}
	const response = await fetchImpl(joinGrokbotBackendUrl(backend, GROKBOT_RENEWAL_PATH), {
		method: "POST",
		headers: mergeGrokbotHeaders(requestHeaders, { "content-type": "application/json" }, grokbotClientHeaders(cfg)),
		body: JSON.stringify({ credential: cfg.renewal }),
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		logger.warn("Grok Bot token renew failed", { status: response.status, body: body.slice(0, 200) });
		throw new Error(`Grok Bot token renew failed (HTTP ${response.status})`);
	}
	const parsed = (await response.json()) as { accessToken?: unknown; expiresAtMs?: unknown };
	const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : "";
	if (!accessToken) throw new Error("Grok Bot token renew returned no accessToken");
	const expiresAtMs =
		typeof parsed.expiresAtMs === "number" && Number.isFinite(parsed.expiresAtMs)
			? parsed.expiresAtMs
			: (getAccessTokenExpiryMs(accessToken) ?? Date.now() + GROKBOT_DEFAULT_TOKEN_TTL_MS);
	tokenCache.set(cacheKey, { accessToken, expiresAtMs });
	return accessToken;
}

/** Test-only: clear cached JWTs. Also used after HTTP 401 so auth-retry remints. */
export function clearGrokbotTokenCache(): void {
	tokenCache.clear();
}
