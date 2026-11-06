import { afterEach, describe, expect, it } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { HANDOFF_DRAIN_DEADLINE_MS, HANDOFF_DRAIN_IDLE_MS } from "@oh-my-pi/pi-tui/terminal-handoff";

const FIXTURE = path.join(import.meta.dir, "fixtures", "stalled-terminal-sigterm.ts");

/** No pseudo-terminal here (Windows, another libc, no /dev/ptmx or devpts): skip. */
function canOpenPty(): boolean {
	if (process.platform === "win32") return false;
	try {
		const { master, slave } = openPty();
		fs.closeSync(slave);
		fs.closeSync(master);
		return true;
	} catch {
		return false;
	}
}

/** A pseudo-terminal that stays open while nothing reads its master, as a hung session does. */
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

function within<T>(signal: Promise<T>, ms: number): Promise<T | "timeout"> {
	return Promise.race([signal, Bun.sleep(ms).then(() => "timeout" as const)]);
}

describe.skipIf(!canOpenPty())("the exit drain on a terminal that stays open and never reads", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	it("gives up on the held output and exits on a signal", async () => {
		const { master, slave } = openPty();
		cleanups.push(() => fs.closeSync(master));
		const held = Promise.withResolvers<true>();
		const child = Bun.spawn([process.execPath, FIXTURE, "signal"], {
			cwd: process.cwd(),
			// Nothing ever reads `master`, and the terminal stays open: the pump's
			// write(2) never errors, so `dead` never becomes true.
			env: { PATH: Bun.env.PATH ?? "", TERM: "xterm-256color", LANG: "C.UTF-8" },
			stdin: "pipe",
			stdout: slave,
			stderr: slave,
			ipc(message) {
				if (message === "held") held.resolve(true);
			},
		});
		cleanups.push(() => child.kill("SIGKILL"));
		fs.closeSync(slave);
		const exited = child.exited.then(() => "exited" as const);

		expect(await within(Promise.race([held.promise, exited]), 60_000)).toBe(true);
		const signalledAt = Date.now();
		child.kill("SIGTERM");
		// Unbounded, this never returns: the drain is synchronous, so even a
		// second signal would not be handled.
		const settled = await within(exited, HANDOFF_DRAIN_DEADLINE_MS);
		const tookMs = Date.now() - signalledAt;

		expect(settled).toBe("exited");
		expect(tookMs).toBeLessThan(HANDOFF_DRAIN_DEADLINE_MS);
	}, 180_000);

	it("keeps waiting while a slow terminal is still taking the bytes", async () => {
		const { master, slave } = openPty();
		cleanups.push(() => fs.closeSync(master));
		const held = Promise.withResolvers<true>();
		const child = Bun.spawn([process.execPath, FIXTURE, "exit", String(96 * 1024)], {
			cwd: process.cwd(),
			env: { PATH: Bun.env.PATH ?? "", TERM: "xterm-256color", LANG: "C.UTF-8" },
			stdin: "pipe",
			stdout: slave,
			stderr: slave,
			ipc(message) {
				if (message === "held") held.resolve(true);
			},
		});
		cleanups.push(() => child.kill("SIGKILL"));
		fs.closeSync(slave);
		expect(await within(Promise.race([held.promise, child.exited]), 60_000)).toBe(true);

		// Takes the backlog in small reads. Every one restarts the idle window,
		// so the bound never cuts a terminal that is still taking bytes; what it
		// cannot save is one so slow that a whole window passes without a queued
		// chunk landing, which loses the rest exactly as a stop that could not
		// drain did before the handoff existed.
		let text = "";
		const buffer = Buffer.alloc(16 * 1024);
		const reading = (async () => {
			for (;;) {
				await Bun.sleep(HANDOFF_DRAIN_IDLE_MS / 25);
				let got = 0;
				try {
					got = fs.readSync(master, buffer, 0, buffer.length, null);
				} catch {
					return;
				}
				text += buffer.toString("latin1", 0, got);
				if (text.includes("TAIL-END")) return;
			}
		})();

		expect(await within(child.exited, HANDOFF_DRAIN_DEADLINE_MS)).not.toBe("timeout");
		await reading;
		// Everything the handoff held reached it, last byte included.
		expect(text).toContain("TAIL-END");
	}, 180_000);

	it("gives up on the held output and exits when the script returns", async () => {
		const { master, slave } = openPty();
		cleanups.push(() => fs.closeSync(master));
		const held = Promise.withResolvers<true>();
		const child = Bun.spawn([process.execPath, FIXTURE, "exit"], {
			cwd: process.cwd(),
			env: { PATH: Bun.env.PATH ?? "", TERM: "xterm-256color", LANG: "C.UTF-8" },
			stdin: "pipe",
			stdout: slave,
			stderr: slave,
			ipc(message) {
				if (message === "held") held.resolve(true);
			},
		});
		cleanups.push(() => child.kill("SIGKILL"));
		fs.closeSync(slave);
		const exited = child.exited.then(() => "exited" as const);
		const startedAt = Date.now();

		// No signal interrupts this one: the exit cleanup drains with the
		// terminal open and silent, which unbounded never ends.
		expect(await within(Promise.race([held.promise, exited]), 60_000)).toBe(true);
		const settled = await within(exited, HANDOFF_DRAIN_DEADLINE_MS);

		expect(settled).toBe("exited");
		expect(Date.now() - startedAt).toBeLessThan(HANDOFF_DRAIN_DEADLINE_MS);
	}, 180_000);
});
