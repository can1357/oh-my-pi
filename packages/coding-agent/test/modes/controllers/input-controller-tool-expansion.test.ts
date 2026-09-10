import { describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("InputController tool output expansion", () => {
	it("expands only unborrowed cards while preserving the ordered native-history prefix", () => {
		const card = (label: string) => {
			let expanded = false;
			return {
				render: () => (expanded ? [label, `${label} details`] : [label]),
				setExpanded: (value: boolean) => {
					expanded = value;
				},
				isTranscriptBlockFinalized: () => true,
			};
		};
		const chatContainer = new TranscriptContainer();
		const frontier = { render: () => ["frontier"], isTranscriptBlockFinalized: () => false };
		chatContainer.addChild(frontier);
		chatContainer.addChild(card("borrowed first"));
		chatContainer.addChild(card("borrowed second"));
		chatContainer.addChild(card("live"));
		const viewport = chatContainer.renderViewport(80, 20, { tick: 0, now: 0 });
		chatContainer.setBorrowedViewportRows(viewport.indexOf("live"));
		const ctx = {
			toolOutputExpanded: false,
			chatContainer,
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		controller.setToolsExpanded(true);
		expect(chatContainer.render(80).filter(Boolean)).toEqual([
			"frontier",
			"borrowed first",
			"borrowed second",
			"live",
			"live details",
		]);
		controller.setToolsExpanded(false);
		expect(chatContainer.render(80).filter(Boolean)).toEqual([
			"frontier",
			"borrowed first",
			"borrowed second",
			"live",
		]);
	});

	it("does not expand hidden tool activity and explains why", () => {
		const expandable = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getDisplayString: vi.fn(() => "Alt+H") },
			showStatus,
			ui: { requestRender },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Alt+H"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
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
		const set = vi.fn();
		const clearInlineImages = vi.fn();
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const setToolActivityVisible = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings: { set },
			chatContainer: { children, clear, addChild, setToolActivityVisible },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, requestRender },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(set).toHaveBeenLastCalledWith("display.hideToolActivity", true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(requestRender.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: hidden");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(set).toHaveBeenLastCalledWith("display.hideToolActivity", false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: visible");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(true);
	});
});
