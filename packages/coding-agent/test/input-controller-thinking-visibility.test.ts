import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import {
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/** The revealed text of the answer block in a rendered assistant message. */
function answerText(message: AssistantMessage): string {
	const block = message.content[1];
	if (block?.type !== "text") throw new Error("Expected a text block at index 1");
	return block.text;
}

function createAssistant(): AssistantMessageComponent {
	const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
	assistant.setHideThinkingBlock = vi.fn();
	return assistant;
}

describe("InputController thinking visibility", () => {
	afterEach(() => {
		vi.useRealTimers();
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

	it("keeps the answer at its reveal position when Ctrl+T hides thinking mid-reveal", () => {
		// Ctrl+T mid-reveal regression: the toggle used to call
		// `streamingComponent.updateContent(rawStreamingMessage)` — the raw
		// cumulative message bypasses the reveal controller's truncating view, so
		// the text snaps to 100% and re-types (and the non-transient update zeroes
		// the streaming gauges for a frame). The toggle must hand the in-flight
		// render back to the reveal controller, and the answer must stay exactly
		// where the user watched it.
		//
		// The reveal controller is the real one here, not a spy: the contract is
		// the DISPLAYED message, so a resync that snapped or retyped the answer
		// has to fail this test.
		const rendered: AssistantMessage[] = [];
		const revealComponent = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
		revealComponent.updateContent = (message: AssistantMessage) => {
			rendered.push(message);
		};
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const streamingComponent = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
		streamingComponent.setHideThinkingBlock = vi.fn();
		streamingComponent.updateContent = vi.fn();
		const updateContent = streamingComponent.updateContent as Mock<
			(message: AssistantMessage, options?: { transient?: boolean }) => void
		>;
		const answer = "the visible answer tail that the user is reading. ".repeat(6);
		const streamingMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning through the answer.", thinkingSignature: "sig" },
				{ type: "text", text: answer },
			],
		} as unknown as AssistantMessage;
		const settings = Settings.isolated();
		const resetOrder: string[] = [];
		const resetDisplay = vi.fn(() => resetOrder.push("display"));
		const resetStableEmission = vi.fn(() => resetOrder.push("stable emission"));
		const revealRef: { controller?: StreamingRevealController } = {};
		const resyncStreamingRevealVisibility = vi.fn(() => revealRef.controller?.resyncVisibility());
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
			proseOnlyThinking: true,
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
		revealRef.controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => ctx.proseOnlyThinking,
			requestRender: () => {},
		});

		vi.useFakeTimers();
		revealRef.controller.begin(revealComponent, streamingMessage, false);
		// Let the reveal pace part of the answer out, so the frontier sits inside
		// the answer rather than at its end.
		for (let frame = 0; frame < 3; frame++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		const framesBefore = rendered.length;
		const answerBefore = answerText(rendered.at(-1)!);
		expect(answerBefore.length).toBeGreaterThan(0);
		expect(answerBefore.length).toBeLessThan(answer.length);

		new InputController(ctx).toggleThinkingBlockVisibility();

		// The reveal controller — never the toggle — owns the in-flight render.
		expect(updateContent).not.toHaveBeenCalled();
		expect(resyncStreamingRevealVisibility).toHaveBeenCalledTimes(1);
		// The resync ran and produced a frame of its own.
		expect(rendered.length).toBeGreaterThan(framesBefore);
		// The answer stays exactly where the user watched it: hiding the
		// reasoning must not snap the answer to 100% or re-type it.
		expect(answerText(rendered.at(-1)!)).toBe(answerBefore);
		expect(streamingComponent.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(resetOrder).toEqual(["stable emission", "display"]);
		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
	});
});
