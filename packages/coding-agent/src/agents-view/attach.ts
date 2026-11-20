/**
 * Attach client: this terminal becomes the viewer of a hosted session. Raw stdin goes
 * into the unit's PTY, PTY output comes back to stdout, resizes follow SIGWINCH, and
 * the hosted TUI is told who the viewer is (attach APC) so it repaints for it.
 */
import { TtyWriter } from "@oh-my-pi/pi-natives";
import { postmortem } from "@oh-my-pi/pi-utils";
import { DaemonRejectedError, daemonClient } from "../daemon/client";
import type { DaemonClient, UnitRef } from "../daemon/protocol";
import { agentUnitRef } from "./host";
import { DetachMarkerMatcher, encodeAttachMarker, isAttachToken, viewerIdentityFromEnv } from "./markers";
import { listAgentSessions } from "./status";

/** How an attach ended: the hosted TUI detached, its process exited, or the tunnel dropped. */
export type AttachResult = "detached" | "exited" | "disconnected";

/** Output queued for the terminal beyond this disconnects: the viewer cannot keep up with the session. */
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How long a dropped tunnel waits for the unit to report its exit before counting as a disconnect. */
const EXIT_CONFIRM_MS = 1000;
/** How long the hosted output still queued at the end may take to reach the terminal. */
const OUTPUT_FLUSH_MS = 1000;
/** How long a session that is still starting may take to publish its attach token. */
const TOKEN_WAIT_MS = 30_000;
const TOKEN_POLL_MS = 250;

/**
 * Terminal state the hosted TUI could not hand back itself (it ran no teardown for this
 * viewer): synchronized output off, attributes reset, cursor shown, main screen, mouse
 * reporting and bracketed paste off, one Kitty keyboard level popped, modifyOtherKeys
 * off, normal cursor keys and keypad.
 */
const SAFE_TERMINAL_RESET =
	"\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?1l\x1b>";

