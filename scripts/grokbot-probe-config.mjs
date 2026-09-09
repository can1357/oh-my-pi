/**
 * Shared Grok Bot probe config loader.
 *
 * Agent-dir resolution uses the same `getAgentDir()` leaf helper as the CLI
 * (profile / XDG aware). Env credentials still work when the secrets file is
 * absent. Secrets-file parsing uses the shared dotenv loader so `export`,
 * quotes, and inline comments match CLI/catalog minting.
 */
import * as path from "node:path";
import { getAgentDir } from "../packages/utils/src/dirs.ts";
import { parseEnvFile } from "../packages/utils/src/env.ts";
import { mintGrokbotAccessToken as mintToken } from "../packages/catalog/src/discovery/grokbot-auth.ts";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_RENEWAL_PATH = "/sand-box/inference-credential";
export const GROKBOT_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
export const GROKBOT_CLIENT_TYPE = "sand";
export const GROKBOT_STAMPED_CLIENT_VERSION = "0.30.0-pre.16";
export const GROKBOT_DEFAULT_NAMESPACE = "prod";
export const GROKBOT_DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

const STAMPED_VERSION_BASE = /^(\d+\.\d+\.\d+)(?:-.+)?$/;

export function stampedVersionBaseOf(stamped) {
	const match = STAMPED_VERSION_BASE.exec(stamped?.trim() ?? "");
	return match?.[1];
}

export function resolveGrokbotClientVersion(namespace, stamped, explicitOverride) {
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

/** Profile/XDG-aware agent dir — same resolver the CLI uses. */
export function resolveAgentDir() {
	return getAgentDir();
}

export function grokbotSecretsPath(agentDir = resolveAgentDir()) {
	return path.join(agentDir, "secrets", "grokbot.env");
}

/** Env overrides secrets file; missing file is empty (env-only configs work). */
export function loadGrokbotConfig() {
	const file = parseEnvFile(grokbotSecretsPath());
	const namespace = process.env.GROKBOT_NAMESPACE || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = process.env.GROKBOT_CLIENT_VERSION || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		renewal:
			process.env.GROKBOT_RENEWAL_CREDENTIAL ||
			process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			file.GROKBOT_RENEWAL_CREDENTIAL ||
			file.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			"",
		machineId: process.env.GROKBOT_MACHINE_ID || file.GROKBOT_MACHINE_ID || "",
		namespace,
		clientVersion: resolveGrokbotClientVersion(namespace, GROKBOT_STAMPED_CLIENT_VERSION, explicitVersion),
	};
}

/** Sand client identity headers — mirrors catalog/ai grokbotClientHeaders. */
export function grokbotClientHeaders(cfg) {
	return {
		"x-cursor-client-type": GROKBOT_CLIENT_TYPE,
		"x-cursor-client-version": cfg.clientVersion,
		"x-sand-box-namespace": cfg.namespace,
	};
}

function enhancedObfuscate(bytes) {
	let lastByte = 165;
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (bytes[i] ^ lastByte) + (i % 256);
		lastByte = bytes[i];
	}
	return bytes;
}

/** Wire checksum — mirrors catalog/ai createGrokbotChecksum (no pi-utils). */
export function createGrokbotChecksum(machineId, nowMs = Date.now()) {
	const uks = Math.floor(nowMs / 1e6);
	const bytes = Uint8Array.from([
		(uks >> 8) & 255,
		uks & 255,
		(uks >> 24) & 255,
		(uks >> 16) & 255,
		(uks >> 8) & 255,
		uks & 255,
	]);
	const checksum = Buffer.from(enhancedObfuscate(bytes)).toString("base64url");
	return `${checksum}${machineId}`;
}

export function joinGrokbotBackendUrl(baseUrl, p) {
	const normalized = (baseUrl?.trim() || GROKBOT_BACKEND).replace(/\/+$/, "") || GROKBOT_BACKEND;
	const suffix = p.startsWith("/") ? p : `/${p}`;
	return new URL(`${normalized}${suffix}`);
}

export function getAccessTokenExpiryMs(token) {
	try {
		const payloadB64 = token.split(".")[1];
		if (!payloadB64) return null;
		const json = Buffer.from(payloadB64, "base64url").toString("utf8");
		const payload = JSON.parse(json);
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

/** Share production minting and purpose selection; metadata and inference use different bearers. */
export async function mintGrokbotAccessToken(cfg, fetchImpl = fetch, purpose = "api") {
	return mintToken(cfg, fetchImpl, GROKBOT_BACKEND, undefined, undefined, purpose);
}
