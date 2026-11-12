/**
 * Idle reload of the omp binary inside herdr or tmux.
 *
 * {@link decideBinaryReload} is the compare: the running executable against the
 * executable `$which("omp")` would launch now. {@link createBinaryHotReloadSubsystem}
 * polls that compare only while the session is idle; a change mid-turn is
 * deferred until the turn ends.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import {
	$which,
	isCompiledBinary,
	isExecutable,
	stripWindowsExtendedLengthPathPrefix,
	WhichCachePolicy,
} from "@oh-my-pi/pi-utils";
import type { HotReloadSubsystem } from "./hot-reload";

/** How often an idle session asks what `$which("omp")` would launch. */
export const BINARY_HOT_RELOAD_POLL_MS = 2_000;

export interface BinaryReloadFacts {
	/** `realpath` of `process.execPath`. */
	runningPath: string;
	/** Executable `$which("omp")` would launch, when one can be named. */
	launchPath: string | undefined;
	launchExecutable: boolean;
	/** True only inside herdr or tmux. A plain terminal never auto-restarts. */
	inMultiplexer: boolean;
	/** `hotReload.binary`. Default on; the multiplexer gate still applies. */
	enabled: boolean;
}

export type BinaryReloadDecision = "relaunch" | "stay";

/**
 * Relaunch only when a newer executable is on PATH, the session is inside
 * herdr or tmux, and hot reload is enabled. A matching path, a missing or
 * non-executable launch path, a plain terminal, or a disabled setting stays.
 */
export function decideBinaryReload(facts: BinaryReloadFacts): BinaryReloadDecision {
	if (!facts.enabled || !facts.inMultiplexer) return "stay";
	if (!facts.launchPath || !facts.launchExecutable) return "stay";
	if (facts.runningPath === facts.launchPath) return "stay";
	return "relaunch";
}

/** True when herdr or tmux owns this session. Other multiplexers do not auto-restart. */
export function inHerdrOrTmuxSession(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return hasTerminalMultiplexerSession("herdr", env) || hasTerminalMultiplexerSession("tmux", env);
}

/**
 * Auto-reload only for a compiled binary inside herdr or tmux, with the
 * setting on. A bun dev session's execPath is bun, which always differs from
 * `$which("omp")`; watching it would restart off the dev session every idle poll.
 */
export function shouldWatchBinaryReload(enabled: boolean, env: NodeJS.ProcessEnv = Bun.env): boolean {
	return enabled && isCompiledBinary() && inHerdrOrTmuxSession(env);
}

function commandName(filePath: string): string {
	const base = path.basename(filePath);
	return base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
}

/**
 * The executable a `$which` hit would launch, after `realpath` on both sides.
 *
 * A PATH entry whose realpath is still named `omp` launches that file. A mise
 * shim realpaths to the `mise` binary, not the install; `miseInstall` is what
 * `mise which omp` names. Without that install path the shim is not a launch
 * target — exec'ing the mise binary would not be omp, and comparing it to
 * `process.execPath` would differ on every poll.
 */
export function executableWhichWouldLaunch(
	whichPath: string,
	resolvedPath: string,
	miseInstall?: string,
): string | undefined {
	if (commandName(resolvedPath) === commandName(whichPath)) return resolvedPath;
	if (commandName(resolvedPath) !== "mise" || !miseInstall) return undefined;
	return miseInstall;
}

