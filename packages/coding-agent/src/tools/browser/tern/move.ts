/**
 * Move a Tern block into a tab of its own (`tern move BLOCK tab new-tab`).
 *
 * The daemon protocol lists `browser` and `fork` and no move, and the script
 * commands that could move a block are reachable only through a window's
 * control endpoint, which a user's own window does not open. The CLI reaches
 * the same daemon, so a fork that must land in a tab rather than beside the
 * pane it forked goes through it.
 */

/** Give up after this long: a move is one layout command to a live daemon. */
const MOVE_TIMEOUT_MS = 5_000;

/** How far back a failed move's stderr is kept for the message. */
const STDERR_TAIL = 300;

export interface TernMoveOptions {
	/** The `tern` to run; default `$TERN_EXE` (Tern exports it into every pane), else `tern` on PATH. */
	executable?: string;
	/** Give up after this long (default 5 s). */
	timeoutMs?: number;
}

/** Moves `block` into a new tab of the session and window it currently lives in. */
export async function moveTernBlockToNewTab(block: number, options: TernMoveOptions = {}): Promise<void> {
	const executable = options.executable ?? (process.env.TERN_EXE?.trim() || "tern");
	const proc = Bun.spawn([executable, "move", String(block), "tab", "new-tab"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, options.timeoutMs ?? MOVE_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	clearTimeout(timeout);
	if (timedOut) throw new Error(`${executable} move BLOCK tab new-tab timed out`);
	if (exitCode !== 0) {
		const detail = stderr.trim() || stdout.trim();
		throw new Error(
			`${executable} move BLOCK tab new-tab exited with code ${exitCode}${detail ? `: ${detail.slice(-STDERR_TAIL)}` : ""}`,
		);
	}
}
