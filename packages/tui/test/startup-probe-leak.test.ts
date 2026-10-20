import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

const COLUMNS = 40;
const ROWS = 12;
const BODY = Array.from({ length: ROWS - 2 }, (_, index) => `row ${index + 1}`);

/** Fills the screen under the harness's width probe and parks the cursor on the bottom row. */
class PromptFrame implements Component {
	invalidate(): void {}
	render(): string[] {
		return [...BODY, `> ${CURSOR_MARKER}`];
	}
}

describe("startup capability probes", () => {
	withoutTerminalMultiplexer();
	const PROBE_ENV = ["PI_TUI_GLYPH_PROTOCOL_PROBE", "PI_TUI_NATIVE", "PI_NO_GLYPH_PROTOCOL"] as const;
	const previousEnv = new Map<string, string | undefined>();
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		for (const key of PROBE_ENV) previousEnv.set(key, Bun.env[key]);
		// bun test skips the APC probes by default; send them as a real session does.
		Bun.env.PI_TUI_GLYPH_PROTOCOL_PROBE = "1";
		Bun.env.PI_TUI_NATIVE = "1";
		delete Bun.env.PI_NO_GLYPH_PROTOCOL;
		// `TERM_PROGRAM=tern` would start a TSP surface instead of the row renderer.
		delete Bun.env.TERM_PROGRAM;
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		previousEnv.clear();
	});

	it("leave no text or scroll behind on a terminal that prints them", async () => {
		harness = createProcessTerminalRenderHarness(COLUMNS, ROWS, { conpty: false }, { deferInput: true });
		harness.tui.addChild(new PromptFrame());
		await harness.settle();
		// The probes go out after the prepaint, with the cursor on the bottom row.
		harness.tui.enableInput();
		await harness.settle();

		// Replay the output the way Apple Terminal treats probes it does not
		// implement: an APC loses its `ESC _` / `ESC \` framing and its payload
		// prints, and DECRQM (`CSI ? Ps $ p`) is abandoned at the `$`, printing `p`.
		const replay = harness.writes
			.join("")
			.replace(/\x1b_([\s\S]*?)\x1b\\/g, "$1")
			.replace(/\x1b\[\?\d+\$p/g, "p");
		// Precondition: this terminal really prints probe payloads, wider than a row.
		expect(replay).toContain('tsp;q;{"q":"hello"');

		const screen = new VirtualTerminal(COLUMNS, ROWS);
		screen.write(replay);
		expect(screen.getBufferPosition().baseY).toBe(0);
		expect(screen.getViewport().map(row => row.trimEnd())).toEqual(["x".repeat(COLUMNS), ...BODY, ">"]);
	});
});
