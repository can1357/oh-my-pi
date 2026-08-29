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

function tokenCacheKey(cfg: Pick<GrokbotConfig, "renewal" | "namespace" | "clientVersion">, backend: string): string {
	return `${cfg.renewal}\0${backend}\0${cfg.namespace}\0${cfg.clientVersion}`;
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

/** Sync resolver for registry `envKeys` / AuthStorage availability. */
export function resolveGrokbotEnvApiKey(): string | undefined {
	const fromEnv = $env.GROKBOT_RENEWAL_CREDENTIAL || $env.SAND_INFERENCE_RENEWAL_CREDENTIAL || undefined;
	if (fromEnv) return fromEnv;
	const file = loadGrokbotSecretFileSync();
	const fromFile = file.GROKBOT_RENEWAL_CREDENTIAL || file.SAND_INFERENCE_RENEWAL_CREDENTIAL || "";
	return fromFile || undefined;
}

export async function loadGrokbotConfig(renewalOverride?: string): Promise<GrokbotConfig> {
	const file = await loadGrokbotSecretFile();
	const namespace = $env.GROKBOT_NAMESPACE || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = $env.GROKBOT_CLIENT_VERSION || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		renewal:
			renewalOverride ||
			$env.GROKBOT_RENEWAL_CREDENTIAL ||
			file.GROKBOT_RENEWAL_CREDENTIAL ||
			$env.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
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
): Promise<string> {
	if (!cfg.renewal) {
		throw new Error(`Grok Bot renewer missing. Set GROKBOT_RENEWAL_CREDENTIAL or write ${grokbotSecretsPath()}`);
	}
	const cacheKey = tokenCacheKey(cfg, backend);
	const cached = tokenCache.get(cacheKey);
	if (cached?.accessToken && Date.now() < cached.expiresAtMs - 60_000) {
		return cached.accessToken;
	}
	const response = await fetchImpl(new URL(GROKBOT_RENEWAL_PATH, backend), {
		method: "POST",
		headers: { "content-type": "application/json", ...grokbotClientHeaders(cfg) },
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
