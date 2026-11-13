/**
 * Stdio-framed transport for the JS eval subprocess inside the OS sandbox, and for its outbound
 * direction on Windows hosts (see `runStdioSubprocessWorker`).
 *
 * Bun's subprocess `ipc` channel is an extra inherited descriptor, which a sandboxed process does
 * not receive: only stdin/stdout/stderr cross the container boundary. The contained evaluator
 * therefore exchanges the same structured-clone payloads as the `advanced` IPC serialization
 * (`bun:jsc` `serialize`), one per line, base64-encoded behind a sentinel. Anything else written to
 * stdout (stray output from cell code or its children) is not a frame and is skipped, so it cannot
 * corrupt the protocol unless it lands in the middle of a frame line.
 *
 * Kept free of evaluator imports: the CLI selector loads it synchronously in the child, and the
 * parent's context manager uses the codec.
 */
import { deserialize, serialize } from "bun:jsc";
import { startParentWatchdog } from "../../subprocess/parent-watchdog";

const FRAME_PREFIX = "\x1eomp-js-eval:";

/** Encode one message as a frame line. Throws (DataCloneError) when the value is not cloneable. */
export function encodeStdioFrame(message: unknown): string {
	return `${FRAME_PREFIX}${serialize(message, { binaryType: "nodebuffer" }).toString("base64")}\n`;
}

/** Incremental frame-line decoder over a byte stream. */
export class StdioFrameDecoder {
	readonly #decoder = new TextDecoder();
	readonly #onFrame: (message: unknown) => void;
	readonly #onNoise: (text: string) => void;
	#pending = "";

	constructor(onFrame: (message: unknown) => void, onNoise: (text: string) => void) {
		this.#onFrame = onFrame;
		this.#onNoise = onNoise;
	}

	/** Feed a chunk; throws when a frame line does not decode. */
	push(chunk: Uint8Array): void {
		// Search only the new bytes for line ends so a large frame arriving in many chunks stays linear.
		let from = this.#pending.length;
		this.#pending += this.#decoder.decode(chunk, { stream: true });
		let start = 0;
		let newline = this.#pending.indexOf("\n", from);
		while (newline !== -1) {
			const line = this.#pending.slice(start, newline);
			start = newline + 1;
			from = start;
			this.#line(line);
			newline = this.#pending.indexOf("\n", from);
		}
		if (start > 0) this.#pending = this.#pending.slice(start);
	}

	#line(line: string): void {
		const at = line.indexOf(FRAME_PREFIX);
		if (at === -1) {
			if (line.length > 0) this.#onNoise(line);
			return;
		}
		if (at > 0) this.#onNoise(line.slice(0, at));
		this.#onFrame(deserialize(Buffer.from(line.slice(at + FRAME_PREFIX.length), "base64")));
	}
}

/**
 * Child side: answer `start`'s transport in stdout frames and take messages from the parent's IPC
 * channel when it opened one (the unsandboxed Windows evaluator, whose stdin stays closed so cell
 * code cannot consume protocol traffic), else from stdin frames (inside the sandbox, where IPC
 * cannot cross). Serves until that inbound channel closes (the parent ended it or died), then
 * hard-exits like the IPC worker runner. A non-cloneable outbound message throws to the sender so
 * that cell fails instead of the whole evaluator; a broken stdout means the parent is gone and
 * shuts down.
 *
 * Frames go through a dedicated `Bun.stdout` writer, not `process.stdout`: the evaluator captures
 * `process.stdout`/`console` output as cell text, which would feed every frame back into itself.
 */
export async function runStdioSubprocessWorker<In, Out>(
	start: (transport: { send(message: Out): void; onMessage(handler: (message: In) => void): () => void }) => void,
): Promise<void> {
	const handlers = new Set<(message: In) => void>();
	const out = Bun.stdout.writer();
	let closed = false;
	const shutdown = (): void => {
		closed = true;
		process.kill(process.pid, "SIGKILL");
	};
	start({
		send(message) {
			if (closed) return;
			const frame = encodeStdioFrame(message);
			try {
				out.write(frame);
				const flushed = out.flush();
				if (flushed instanceof Promise) flushed.catch(shutdown);
			} catch {
				shutdown();
			}
		},
		onMessage(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
	});
	const deliver = (message: unknown): void => {
		for (const handler of handlers) handler(message as In);
	};
	// Like the IPC runner: never outlive the parent, even while a cell pins the main thread.
	if (process.ppid > 0) startParentWatchdog(process.ppid);
	if (typeof process.send === "function") {
		const disconnected = Promise.withResolvers<void>();
		process.on("message", deliver);
		process.on("disconnect", disconnected.resolve);
		const keepalive = setInterval(() => {}, 2 ** 30);
		try {
			await disconnected.promise;
		} finally {
			clearInterval(keepalive);
			shutdown();
		}
		return;
	}
	const decoder = new StdioFrameDecoder(deliver, () => {});
	try {
		for await (const chunk of Bun.stdin.stream()) decoder.push(chunk);
	} finally {
		shutdown();
	}
}
