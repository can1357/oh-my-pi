import { beforeAll, describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

describe("InputController tool output expansion", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	function shellBlocks(hidden = false) {
		const ctx = createInteractiveModeContext({ hideToolActivity: hidden });
		const transcript = new BashExecutionComponent("transcript output", ctx.ui);
		const pending = new BashExecutionComponent("pending output", ctx.ui);
		for (const [component, marker] of [
			[transcript, "TRANSCRIPT_FIRST"],
			[pending, "PENDING_FIRST"],
		] as const) {
			component.setComplete(0, false, {
				output: [marker, ...Array.from({ length: 40 }, (_, index) => `output row ${index}`)].join("\n"),
			});
		}
		ctx.chatContainer.addChild(transcript);
		ctx.pendingShellContainer.addChild(pending);
		return { ctx, transcript, pending };
	}

	it("reveals clipped transcript and pending shell output, then collapses both", () => {
		const { ctx, transcript, pending } = shellBlocks();
		try {
			expect(transcript.render(100).join("\n")).not.toContain("TRANSCRIPT_FIRST");
			expect(pending.render(100).join("\n")).not.toContain("PENDING_FIRST");
			const controller = new InputController(ctx);
			controller.toggleToolOutputExpansion();
			expect(transcript.render(100).join("\n")).toContain("TRANSCRIPT_FIRST");
			expect(pending.render(100).join("\n")).toContain("PENDING_FIRST");
			controller.toggleToolOutputExpansion();
			expect(transcript.render(100).join("\n")).not.toContain("TRANSCRIPT_FIRST");
			expect(pending.render(100).join("\n")).not.toContain("PENDING_FIRST");
		} finally {
			transcript.dispose();
			pending.dispose();
		}
	});

	it("keeps transcript and pending shell output collapsed while tool activity is hidden", () => {
		const { ctx, transcript, pending } = shellBlocks(true);
		try {
			new InputController(ctx).toggleToolOutputExpansion();
			expect(ctx.toolOutputExpanded).toBe(false);
			expect(transcript.render(100).join("\n")).not.toContain("TRANSCRIPT_FIRST");
			expect(pending.render(100).join("\n")).not.toContain("PENDING_FIRST");
		} finally {
			transcript.dispose();
			pending.dispose();
		}
	});
});

describe("InputController tool activity visibility", () => {
	it("persists the toggle, preserves transient children, and reveals tools collapsed", () => {
		const pendingUserMessage = { kind: "pending-user" };
		const loadingIndicator = { kind: "loading" };
		const assistant = new AssistantMessageComponent();
		const setToolResultImagesVisible = vi.spyOn(assistant, "setToolResultImagesVisible");
		const children = [pendingUserMessage, assistant, loadingIndicator];
		const clear = vi.fn();
		const addChild = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const settings = Settings.isolated();
		const clearInlineImages = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const setToolActivityVisible = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings,
			chatContainer: { children, clear, addChild, setToolActivityVisible },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(true);
	});
});
