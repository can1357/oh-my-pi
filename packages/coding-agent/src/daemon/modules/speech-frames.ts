/**
 * Binary frame protocol of the speech (STT/TTS) workers, used on both hops:
 * client tunnel <-> daemon `speech` module <-> worker stdin/stdout.
 *
 * Frame: `u32le length | u8 type | body`, where `length` counts the type byte
 * and the body.
 * - type 0 ({@link FRAME_JSON}): body is one UTF-8 JSON message.
 * - type 1 ({@link FRAME_PCM}): body is `u32le headerLength | header JSON | f32le samples`.
 *   The header names the message field the samples belong to in `$pcm`.
 *
 * Samples are always little-endian on the wire: copied through a `DataView` on
 * a big-endian host, passed through as-is on a little-endian one.
 */
import { startParentWatchdog } from "../../subprocess/parent-watchdog";
import type { WorkerSpawnCommand } from "../../subprocess/worker-client";

export const FRAME_JSON = 0;
export const FRAME_PCM = 1;

/** Unit kind of the daemon speech module. */
export const SPEECH_MODULE_KIND = "speech";

/** Header field naming the message property carried as the PCM payload. */
const PCM_FIELD = "$pcm";
const FRAME_PREFIX_BYTES = 5;
/** Bound on one frame; a larger length prefix means a desynchronized or corrupt stream. */
const MAX_FRAME_BYTES = 512 * 1024 * 1024;
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Launch parameters of a `speech` unit, from the opening client. */
export interface SpeechUnitParams {
	/** `resolveWorkerSpawnCmd(STT_WORKER_ARG | TTS_WORKER_ARG).cmd`. */
	command: string[];
	cwd: string;
	/** Complete worker environment (`tinyWorkerEnv()`). */
	env: Record<string, string>;
}

/** Which speech worker a unit runs. */
export type SpeechFlavor = "stt" | "tts";

/** Unit key: the worker flavor plus the effective tiny-model device/dtype it was started under. */
export function speechUnitKey(flavor: SpeechFlavor, env: Record<string, string>): string {
	return `${flavor}:${env.PI_TINY_DEVICE || "auto"}:${env.PI_TINY_DTYPE || "auto"}`;
}

/** Build {@link SpeechUnitParams} from a worker spawn command and env; `fallbackCwd` when the command has none. */
export function speechUnitParams(
	command: WorkerSpawnCommand,
	env: Record<string, string>,
	fallbackCwd: string,
): SpeechUnitParams {
	return { command: command.cmd, cwd: command.cwd ?? fallbackCwd, env };
}

/** One decoded frame: the JSON header and, for {@link FRAME_PCM}, the raw sample bytes. */
export interface SpeechFrame {
	header: Record<string, unknown>;
	payload?: Uint8Array;
}

/** Encode one frame; `payload` present selects {@link FRAME_PCM}. */
export function encodeFrame(header: object, payload?: Uint8Array): Uint8Array {
	const json = textEncoder.encode(JSON.stringify(header));
	if (!payload) {
		const frame = new Uint8Array(FRAME_PREFIX_BYTES + json.length);
		const view = new DataView(frame.buffer);
		view.setUint32(0, 1 + json.length, true);
		frame[4] = FRAME_JSON;
		frame.set(json, FRAME_PREFIX_BYTES);
		return frame;
	}
	const frame = new Uint8Array(FRAME_PREFIX_BYTES + 4 + json.length + payload.length);
	const view = new DataView(frame.buffer);
	view.setUint32(0, 1 + 4 + json.length + payload.length, true);
	frame[4] = FRAME_PCM;
	view.setUint32(FRAME_PREFIX_BYTES, json.length, true);
	frame.set(json, FRAME_PREFIX_BYTES + 4);
	frame.set(payload, FRAME_PREFIX_BYTES + 4 + json.length);
	return frame;
}

/** Encode a protocol message; its (single) `Float32Array` field travels as the PCM payload. */
export function encodeMessage(message: object): Uint8Array {
	const fields = message as Record<string, unknown>;
	for (const field in fields) {
		const value = fields[field];
		if (!(value instanceof Float32Array)) continue;
		const header: Record<string, unknown> = { ...fields, [PCM_FIELD]: field };
		delete header[field];
		return encodeFrame(header, samplesToLittleEndian(value));
	}
	return encodeFrame(message);
}

