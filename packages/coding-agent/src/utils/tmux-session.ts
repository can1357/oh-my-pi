/**
 * Keep the tmux window name in sync with the omp session name so
 * `tmux list-windows -a` identifies live sessions by name on remote machines.
 *
 * OSC 0 titles do not reliably reach tmux window names, so this issues a real
 * `tmux rename-window` against `TMUX_PANE` — the precise, rename-stable target
 * for the window this process lives in.
 */
import * as path from "node:path";

import { isInsideTmux } from "@oh-my-pi/pi-tui/terminal-capabilities";

const TMUX_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** tmux accepts `.` and `:` in a window name but then misparses `-t <name>`. */
const TMUX_NAME_TARGET_DELIMITERS = /[.:]/g;
const TMUX_NAME_WHITESPACE = /\s+/g;
const TMUX_NAME_MAX_LENGTH = 64;

/**
 * The three shapes of tmux invocation this module needs. Injectable so tests
 * never spawn a real tmux (CI has none).
 */
export interface TmuxCommandRunner {
	/** Fire and forget: stdio ignored, missing binary and nonzero exits swallowed. */
	run(args: string[]): Promise<void>;
	/** Capture stdout; `undefined` when tmux is missing or exits nonzero. */
	capture(args: string[]): Promise<string | undefined>;
	/**
	 * Blocking variant for the shutdown restore. An awaited spawn loses the race
	 * with process exit, which would strand the window under the omp session name
	 * with `automatic-rename` still off, so restore must finish before we return.
	 */
	runSync(args: string[]): void;
}

const defaultRunner: TmuxCommandRunner = {
	async run(args) {
		try {
			const proc = Bun.spawn(["tmux", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			await proc.exited;
		} catch {
			// tmux missing or unspawnable: the window name is cosmetic, stay silent.
		}
	},
	async capture(args) {
		try {
			const proc = Bun.spawn(["tmux", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return exitCode === 0 ? stdout : undefined;
		} catch {
			return undefined;
		}
	},
	runSync(args) {
		try {
			Bun.spawnSync(["tmux", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		} catch {
			// Same policy as `run`: a cosmetic window name never breaks shutdown.
		}
	},
};

interface CapturedWindow {
	name: string;
	/** tmux renders `#{automatic-rename}` as `1`/`0`; `set-window-option` wants `on`/`off`. */
	automaticRename: "on" | "off";
}

interface TmuxWindowRuntime {
	enabled: boolean;
	runner: TmuxCommandRunner;
	/** Last name handed to tmux, so a repeated rename is a no-op. */
	lastName?: string;
	/** `undefined` = not captured yet, `null` = capture failed, so skip restore. */
	original?: CapturedWindow | null;
	/** Serializes tmux calls: capture must land before the first rename. */
	queue: Promise<void>;
}

const tmuxWindowRuntime: TmuxWindowRuntime = {
	enabled: false,
	runner: defaultRunner,
	queue: Promise.resolve(),
};

/** Enable/disable window renaming (driven by the `tui.tmuxWindowName` setting). */
export function setTmuxWindowNameEnabled(enabled: boolean): void {
	tmuxWindowRuntime.enabled = enabled;
}

/** Swap the tmux invoker so tests can assert argv without spawning anything. */
export function setTmuxCommandRunnerForTesting(runner: TmuxCommandRunner | undefined): void {
	tmuxWindowRuntime.runner = runner ?? defaultRunner;
	tmuxWindowRuntime.lastName = undefined;
	tmuxWindowRuntime.original = undefined;
	tmuxWindowRuntime.queue = Promise.resolve();
}

/** Await every tmux call queued so far. Test-only; production paths never block. */
export function drainTmuxWindowQueue(): Promise<void> {
	return tmuxWindowRuntime.queue;
}

/**
 * Strip anything that would corrupt a window name or a later `-t <name>` lookup:
 * control characters (terminal escape injection), `.` and `:` (tmux target
 * separators), and runs of whitespace.
 */
export function sanitizeTmuxWindowName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value
		.replace(TMUX_NAME_CONTROL_CHARS, "")
		.replace(TMUX_NAME_TARGET_DELIMITERS, "")
		.replace(TMUX_NAME_WHITESPACE, " ")
		.trim()
		.slice(0, TMUX_NAME_MAX_LENGTH)
		.trim();
	return sanitized || undefined;
}

/** Mirror of `getFallbackTerminalTitle`: an unnamed session shows its project directory. */
function getFallbackTmuxWindowName(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTmuxWindowName(baseName);
}

/** Chain onto the tmux queue; a rejection never escapes into the caller's turn. */
function enqueueTmuxCall(task: () => Promise<void>): void {
	tmuxWindowRuntime.queue = tmuxWindowRuntime.queue.then(task).catch(() => {});
}

async function captureOriginalWindow(pane: string): Promise<void> {
	if (tmuxWindowRuntime.original !== undefined) return;
	const output = await tmuxWindowRuntime.runner.capture([
		"display-message",
		"-p",
		"-t",
		pane,
		"#{window_name}\t#{automatic-rename}",
	]);
	const [name, automaticRename] = output?.trim().split("\t") ?? [];
	// No capture means no safe restore target: skip restore rather than guess.
	tmuxWindowRuntime.original = name ? { name, automaticRename: automaticRename === "1" ? "on" : "off" } : null;
}

/**
 * Rename the enclosing tmux window to the session name. Fire and forget: the
 * caller is never blocked and never sees a tmux failure.
 *
 * An explicit `rename-window` also clears the window's `automatic-rename`, so
 * the name sticks until {@link restoreTmuxWindowName} puts the original back.
 */
export function setTmuxWindowName(sessionName: string | undefined, cwd?: string): void {
	if (!tmuxWindowRuntime.enabled || !isInsideTmux()) return;
	const pane = Bun.env.TMUX_PANE;
	if (!pane) return;
	const next = sanitizeTmuxWindowName(sessionName) ?? getFallbackTmuxWindowName(cwd);
	if (!next || next === tmuxWindowRuntime.lastName) return;
	tmuxWindowRuntime.lastName = next;
	enqueueTmuxCall(async () => {
		await captureOriginalWindow(pane);
		await tmuxWindowRuntime.runner.run(["rename-window", "-t", pane, next]);
	});
}

/**
 * Put the pre-omp window name and `automatic-rename` back on shutdown.
 *
 * Synchronous on purpose: the caller exits the process immediately afterwards,
 * and an enqueued async spawn never runs, which would leave the window stuck on
 * the omp session name with `automatic-rename` disabled.
 */
export function restoreTmuxWindowName(): void {
	const pane = Bun.env.TMUX_PANE;
	const original = tmuxWindowRuntime.original;
	tmuxWindowRuntime.lastName = undefined;
	tmuxWindowRuntime.original = undefined;
	if (!pane || !original) return;
	tmuxWindowRuntime.runner.runSync(["rename-window", "-t", pane, original.name]);
	// rename-window forces automatic-rename off, so reinstate it afterwards.
	tmuxWindowRuntime.runner.runSync(["set-window-option", "-t", pane, "automatic-rename", original.automaticRename]);
}
