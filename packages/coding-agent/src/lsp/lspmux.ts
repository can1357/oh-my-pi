import * as os from "node:os";
import * as path from "node:path";
import { $flag, $which, logger } from "@oh-my-pi/pi-utils";
import { TOML } from "bun";

/**
 * lspmux integration for LSP server multiplexing.
 *
 * When lspmux is available and running, this module wraps supported LSP server
 * commands to use lspmux client mode, enabling server instance sharing across
 * multiple editor windows.
 *
 * Integration is transparent: if lspmux is unavailable, falls back to direct spawning.
 */

// =============================================================================
// Types
// =============================================================================

interface LspmuxConfig {
	instance_timeout?: number;
	gc_interval?: number;
	listen?: [string, number] | string;
	connect?: [string, number] | string;
	log_filters?: string;
	pass_environment?: string[];
}

interface LspmuxState {
	available: boolean;
	running: boolean;
	binaryPath: string | null;
	config: LspmuxConfig | null;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Servers that benefit from lspmux multiplexing.
 *
 * lspmux can multiplex any LSP server, but it's most beneficial for servers
 * with high startup cost or significant memory usage.
 */
const DEFAULT_SUPPORTED_SERVERS = new Set([
	"rust-analyzer",
	// Other servers can be added after testing with lspmux
]);

/** Timeout for liveness check (ms) */
const LIVENESS_TIMEOUT_MS = 1000;

/** Cache duration for lspmux state (5 minutes) */
const STATE_CACHE_TTL_MS = 5 * 60 * 1000;

// =============================================================================
// Config Path
// =============================================================================

/**
 * Get the lspmux config path based on platform.
 * Matches Rust's `dirs::config_dir()` behavior.
 */
function getConfigPath(): string {
	const home = os.homedir();
	switch (os.platform()) {
		case "win32":
			return path.join(Bun.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "lspmux", "config.toml");
		case "darwin":
			return path.join(home, "Library", "Application Support", "lspmux", "config.toml");
		default:
			return path.join(Bun.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "lspmux", "config.toml");
	}
}

// =============================================================================
// State Management
// =============================================================================

let cachedState: LspmuxState | null = null;
let cacheTimestamp = 0;

/**
 * Parse lspmux config.toml file.
 */
async function parseConfig(): Promise<LspmuxConfig | null> {
	try {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) {
			return null;
		}
		return TOML.parse(await file.text()) as LspmuxConfig;
	} catch {
		return null;
	}
}

/**
 * Check if lspmux server is running via `lspmux status`.
 */
async function checkServerRunning(binaryPath: string): Promise<boolean> {
	try {
		const proc = Bun.spawn([binaryPath, "status"], {
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const exited = await Promise.race([
			proc.exited,
			new Promise<null>(resolve => setTimeout(() => resolve(null), LIVENESS_TIMEOUT_MS)),
		]);

		if (exited === null) {
			proc.kill();
			return false;
		}

		return exited === 0;
	} catch {
		return false;
	}
}

/**
 * Detect lspmux availability and state.
 * Results are cached for STATE_CACHE_TTL_MS.
 *
 * Set PI_DISABLE_LSPMUX=1 to disable.
 */
export async function detectLspmux(): Promise<LspmuxState> {
	const now = Date.now();
	if (cachedState && now - cacheTimestamp < STATE_CACHE_TTL_MS) {
		return cachedState;
	}

	if ($flag("PI_DISABLE_LSPMUX")) {
		cachedState = { available: false, running: false, binaryPath: null, config: null };
		cacheTimestamp = now;
		return cachedState;
	}

	const binaryPath = $which("lspmux");
	if (!binaryPath) {
		cachedState = { available: false, running: false, binaryPath: null, config: null };
		cacheTimestamp = now;
		return cachedState;
	}

	const [config, running] = await Promise.all([parseConfig(), checkServerRunning(binaryPath)]);

	cachedState = { available: true, running, binaryPath, config };
	cacheTimestamp = now;

	if (running) {
		logger.debug("lspmux detected and running", { binaryPath });
	}

	return cachedState;
}

// =============================================================================
// Command Wrapping
// =============================================================================

/**
 * Check if a server command is supported by lspmux.
 */
export function isLspmuxSupported(command: string): boolean {
	// Extract base command name (handle full paths)
	const baseName = command.split("/").pop() ?? command;
	return DEFAULT_SUPPORTED_SERVERS.has(baseName);
}

export interface LspmuxWrappedCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * Wrap a server command to use lspmux client mode.
 *
 * @param originalCommand - The original LSP server command (e.g., "rust-analyzer")
 * @param originalArgs - Original command arguments
 * @param state - lspmux state from detectLspmux()
 * @returns Wrapped command, args, and env vars; or original if lspmux unavailable
 */
export function wrapWithLspmux(
	originalCommand: string,
	originalArgs: string[] | undefined,
	state: LspmuxState,
): LspmuxWrappedCommand {
	if (!state.available || !state.running || !state.binaryPath) {
		return { command: originalCommand, args: originalArgs ?? [] };
	}

	if (!isLspmuxSupported(originalCommand)) {
		return { command: originalCommand, args: originalArgs ?? [] };
	}

	const baseName = originalCommand.split("/").pop() ?? originalCommand;
	const isDefaultRustAnalyzer = baseName === "rust-analyzer" && originalCommand === "rust-analyzer";
	const hasArgs = originalArgs && originalArgs.length > 0;

	// rust-analyzer from $PATH with no args - lspmux's default, simplest case
	if (isDefaultRustAnalyzer && !hasArgs) {
		return { command: state.binaryPath, args: [] };
	}

	// Use explicit `client` subcommand with LSPMUX_SERVER env var
	// Use `--` to separate lspmux options from server args
	const args = hasArgs ? ["client", "--", ...originalArgs] : ["client"];
	return {
		command: state.binaryPath,
		args,
		env: { LSPMUX_SERVER: originalCommand },
	};
}

/**
 * Get lspmux-wrapped command if available, otherwise return original.
 * This is the main entry point for config.ts integration.
 *
 * @param command - Original LSP server command
 * @param args - Original command arguments
 * @returns Command and args to use (possibly wrapped with lspmux)
 */
export async function getLspmuxCommand(command: string, args?: string[]): Promise<LspmuxWrappedCommand> {
	const state = await detectLspmux();
	return wrapWithLspmux(command, args, state);
}
