import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI start listeners", () => {
	it("fires registered hooks on initial start and restart", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		tui.addStartListener(() => {
			starts++;
		});

		try {
			tui.start();
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("runs a hook added to an already started TUI at once, then on each restart", () => {
		// The prepaint composer starts the TUI before the interactive mode wires its
		// controllers, so their hooks are added after the start they would react to.
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;

		try {
			tui.start();
			tui.addStartListener(() => {
				starts++;
			});
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("holds a hook added to a stopped TUI until the next start", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;

		try {
			tui.start();
			tui.stop();
			tui.addStartListener(() => {
				starts++;
			});
			expect(starts).toBe(0);

			tui.start();
			expect(starts).toBe(1);
		} finally {
			tui.stop();
		}
	});
});
