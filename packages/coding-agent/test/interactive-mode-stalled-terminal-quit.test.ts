import { afterEach, describe, expect, it } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FIXTURE = path.join(import.meta.dir, "fixtures", "stalled-terminal-quit.ts");
// What a settle's discard of the undelivered backlog is followed by.
const SETTLE_RESET = "\x1b\\\x1b[?2026l\x1b[0m\x1b]8;;\x07\x1b[?25h";
// ProcessTerminal.stop()'s restore writes: bracketed paste off, then enhanced
// paste off. The exit-time blind restore follows ?2004l with ?2031l instead.
const STOP_RESTORE = "\x1b[?2004l\x1b[?5522l";
const HINT = "Resume this session with";

function loadPtyLibc() {
	return dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
		grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
		unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
		ptsname_r: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	});
}

/** No PTY helpers (Windows, or a libc under another name such as musl's): skip. */
function canOpenPty(): boolean {
	if (process.platform === "win32") return false;
	try {
		loadPtyLibc().close();
		return true;
	} catch {
		return false;
	}
}

/**
 * A pseudo-terminal whose output reaches the test only once it starts reading
 * the master: until then a writer blocks when the PTY buffer fills, as it
 * does on a terminal that stopped reading.
 */
function openPty(): { master: number; slave: number } {
	const libc = loadPtyLibc();
	try {
		const { O_RDWR, O_NOCTTY } = fs.constants;
		const master = fs.openSync("/dev/ptmx", O_RDWR | O_NOCTTY);
		const name = Buffer.alloc(256);
		if (
			libc.symbols.grantpt(master) !== 0 ||
			libc.symbols.unlockpt(master) !== 0 ||
			libc.symbols.ptsname_r(master, ptr(name), name.length) !== 0
		) {
			fs.closeSync(master);
			throw new Error("could not set up a pseudo-terminal");
		}
		const slave = fs.openSync(name.toString("utf8", 0, name.indexOf(0)), O_RDWR | O_NOCTTY);
		return { master, slave };
	} finally {
		libc.close();
	}
}

/** Read the terminal until every writer has closed it. */
function readTerminal(master: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let text = "";
	const stream = fs.createReadStream("", { fd: master, autoClose: false });
	stream.on("data", chunk => {
		text += Buffer.from(chunk).toString("latin1");
	});
	stream.on("end", () => resolve(text));
	// A PTY master reads EIO once the last slave descriptor closes.
	stream.on("error", err => ((err as NodeJS.ErrnoException).code === "EIO" ? resolve(text) : reject(err)));
	return promise;
}

/**
 * Whether `signal` settles before `ms` pass. The deadlines are real time on
 * purpose: the child runs against a real terminal it cannot see stalling.
 */
function within<T>(signal: Promise<T>, ms: number): Promise<T | "timeout"> {
	return Promise.race([signal, Bun.sleep(ms).then(() => "timeout" as const)]);
}

describe.skipIf(!canOpenPty())("quitting while the terminal is not reading", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	it("waits for the terminal, then gives it the restore before the resume hint", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stalled-quit-"));
		cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
		const { master, slave } = openPty();
		cleanups.push(() => fs.closeSync(master));
		const shutdownStarted = Promise.withResolvers<true>();
		const exitCleanupReached = Promise.withResolvers<true>();
		const child = Bun.spawn([process.execPath, FIXTURE, dir], {
			cwd: process.cwd(),
			// A real terminal, not the test runtime: the child's ProcessTerminal
			// paints through the native output pump. Input comes from a pipe that
			// stays open. With stdin on the terminal, restoring its mode
			// (setRawMode) makes stop() wait for the terminal to read, except on
			// kernels without Linux commit 094fb49a2d0d ("tty: Prevent writing
			// chars during tcsetattr TCSADRAIN/FLUSH"; in 5.4.243, 5.10.180,
			// 5.15.111, 6.1.28 and 6.2.15 and later), which do not wait. The pipe
			// stands in for every case where the quit reaches the hint with the
			// backlog unread: stdin that is not the terminal (an embedded or SDK
			// InteractiveMode), a quit before raw mode was ever enabled (the
			// deferInput prepaint), and those kernels.
			env: { PATH: Bun.env.PATH ?? "", HOME: dir, TERM: "xterm-256color", LANG: "C.UTF-8" },
			stdin: "pipe",
			stdout: slave,
			stderr: slave,
			ipc(message) {
				if (message === "shutdown") shutdownStarted.resolve(true);
				if (message === "exit-cleanup") exitCleanupReached.resolve(true);
			},
		});
		cleanups.push(() => child.kill());
		fs.closeSync(slave);
		const exited = child.exited.then(() => "exited" as const);

		// Nothing reads the terminal until the checks below are done.
		const started = await within(Promise.race([shutdownStarted.promise, exited]), 60_000);
		// The quit gets through the hint to its exit cleanup without the terminal
		// reading: the hint queues behind the unread backlog instead of blocking
		// on the terminal.
		const reachedExitCleanup = await within(Promise.race([exitCleanupReached.promise, exited]), 60_000);
		// Then the exit waits for the terminal instead of dropping what it holds.
		const stillRunning = await within(exited, 3_000);
		const output = await readTerminal(master);
		const exitCode = await child.exited;

		expect(output).toContain(HINT);
		expect(started).toBe(true);
		const hintAt = output.indexOf(HINT);
		expect(output.indexOf(SETTLE_RESET)).toBeGreaterThan(-1);
		expect(output.indexOf(SETTLE_RESET)).toBeLessThan(hintAt);
		expect(output.indexOf(STOP_RESTORE)).toBeGreaterThan(-1);
		expect(output.indexOf(STOP_RESTORE)).toBeLessThan(hintAt);
		expect(reachedExitCleanup).toBe(true);
		expect(stillRunning).toBe("timeout");
		expect(exitCode).toBe(0);
	}, 180_000);
});
