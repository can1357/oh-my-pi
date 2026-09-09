/**
 * Grok Bot sand credential minting shared by catalog discovery and the ai stream client.
 *
 * Auth is NOT Cursor OAuth, NOT xAI API keys, and NOT SuperGrok OAuth. A long-lived
 * renewal credential is exchanged for a short-lived JWT via POST
 * /sand-box/inference-credential. Machine id feeds `x-cursor-checksum`.
 */
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { $env, getAgentDir, logger, parseEnvFile, parseEnvFileAsync } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_RENEWAL_PATH = "/sand-box/inference-credential";
export const GROKBOT_CLIENT_TYPE = "sand";

/**
 * Join a sand API path onto a configured backend while preserving any reverse-proxy
 * path prefix (e.g. `https://proxy.example/grokbot`) and query string
 * (e.g. `?api_key=secret`). `new URL("/sand-box/…", base)` resets the pathname;
 * appending onto `pathname` keeps path + search intact.
 */
export function joinGrokbotBackendUrl(baseUrl: string, apiPath: string): URL {
	// Parse first so trailing-slash normalization only touches pathname — never
	// a query value that happens to end in `/` (e.g. `?token=signed-value/`).
	const url = new URL(baseUrl.trim() || GROKBOT_BACKEND);
	const suffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
	const basePath = url.pathname.replace(/\/+$/, "");
	url.pathname = `${basePath}${suffix}`;
	return url;
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

/** Shared with Bedrock/Vertex env hooks — not a literal renewal credential. */
export const GROKBOT_AUTHENTICATED_SENTINEL = "<authenticated>";
const STAMPED_VERSION_BASE = /^(\d+\.\d+\.\d+)(?:-.+)?$/;

/**
 * Parallel-safe auth source for tests and embedded callers. When set via
 * {@link runWithGrokbotAuthSource}, secrets/env reads use this overlay instead
 * of mutating `process.env` or the process-wide agent dir.
 */
export type GrokbotAuthSource = {
	secretsPath?: string;
	/** Present keys override `$env`; `undefined` values mean unset (no fallthrough). */
	env?: Record<string, string | undefined>;
};

const grokbotAuthSource = new AsyncLocalStorage<GrokbotAuthSource>();

/** Run `fn` with an injected secrets path / env overlay (parallel-test safe). */
export function runWithGrokbotAuthSource<T>(source: GrokbotAuthSource, fn: () => T): T {
	return grokbotAuthSource.run(source, fn);
}

/** Async counterpart of {@link runWithGrokbotAuthSource}. */
export function runWithGrokbotAuthSourceAsync<T>(source: GrokbotAuthSource, fn: () => Promise<T>): Promise<T> {
	return grokbotAuthSource.run(source, fn);
}

function grokbotEnv(name: string): string | undefined {
	const overlay = grokbotAuthSource.getStore()?.env;
	if (overlay && Object.prototype.hasOwnProperty.call(overlay, name)) {
		const value = overlay[name];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}
	const fromProcess = $env[name];
	return typeof fromProcess === "string" && fromProcess.trim() ? fromProcess.trim() : undefined;
}

export type GrokbotConfig = {
	renewal: string;
	machineId: string;
	namespace: string;
	clientVersion: string;
};

type CachedToken = {
	accessToken: string;
	grokBotToken?: string;
	expiresAtMs: number;
};

export type GrokbotTokenPurpose = "api" | "inference";

function tokenForPurpose(token: CachedToken, purpose: GrokbotTokenPurpose): string {
	return purpose === "inference" ? (token.grokBotToken ?? token.accessToken) : token.accessToken;
}

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
	return grokbotAuthSource.getStore()?.secretsPath ?? path.join(getAgentDir(), "secrets", "grokbot.env");
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
	const namespace =
		overrideNs || grokbotEnv("GROKBOT_NAMESPACE") || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion =
		overrideVer || grokbotEnv("GROKBOT_CLIENT_VERSION") || file.GROKBOT_CLIENT_VERSION || undefined;
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
	const namespace =
		overrideNs || grokbotEnv("GROKBOT_NAMESPACE") || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion =
		overrideVer || grokbotEnv("GROKBOT_CLIENT_VERSION") || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		namespace,
		clientVersion: resolveGrokbotClientVersion(namespace, GROKBOT_STAMPED_CLIENT_VERSION, explicitVersion),
	};
}

