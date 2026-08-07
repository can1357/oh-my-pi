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
import { postmortem } from "@oh-my-pi/pi-utils";

const TMUX_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const TMUX_NAME_WHITESPACE = /\s+/g;
const TMUX_NAME_MAX_LENGTH = 64;

/**
 * The three shapes of tmux invocation this module needs. Injectable so tests
 * never spawn a real tmux (CI has none).
 */
export interface TmuxCommandRunner {
	/** Fire and forget: stdio ignored, missing binary and nonzero exits swallowed. */
	run(args: string[]): Promise<void>;
	/**
	 * Blocking stdout capture; `undefined` when tmux is missing or exits nonzero.
	 *
	 * Blocking on purpose: the original window name must be known the instant the
	 * first rename is issued, so a restore triggered from any exit path — including
	 * a signal handler, which cannot await — always has a target. See
	 * {@link TmuxWindowNamer.restore}.
	 */
	captureSync(args: string[]): string | undefined;
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
	captureSync(args) {
		try {
			const proc = Bun.spawnSync(["tmux", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
			return proc.exitCode === 0 ? proc.stdout.toString() : undefined;
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

/**
 * Strip anything that would corrupt a window name: control characters (terminal
 * escape injection) and runs of whitespace. `.` and `:` survive — they are tmux
 * *target* separators, and nothing here ever passes the display name as a `-t`
 * target, so mangling `feat: parser` into `feat parser` would break the session
 * name sync for no gain.
 */
export function sanitizeTmuxWindowName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value
		.replace(TMUX_NAME_CONTROL_CHARS, "")
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

/**
 * Owns the tmux window name for exactly one session.
 *
 * Instance-scoped rather than module-global: embedding hosts and test harnesses
 * run several `InteractiveMode`s in one process, and a shared runtime would let
 * one session's restore clear the other's captured window name (or rename the
 * other's window). Each mode constructs one namer and {@link restore}s it.
 */
export class TmuxWindowNamer {
	readonly #runner: TmuxCommandRunner;
	#enabled = false;
	/** Last name handed to tmux, so a repeated rename is a no-op. */
	#lastName?: string;
	/** `undefined` = not captured yet, `null` = capture failed, so skip restore. */
	#original?: CapturedWindow | null;
	/** Serializes the fire-and-forget renames so they land in call order. */
	#queue: Promise<void> = Promise.resolve();
	/** Set by {@link restore}: the window is back to its original name, stay off it. */
	#restored = false;
	#cancelCleanup?: () => void;

	/** `runner` is the test seam; production always uses the real `tmux` binary. */
	constructor(runner: TmuxCommandRunner = defaultRunner) {
		this.#runner = runner;
	}

	/** Enable/disable window renaming (driven by the `tui.tmuxWindowName` setting). */
	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	/** Await every tmux call queued so far. Test-only; production paths never block. */
	drain(): Promise<void> {
		return this.#queue;
	}

	/**
	 * Rename the enclosing tmux window to the session name. The rename itself is
	 * fire and forget, so the caller is never blocked and never sees a tmux
	 * failure; only the one-time capture of the pre-omp window name is blocking.
	 *
	 * An explicit `rename-window` also clears the window's `automatic-rename`, so
	 * the name sticks until {@link restore} puts the original back.
	 */
	sync(sessionName: string | undefined, cwd?: string): void {
		if (!this.#enabled || this.#restored || !isInsideTmux()) return;
		const pane = Bun.env.TMUX_PANE;
		if (!pane) return;
		const next = sanitizeTmuxWindowName(sessionName) ?? getFallbackTmuxWindowName(cwd);
		if (!next || next === this.#lastName) return;
		this.#lastName = next;
		this.#captureOriginal(pane);
		// `--` stops tmux's option scan, which otherwise continues past `-t` and
		// rejects a session name like `-debug` as an unknown flag.
		this.#enqueue(["rename-window", "-t", pane, "--", next]);
	}

	/**
	 * Put the pre-omp window name and `automatic-rename` back.
	 *
	 * Synchronous on purpose: every caller exits the process immediately
	 * afterwards, and an enqueued async spawn never runs, which would leave the
	 * window stuck on the omp session name with `automatic-rename` disabled.
	 * Idempotent, because the owning mode's `shutdown()` and the postmortem
	 * cleanup registered on the first rename can both reach it.
	 */
	restore(): void {
		if (this.#restored) return;
		this.#restored = true;
		this.#cancelCleanup?.();
		this.#cancelCleanup = undefined;
		const original = this.#original;
		this.#lastName = undefined;
		this.#original = undefined;
		const pane = Bun.env.TMUX_PANE;
		if (!pane || !original) return;
		this.#runner.runSync(["rename-window", "-t", pane, "--", original.name]);
		// rename-window forces automatic-rename off, so reinstate it afterwards.
		this.#runner.runSync(["set-window-option", "-t", pane, "automatic-rename", original.automaticRename]);
	}

	/**
	 * Capture the pre-omp window name before the first rename is queued.
	 *
	 * Blocking (once per session, a single `tmux display-message`) so `#original`
	 * is populated the moment a rename becomes possible. Capturing through the
	 * async queue instead would let a shutdown that starts mid-capture find
	 * `#original` still unset, skip the restore, and then have the queued rename
	 * run *after* it — leaving the window renamed with `automatic-rename` off.
	 */
	#captureOriginal(pane: string): void {
		if (this.#original !== undefined) return;
		const output = this.#runner.captureSync([
			"display-message",
			"-p",
			"-t",
			pane,
			"#{window_name}\t#{automatic-rename}",
		]);
		const [name, automaticRename] = output?.trim().split("\t") ?? [];
		// No capture means no safe restore target: skip restore rather than guess.
		this.#original = name ? { name, automaticRename: automaticRename === "1" ? "on" : "off" } : null;
		if (!this.#original) return;
		// `InteractiveMode.shutdown()` is not reached on SIGINT/SIGTERM/SIGHUP or a
		// fatal error — postmortem runs its callbacks and exits. Register here so an
		// SSH disconnect or `kill` restores the window too.
		this.#cancelCleanup = postmortem.register("tmux-window-name", () => this.restore());
	}

	/** Chain onto the tmux queue; a rejection never escapes into the caller's turn. */
	#enqueue(args: string[]): void {
		this.#queue = this.#queue
			.then(async () => {
				// A restore may have landed while this rename sat in the queue; running
				// it now would re-apply the omp name over the window we just restored.
				if (this.#restored) return;
				await this.#runner.run(args);
			})
			.catch(() => {});
	}
}
