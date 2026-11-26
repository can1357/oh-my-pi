import { beforeAll, describe, expect, it } from "bun:test";
import { UiNode } from "@oh-my-pi/pi-tui";
import { extensionOverlay } from "../../src/modes/controllers/extension-ui-blocks";
import { PtyConsole, PtyConsoleModel } from "../../src/ui/overlays/panels/pty-console";
import { initTheme } from "../../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, renderRows } from "../helpers/mode-terminal";

/** A view that draws two rows of its own. */
function twoRows(): UiNode {
	return new UiNode("col", {
		children: [new UiNode("text", { text: "Parity overlay" }), new UiNode("text", { text: "Escape closes it" })],
	});
}

/** A started shell on a memory terminal; disposed after `run`. */
async function withTerminal(run: (term: ModeTerminal) => Promise<void>): Promise<void> {
	const term = createModeTerminal({ columns: 60, rows: 12 });
	await term.start();
	try {
		await run(term);
	} finally {
		term.frame.shell.overlays.closeAll();
		await term.frame.shell.stop();
		term.frame.shell.surface.dispose();
		term.dispose();
	}
}

describe("sheets in terminal rows", () => {
	beforeAll(() => {
		initTheme();
	});

	it("draws an extension overlay without a frame over the bottom rows, at the screen's width", () =>
		withTerminal(async term => {
			term.frame.composer.setText("draft under the overlay");
			await term.waitFor(screen => screen.some(row => row.includes("draft under the overlay")));
			term.frame.shell.overlays.show(() => extensionOverlay(twoRows(), false, false));
			await term.waitFor(screen => screen.some(row => row.includes("Parity overlay")));

			// Its rows are the screen's last ones, whole: nothing of the composer shows beside them.
			expect(
				term
					.screen()
					.slice(-2)
					.map(row => row.trimEnd()),
			).toEqual(["Parity overlay", "Escape closes it"]);
		}));

	it("centers a fullscreen extension overlay on an otherwise empty screen", () =>
		withTerminal(async term => {
			term.frame.shell.overlays.show(() => extensionOverlay(twoRows(), true, false));
			await term.waitFor(screen => screen.some(row => row.includes("Parity overlay")));

			const screen = term.screen().map(row => row.trimEnd());
			expect(screen.slice(0, 5)).toEqual(["", "", "", "", ""]);
			expect(screen.slice(5)).toEqual(["Parity overlay", "Escape closes it"]);
		}));

	it("draws the interactive console as one box: status head, the PTY screen, the force-kill foot", async () => {
		const model = new PtyConsoleModel("printf ready", PtyConsoleModel.gridFor(60, 20), {
			onInput: () => {},
			onKill: () => {},
			onResize: () => {},
		});
		try {
			model.append("ready\r\n");
			await model.flush();
			const rows = renderRows(() => PtyConsole({ model }), 60);

			// Head, the 12 PTY rows of a 20-row terminal, foot, inside the frame.
			expect(rows).toHaveLength(16);
			expect(rows.every(row => row.length === 60)).toBe(true);
			expect(rows[0]).toMatch(/^╭─+╮$/);
			expect(rows[1]).toMatch(/^│\S+ Console printf ready \Srunning\S +│$/);
			expect(rows[2]).toMatch(/^│ready +│$/);
			expect(rows[14]).toMatch(/^│\S+ force-kill · input forwarded to PTY +│$/);
			expect(rows[15]).toMatch(/^╰─+╯$/);

			model.complete({ exitCode: 0, cancelled: false, timedOut: false });
			const ended = renderRows(() => PtyConsole({ model }), 60);
			expect(ended[1]).toMatch(/Console printf ready \Sexit 0\S +│$/);
			expect(ended[14]).toMatch(/^│session finished +│$/);
		} finally {
			model.dispose();
		}
	});
});