/** Rebuild the protocol message of a frame, restoring its `Float32Array` field. */
export function decodeMessage<T>(frame: SpeechFrame): T {
	const message: Record<string, unknown> = { ...frame.header };
	const field = message[PCM_FIELD];
	delete message[PCM_FIELD];
	if (frame.payload && typeof field === "string") message[field] = samplesFromLittleEndian(frame.payload);
	return message as T;
}

/** f32le bytes of `samples`; a view of them on little-endian hosts. */
function samplesToLittleEndian(samples: Float32Array): Uint8Array {
	if (HOST_LITTLE_ENDIAN) return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
	const bytes = new Uint8Array(samples.byteLength);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i]!, true);
	return bytes;
}

/** Samples of f32le `bytes` (a trailing partial sample is dropped). */
function samplesFromLittleEndian(bytes: Uint8Array): Float32Array {
	const count = Math.floor(bytes.byteLength / 4);
	if (HOST_LITTLE_ENDIAN) {
		const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
		return new Float32Array(aligned.buffer, aligned.byteOffset, count);
	}
	const samples = new Float32Array(count);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = 0; i < count; i++) samples[i] = view.getFloat32(i * 4, true);
	return samples;
}

/** Incremental frame parser over an arbitrary chunking of the byte stream. */
export class FrameDecoder {
	#buffer = new Uint8Array(64 * 1024);
	#length = 0;