/**
 * Sync machine-id resolver for availability / cache-warm gates.
 * Env wins over secrets-file, matching `loadGrokbotConfig`.
 */
export function resolveGrokbotMachineId(): string | undefined {
	const fromEnv = grokbotEnv("GROKBOT_MACHINE_ID");
	if (fromEnv) return fromEnv;
	const file = loadGrokbotSecretFileSync();
	const fromFile = file.GROKBOT_MACHINE_ID?.trim() || undefined;
	return fromFile || undefined;
}

/**
 * Sync resolver for registry `envKeys` / AuthStorage availability.
 *
 * Process-env renewal credentials are returned literally so broker migrate
 * `--include-env` can upload them. Host-secret *file* credentials only advertise
 * that auth is available via the shared `<authenticated>` sentinel — migrate
 * skips that sentinel, so a file-backed renewer is never uploaded without the
 * paired machine id.
 *
 * Both halves of the auth pair are required: a renewer without
 * `GROKBOT_MACHINE_ID` (env or secrets file) must not advertise availability,
 * or ModelRegistry would expose models that `streamGrokBot` always rejects.
 */
export function resolveGrokbotEnvApiKey(): string | undefined {
	const fromEnv = grokbotEnv("GROKBOT_RENEWAL_CREDENTIAL") || grokbotEnv("SAND_INFERENCE_RENEWAL_CREDENTIAL");
	const machineFromEnv = grokbotEnv("GROKBOT_MACHINE_ID");
	if (fromEnv && machineFromEnv) return fromEnv;

	const file = loadGrokbotSecretFileSync();
	const renewal = fromEnv || file.GROKBOT_RENEWAL_CREDENTIAL || file.SAND_INFERENCE_RENEWAL_CREDENTIAL || "";
	const machineId = machineFromEnv || file.GROKBOT_MACHINE_ID || "";
	if (!renewal.trim() || !machineId.trim()) return undefined;
	return fromEnv ? fromEnv : GROKBOT_AUTHENTICATED_SENTINEL;
}

/**
 * Renewal credential used for model-cache scoping. Expands the shared
 * `<authenticated>` sentinel (and empty/missing keys) to the resolved env or
 * secrets-file renewer so file-backed accounts do not collapse onto one cache.
 *
 * Prefer {@link resolveGrokbotCacheCredentialAsync} (or a precomputed
 * `cacheCredential` on model-manager options) on catalog-refresh paths so the
 * TUI does not sync-read `secrets/grokbot.env`.
 */
export function resolveGrokbotCacheCredential(apiKey?: string): string {
	const trimmed = apiKey?.trim();
	if (trimmed && trimmed !== GROKBOT_AUTHENTICATED_SENTINEL) return trimmed;
	const fromEnv = grokbotEnv("GROKBOT_RENEWAL_CREDENTIAL") || grokbotEnv("SAND_INFERENCE_RENEWAL_CREDENTIAL") || "";
	if (fromEnv) return fromEnv;
	const file = loadGrokbotSecretFileSync();
	return file.GROKBOT_RENEWAL_CREDENTIAL || file.SAND_INFERENCE_RENEWAL_CREDENTIAL || "";
}

/** Async counterpart of {@link resolveGrokbotCacheCredential} for catalog refresh. */
export async function resolveGrokbotCacheCredentialAsync(apiKey?: string): Promise<string> {
	const trimmed = apiKey?.trim();
	if (trimmed && trimmed !== GROKBOT_AUTHENTICATED_SENTINEL) return trimmed;
	const fromEnv = grokbotEnv("GROKBOT_RENEWAL_CREDENTIAL") || grokbotEnv("SAND_INFERENCE_RENEWAL_CREDENTIAL") || "";
	if (fromEnv) return fromEnv;
	const file = await loadGrokbotSecretFile();
	return file.GROKBOT_RENEWAL_CREDENTIAL || file.SAND_INFERENCE_RENEWAL_CREDENTIAL || "";
}