function terminalSize(): { cols: number; rows: number } {
	return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

/** Why the tunnel closed: the unit's process ended, or the connection alone dropped. */
async function classifyClose(client: DaemonClient, unit: UnitRef): Promise<AttachResult> {
	try {
		const { unit: snapshot } = await client.request({ op: "wait", unit, for: "exit", timeoutMs: EXIT_CONFIRM_MS });
		return snapshot.state === "exited" || snapshot.state === "failed" ? "exited" : "disconnected";
	} catch (error) {
		// The unit left the board: its process is gone.
		return error instanceof DaemonRejectedError ? "exited" : "disconnected";
	}
}

/**
 * The attach token hosted session `key` published in its status record, waiting while
 * the session is still starting. Undefined when the session is gone.
 */
async function sessionAttachToken(key: string): Promise<string | undefined> {
	const deadline = Date.now() + TOKEN_WAIT_MS;
	for (;;) {
		const row = (await listAgentSessions()).find(candidate => candidate.hostKey === key);
		if (!row) return undefined;
		if (row.attachToken && isAttachToken(row.attachToken)) return row.attachToken;
		if (Date.now() >= deadline) throw new Error("The background session did not finish starting.");
		await Bun.sleep(TOKEN_POLL_MS);
	}
}

/**
 * Ordered terminal output that never blocks the event loop: on a TTY the bytes go
 * through a native writer thread (Bun's TTY `stdout.write` blocks until the emulator
 * drains), elsewhere through stdout's own queue.
 */
class ViewerOutput {
	readonly #pump: TtyWriter | undefined;
	readonly #decoder = new TextDecoder();
	#retired = false;

	constructor(onFailure: () => void) {
		let pump: TtyWriter | undefined;
		if (process.stdout.isTTY) {
			try {
				pump = new TtyWriter(1, MAX_PENDING_OUTPUT_BYTES, () => {
					if (!this.#retired && pump?.dead) onFailure();
				});
			} catch {
				// No writer thread on this platform: stdout's queue is what is left.
			}
		}
		this.#pump = pump;
	}

	/** Queue `bytes`; returns the bytes not yet written. */
	write(bytes: Uint8Array): number {
		const pump = this.#pump;
		if (!pump) {
			process.stdout.write(bytes);
			return process.stdout.writableLength;
		}
		// The writer takes text: decode as a stream so a split UTF-8 sequence survives.
		return pump.write(this.#decoder.decode(bytes, { stream: true }));
	}

	/** Stop writing: `flushMs` bounds how long queued output may still take; 0 drops it. */
	retire(flushMs: number): void {
		if (this.#retired) return;
		this.#retired = true;
		const pump = this.#pump;
		if (!pump) return;
		const tail = this.#decoder.decode();
		if (tail && flushMs > 0) pump.write(tail);
		pump.stop(flushMs);
	}
}

/**
 * View hosted session `key` in this terminal until it detaches, exits, or the tunnel
 * drops. Raw mode is always restored on return; non-detached returns also reset the
 * terminal modes the hosted TUI could not reset for this viewer.
 */
export async function attachHosted(key: string): Promise<AttachResult> {
	const token = await sessionAttachToken(key);
	if (!token) return "exited";
	const client = await daemonClient();
	const unit = agentUnitRef(key);
	const tunnel = await client.attach(unit);
	const stdin = process.stdin;
	const wasRaw = stdin.isTTY ? stdin.isRaw : false;
	const matcher = new DetachMarkerMatcher(token);
	const { promise, resolve } = Promise.withResolvers<AttachResult>();
	let settled = false;
	let closing = false;
	/** The viewer fell behind: queued output is dropped instead of drained. */
	let overrun = false;
	let notice: string | undefined;

	const restore = (result: AttachResult): void => {
		stdin.removeListener("data", onInput);
		stdin.removeListener("end", onInputEnd);
		process.removeListener("SIGWINCH", onResize);
		cancelCleanup();
		stdin.pause();
		try {
			if (stdin.isTTY) stdin.setRawMode(wasRaw);
		} catch {
			// A revoked terminal has no mode left to restore.
		}
		tunnel.close();
		output.retire(overrun ? 0 : OUTPUT_FLUSH_MS);
		let tail = result === "detached" ? "" : SAFE_TERMINAL_RESET;
		if (notice) tail += `\r\n${notice}\r\n`;
		// Small, after the writer is gone: the next screen owner starts from a known state.
		if (tail) process.stdout.write(tail);
	};
	const finish = (result: AttachResult): void => {
		if (settled) return;
		settled = true;
		restore(result);
		resolve(result);
	};
	const output = new ViewerOutput(() => finish("disconnected"));
	const onInput = (chunk: string | Buffer): void => {
		if (settled) return;
		if (tunnel.send(chunk)) return;
		stdin.pause();
		void tunnel.drained().then(() => {
			if (!settled) stdin.resume();
		});
	};
	const onInputEnd = (): void => finish("disconnected");
	const onResize = (): void => {
		const { cols, rows } = terminalSize();
		client.resize(unit, cols, rows).catch(() => undefined);
	};
	// A hangup or termination exits through postmortem; hand the terminal back first.
	const cancelCleanup = postmortem.register("agents-attach", () => finish("disconnected"));

	// Output is written in arrival order; once this session's detach marker shows, the
	// bytes after it are dropped and stdin stops reaching the session (finish removes
	// the listener synchronously). A viewer that lets the queue grow past the bound is
	// dropped instead of buffering the session without limit.
	tunnel.start(
		chunk => {
			if (settled || closing) return;
			const { output: bytes, detached } = matcher.feed(chunk);
			const pending = bytes.length > 0 ? output.write(bytes) : 0;
			if (detached) {
				finish("detached");
				return;
			}
			if (pending > MAX_PENDING_OUTPUT_BYTES) {
				overrun = true;
				notice = "Detached: this terminal could not keep up with the session output.";
				finish("disconnected");
			}
		},
		() => {
			if (settled || closing) return;
			closing = true;
			void classifyClose(client, unit).then(finish);
		},
	);

	try {
		if (stdin.isTTY) stdin.setRawMode(true);
		const { cols, rows } = terminalSize();
		await client.resize(unit, cols, rows);
		if (!settled) tunnel.send(encodeAttachMarker(token, viewerIdentityFromEnv(process.env, cols, rows)));
	} catch (error) {
		finish("disconnected");
		throw error;
	}
	if (!settled) {
		stdin.on("data", onInput);
		stdin.on("end", onInputEnd);
		process.on("SIGWINCH", onResize);
		stdin.resume();
	}
	return promise;
}
