import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

class RecordingVirtualTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("TUI normal-buffer mouse tracking", () => {
	it("stays disabled for hosts that do not opt in", () => {
		const terminal = new RecordingVirtualTerminal();
		const tui = new TUI(terminal);
		try {
			tui.start();
			expect(terminal.writes.join("")).not.toContain(MOUSE_TRACKING_ON);
		} finally {
			tui.stop();
		}
	});

	it("emits tracking reports only after explicit opt-in and cleans them up", () => {
		const terminal = new RecordingVirtualTerminal();
		const tui = new TUI(terminal);
		try {
			tui.start();
			const beforeEnable = terminal.writes.length;
			tui.setMouseTracking(true);
			expect(terminal.writes.slice(beforeEnable).join("")).toContain(MOUSE_TRACKING_ON);

			const beforeDisable = terminal.writes.length;
			tui.setMouseTracking(false);
			expect(terminal.writes.slice(beforeDisable).join("")).toContain(MOUSE_TRACKING_OFF);
		} finally {
			tui.stop();
		}
	});

	it("suspends normal tracking for blocking overlays but not passive overlays", () => {
		const terminal = new RecordingVirtualTerminal();
		const tui = new TUI(terminal);
		const overlay = { render: () => ["overlay"] };
		try {
			tui.start();
			tui.setMouseTracking(true);

			const beforeBlocking = terminal.writes.length;
			const blocking = tui.showOverlay(overlay);
			expect(terminal.writes.slice(beforeBlocking).join("")).toContain(MOUSE_TRACKING_OFF);

			const beforeRestore = terminal.writes.length;
			blocking.hide();
			expect(terminal.writes.slice(beforeRestore).join("")).toContain(MOUSE_TRACKING_ON);

			const beforePassive = terminal.writes.length;
			const passive = tui.showOverlay(overlay, { focus: false });
			expect(terminal.writes.slice(beforePassive).join("")).not.toContain(MOUSE_TRACKING_OFF);
			passive.hide();
		} finally {
			tui.stop();
		}
	});
});
