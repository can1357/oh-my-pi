/**
 * `createWorkerSubprocess` failure surfaces.
 *
 * Worker stderr is piped without a live read while the worker is idle; after
 * `onExit` the wrapper drains it, keeps the last 16 KiB in a bounded ring, and
 * appends that tail to the `Error` surfaced to `errors` handlers, so a native
 * crash (ONNX Runtime traceback, glibc assertion, segfault) is diagnosable.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createWorkerSubprocess, type SpawnedSubprocess } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";

interface FakeWorkerOutbound {
	type: "pong";
	id: string;
}

interface FakeWorker {
	/** Write `bytes` to the stderr target the wrapper handed the child, as the child would. */
	writeStderr(bytes: string): void;
	/** The child exits; Bun reports it through the spawn's `onExit`. */
	exit(exitCode: number | null, signalCode: NodeJS.Signals | null): void;
}

/**
 * Stand in for the worker child at the `Bun.spawn` boundary. The contract under test is the
 * wrapper's: what it does with the stderr target and the exit Bun reports. A real child adds
 * only process start-up time, which under a loaded machine is unbounded.
 */
function fakeWorkerSpawn(): FakeWorker {
	let options: Bun.SpawnOptions.OptionsObject<"ignore", "ignore", number> | undefined;
	const exited = Promise.withResolvers<number>();
	const proc = {
		pid: 12345,
		exited: exited.promise,
		kill(signal?: NodeJS.Signals) {
			worker.exit(null, signal ?? "SIGTERM");
		},
		unref() {},
		ref() {},
	};
	const worker: FakeWorker = {
		writeStderr(bytes) {
			const fd = options?.stderr;
			if (typeof fd !== "number") throw new Error("the wrapper gave the child no stderr file");
			fs.writeSync(fd, bytes);
		},
		exit(exitCode, signalCode) {
			options?.onExit?.(proc as never, exitCode, signalCode as never);
			exited.resolve(exitCode ?? 137);
		},
	};
	spyOn(Bun, "spawn").mockImplementation(((spawnOptions: typeof options) => {
		options = spawnOptions;
		return proc;
	}) as unknown as typeof Bun.spawn);
	return worker;
}

/**
 * Resolve the first worker-error handler fires with. The subprocess wires the
 * error surface off `stderrDrained` so this always resolves after the stderr
 * tail has fully drained — no wall-clock races.
 */
function firstWorkerError(sub: SpawnedSubprocess<FakeWorkerOutbound>): Promise<Error> {
	const { promise, resolve } = Promise.withResolvers<Error>();
	sub.errors.add(resolve);
	return promise;
}

const spawnCommand = { cmd: ["tts-worker"] };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("worker subprocess stderr survives to the exit error", () => {
	it("surfaces stderr in the onExit error when the worker exits non-zero", async () => {
		const stderr =
			"onnxruntime[Native]: Non-zero status code returned while executing Add node.\n" +
			"terminate called after throwing an instance of 'std::runtime_error'\n" +
			"  what():  cudaMemcpy failed\n";
		const worker = fakeWorkerSpawn();
		const sub = createWorkerSubprocess<FakeWorkerOutbound>({ spawnCommand, env: {}, exitLabel: "tts subprocess" });
		const error = firstWorkerError(sub);
		worker.writeStderr(stderr);
		worker.exit(7, null);
		const err = await error;
		// The exit-code prefix is preserved so existing log parsers keep working.
		expect(err.message).toStartWith("tts subprocess exited with code 7");
		// The actual native crash reason must be part of the error.
		expect(err.message).toContain("onnxruntime[Native]");
		expect(err.message).toContain("cudaMemcpy failed");
	});

	it("truncates a large stderr to the last ~16 KiB so a chatty runtime can't blow the parent up", async () => {
		// Write well past the 16 KiB tail limit. A recognisable trailer must
		// still land at the end so the diagnostic tail is what survives.
		const trailer = "FATAL: onnxruntime session run failed\n";
		const worker = fakeWorkerSpawn();
		const sub = createWorkerSubprocess<FakeWorkerOutbound>({ spawnCommand, env: {}, exitLabel: "tts subprocess" });
		const error = firstWorkerError(sub);
		worker.writeStderr(`${"A".repeat(64 * 1024)}${trailer}`);
		worker.exit(7, null);
		const err = await error;
		// Trailer wins.
		expect(err.message).toContain("FATAL: onnxruntime session run failed");
		// Truncation happened — we did not append the whole 64 KiB.
		expect(err.message.length).toBeLessThan(20_000);
	});

	it("does not surface intentional terminate() SIGKILLs as worker errors", async () => {
		// Piping stderr must not change the semantics of an intentional teardown. The wrapper's `terminate()` flips
		// `intentionalExit` then SIGKILLs — the error channel must stay quiet.
		fakeWorkerSpawn();
		const sub = createWorkerSubprocess<FakeWorkerOutbound>({ spawnCommand, env: {}, exitLabel: "tts subprocess" });
		let errored = false;
		sub.errors.add(() => {
			errored = true;
		});
		sub.intentionalExit.value = true;
		sub.proc.kill("SIGKILL");
		// Wait for both process reap AND stderr drain so any latent error
		// path has had its shot at firing before we assert silence.
		await sub.proc.exited;
		await sub.stderrDrained;
		expect(errored).toBe(false);
	});
});

