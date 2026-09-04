/**
 * Shared Grok Bot probe config loader.
 *
 * Mirrors `loadGrokbotConfig` / agent-dir resolution without importing the
 * `@oh-my-pi/pi-utils` barrel (which pulls native bindings). Env credentials
 * work even when the secrets file is absent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_RENEWAL_PATH = "/sand-box/inference-credential";
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

export function parseEnvFile(filePath) {
	if (!fs.existsSync(filePath)) return {};
	const text = fs.readFileSync(filePath, "utf8");
	const out = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

/** Resolve agent dir like omp (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`). */
export function resolveAgentDir() {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return path.join(os.homedir(), ".omp", "agent");
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
