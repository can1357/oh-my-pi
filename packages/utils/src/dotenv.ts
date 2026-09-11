/**
 * Side-effect-free dotenv parsing and post-profile environment loading.
 *
 * `@oh-my-pi/pi-utils/env` eagerly loads `.env` files at import time, so it
 * must never be imported before the CLI resolves the active profile
 * (see `profile-bootstrap.ts` and `process-entry-import.test.ts`). This module
 * has no top-level side effects: importing it is safe anywhere, and calling
 * {@link ensureProfileEnvLoaded} after `setProfile()` applies the selected
 * profile's environment (including directory-affecting keys such as
 * `XDG_STATE_HOME`) before any module imports `pi-utils/env`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getProjectDir, refreshDirsFromEnv } from "./dirs";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

/**
 * Names from the project `.env` that OMP itself injected into `Bun.env`.
 * Shared with `env.ts` so `filterChildShellEnv` keeps the same provenance
 * whether the first load ran here (post-profile, pre-`env` import) or in the
 * eager `env.ts` block.
 */
export const projectEnvNamesLoadedByOmp = new Set<string>();

/**
 * Parse one dotenv line with Bun-compatible semantics: an optional `export`
 * prefix, full-line `#` comments, inline `#` comments after whitespace on
 * unquoted values, and single/double/backtick quoting (a `#` inside quotes
 * stays literal). Returns undefined for blank lines, comments, and malformed
 * names.
 */
function parseEnvLine(line: string): { key: string; value: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const eqIndex = trimmed.indexOf("=");
	if (eqIndex === -1) return undefined;
	let key = trimmed.slice(0, eqIndex).trim();
	const exported = key.match(/^export[ \t]+(.*)$/);
	if (exported) key = exported[1].trim();
	if (!isValidEnvName(key)) return undefined;
	const raw = trimmed.slice(eqIndex + 1).replace(/^[ \t]+/, "");
	const quote = raw[0];
	if (quote === '"' || quote === "'" || quote === "`") {
		let close = raw.indexOf(quote, 1);
		while (close !== -1 && raw[close - 1] === "\\") close = raw.indexOf(quote, close + 1);
		return { key, value: close === -1 ? raw.slice(1) : raw.slice(1, close) };
	}
	const commentIndex = raw.search(/[ \t]#/);
	return { key, value: (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trimEnd() };
}

/**
 * Parses a .env file synchronously into key-value string pairs using
 * {@link parseEnvLine} for Bun-compatible line semantics, then mirrors valid
 * `OMP_` variables to their `PI_` aliases.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const parsed = parseEnvLine(line);
			if (parsed && isSafeEnvValue(parsed.value)) result[parsed.key] = parsed.value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

/**
 * Apply the home/config/agent/project `.env` files for the active profile to
 * `Bun.env` (explicit environment wins; nothing is overwritten) and rebuild
 * the dirs resolver so directory-affecting keys take effect.
 *
 * MUST be called after `setProfile()` and before the first `pi-utils/env`
 * import (a later `env` import re-runs the same application as a no-op for
 * already-set keys). Safe to call when `env` was already imported: keys this
 * process already owns keep their values.
 */
export function ensureProfileEnvLoaded(): void {
	// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
	const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
	const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
	const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
	const projectEnv = parseEnvFile(path.join(getProjectDir(), ".env"));

	for (const key of Object.keys(Bun.env)) {
		const value = Bun.env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			delete Bun.env[key];
		}
	}

	for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
		for (const key in file) {
			if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
				Bun.env[key] = file[key];
				if (file === projectEnv) projectEnvNamesLoadedByOmp.add(key);
			}
		}
	}

	// Directory-affecting keys (XDG_*_HOME, and in default mode PI_CODING_AGENT_DIR)
	// may have just arrived from the profile/agent `.env` applied above. The dirs
	// resolver cached its paths at module load — before this file ran — so rebuild
	// it now from the updated env. `getAgentDir()` already located the `.env` from
	// the profile name + home, so this re-reads only the directory vars.
	refreshDirsFromEnv();
}