/**
 * Bun raises a malformed or truncated advanced-IPC frame from a worker as a
 * process-level `uncaughtException` in the PARENT (oven-sh/bun#37287), not in the
 * channel's `ipc()` callback. The postmortem handler must recognize that decode
 * error (`isWorkerIpcDeserializeError`), keep the session alive, and fault every
 * active advanced-IPC worker so its owning client rejects in-flight requests.
 */
describe("malformed worker IPC frame does not terminate the parent", () => {
	it("contains an advanced-serialization decode failure to the worker instead of exiting the session", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..");
		// Bun advanced-IPC frame with an invalid structured-clone body, written
		// raw to the IPC fd (3), then the child blocks forever. Staying alive is
		// the point: the malformed frame — not an exit — must fault the worker.
		// On Windows the IPC fd is a libuv ipc-mode named pipe that wraps every
		// write in a 16-byte frame header ({flags=HAS_DATA, 0, length, 0}); an
		// unwrapped raw write is rejected by libuv and silently closes the
		// channel without ever reaching Bun's deserializer.
		const childScript =
			'const body = Buffer.from([2, 4, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]); let frame = body; if (process.platform === "win32") { const header = Buffer.alloc(16); header.writeUInt32LE(1, 0); header.writeUInt32LE(body.length, 8); frame = Buffer.concat([header, body]); } require("node:fs").writeSync(3, frame); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);';
		// Runs in a spawned `bun -e` parent that installs the postmortem
		// uncaughtException handler under test, as the CLI does at startup.
		const wrapperScript = `
			import { postmortem } from "@oh-my-pi/pi-utils";
			import { createWorkerSubprocess } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
			postmortem.installProcessHandlers();
			const worker = createWorkerSubprocess({
				spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(childScript)}] },
				env: {},
				exitLabel: "malformed IPC child",
				unref: false,
			});
			const { promise: errored, resolve } = Promise.withResolvers();
			worker.errors.add(resolve);
			// The bad frame is contained and faults the worker's error channel even
			// though the child never exits on its own.
			const err = await errored;
			process.stdout.write("FAULTED:" + err.message);
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_TEST_RUNTIME: "0" },
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("FAULTED:");
		expect(stdout).toContain("worker sent a malformed IPC frame");
	}, 20_000);

	it("still faults on an unrelated TypeError with the same message but a real stack", async () => {
		// Guards the narrowed matcher: an application-thrown `TypeError` carrying
		// this exact message but a populated stack must stay on the fatal path,
		// so a genuine bug is never silently swallowed as a worker IPC frame.
		const repoRoot = path.resolve(import.meta.dir, "..");
		const wrapperScript = `
			import { postmortem } from "@oh-my-pi/pi-utils";
			import "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
			postmortem.installProcessHandlers();
			process.stdout.write("BEFORE_THROW");
			queueMicrotask(() => { throw new TypeError("Unable to deserialize data."); });
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_TEST_RUNTIME: "0" },
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("BEFORE_THROW");
	}, 20_000);
});
