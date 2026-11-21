import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, TUI } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// kitty implements DEC 2026 by snapshotting the screen, cursor visibility
// included, at ?2026h and presenting that snapshot until ?2026l. A paint that
// hides the cursor before opening the synchronized update makes kitty present a
// cursorless frame on every animation tick, so a resting cursor flashes.

const SYNC_OVERRIDE_KEYS = ["PI_NO_SYNC_OUTPUT", "PI_FORCE_SYNC_OUTPUT", "PI_TUI_SYNC_OUTPUT"] as const;

class RecordingTerminal extends VirtualTerminal {
	output = "";

	override write(data: string): void {
		this.output += data;
		super.write(data);
	}
}

class SpinnerPrompt implements Component {
	frame = 0;

	invalidate(): void {}

	render(): string[] {
		return [`working ${"|/-\\"[this.frame % 4]}`, `> ${CURSOR_MARKER}`];
	}
}

/** Cursor visibility a kitty-style terminal presents for each synchronized update in `output`. */
function presentedCursorVisibility(output: string): boolean[] {
	const presented: boolean[] = [];
	let visible = true;
	for (const [seq] of output.matchAll(/\x1b\[\?(?:25|2026)[hl]/g)) {
		if (seq === "\x1b[?2026h") presented.push(visible);
		else if (seq === "\x1b[?25h") visible = true;
		else if (seq === "\x1b[?25l") visible = false;
	}
	return presented;
}

describe("synchronized paint cursor visibility", () => {
	const previous = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of SYNC_OVERRIDE_KEYS) {
			previous.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		Bun.env.PI_FORCE_SYNC_OUTPUT = "1";
	});

	afterEach(() => {
		for (const key of SYNC_OVERRIDE_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		previous.clear();
	});

	it("keeps a resting hardware cursor visible through animation ticks", async () => {
		const terminal = new RecordingTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		const prompt = new SpinnerPrompt();
		tui.addChild(prompt);
		tui.start();
		await scheduler.settle(terminal);
		try {
			for (let tick = 1; tick <= 3; tick++) {
				prompt.frame = tick;
				tui.requestRender();
				await scheduler.settle(terminal);
			}
			expect(terminal.getViewport()[0]).toContain("working \\");
			expect(presentedCursorVisibility(terminal.output).slice(-3)).toEqual([true, true, true]);
		} finally {
			tui.stop();
		}
	});
});
