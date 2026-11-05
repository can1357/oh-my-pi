import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { TUI } from "@oh-my-pi/pi-tui";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 80;
const HEIGHT = 24;
let darkTheme: Theme | undefined;

withoutTerminalMultiplexer();

describe("BtwHistoryPanel follow-up hardware cursor", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
	});

	it("parks the hardware cursor at the follow-up caret so IME preedit anchors there", async () => {
		const terminal = new VirtualTerminal(WIDTH, HEIGHT);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		const panel = new BtwHistoryPanel({
			records: [
				{
					id: "topic",
					leafId: "leaf",
					question: "hello",
					answer: "Hello answer",
					status: "complete",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			onClose: vi.fn(),
			onCopy: vi.fn(),
			onCancel: vi.fn(),
			canFollowUp: () => true,
			onFollowUp: vi.fn(async () => true),
			requestRender: () => tui.requestRender(),
			getHeight: () => HEIGHT,
		});

		tui.start();
		try {
			await scheduler.settle(terminal);
			tui.showOverlay(panel, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			tui.setFocus(panel);
			await scheduler.settle(terminal);
			expect(tui.getShowHardwareCursor()).toBe(true);

			// Enter opens the follow-up composer; then type a draft.
			terminal.sendInput("\r");
			await scheduler.settle(terminal);
			terminal.sendInput("f");
			await scheduler.settle(terminal);

			const viewport = terminal.getViewport().map(row => stripVTControlCharacters(row));
			const row = viewport.findIndex(line => line.includes("Follow up: f"));
			expect(row).toBeGreaterThanOrEqual(0);
			const col = viewport[row]!.indexOf("Follow up: f") + "Follow up: f".length;
			expect(terminal.getCursor()).toEqual({ row, col });
		} finally {
			tui.stop();
		}
	});
});
