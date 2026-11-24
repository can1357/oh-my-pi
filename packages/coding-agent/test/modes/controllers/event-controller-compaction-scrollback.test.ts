/**
 * Contract: a compaction rebuilds the transcript (the rebuild replays terminal
 * scrollback itself), whether or not
 * `display.collapseCompacted` is on. Without that clear every block re-emits over the rows still sitting in
 * native scrollback and each compaction appends a duplicate copy of the whole
 * transcript (#12140). Covers both compaction paths: the automatic
 * `auto_compaction_end` handler and the manual `/compact`
 * (`CommandController.executeCompaction`) route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { initTheme } from "../../../src/ui/theme/service";

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
		initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("rebuilds the transcript when collapseCompacted is off", async () => {
		const context = await dispatchCompactionEnd(false);

		expect(context.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(context.statusLine.refresh).toHaveBeenCalled();
	});

	it("rebuilds the same way when collapseCompacted is on", async () => {
		const context = await dispatchCompactionEnd(true);

		expect(context.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(context.statusLine.refresh).toHaveBeenCalled();
	});
});

describe("manual /compact scrollback pairing", () => {
	beforeEach(async () => {
		initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	async function runCompact(collapseCompacted: boolean) {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.collapseCompacted": collapseCompacted } });
		const ctx = createInteractiveModeContext({
			session: { compact: vi.fn(async () => ({ summary: "s", firstKeptEntryId: "e", tokensBefore: 1 })) },
		});
		const controller = new CommandController(ctx);
		await controller.executeCompaction();
		return ctx;
	}

	it("rebuilds the transcript after /compact when collapseCompacted is off", async () => {
		const ctx = await runCompact(false);

		expect(ctx.showWorking).toHaveBeenCalledWith(
			"maintenance",
			expect.objectContaining({ label: "Compacting context…" }),
		);
		expect(ctx.working).toBeUndefined();
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
	});

	it("rebuilds the same way after /compact when collapseCompacted is on", async () => {
		const ctx = await runCompact(true);

		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
	});
});
