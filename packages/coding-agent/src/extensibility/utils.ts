import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { theme } from "../modes/theme/theme";
import { expandPath, normalizeLocalScheme } from "../tools/path-utils";
import type { HookUIContext } from "./hooks/types";

/**
 * Resolve a file path:
 * - Absolute paths used as-is
 * - Paths starting with ~ expanded to home directory
 * - Relative paths resolved from cwd
 */
export function resolvePath(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expanded);
	if (expandedAndNormalized.startsWith("local://")) {
		throw new Error(
			`Path "${filePath}" uses internal scheme "local://" and must be resolved through the proper protocol handler, not as a filesystem path.`,
		);
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

/**
 * Create a no-op UI context for headless modes.
 */
export function createNoOpUIContext(): HookUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setStatus: () => {},
		custom: async () => undefined as never,
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		get theme() {
			return theme;
		},
	};
}

/**
 * Raised by {@link withHostGuard} when a guarded callback synchronously
 * attempts to terminate the host process. Callers catch this like any other
 * load-time failure so the extension/hook is skipped with a logged error
 * instead of taking the CLI down with it.
 */
export class ExtensionExitError extends Error {
	readonly code: number | string | undefined;
	constructor(
		code: number | string | undefined,
		readonly alias = "process.exit",
	) {
		super(
			`Module called ${alias}(${code === undefined ? "" : String(code)}) during guarded extension/hook loading; ` +
				`OMP extension/hook modules must not terminate the host process.`,
		);
		this.name = "ExtensionExitError";
		this.code = code;
	}
}

type ExitAliasName = "process.exit" | "process.reallyExit";

/**
 * stdin events a loaded module must not be allowed to leave hijacked. A
 * top-level `new StdioServerTransport()` (or a bare `process.stdin.resume()`)
 * inside a `~/.claude/tools` MCP server attaches a `data` consumer and puts the
 * shared stdin into flowing mode; Bun delivers one `data` event to that
 * consumer and the TUI's own listener (attached later in `terminal.start()`)
 * then never re-arms — every keypress after the first is swallowed (#5618).
 */
const HOST_GUARD_STDIN_EVENTS = ["data", "readable", "end", "close", "error"] as const;
type StdinGuardEvent = (typeof HOST_GUARD_STDIN_EVENTS)[number];
type StdinGuardListener = (...args: unknown[]) => void;

let hostGuardDepth = 0;
let hostGuardOriginalProcessExit: typeof process.exit | null = null;
let hostGuardOriginalReallyExit: typeof process.reallyExit | null = null;
let hostGuardStdinListeners: Record<StdinGuardEvent, StdinGuardListener[]> | null = null;
let hostGuardStdinWasPaused = false;
let hostGuardStdinWasRaw = false;

/**
 * Run `fn` with host-owned process state fenced off from third-party module
 * evaluation, restored in `finally`. Guards the dynamic-import and
 * factory-invocation sites that load extension / hook / tool / plugin modules
 * from user directories (including Claude Code's `~/.claude/tools`, which OMP
 * slurps wholesale). Two hazards are neutralized:
 *
 * - **Hard exit.** `process.exit(0)` / `process.reallyExit(0)` in a stranger's
 *   script (e.g. a CLI-shaped module with `main()` at the bottom) would kill
 *   OMP during startup with no error surface, since `try/catch` cannot
 *   intercept a synchronous exit. Both are patched to throw
 *   {@link ExtensionExitError} instead.
 * - **stdin hijack.** A module that attaches a stdin consumer at evaluation
 *   time (an MCP `StdioServerTransport`, or a bare `resume()`) steals Bun's
 *   single stdin reader, so the TUI goes permanently deaf after one keypress
 *   (#5618). Any `data`/`readable`/`end`/`close`/`error` listener the module
 *   adds is removed, and the stream's paused and raw-mode state is restored to
 *   the pre-load snapshot.
 *
 * Nested and concurrent guard windows are safe: only the outermost guard
 * snapshots and restores host state.
 */
function guardedExit(alias: ExitAliasName): (code?: number | string) => never {
	return (code?: number | string): never => {
		throw new ExtensionExitError(code, alias);
	};
}

export async function withHostGuard<T>(fn: () => Promise<T>): Promise<T> {
	if (hostGuardDepth === 0) {
		// Stamp each throwing replacement with the native primitive it shadows so
		// host-owned shutdown (postmortem's signal/fatal handlers) can still exit
		// through the real exit even while this guard window is open (#6488).
		hostGuardOriginalProcessExit = process.exit;
		const processExitGuard = guardedExit("process.exit") as typeof process.exit;
		Reflect.set(processExitGuard, postmortem.NATIVE_PROCESS_EXIT, hostGuardOriginalProcessExit);
		process.exit = processExitGuard;

		if (typeof process.reallyExit === "function") {
			hostGuardOriginalReallyExit = process.reallyExit;
			const reallyExitGuard = guardedExit("process.reallyExit") as typeof process.reallyExit;
			Reflect.set(reallyExitGuard, postmortem.NATIVE_PROCESS_EXIT, hostGuardOriginalReallyExit);
			process.reallyExit = reallyExitGuard;
		}

		const stdin = process.stdin;
		hostGuardStdinWasPaused = stdin.isPaused();
		hostGuardStdinWasRaw = stdin.isRaw ?? false;
		const snapshot = {} as Record<StdinGuardEvent, StdinGuardListener[]>;
		for (const event of HOST_GUARD_STDIN_EVENTS) {
			snapshot[event] = stdin.rawListeners(event) as StdinGuardListener[];
		}
		hostGuardStdinListeners = snapshot;
	}
	hostGuardDepth++;
	try {
		return await fn();
	} finally {
		hostGuardDepth--;
		if (hostGuardDepth === 0) {
			if (hostGuardOriginalProcessExit) {
				process.exit = hostGuardOriginalProcessExit;
				hostGuardOriginalProcessExit = null;
			}
			if (hostGuardOriginalReallyExit) {
				process.reallyExit = hostGuardOriginalReallyExit;
				hostGuardOriginalReallyExit = null;
			}
			if (hostGuardStdinListeners) {
				const stdin = process.stdin;
				for (const event of HOST_GUARD_STDIN_EVENTS) {
					const before = hostGuardStdinListeners[event];
					// Reconcile the stream back to the pre-load snapshot: drop any
					// listener the module added, and reinstate any snapshot listener
					// it removed (e.g. a factory calling `removeAllListeners("data")`
					// would otherwise permanently strip ProcessTerminal's input
					// handler, leaving the parent TUI deaf). removeAllListeners then
					// re-adding in snapshot order restores both membership and order.
					const current = stdin.rawListeners(event) as StdinGuardListener[];
					const differs =
						current.length !== before.length || current.some((listener, index) => listener !== before[index]);
					if (!differs) continue;
					stdin.removeAllListeners(event);
					for (const listener of before) {
						stdin.on(event, listener);
					}
				}
				if (
					stdin.isTTY &&
					typeof stdin.setRawMode === "function" &&
					(stdin.isRaw ?? false) !== hostGuardStdinWasRaw
				) {
					stdin.setRawMode(hostGuardStdinWasRaw);
				}
				if (hostGuardStdinWasPaused && !stdin.isPaused()) {
					stdin.pause();
				} else if (!hostGuardStdinWasPaused && stdin.isPaused()) {
					stdin.resume();
				}
				hostGuardStdinListeners = null;
			}
		}
	}
}
