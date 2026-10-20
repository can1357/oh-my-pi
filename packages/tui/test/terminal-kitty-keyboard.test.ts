import { afterEach, describe, expect, it } from "bun:test";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// Kitty keyboard negotiation must arm the terminal before it asks which flags
// are in effect. The query alone (`CSI ? u`) is answered honestly with
// "flags = 0" by terminals that never push anything themselves (rio), and
// rio ignores the modifyOtherKeys fallback omp would use instead — so an
// unarmed terminal keeps encoding Shift+Enter as a bare CR and omp submits
// the prompt instead of inserting a newline (#12411).

describe("ProcessTerminal kitty keyboard arming", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("pushes the kitty flags before querying them", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		expect(harness.writes.join("")).toContain("\x1b[>5u\x1b[?u\x1b[c");
	});

	it("arms ConPTY hosts with disambiguation only", async () => {
		// ConPTY drops Shift+letter keypresses when flag 4 (report alternate
		// keys) is set, so the arming push asks for disambiguation only.
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true });
		await harness.settle();

		expect(harness.writes.join("")).toContain("\x1b[>1u\x1b[?u\x1b[c");
	});

	it("arms the terminal before the negotiation reply arrives", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		// The reply has not come back yet, but the terminal is already armed:
		// a Shift+Enter pressed in the meantime arrives as `CSI 13;2u` instead
		// of a bare CR.
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(harness.writes.join("")).toContain("\x1b[>5u");
	});

	it("pops the arming frame when the terminal never answers the query", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		harness.writes.length = 0;

		// Only the DA1 sentinel comes back: the terminal never confirmed the
		// arming push, so omp takes its frame back off the kitty stack instead
		// of leaving the terminal reporting kitty keys it cannot decode.
		await harness.feed("\x1b[?1;2c");

		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(harness.writes.join("")).toContain("\x1b[<u");
	});

	it("keeps a single kitty frame on the stack across the negotiation", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?5u", "\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		// The reply echoed the armed level: no second push, so the single pop
		// on exit balances the kitty stack.
		expect(out).not.toContain("\x1b[>5u");
		expect(out).not.toContain("\x1b[<u");
	});
});
