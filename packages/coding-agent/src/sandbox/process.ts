/**
 * {@link SandboxChild} adapter over the native {@link SandboxProcess}: the native side pushes
 * output chunks (a zero-length chunk marks EOF) and queues stdin writes in call order.
 */
import { SandboxProcess, type SandboxSpawnOptions } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { SandboxChild } from "./runtime";

/** Exit code for a process `kill()` ended (SIGKILL), which reports no exit code. */
const KILLED_EXIT_CODE = 128 + 9;
/** Exit code for a process ended by a signal it did not get from `kill()`, or whose `wait()` failed. */
const ABNORMAL_EXIT_CODE = 1;

/** Push-fed byte stream: enqueues every chunk (never drops) and closes on the zero-length EOF chunk. */
class PushedStream {
	readonly stream: ReadableStream<Uint8Array>;
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	#done = false;

	constructor() {
		this.stream = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
			cancel: () => {
				this.#done = true;
			},
		});
	}

	/** Native stream callback. */
	readonly push = (err: Error | null, chunk: Uint8Array): void => {
		if (this.#done) return;
		if (err) {
			this.#done = true;
			this.#controller.error(err);
		} else if (chunk.length === 0) {
			this.#done = true;
			this.#controller.close();
		} else {
			this.#controller.enqueue(chunk);
		}
	};
}

/** Stdin over the native queue, which copies each write on call and delivers in call order. */
class SandboxStdin {
	readonly #native: SandboxProcess;
	#ended = false;

	constructor(native: SandboxProcess) {
		this.#native = native;
	}

	write(data: string | Uint8Array): void {
		if (this.#ended) return;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (bytes.length === 0) return;
		this.#native.write(bytes).catch(error => {
			// The child closed its stdin or exited; the bytes have nowhere to go.
			logger.debug("sandbox: stdin write failed", { error: String(error) });
		});
	}

	/** Writes go straight to the native queue; nothing is buffered on this side. */
	flush(): void {}

	/** Closes stdin once the queued writes are delivered. */
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#native.closeStdin();
	}
}

class SandboxChildProcess implements SandboxChild {
	readonly pid: number;
	readonly stdin: SandboxStdin;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly #native: SandboxProcess;
	#exitCode: number | null = null;
	#killed = false;

	constructor(native: SandboxProcess, stdout: PushedStream, stderr: PushedStream) {
		this.#native = native;
		this.pid = native.pid;
		this.stdin = new SandboxStdin(native);
		this.stdout = stdout.stream;
		this.stderr = stderr.stream;
		this.exited = native.wait().then(
			({ exitCode }) => {
				// The binding reports a signal death as `-1` (or no code at all).
				if (exitCode !== undefined && exitCode !== -1) return this.#settle(exitCode);
				return this.#settle(this.#killed ? KILLED_EXIT_CODE : ABNORMAL_EXIT_CODE);
			},
			error => {
				logger.warn("sandbox: waiting for contained process failed", { pid: this.pid, error: String(error) });
				return this.#settle(ABNORMAL_EXIT_CODE);
			},
		);
	}

	get exitCode(): number | null {
		return this.#exitCode;
	}

	/** Kills the whole contained tree. Idempotent. */
	kill(): void {
		if (this.#killed || this.#exitCode !== null) return;
		this.#killed = true;
		try {
			this.#native.kill();
		} catch (error) {
			logger.debug("sandbox: kill failed", { pid: this.pid, error: String(error) });
		}
	}

	#settle(code: number): number {
		this.#exitCode = code;
		return code;
	}
}

/** Launches `options` contained; rejects with the native error (MXC code, message, remediation). */
export async function spawnSandboxChild(options: SandboxSpawnOptions): Promise<SandboxChild> {
	const stdout = new PushedStream();
	const stderr = new PushedStream();
	const native = await SandboxProcess.spawn(options, stdout.push, stderr.push);
	return new SandboxChildProcess(native, stdout, stderr);
}
