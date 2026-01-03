import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Embed package.json at build time for config
import packageJson from "../package.json" with { type: "json" };

// =============================================================================
// App Config (from embedded package.json)
// =============================================================================

export const APP_NAME: string = (packageJson as { piConfig?: { name?: string } }).piConfig?.name || "pi";
export const CONFIG_DIR_NAME: string =
	(packageJson as { piConfig?: { configDir?: string } }).piConfig?.configDir || ".pi";
export const VERSION: string = (packageJson as { version: string }).version;

// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

// =============================================================================
// Package Directory (for optional external docs/examples)
// =============================================================================

/**
 * Get the base directory for resolving optional package assets (docs, examples).
 * Walk up from import.meta.dir until we find package.json, or fall back to cwd.
 */
export function getPackageDir(): string {
	let dir = import.meta.dir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback to cwd (docs/examples won't be found, but that's fine)
	return process.cwd();
}

/** Get path to README.md (optional, may not exist in binary) */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory (optional, may not exist in binary) */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory (optional, may not exist in binary) */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md (optional, may not exist in binary) */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir(): string {
	return process.env[ENV_AGENT_DIR] || join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to slash commands directory */
export function getCommandsDir(): string {
	return join(getAgentDir(), "commands");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
