import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function createAssistant(): AssistantMessageComponent {
	const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
	assistant.setHideThinkingBlock = vi.fn();
	return assistant;
}

describe("InputController thinking visibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses to toggle and informs the user when thinking level is off", () => {
		// When thinking is "off", effectiveHideThinkingBlock is true even if the
		// user's hideThinkingBlock setting is false. The toggle should refuse
		// instead of silently no-op'ing or corrupting the setting.
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings,
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
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("allows toggling when thinking is off after reasoning content was received", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetOrder: string[] = [];
		const resetDisplay = vi.fn(() => resetOrder.push("display"));
		const resetStableEmission = vi.fn(() => resetOrder.push("stable emission"));
		const ctx = createInteractiveModeContext({
			hideThinkingBlock: false,
			// Mirrors InteractiveMode.effectiveHideThinkingBlock: the helper writes
			// ctx.hideThinkingBlock before propagating, so the fake must derive the
			// effective value instead of freezing it.
			get effectiveHideThinkingBlock(): boolean {
				const thinkingOff = (this.session?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
				return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
			},
			hasDisplayableThinkingContent: true,
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: ThinkingLevel.Off },
			chatContainer: {
				children: [assistant],
				clear: vi.fn(),
				addChild: vi.fn(),
				resetStableEmission,
			},
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		});

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(resetOrder).toEqual(["stable emission", "display"]);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("refuses to toggle when the focused view session has thinking off", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true,
			settings,
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
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
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
		const settings = Settings.isolated();
		cfgHideThinkingBlock.set(settings, true);
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: true,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings,
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
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("resyncs the streaming reveal controller instead of pushing the raw message on a mid-stream toggle", () => {
		// Ctrl+T mid-reveal regression: the toggle used to call
		// `streamingComponent.updateContent(rawStreamingMessage)` — the raw
		// cumulative message bypasses the reveal controller's truncating view, so
		// the text snaps to 100% and re-types (and the non-transient update zeroes
		// the streaming gauges for a frame). The toggle must hand the in-flight
		// render back to the reveal controller.
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const streamingComponent = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
		streamingComponent.setHideThinkingBlock = vi.fn();
		streamingComponent.updateContent = vi.fn();
		const updateContent = streamingComponent.updateContent as Mock<
			(message: AssistantMessage, options?: { transient?: boolean }) => void
		>;
		const streamingMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning through the answer", thinkingSignature: "sig" },
				{ type: "text", text: "the visible answer tail" },
			],
		} as unknown as AssistantMessage;
		const resyncStreamingRevealVisibility = vi.fn();
		const settings = Settings.isolated();
		const resetOrder: string[] = [];
		const resetDisplay = vi.fn(() => resetOrder.push("display"));
		const resetStableEmission = vi.fn(() => resetOrder.push("stable emission"));
		const ctx = createInteractiveModeContext({
			hideThinkingBlock: false,
			// Mirrors InteractiveMode.effectiveHideThinkingBlock: the helper writes
			// ctx.hideThinkingBlock before propagating, so the fake must derive the
			// effective value instead of freezing it.
			get effectiveHideThinkingBlock(): boolean {
				const thinkingOff = (this.session?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
				return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
			},
			hasDisplayableThinkingContent: true,
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: ThinkingLevel.High },
			chatContainer: {
				children: [assistant],
				clear: vi.fn(),
				addChild: vi.fn(),
				resetStableEmission,
			},
			streamingComponent,
			streamingMessage,
			eventController: { resyncStreamingRevealVisibility },
			showStatus: vi.fn(),
			ui: { resetDisplay },
		});

		new InputController(ctx).toggleThinkingBlockVisibility();

		// The reveal controller — never the toggle — owns the in-flight render.
		expect(updateContent).not.toHaveBeenCalled();
		expect(resyncStreamingRevealVisibility).toHaveBeenCalledTimes(1);
		expect(streamingComponent.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(resetOrder).toEqual(["stable emission", "display"]);
		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
	});

});
