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
import * as fs from "node:fs";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { startParentWatchdog } from "../../subprocess/parent-watchdog";

const FRAME_PREFIX = "\x1eomp-js-eval:";

/**
 * Cap on the frame line still open after each chunk, either direction, so a reader holds at most
 * this plus one chunk. A frame is one message's structured clone in base64 (4/3 of the clone,
 * whose strings may take two bytes per character), so this leaves room for large cell output; a
 * peer exceeding it is broken (or hostile) and its channel is dropped.
 */
export const MAX_STDIO_FRAME_BYTES = 128 * 1024 * 1024;

/** Encode one message as a frame line. Throws (DataCloneError) when the value is not cloneable. */
export function encodeStdioFrame(message: unknown): string {
	return `${FRAME_PREFIX}${serialize(message, { binaryType: "nodebuffer" }).toString("base64")}\n`;
}

/**
 * The lines of a frame stream. Throws (`LineTooLongError`) on any line longer than
 * {@link MAX_STDIO_FRAME_BYTES}, terminated or not, so the reader's memory stays bounded.
 */
export function readStdioLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	return readLines(stream, undefined, { maxLineBytes: MAX_STDIO_FRAME_BYTES });
}

const lineDecoder = new TextDecoder();

/**
 * Decode one line of {@link readStdioLines}: the message of its frame goes to `onFrame`, text that
 * is no frame (or is glued in front of one) to `onNoise`. Throws when the frame does not decode.
 */
export function decodeStdioLine(
	bytes: Uint8Array,
	onFrame: (message: unknown) => void,
	onNoise: (text: string) => void,
): void {
	const line = lineDecoder.decode(bytes);
	const at = line.indexOf(FRAME_PREFIX);
	if (at === -1) {
		if (line.length > 0) onNoise(line);
		return;
	}
	if (at > 0) onNoise(line.slice(0, at));
	onFrame(deserialize(Buffer.from(line.slice(at + FRAME_PREFIX.length), "base64")));
}

/**
 * Child side. With an IPC channel from the parent (the unsandboxed Windows evaluator, and the
 * evaluator a relay starts, see below) this is the evaluator: it takes messages from IPC and
 * answers `start`'s transport in stdout frames. Its stdin is not a protocol channel, so cell code
 * and the children it spawns (`stdin: "inherit"`, `Bun.$`, `prompt()`) never read (and swallow)
 * protocol traffic. It serves until IPC disconnects (the parent ended it or died), then hard-exits
 * like the IPC worker runner. A non-cloneable outbound message throws to the sender so that cell
 * fails instead of the whole evaluator; a broken stdout means the parent is gone and shuts down.
 *
 * Without IPC (inside the sandbox, where it cannot cross) this process is only a relay: it starts
 * the evaluator as its own child, still contained, over IPC with stdin closed and stdout/stderr
 * inherited, so frames still go straight to the parent's pipe, and forwards the parent's stdin
 * frames to it. No rendezvous point exists that another contained process could reach. It exits
 * with the evaluator, and kills it once stdin ends; a failed start is reported on stderr and exits
 * non-zero, which fails the parent's startup.
 *
 * Frames go through a dedicated `Bun.stdout` writer, not `process.stdout`: the evaluator captures
 * `process.stdout`/`console` output as cell text, which would feed every frame back into itself.
 */
export async function runStdioSubprocessWorker<In, Out>(
	start: (transport: { send(message: Out): void; onMessage(handler: (message: In) => void): () => void }) => void,
): Promise<void> {
	// Like the IPC runner: never outlive the parent, even while a cell pins the main thread.
	if (process.ppid > 0) startParentWatchdog(process.ppid);
	if (typeof process.send !== "function") {
		await relayStdinToEvaluator();
		return;
	}
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
	const disconnected = Promise.withResolvers<void>();
	process.on("message", (message: unknown) => {
		for (const handler of handlers) handler(message as In);
	});
	process.on("disconnect", disconnected.resolve);
	const keepalive = setInterval(() => {}, 2 ** 30);
	try {
		await disconnected.promise;
	} finally {
		clearInterval(keepalive);
		shutdown();
	}
}

/** The relay of {@link runStdioSubprocessWorker}: re-enters this entry as the evaluator, over IPC. */
async function relayStdinToEvaluator(): Promise<void> {
	// `argv[1]` is the entry script, or the embedded `/$bunfs` path of a compiled binary, which
	// re-enters by itself.
	const cmd = isCompiledBinary()
		? [process.execPath, ...process.argv.slice(2)]
		: [process.execPath, ...process.argv.slice(1)];
	let evaluator: Bun.Subprocess;
	try {
		evaluator = Bun.spawn({
			cmd,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			serialization: "advanced",
			windowsHide: true,
			// Outbound only: the evaluator answers on stdout. Bun opens the channel only with a handler.
			ipc() {},
		});
	} catch (error) {
		process.stderr.write(
			`JS eval relay could not start the contained evaluator: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	}
	void evaluator.exited.then(code => process.exit(code));
	const deliver = (message: unknown): void => {
		evaluator.send(message);
	};
	try {
		for await (const line of readStdioLines(Bun.stdin.stream())) decodeStdioLine(line, deliver, () => {});
	} catch (error) {
		// Synchronous: the SIGKILL below would drop a queued stderr write.
		fs.writeSync(
			2,
			`JS eval relay dropped the host channel: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	} finally {
		// The parent ended the channel, died, or sent something that is no frame: end the evaluator.
		evaluator.kill("SIGKILL");
		process.kill(process.pid, "SIGKILL");
	}
}
