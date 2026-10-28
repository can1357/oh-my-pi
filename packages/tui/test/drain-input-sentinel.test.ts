import { afterEach, describe, expect, it } from "bun:test";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// The exit drain reads what the terminal still sends before omp hands the pty
// back to the shell. A terminal may answer the last frames (TSP acks) well
// after a short idle window; whatever arrives once omp stops reading is typed
// into the shell's prompt (`omptsp;e;{"ev":"ack",…}` in zsh). A terminal that
// answers DA1 gets one more sentinel, and the drain lasts until its reply.

const DA1_REPLY = "\x1b[?1;2c";

function sentinels(writes: string[]): number {
	return writes.join("").split("\x1b[c").length - 1;
}

describe("ProcessTerminal exit drain", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("keeps reading until the terminal answers its sentinel", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		// Answer every startup probe, as a terminal that speaks DA1 does.
		let answered = 0;
		while (sentinels(harness.writes) > answered) {
			await harness.feed(DA1_REPLY);
			answered++;
			await harness.settle();
		}
		harness.writes.length = 0;

		let drained = false;
		const drain = harness.terminal.drainInput(1000, 20).then(() => {
			drained = true;
		});
		expect(sentinels(harness.writes)).toBe(1);
		// Real time: the drain measures its idle window with Date.now() and
		// setTimeout, and the contract is that it outlasts that window.
		await Bun.sleep(120);
		expect(drained).toBe(false);

		await harness.feed('\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":9}\x1b\\', DA1_REPLY);
		await drain;
		expect(drained).toBe(true);
	});
});
