import * as path from "node:path";
import { isEnoent, logger } from "@pk-nerdsaver-ai/pi-utils";
import { YAML } from "bun";
import type { SecretEntry } from "./obfuscator";
import { compileSecretRegex } from "./regex";

export {
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./obfuscator";

/**
 * Load secrets from project-local and global secrets.yml files.
 * Project-local entries override global entries with matching content.
 */
export async function loadSecrets(cwd: string, agentDir: string): Promise<SecretEntry[]> {
	const projectPath = path.join(cwd, ".omp", "secrets.yml");
	const globalPath = path.join(agentDir, "secrets.yml");

	const globalEntries = await loadSecretsFile(globalPath);
	const projectEntries = await loadSecretsFile(projectPath);

	if (globalEntries.length === 0) return projectEntries;
	if (projectEntries.length === 0) return globalEntries;

	// Merge: project overrides global by content match
	const projectContents = new Set(projectEntries.map(e => e.content));
	const merged = [...globalEntries.filter(e => !projectContents.has(e.content)), ...projectEntries];
	return merged;
}

/** Minimum env var value length to consider as a secret. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Env var name patterns that indicate secret values. */
const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** Collect environment variable values that look like secrets. */
export function collectEnvSecrets(): SecretEntry[] {
	const entries: SecretEntry[] = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push({ type: "plain", content: value, mode: "obfuscate" });
	}
	return entries;
}

async function loadSecretsFile(filePath: string): Promise<SecretEntry[]> {
	try {
		const text = await Bun.file(filePath).text();
		const raw = YAML.parse(text);
		if (!Array.isArray(raw)) {
			logger.warn("secrets.yml must be a YAML array", { path: filePath });
			return [];
		}
		const entries: SecretEntry[] = [];
		for (let i = 0; i < raw.length; i++) {
			const entry = raw[i];
			if (!validateEntry(entry, filePath, i)) continue;
			entries.push({
				type: entry.type,
				content: entry.content,
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				flags: entry.flags,
			});
		}
		return entries;
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to load secrets.yml", { path: filePath, error: String(err) });
		return [];
	}
}

function validateEntry(entry: unknown, filePath: string, index: number): entry is SecretEntry {
	if (entry === null || typeof entry !== "object") {
		logger.warn(`secrets.yml[${index}]: entry must be an object`, { path: filePath });
		return false;
	}
	const e = entry as Record<string, unknown>;
	if (e.type !== "plain" && e.type !== "regex") {
		logger.warn(`secrets.yml[${index}]: type must be "plain" or "regex"`, { path: filePath });
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		logger.warn(`secrets.yml[${index}]: content must be a non-empty string`, { path: filePath });
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		logger.warn(`secrets.yml[${index}]: mode must be "obfuscate" or "replace"`, { path: filePath });
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		logger.warn(`secrets.yml[${index}]: replacement must be a string`, { path: filePath });
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		logger.warn(`secrets.yml[${index}]: flags must be a string`, { path: filePath });
		return false;
	}
	if (e.type === "regex") {
		try {
			compileSecretRegex(e.content as string, e.flags as string | undefined);
		} catch (error) {
			logger.warn(`secrets.yml[${index}]: invalid regex pattern`, {
				path: filePath,
				pattern: e.content,
				error: String(error),
			});
			return false;
		}
	}
	return true;
}
