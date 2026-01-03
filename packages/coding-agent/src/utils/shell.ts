import { accessSync, constants, existsSync } from "node:fs";
import { SettingsManager } from "../core/settings-manager";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string | undefined>;
	prefix: string | undefined;
}

let cachedShellConfig: ShellConfig | null = null;

/**
 * Check if a shell binary is executable.
 */
function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string): Record<string, string | undefined> {
	const noCI = process.env.OMP_BASH_NO_CI || process.env.CLAUDE_BASH_NO_CI;
	return {
		...process.env,
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	};
}

/**
 * Get shell args, optionally including login shell flag.
 * Supports OMP_BASH_NO_LOGIN and CLAUDE_BASH_NO_LOGIN to skip -l.
 */
function getShellArgs(): string[] {
	const noLogin = process.env.OMP_BASH_NO_LOGIN || process.env.CLAUDE_BASH_NO_LOGIN;
	return noLogin ? ["-c"] : ["-l", "-c"];
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(): string | undefined {
	return process.env.OMP_SHELL_PREFIX || process.env.CLAUDE_CODE_SHELL_PREFIX;
}

/**
 * Find bash executable on PATH (Windows)
 */
function findBashOnPath(): string | null {
	try {
		const result = Bun.spawnSync(["where", "bash.exe"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0 && result.stdout) {
			const firstMatch = result.stdout.toString().trim().split(/\r?\n/)[0];
			if (firstMatch && existsSync(firstMatch)) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
export function getShellConfig(): ShellConfig {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	const settings = SettingsManager.create();
	const customShellPath = settings.getShellPath();

	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			cachedShellConfig = buildConfig(customShellPath);
			return cachedShellConfig;
		}
		throw new Error(
			`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.omp/agent/settings.json`,
		);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				cachedShellConfig = buildConfig(path);
				return cachedShellConfig;
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			cachedShellConfig = buildConfig(bashOnPath);
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				`  3. Set shellPath in ~/.omp/agent/settings.json\n\n` +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: prefer user's shell from $SHELL if it's bash/zsh and executable
	const userShell = process.env.SHELL;
	const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		cachedShellConfig = buildConfig(userShell);
		return cachedShellConfig;
	}

	// Fallback paths (Claude's approach: check known locations)
	const fallbackPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
	const preferZsh = !userShell?.includes("bash");
	const shellOrder = preferZsh ? ["zsh", "bash"] : ["bash", "zsh"];

	for (const shellName of shellOrder) {
		for (const dir of fallbackPaths) {
			const shellPath = `${dir}/${shellName}`;
			if (isExecutable(shellPath)) {
				cachedShellConfig = buildConfig(shellPath);
				return cachedShellConfig;
			}
		}
	}

	// Last resort: use Bun.which
	const bashPath = Bun.which("bash");
	if (bashPath) {
		cachedShellConfig = buildConfig(bashPath);
		return cachedShellConfig;
	}

	const shPath = Bun.which("sh");
	cachedShellConfig = buildConfig(shPath || "sh");
	return cachedShellConfig;
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

let pgrepAvailable: boolean | null = null;

/**
 * Check if pgrep is available on this system (cached).
 */
function hasPgrep(): boolean {
	if (pgrepAvailable === null) {
		try {
			const result = Bun.spawnSync(["pgrep", "--version"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			// pgrep exists if it ran (exit 0 or 1 are both valid)
			pgrepAvailable = result.exitCode !== null;
		} catch {
			pgrepAvailable = false;
		}
	}
	return pgrepAvailable;
}

/**
 * Get direct children of a PID using pgrep.
 */
function getChildrenViaPgrep(pid: number): number[] {
	const result = Bun.spawnSync(["pgrep", "-P", String(pid)], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});

	if (result.exitCode !== 0 || !result.stdout) return [];

	const children: number[] = [];
	for (const line of result.stdout.toString().trim().split("\n")) {
		const childPid = parseInt(line, 10);
		if (!Number.isNaN(childPid)) children.push(childPid);
	}
	return children;
}

/**
 * Get direct children of a PID using /proc (Linux only).
 */
function getChildrenViaProc(pid: number): number[] {
	try {
		const result = Bun.spawnSync(
			[
				"sh",
				"-c",
				`for p in /proc/[0-9]*/stat; do cat "$p" 2>/dev/null; done | awk -v ppid=${pid} '$4 == ppid { print $1 }'`,
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		if (result.exitCode !== 0 || !result.stdout) return [];

		const children: number[] = [];
		for (const line of result.stdout.toString().trim().split("\n")) {
			const childPid = parseInt(line, 10);
			if (!Number.isNaN(childPid)) children.push(childPid);
		}
		return children;
	} catch {
		return [];
	}
}

/**
 * Collect all descendant PIDs breadth-first.
 * Returns deepest descendants first (reverse BFS order) for proper kill ordering.
 */
function getDescendantPids(pid: number): number[] {
	const getChildren = hasPgrep() ? getChildrenViaPgrep : getChildrenViaProc;
	const descendants: number[] = [];
	const queue = [pid];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const children = getChildren(current);
		for (const child of children) {
			descendants.push(child);
			queue.push(child);
		}
	}

	// Reverse so deepest children are killed first
	return descendants.reverse();
}

function tryKill(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill a process and all its descendants.
 * @param gracePeriodMs - Time to wait after SIGTERM before SIGKILL (0 = immediate SIGKILL)
 */
export function killProcessTree(pid: number, gracePeriodMs = 0): void {
	if (process.platform === "win32") {
		Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		return;
	}

	const signal = gracePeriodMs > 0 ? "SIGTERM" : "SIGKILL";

	// Fast path: process group kill (works if pid is group leader)
	try {
		process.kill(-pid, signal);
		if (gracePeriodMs > 0) {
			Bun.sleepSync(gracePeriodMs);
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already dead
			}
		}
		return;
	} catch {
		// Not a process group leader, fall through
	}

	// Collect descendants BEFORE killing to minimize race window
	const allPids = [...getDescendantPids(pid), pid];

	if (gracePeriodMs > 0) {
		for (const p of allPids) tryKill(p, "SIGTERM");
		Bun.sleepSync(gracePeriodMs);
	}

	for (const p of allPids) tryKill(p, "SIGKILL");
}