function realpathOr(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

/** `$which("omp")` with the cache bypassed, when that PATH entry is executable. */
export function resolveWhichOmp(): string | undefined {
	const whichPath = $which("omp", {
		requireAbsolutePaths: true,
		cache: WhichCachePolicy.Bypass,
	});
	if (!whichPath || !isExecutable(whichPath)) return undefined;
	return whichPath;
}

/**
 * Resolve `latest/omp` inside the mise `installs/` tree
 * adjacent to `shimPath` (`.../mise/shims/omp` -> `.../mise/installs/<tool>/latest/omp`).
 */
function readMiseOmpInstall(shimPath: string): string | undefined {
	const shimsDir = path.dirname(shimPath);
	if (path.basename(shimsDir) !== "shims") return undefined;
	const installsDir = path.join(path.dirname(shimsDir), "installs");
	let toolDirs: string[];
	try {
		toolDirs = fs.readdirSync(installsDir);
	} catch {
		return undefined;
	}
	const binaryName = path.basename(shimPath);
	for (const tool of toolDirs) {
		try {
			const candidate = fs.realpathSync(path.join(installsDir, tool, "latest", binaryName));
			if (isExecutable(candidate)) return candidate;
		} catch {
			// Try next tool dir.
		}
	}
	return undefined;
}

/**
 * Resolve `latest/omp` inside the mise tool install
 * directory that owns `installBinaryPath` (`.../mise/installs/<tool>/<ver>/omp`),
 * so a shell whose PATH pins an older `<ver>` still sees a newly installed build.
 */
export function readMiseLatestSiblingOmp(
	installBinaryPath: string = runningExecutablePath(),
	realpath: (filePath: string) => string = fs.realpathSync,
	executable: (filePath: string) => boolean = isExecutable,
): string | undefined {
	const versionDir = path.dirname(installBinaryPath);
	const toolDir = path.dirname(versionDir);
	if (path.basename(path.dirname(toolDir)) !== "installs") return undefined;
	try {
		const candidate = realpath(path.join(toolDir, "latest", path.basename(installBinaryPath)));
		if (executable(candidate)) return candidate;
	} catch {
		// Ignore missing latest alias.
	}
	return undefined;
}

/**
 * `realpath` of `$which("omp")`, cache bypassed. A mise install with a
 * `latest` symlink prefers that target; a mise shim is
 * resolved to the install `mise which omp` names. Undefined when omp is not on
 * PATH or the resolved file is not executable.
 */
export function resolveLiveOmpExecutable(): string | undefined {
	const siblingLatest = readMiseLatestSiblingOmp();
	if (siblingLatest) return siblingLatest;
	const whichPath = resolveWhichOmp();
	if (!whichPath) return undefined;
	const resolved = realpathOr(whichPath);
	const whichSiblingLatest = readMiseLatestSiblingOmp(resolved);
	if (whichSiblingLatest) return whichSiblingLatest;
	const miseInstall = commandName(resolved) === "mise" ? readMiseOmpInstall(whichPath) : undefined;
	const launched = executableWhichWouldLaunch(whichPath, resolved, miseInstall);
	if (!launched || !isExecutable(launched)) return undefined;
	return launched;
}

/** `realpath` of the running executable, or the path itself when it is already gone. */
export function runningExecutablePath(execPath: string = process.execPath): string {
	return realpathOr(stripWindowsExtendedLengthPathPrefix(execPath));
}

/**
 * Live omp path for `/restart`, or undefined when this process is not a
 * compiled binary. A bun dev session must keep relaunching bun.
 *
 * Prefers the install `mise which omp` names when the PATH entry realpaths to
 * the mise binary, otherwise `realpath($which("omp"))`. Falls back to the PATH
 * entry itself when that install cannot be named.
 */
export function restartLiveExecutable(): string | undefined {
	if (!isCompiledBinary()) return undefined;
	return resolveLiveOmpExecutable() ?? resolveWhichOmp();
}

/** Facts for one poll. Only a compiled binary is compared; a bun dev session must not jump to the install. */
export function readBinaryReloadFacts(env: NodeJS.ProcessEnv = Bun.env, enabled = true): BinaryReloadFacts {
	const launchPath = isCompiledBinary() ? resolveLiveOmpExecutable() : undefined;
	return {
		runningPath: runningExecutablePath(),
		launchPath,
		launchExecutable: launchPath !== undefined,
		inMultiplexer: inHerdrOrTmuxSession(env),
		enabled,
	};
}

export function createBinaryHotReloadSubsystem(options: {
	observe: () => BinaryReloadFacts | Promise<BinaryReloadFacts>;
	enabled?: () => boolean;
	restart: () => Promise<void>;
}): HotReloadSubsystem {
	return {
		id: "binary",
		source: "session",
		enabled: options.enabled,
		shouldReload: async () => decideBinaryReload(await options.observe()) === "relaunch",
		reload: options.restart,
		deferredMessage: "a newer omp is on PATH; restart deferred until the current turn ends",
		errorPrefix: "omp binary reload failed",
		stopBeforeReload: true,
	};
}
