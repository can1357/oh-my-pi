import { vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { TUI } from "@oh-my-pi/pi-tui";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { VirtualRenderScheduler } from "../virtual-render-scheduler";
import { VirtualTerminal } from "../virtual-terminal";

export const BTW_SHEET_HEIGHT = 24;
export const BTW_SHEET_WIDE = 120;

/** Answer rows long enough that a first and a last row cannot share one sheet's viewport. */
export function btwAnswerRows(topic: string, count = 40): string {
	return Array.from({ length: count }, (_, row) => `row ${row} of ${topic}`).join("\n");
}

interface OpenBtwSheetOptions {
	width?: number;
	height?: number;
	/** Defaults to accepting every follow-up. */
	onFollowUp?: (record: BtwHistoryRecord, question: string) => Promise<boolean>;
}

/** Mount the BTW history sheet fullscreen on a virtual terminal, as the sheet's own overlay does. */
export async function openBtwSheet(records: readonly BtwHistoryRecord[], options: OpenBtwSheetOptions = {}) {
	const width = options.width ?? BTW_SHEET_WIDE;
	const height = options.height ?? BTW_SHEET_HEIGHT;
	const terminal = new VirtualTerminal(width, height);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	const onFollowUp = vi.fn(options.onFollowUp ?? (async () => true));
	const panel = new BtwHistoryPanel({
		records,
		onClose: vi.fn(),
		onCopy: vi.fn(),
		onCancel: vi.fn(),
		canFollowUp: () => true,
		onFollowUp,
		requestRender: () => tui.requestRender(),
		getHeight: () => height,
	});
	tui.start();
	await scheduler.settle(terminal);
	tui.showOverlay(panel, { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
	tui.setFocus(panel);
	await scheduler.settle(terminal);
	return { terminal, scheduler, tui, panel, onFollowUp, width, height };
}

/** The sheet's visible rows as plain text: what the reader actually sees. */
export function btwViewport(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => stripVTControlCharacters(row));
}
