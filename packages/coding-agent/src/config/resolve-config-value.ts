/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * Note: command execution is async to avoid blocking the TUI.
 */

import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, ptree } from "@oh-my-pi/pi-utils";

/** Cache for successful shell command results (persists for process lifetime). */
const commandResultCache = new Map<string, string>();

/** De-duplicates concurrent executions for the same command. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export async function resolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) {
		return await executeCommand(config);
	}
	const envValue = $envExact(config);
	return envValue || config;
}

async function executeCommand(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined) {
		return cached;
	}

	const existing = commandInFlight.get(commandConfig);
	if (existing) {
		return await existing;
	}

	const command = commandConfig.slice(1);
	const promise = runShellCommand(command, 10_000)
		.then(result => {
			if (result !== undefined) {
				commandResultCache.set(commandConfig, result);
			}
			return result;
		})
		.finally(() => {
			commandInFlight.delete(commandConfig);
		});

	commandInFlight.set(commandConfig, promise);
	return await promise;
}

/**
 * Run one `!command` config-value resolution and capture stdout.
 *
 * Exported for testing (timeout and tree-kill semantics).
 *
 * On POSIX, ptree spawns through Bun with piped-only stdio, so descriptors
 * this process holds open — e.g. a credential a launcher passed us on a
 * private fd — cannot cross into the command, matching the models.yml apiKey
 * resolver's isolation (model-config-values.ts). On timeout it hard-kills the
 * whole descendant tree and only reports once that kill has completed, so a
 * credential helper that forked background work cannot outlive its budget;
 * stderr is drained to a truncated tail rather than mixed into the captured
 * value.
 *
 * Windows keeps the original natives Brush shell: existing `!command` values
 * depend on its POSIX-style grammar, and piped-only stdio changes nothing
 * there — child handle inheritance is governed by the CreateProcess
 * inheritable-handle set, not by which stdio streams are wired, so the
 * measured POSIX fd-inheritance leak has no Windows equivalent this switch
 * would close.
 */
export async function runShellCommand(command: string, timeoutMs: number): Promise<string | undefined> {
	if (process.platform === "win32") {
		try {
			let output = "";
			const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
				if (!err) {
					output += chunk;
				}
			});
			if (result.timedOut || result.exitCode !== 0) {
				return undefined;
			}
			const trimmed = output.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		// Absolute OS shell, not a PATH-resolved name: a launcher may hand omp a
		// minimal tool-only PATH (same shape as execSync's default shell).
		const result = await ptree.exec(["/bin/sh", "-c", command], {
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			// POSIX process-group isolation keeps double-forked/reparented
			// descendants reachable after they leave the shell's PID tree.
			detached: true,
			// Linux child-subreaper supervision retains workers that create a new
			// session and outlive the intermediate process that launched them.
			subreaper: process.platform === "linux",
		});
		// An aborted result can still carry a real exit code (the command may
		// exit zero in the window between the timeout firing and the kill landing)
		// — timed-out output is never a resolved credential.
		if (!result.ok || result.exitError?.aborted) return undefined;
		const trimmed = result.stdout.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveHeaders(
	headers: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = await resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	commandInFlight.clear();
}
