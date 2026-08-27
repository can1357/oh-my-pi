import { describe, expect, it, type Mock, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createAssistant(): AssistantMessageComponent {
	const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
	assistant.setHideThinkingBlock = vi.fn();
	return assistant;
}

describe("InputController thinking visibility", () => {
	it("refuses to toggle and informs the user when thinking level is off", () => {
		// When thinking is "off", effectiveHideThinkingBlock is true even if the
		// user's hideThinkingBlock setting is false. The toggle should refuse
		// instead of silently no-op'ing or corrupting the setting.
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const set = vi.fn();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings: { set },
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		// Setting was not changed, components were not updated, no reset.
		expect(ctx.hideThinkingBlock).toBe(false);
		expect(set).not.toHaveBeenCalled();
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("allows toggling when thinking is off after reasoning content was received", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const set = vi.fn();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: false,
			hasDisplayableThinkingContent: true,
			settings: { set },
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(set).toHaveBeenCalledWith("hideThinkingBlock", true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("refuses to toggle when the focused view session has thinking off", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const set = vi.fn();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true,
			settings: { set },
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "high" },
			viewSession: { thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(false);
		expect(set).not.toHaveBeenCalled();
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("refuses to toggle when thinking is off even if hideThinkingBlock is already true", () => {
		// The persisted preference may already be true from a prior session
		// where thinking was on. With thinking off, effectiveHideThinkingBlock
		// is true regardless, so any toggle is a no-op — guard it rather than
		// flipping the persisted preference back to false.
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const set = vi.fn();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: true,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings: { set },
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		// Persisted preference unchanged, no component updates, no reset.
		expect(ctx.hideThinkingBlock).toBe(true);
		expect(set).not.toHaveBeenCalled();
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});
});