	/** Append `chunk` and emit every complete frame; throws on a malformed frame. */
	push(chunk: Uint8Array, onFrame: (frame: SpeechFrame) => void): void {
		this.#append(chunk);
		let offset = 0;
		const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#length);
		while (this.#length - offset >= 4) {
			const size = view.getUint32(offset, true);
			if (size < 1) throw new Error("speech frame: empty frame");
			if (size > MAX_FRAME_BYTES) throw new Error(`speech frame: ${size} bytes exceeds the frame limit`);
			if (this.#length - offset - 4 < size) break;
			const type = this.#buffer[offset + 4];
			const body = this.#buffer.subarray(offset + FRAME_PREFIX_BYTES, offset + 4 + size);
			offset += 4 + size;
			onFrame(parseBody(type, body));
		}
		if (offset > 0) {
			this.#buffer.copyWithin(0, offset, this.#length);
			this.#length -= offset;
		}
	}

	#append(chunk: Uint8Array): void {
		const needed = this.#length + chunk.length;
		if (needed > this.#buffer.length) {
			const grown = new Uint8Array(Math.max(needed, this.#buffer.length * 2));
			grown.set(this.#buffer.subarray(0, this.#length));
			this.#buffer = grown;
		}
		this.#buffer.set(chunk, this.#length);
		this.#length = needed;
	}
}

function parseBody(type: number | undefined, body: Uint8Array): SpeechFrame {
	if (type === FRAME_JSON) return { header: parseHeader(body) };
	if (type !== FRAME_PCM) throw new Error(`speech frame: unknown type ${type}`);
	if (body.length < 4) throw new Error("speech frame: truncated PCM header");
	const headerLength = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
	if (4 + headerLength > body.length) throw new Error("speech frame: PCM header overruns frame");
	// Copy the samples out: the decoder's buffer is reused for later frames.
	return { header: parseHeader(body.subarray(4, 4 + headerLength)), payload: body.slice(4 + headerLength) };
}

function parseHeader(bytes: Uint8Array): Record<string, unknown> {
	const value: unknown = JSON.parse(textDecoder.decode(bytes));
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("speech frame: header is not an object");
	}
	return value as Record<string, unknown>;
}

/** Byte sink with write backpressure (tunnels, managed-child stdin, worker stdout). */
export interface FrameSink {
	/** False once the sink's buffer is full; the data is still accepted. */
	send(data: Uint8Array): boolean;
	drained(): Promise<void>;
}

/**
 * Ordered writer that honors {@link FrameSink} backpressure: after a `send`
 * returns false, later frames queue until `drained()` resolves.
 */
export class FrameWriter {
	#sink: FrameSink;
	#queue: Uint8Array[] = [];
	#blocked = false;
	#closed = false;
	#unblocked: PromiseWithResolvers<void> | undefined;

	constructor(sink: FrameSink) {
		this.#sink = sink;
	}

	write(frame: Uint8Array): void {
		if (this.#closed) return;
		if (this.#blocked) {
			this.#queue.push(frame);
			return;
		}
		if (!this.#sink.send(frame)) this.#block();
	}

	/** Resolves once nothing is queued and the sink accepted everything without backpressure. */
	flushed(): Promise<void> {
		if (!this.#blocked || this.#closed) return Promise.resolve();
		this.#unblocked ??= Promise.withResolvers<void>();
		return this.#unblocked.promise;
	}

	close(): void {
		this.#closed = true;
		this.#queue.length = 0;
		this.#release();
	}

	#block(): void {
		this.#blocked = true;
		void this.#pump();
	}

	async #pump(): Promise<void> {
		while (this.#blocked && !this.#closed) {
			try {
				await this.#sink.drained();
			} catch {
				this.close();
				return;
			}
			if (this.#closed) return;
			this.#blocked = false;
			while (this.#queue.length > 0) {
				const frame = this.#queue.shift()!;
				if (!this.#sink.send(frame)) {
					this.#blocked = true;
					break;
				}
			}
		}
		this.#release();
	}

	#release(): void {
		const unblocked = this.#unblocked;
		this.#unblocked = undefined;
		unblocked?.resolve();
	}
}

/** Worker transport the STT/TTS worker bodies are written against. */
export interface FramedWorkerTransport<In, Out> {
	send(message: Out): void;
	/** Send and resolve once the frame left the stdout buffer. */
	sendAndFlush(message: Out): Promise<void>;
	onMessage(handler: (message: In) => void): () => void;
}

/** Private handle on a daemon worker child's stdout protocol channel. */
export interface WorkerStdout {
	/** False once the stream buffers; the data is still accepted. */
	write(data: string | Uint8Array): boolean;
	/** Resolves on the next `drain`. */
	drained(): Promise<void>;
	/** Resolves once the stream no longer buffers beyond its high-water mark. */
	flush(): Promise<void>;
}

/**
 * Reserve stdout for the worker protocol of a daemon child (infer and speech
 * workers): `console.log`/`info`/`debug` and every later
 * `process.stdout.write` — library chatter, progress bars — go to stderr,
 * which the daemon only logs. Call once, before loading any library.
 */
export function claimWorkerStdout(): WorkerStdout {
	const stdout = process.stdout;
	const stderr = process.stderr;
	const write = stdout.write.bind(stdout);
	const toStderr = (...args: unknown[]): void => {
		stderr.write(`${args.map(arg => (typeof arg === "string" ? arg : Bun.inspect(arg))).join(" ")}\n`);
	};
	console.log = toStderr;
	console.info = toStderr;
	console.debug = toStderr;
	stdout.write = (...args: unknown[]): boolean => {
		const [chunk] = args;
		const done = args.at(-1);
		const data = typeof chunk === "string" || chunk instanceof Uint8Array ? chunk : String(chunk);
		return stderr.write(data, typeof done === "function" ? () => done() : undefined);
	};
	const drained = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		stdout.once("drain", () => resolve());
		return promise;
	};
	return {
		write: data => write(data),
		drained,
		flush: () => (stdout.writableNeedDrain ? drained() : Promise.resolve()),
	};
}

/**
 * Worker-process side: read frames from stdin, write frames to stdout, send
 * `log` messages to stderr as JSON lines (the daemon module forwards them to
 * its logger). Stdout carries frames only ({@link claimWorkerStdout}). When
 * stdin closes or the parent dies, the process SIGKILLs
 * itself so onnxruntime's NAPI finalizer never runs (issue #1606).
 */
export async function runFramedStdioWorker<In, Out extends { type: string }>(
	start: (transport: FramedWorkerTransport<In, Out>) => void,
): Promise<void> {
	const stdout = claimWorkerStdout();
	const writer = new FrameWriter({ send: data => stdout.write(data), drained: () => stdout.drained() });
	const handlers = new Set<(message: In) => void>();
	const send = (message: Out): void => {
		if (message.type === "log") {
			process.stderr.write(`${JSON.stringify(message)}\n`);
			return;
		}
		writer.write(encodeMessage(message));
	};
	start({
		send,
		async sendAndFlush(message) {
			send(message);
			await writer.flushed();
			await stdout.flush();
		},
		onMessage(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	});

	// Native inference pins the main thread for minutes; the watchdog thread
	// still notices a dead daemon (issue #14340).
	if (process.ppid > 1) startParentWatchdog(process.ppid);

	const decoder = new FrameDecoder();
	try {
		for await (const chunk of Bun.stdin.stream()) {
			decoder.push(chunk, frame => {
				const message = decodeMessage<In>(frame);
				for (const handler of handlers) handler(message);
			});
		}
	} finally {
		process.kill(process.pid, "SIGKILL");
	}
}
