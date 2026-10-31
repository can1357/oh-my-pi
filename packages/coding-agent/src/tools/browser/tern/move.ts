/**
 * Place a Tern block where a `/fork` wants it: a tab of its own (`tern move BLOCK new-tab`) and
 * that tab in front (`tern focus BLOCK`).
 *
 * The daemon protocol lists `browser` and `fork` and no move, and the script
 * commands that could move a block are reachable only through a window's
 * control endpoint, which a user's own window does not open. The CLI reaches
 * the same daemon, so a fork that must land in a tab rather than beside the
 * pane it forked goes through it. The keyword is `new-tab` alone: `move BLOCK
 * tab N` takes a tab number and rejects `new-tab` in that position.
 *
 * A `new-tab` move leaves the original tab selected, so a fork nobody asked to
 * bring forward would land where the user cannot see it; `focus` selects the
 * tab holding the block, which is the fork.
 */

/** Give up after this long: a move or a focus is one layout command to a live daemon. */
const TERN_LAYOUT_TIMEOUT_MS = 5_000;

/** How far back a failed command's stderr is kept for the message. */
const STDERR_TAIL = 300;

export interface TernMoveOptions {
	/** The `tern` to run; default `$TERN_EXE` (Tern exports it into every pane), else `tern` on PATH. */
	executable?: string;
	/** Give up after this long (default 5 s). */
	timeoutMs?: number;
}

/** Runs one `tern` layout command to completion; a non-zero exit or a timeout throws with its output. */
async function runTernLayoutCommand(args: readonly string[], options: TernMoveOptions): Promise<void> {
	const executable = options.executable ?? (process.env.TERN_EXE?.trim() || "tern");
	const command = `${executable} ${args.join(" ")}`;
	const proc = Bun.spawn([executable, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, options.timeoutMs ?? TERN_LAYOUT_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	clearTimeout(timeout);
	if (timedOut) throw new Error(`${command} timed out`);
	if (exitCode !== 0) {
		const detail = stderr.trim() || stdout.trim();
		throw new Error(`${command} exited with code ${exitCode}${detail ? `: ${detail.slice(-STDERR_TAIL)}` : ""}`);
	}
}

/** Moves `block` into a new tab of the session and window it currently lives in. */
export async function moveTernBlockToNewTab(block: number, options: TernMoveOptions = {}): Promise<void> {
	await runTernLayoutCommand(["move", String(block), "new-tab"], options);
}

/** Brings `block` to the front: its tab becomes the session's selected tab. */
export async function focusTernBlock(block: number, options: TernMoveOptions = {}): Promise<void> {
	await runTernLayoutCommand(["focus", String(block)], options);
}
