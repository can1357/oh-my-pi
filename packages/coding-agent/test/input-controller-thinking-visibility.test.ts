import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

function createContext(options: {
	hideThinkingBlock: boolean;
	thinkingLevel: string;
	viewThinkingLevel?: string;
	hasDisplayableThinkingContent?: boolean;
}) {
	const settings = Settings.isolated();
	if (options.hideThinkingBlock) cfgHideThinkingBlock.set(settings, true);
	const showStatus = vi.fn();
	const replayHistory = vi.fn();
	const ctx = {
		hideThinkingBlock: options.hideThinkingBlock,
		hasDisplayableThinkingContent: options.hasDisplayableThinkingContent ?? false,
		settings,
		session: { thinkingLevel: options.thinkingLevel },
		viewSession: options.viewThinkingLevel ? { thinkingLevel: options.viewThinkingLevel } : undefined,
		shell: { host: { replayHistory } },
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, settings, showStatus, replayHistory };
}

describe("InputController thinking visibility", () => {
	it("refuses to toggle and informs the user when thinking level is off", () => {
		// With thinking "off", thinking blocks stay hidden regardless of the
		// preference: the toggle refuses instead of silently corrupting it.
		const { ctx, settings, showStatus, replayHistory } = createContext({
			hideThinkingBlock: false,
			thinkingLevel: "off",
		});

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(false);
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
		expect(replayHistory).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("allows toggling when thinking is off after reasoning content was received", () => {
		const { ctx, settings, showStatus, replayHistory } = createContext({
			hideThinkingBlock: false,
			thinkingLevel: "off",
			hasDisplayableThinkingContent: true,
		});

		new InputController(ctx).toggleThinkingBlockVisibility();

		// The flag is reactive (live blocks follow it); retired rows need the
		// scrollback rebuilt (#10177).
		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(replayHistory).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("refuses to toggle when the focused view session has thinking off", () => {
		const { ctx, settings, showStatus, replayHistory } = createContext({
			hideThinkingBlock: false,
			thinkingLevel: "high",
			viewThinkingLevel: "off",
		});

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(false);
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
		expect(replayHistory).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("refuses to toggle when thinking is off even if hideThinkingBlock is already true", () => {
		// The persisted preference may already be true from a prior session
		// where thinking was on; flipping it back here would corrupt it.
		const { ctx, settings, showStatus, replayHistory } = createContext({
			hideThinkingBlock: true,
			thinkingLevel: "off",
		});

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(replayHistory).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});
});
