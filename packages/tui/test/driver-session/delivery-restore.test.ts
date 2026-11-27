import { afterEach, describe, expect, it, vi } from "bun:test";
import { emergencyTerminalRestore, writeTerminalSequence } from "../../src/driver/session";
import { type ProcessDriverTest, startProcessDriver } from "../../src/testing/process-driver";

const OSC52 = "\x1b]52;c;cHJvYmU=\x07";
const MOUSE_RESET = "\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

let term: ProcessDriverTest | undefined;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setStdoutTty(isTTY: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true, writable: true });
}

/** Stub stdout's write, completing each write's callback with `error`. */
function stubStdout(error: Error | null = null): string[] {
	const writes: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
		writes.push(String(chunk));
		const callback = rest.at(-1);
		if (typeof callback === "function") queueMicrotask(() => callback(error));
		return true;
	}) as typeof process.stdout.write);
	return writes;
}

afterEach(async () => {
	await term?.driver.stop();
	term = undefined;
	vi.restoreAllMocks();
	if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stdout, "isTTY");
});

describe("writeTerminalSequence delivery", () => {
	it("resolves true once the running driver's output took the bytes", async () => {
		const writes = stubStdout();
		term = await startProcessDriver();
		term.output.length = 0;

		expect(await writeTerminalSequence(OSC52, { awaitDelivery: true, ttyOnly: true })).toBe(true);

		expect(term.output).toEqual([OSC52]);
		expect(writes).toEqual([]);
	});

	it("resolves false off a TTY with ttyOnly, writing nothing", async () => {
		setStdoutTty(false);
		const writes = stubStdout();

		expect(await writeTerminalSequence(OSC52, { awaitDelivery: true, ttyOnly: true })).toBe(false);

		expect(writes).toEqual([]);
	});

	it("resolves from stdout's write callback on a TTY", async () => {
		setStdoutTty(true);
		const writes = stubStdout();
		expect(await writeTerminalSequence(OSC52, { awaitDelivery: true, ttyOnly: true })).toBe(true);
		expect(writes).toEqual([OSC52]);

		vi.restoreAllMocks();
		stubStdout(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		expect(await writeTerminalSequence(OSC52, { awaitDelivery: true, ttyOnly: true })).toBe(false);
	});

	it("resolves false when stdout throws", async () => {
		setStdoutTty(true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		});
		expect(await writeTerminalSequence(OSC52, { awaitDelivery: true })).toBe(false);
	});

	it("keeps the fire-and-forget form returning nothing", async () => {
		term = await startProcessDriver();
		term.output.length = 0;
		expect(writeTerminalSequence(OSC52)).toBeUndefined();
		expect(term.output).toEqual([OSC52]);
	});
});

describe("terminal restore", () => {
	it("stop resets every mouse mode and restores the terminal's own alternate scroll", async () => {
		term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } }, "\x1b[?1007;2$y");
		term.driver.setMouse("drag");
		term.driver.setAlternateScroll(true);
		term.output.length = 0;

		await term.driver.stop();

		expect(term.output.join("")).toContain(`${MOUSE_RESET}\x1b[?1007l`);
	});

	it("the crash restore resets 1002, 1016 and 1006 and restores alternate scroll", async () => {
		term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } }, "\x1b[?1007;1$y\x1b[?1016;2$y\x1b[6;20;10t");
		term.driver.setMouse("drag");
		term.driver.setAlternateScroll(false);
		expect(term.output.join("")).toContain("\x1b[?1002h\x1b[?1006h\x1b[?1016h");
		expect(term.output.join("")).toContain("\x1b[?1007l");
		term.output.length = 0;

		emergencyTerminalRestore();

		expect(term.output.join("")).toContain(`${MOUSE_RESET}\x1b[?1007h`);
		expect(term.raw()).toBe(false);
	});
});