export async function loadGrokbotConfig(renewalOverride?: string): Promise<GrokbotConfig> {
	const file = await loadGrokbotSecretFile();
	const namespace = grokbotEnv("GROKBOT_NAMESPACE") || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = grokbotEnv("GROKBOT_CLIENT_VERSION") || file.GROKBOT_CLIENT_VERSION || undefined;
	// ModelRegistry may forward the env-hook sentinel as apiKey; never mint with it.
	const override = renewalOverride?.trim();
	const effectiveOverride = override && override !== GROKBOT_AUTHENTICATED_SENTINEL ? override : undefined;
	return {
		renewal:
			effectiveOverride ||
			grokbotEnv("GROKBOT_RENEWAL_CREDENTIAL") ||
			grokbotEnv("SAND_INFERENCE_RENEWAL_CREDENTIAL") ||
			file.GROKBOT_RENEWAL_CREDENTIAL ||
			file.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			"",
		machineId: grokbotEnv("GROKBOT_MACHINE_ID") || file.GROKBOT_MACHINE_ID || "",
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
	/** Inference uses grokBotToken when minted; metadata RPCs keep accessToken. */
	purpose: GrokbotTokenPurpose = "api",
): Promise<string> {
	if (!cfg.renewal) {
		throw new Error(`Grok Bot renewer missing. Set GROKBOT_RENEWAL_CREDENTIAL or write ${grokbotSecretsPath()}`);
	}
	const cacheKey = tokenCacheKey(cfg, backend, requestHeaders);
	const cached = tokenCache.get(cacheKey);
	if (cached?.accessToken && Date.now() < cached.expiresAtMs - 60_000) {
		return tokenForPurpose(cached, purpose);
	}
	const response = await fetchImpl(joinGrokbotBackendUrl(backend, GROKBOT_RENEWAL_PATH), {
		method: "POST",
		headers: mergeGrokbotHeaders(requestHeaders, { "content-type": "application/json" }, grokbotClientHeaders(cfg)),
		body: JSON.stringify({ credential: cfg.renewal }),
		signal,
	});
	if (!response.ok) {
		// Do not log the response body — reverse proxies may echo the mint
		// request `{ credential }` and persist the long-lived renewer.
		await response.text().catch(() => "");
		logger.warn("Grok Bot token renew failed", { status: response.status });
		throw new Error(`Grok Bot token renew failed (HTTP ${response.status})`);
	}
	const parsed = (await response.json()) as { accessToken?: unknown; grokBotToken?: unknown; expiresAtMs?: unknown };
	const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : "";
	if (!accessToken) throw new Error("Grok Bot token renew returned no accessToken");
	const grokBotToken =
		typeof parsed.grokBotToken === "string" && parsed.grokBotToken.trim() ? parsed.grokBotToken : undefined;
	const responseExpiry =
		typeof parsed.expiresAtMs === "number" && Number.isFinite(parsed.expiresAtMs)
			? parsed.expiresAtMs
			: (getAccessTokenExpiryMs(accessToken) ?? Date.now() + GROKBOT_DEFAULT_TOKEN_TTL_MS);
	// The two tokens can have different lifetimes. Refresh the pair before
	// either expires so switching from discovery to inference cannot use stale auth.
	const expiresAtMs = Math.min(
		responseExpiry,
		getAccessTokenExpiryMs(accessToken) ?? Infinity,
		grokBotToken ? (getAccessTokenExpiryMs(grokBotToken) ?? Infinity) : Infinity,
	);
	const token = { accessToken, grokBotToken, expiresAtMs };
	tokenCache.set(cacheKey, token);
	return tokenForPurpose(token, purpose);
}

/** Test-only: clear cached JWTs. Also used after HTTP 401 so auth-retry remints. */
export function clearGrokbotTokenCache(): void {
	tokenCache.clear();
}
