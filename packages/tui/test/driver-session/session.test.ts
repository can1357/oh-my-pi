import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	activeTerminalDriver,
	emergencyTerminalRestore,
	terminalCapabilities,
	terminalIdentity,
	writeTerminalSequence,
} from "../../src/driver/session";
import { type ProcessDriverTest, startProcessDriver } from "../../src/testing/process-driver";
import { FakeClock } from "../driver-io/fake-clock";

const OSC52 = "\x1b]52;c;cHJvYmU=\x07";

let term: ProcessDriverTest | undefined;

afterEach(async () => {
	await term?.driver.stop();
	term = undefined;
	vi.restoreAllMocks();
});

describe("writeTerminalSequence", () => {
	it("takes the running driver's ordered output path, never stdout", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		term = await startProcessDriver();
		term.output.length = 0;

		writeTerminalSequence(OSC52);

		expect(term.output).toEqual([OSC52]);
		expect(stdout).not.toHaveBeenCalled();
	});

	it("goes straight to stdout once the driver has stopped", async () => {
		term = await startProcessDriver();
		await term.driver.stop();
		term.output.length = 0;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});

		writeTerminalSequence(OSC52);

		expect(writes).toEqual([OSC52]);
		expect(term.output).toEqual([]);
		expect(activeTerminalDriver()).toBe(null);
	});

	it("never throws into the caller when stdout is closed", () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		});
		expect(() => writeTerminalSequence(OSC52)).not.toThrow();
	});
});

describe("terminal identity and capabilities", () => {
	it("reports the running driver's identity, probes included", async () => {
		term = await startProcessDriver({ env: { TERM_PROGRAM: "ghostty" } }, "\x1bP>|ghostty 1.2.0\x1b\\");
		expect(terminalIdentity()).toMatchObject({ id: "ghostty", notify: "osc9", version: "ghostty 1.2.0" });
		expect(terminalCapabilities()).toBe(term.driver.capabilities);
	});

	it("falls back to environment detection without a running driver", () => {
		expect(activeTerminalDriver()).toBe(null);
		expect(terminalIdentity().version).toBe(null);
		expect(terminalCapabilities().tsp).toBe(false);
	});
});

describe("ordered terminal handoff", () => {
	const ack = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":3}\x1b\\';
	const da1 = "\x1b[?62c";

	it("consumes pending Tern acks in raw mode behind the last probe, without dispatching them", async () => {
		const clock = new FakeClock();
		term = await startProcessDriver({ env: { TERM_PROGRAM: "tern" }, hello: "\x1b_tsp;q;{}\x1b\\", clock });
		// The DA1 from this earlier probe must not settle the shutdown fence.
		term.driver.refreshAppearance();
		term.output.length = 0;
		const input = vi.fn();
		term.driver.onInput(input);
		const stopped = term.driver.stop();
		try {
			const output = term.output.join("");
			expect(output).toContain("\x1b[?2004l");
			expect(output.endsWith("\x1b[c")).toBe(true);
			await Promise.resolve(); // The sink flushed; the terminal has not answered yet.
			term.feed(da1);
			clock.advance(200);
			term.feed(ack.slice(0, 13));
			term.feed(ack.slice(13));
			clock.advance(100);
			expect(term.raw()).toBe(true);
			expect(activeTerminalDriver()).toBe(term.driver);

			term.feed(da1);
			clock.advance(49);
			term.feed(ack);
			clock.advance(49);
			await Promise.resolve();
			expect(term.raw()).toBe(true);
			expect(input).not.toHaveBeenCalled();
			clock.advance(1);
			await stopped;
			expect(term.raw()).toBe(false);
			expect(activeTerminalDriver()).toBeNull();
		} finally {
			clock.advance(1000);
			await stopped;
		}
	});

	it("drains late input on a plain terminal without soliciting another reply", async () => {
		const clock = new FakeClock();
		term = await startProcessDriver({ clock });
		term.output.length = 0;
		const input = vi.fn();
		term.driver.onInput(input);
		const stopped = term.driver.stop();
		try {
			await Promise.resolve();
			clock.advance(49);
			term.feed(da1 + "x");
			clock.advance(49);
			await Promise.resolve();
			expect(term.raw()).toBe(true);
			expect(input).not.toHaveBeenCalled();
			expect(term.output.join("")).not.toContain("\x1b[c");
			clock.advance(1);
			await stopped;
			expect(term.raw()).toBe(false);
		} finally {
			clock.advance(1000);
			await stopped;
		}
	});

	it("restores echo synchronously if a hard exit interrupts the awaited drain", async () => {
		const clock = new FakeClock();
		term = await startProcessDriver({ env: { TERM_PROGRAM: "tern" }, hello: "\x1b_tsp;q;{}\x1b\\", clock });
		const stopped = term.driver.stop();
		expect(term.raw()).toBe(true);
		emergencyTerminalRestore();
		expect(term.raw()).toBe(false);
		expect(activeTerminalDriver()).toBeNull();
		await stopped;
	});

	it("hands back raw mode when a Tern pane never answers the exit fence", async () => {
		const clock = new FakeClock();
		term = await startProcessDriver({ env: { TERM_PROGRAM: "tern" }, hello: "\x1b_tsp;q;{}\x1b\\", clock });
		const stopped = term.driver.stop();
		clock.advance(1000);
		await stopped;
		expect(term.raw()).toBe(false);
	});
});

describe("emergencyTerminalRestore", () => {
	it("never writes after a graceful stop has handed the terminal back", async () => {
		term = await startProcessDriver();
		await term.driver.stop();
		expect(term.output.join("")).toContain("\x1b[?25h");
		term.output.length = 0;

		emergencyTerminalRestore();

		expect(term.output).toEqual([]);
	});

	it("restores input modes and raw mode, leaving the alternate screen only when it is up", async () => {
		term = await startProcessDriver();
		term.driver.setMouse("any");
		term.output.length = 0;
		emergencyTerminalRestore();
		const inline = term.output.join("");
		expect(inline).not.toContain("\x1b[?1049l");
		expect(inline).toContain("\x1b[?1003l");
		expect(inline).toContain("\x1b[?1006l");
		expect(inline).toContain("\x1b[?25h");
		expect(term.raw()).toBe(false);
		expect(activeTerminalDriver()).toBe(null);

		term = await startProcessDriver();
		term.driver.present({ viewport: [], cursor: null, fullscreen: ["overlay"] });
		term.output.length = 0;
		emergencyTerminalRestore();
		expect(term.output.join("")).toContain("\x1b[?1049l");
	});

	it("pops keyboard enhancement frames on both screens when crashing from a fullscreen layer", async () => {
		term = await startProcessDriver({}, "\x1b[?0u");
		term.driver.present({ viewport: [], cursor: null, fullscreen: ["overlay"] });
		term.output.length = 0;

		emergencyTerminalRestore();

		const restored = term.output.join("");
		const altExit = restored.indexOf("\x1b[?1049l");
		const altPop = restored.indexOf("\x1b[<u");
		const mainPop = restored.indexOf("\x1b[<u", altExit + 1);
		expect(altPop).toBeGreaterThanOrEqual(0);
		expect(altPop).toBeLessThan(altExit);
		expect(mainPop).toBeGreaterThan(altExit);
	});

	it("permits output through a driver again only after a new start", async () => {
		term = await startProcessDriver();
		emergencyTerminalRestore();
		term.output.length = 0;
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		writeTerminalSequence(OSC52);
		expect(term.output).toEqual([]);

		term = await startProcessDriver();
		term.output.length = 0;
		writeTerminalSequence(OSC52);
		expect(term.output).toEqual([OSC52]);
	});
});
