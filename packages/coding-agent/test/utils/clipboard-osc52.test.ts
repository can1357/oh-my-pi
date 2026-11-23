import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Buffer } from "node:buffer";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as natives from "@oh-my-pi/pi-natives/clipboard";
import { type ActiveTerminalHarness, startActiveTerminal } from "../helpers/active-terminal";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
}

/**
 * A copy's OSC 52 must not tear a TUI frame: while a terminal owns stdout it
 * takes the terminal's ordered write path, and it goes straight to stdout only
 * when no terminal owns it.
 */
describe("copyToClipboard OSC 52 routing", () => {
	let harness: ActiveTerminalHarness | undefined;

	beforeEach(() => {
		// Linux keeps macOS runs off the real pbcopy; the native write is stubbed.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	});

	it("writes OSC 52 through the active terminal, never straight to stdout", async () => {
		harness = startActiveTerminal();

		await copyToClipboard("probe");

		expect(harness.routed).toEqual([osc52("probe")]);
		expect(harness.direct.join("")).not.toContain("\x1b]52;");
	});

	it("writes OSC 52 straight to stdout once the terminal has stopped", async () => {
		harness = startActiveTerminal();
		harness.stop();

		await copyToClipboard("probe");

		expect(harness.direct).toEqual([osc52("probe")]);
		expect(harness.routed).toEqual([]);
	});

	// The computer tool copies from a Bun Worker, which has no route to the
	// main thread's terminal; its OSC 52 would hit fd 1 around the pump.
	it("skips OSC 52 in a worker thread and still makes the native copy", async () => {
		const worker = new Worker(new URL("../fixtures/clipboard-worker-copy.ts", import.meta.url).href, {
			type: "module",
		});
		const report = Promise.withResolvers<{ stdout: string[]; nativeCopies: string[] }>();
		worker.addEventListener("message", event => report.resolve(event.data));
		worker.addEventListener("error", event => report.reject(event.error ?? new Error(event.message)));
		try {
			const { stdout, nativeCopies } = await report.promise;
			expect(stdout.join("")).not.toContain("\x1b]52;");
			expect(nativeCopies).toEqual(["worker probe"]);
		} finally {
			worker.terminate();
		}
	});
});
