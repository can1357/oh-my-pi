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

/**
 * A pseudo-terminal whose output reaches the test only once it starts reading
 * the master: until then a writer blocks when the PTY buffer fills, as it
 * does on a terminal that stopped reading.
 */
function openPty(): { master: number; slave: number } {
	const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
		grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
		unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
		ptsname_r: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	});
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

/** Read the terminal until every writer has closed it; `onText` sees everything received so far. */
function readTerminal(master: number, onText: (text: string) => void): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let text = "";
	const stream = fs.createReadStream("", { fd: master, autoClose: false });
	stream.on("data", chunk => {
		text += Buffer.from(chunk).toString("latin1");
		onText(text);
	});
	stream.on("end", () => resolve(text));
	// A PTY master reads EIO once the last slave descriptor closes.
	stream.on("error", err => ((err as NodeJS.ErrnoException).code === "EIO" ? resolve(text) : reject(err)));
	return promise;
}

describe.skipIf(process.platform === "win32")("quitting while the terminal is not reading", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	it("prints the resume hint after the terminal restore, without waiting for the terminal", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stalled-quit-"));
		cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
		const { master, slave } = openPty();
		cleanups.push(() => fs.closeSync(master));
		const quitting = Promise.withResolvers<true>();
		const child = Bun.spawn([process.execPath, FIXTURE, dir], {
			cwd: process.cwd(),
			// A real terminal, not the test runtime: the child's ProcessTerminal
			// paints through the native output pump. Input comes from a pipe that
			// stays open: restoring a terminal stdin's mode would wait for the
			// terminal to drain (tcsetattr TCSADRAIN) and serialize the quit
			// behind the stalled reader, which hides the order under test.
			env: { PATH: Bun.env.PATH ?? "", HOME: dir, TERM: "xterm-256color", LANG: "C.UTF-8" },
			stdin: "pipe",
			stdout: slave,
			stderr: slave,
			ipc(message) {
				if (message === "quitting") quitting.resolve(true);
			},
		});
		cleanups.push(() => child.kill());
		fs.closeSync(slave);

		// Nothing reads the terminal until the quit reaches its exit cleanup.
		// The deadline is real time on purpose: a quit that waits on the stalled
		// terminal never gets there, and the reader then resumes anyway so the
		// byte order is still checked.
		const quitWhileStalled = await Promise.race([
			quitting.promise,
			child.exited.then(() => false),
			Bun.sleep(45_000).then(() => false),
		]);
		let released = false;
		const output = await readTerminal(master, text => {
			if (released || !text.includes("--resume ")) return;
			released = true;
			child.send("go");
		});
		const exitCode = await child.exited;

		const hintAt = output.indexOf(HINT);
		expect(hintAt).toBeGreaterThan(-1);
		expect(output.indexOf(SETTLE_RESET)).toBeGreaterThan(-1);
		expect(output.indexOf(SETTLE_RESET)).toBeLessThan(hintAt);
		expect(output.indexOf(STOP_RESTORE)).toBeGreaterThan(-1);
		expect(output.indexOf(STOP_RESTORE)).toBeLessThan(hintAt);
		expect(quitWhileStalled).toBe(true);
		expect(exitCode).toBe(0);
	}, 120_000);
});
