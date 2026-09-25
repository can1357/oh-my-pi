/**
 * Contract: a compaction-end carrying a result rebuilds the transcript —
 * `rebuildChatFromMessages` clears the container's emission ledger — so the
 * repaint that follows MUST clear native scrollback (forced), whether or not
 * `display.collapseCompacted` is on. Without that clear every block re-emits
 * over the rows still sitting in native scrollback and each compaction
 * appends a duplicate copy of the whole transcript (#12140).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function compactionResultEvent(): AgentSessionEvent {
	return {
		type: "auto_compaction_end",
		action: "snapcompact",
		result: { summary: "compacted summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
		aborted: false,
		willRetry: false,
	};
}

async function dispatchCompactionEnd(collapseCompacted: boolean) {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.collapseCompacted": collapseCompacted } });
	const context = createInteractiveModeContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent(compactionResultEvent());
	} finally {
		controller.dispose();
	}
	return context;
}

describe("auto compaction-end scrollback pairing", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("pairs the rebuild with a forced scrollback clear when collapseCompacted is off", async () => {
		const context = await dispatchCompactionEnd(false);

		expect(context.rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(context.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("keeps the same forced scrollback clear when collapseCompacted is on", async () => {
		const context = await dispatchCompactionEnd(true);

		expect(context.rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(context.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});
