import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/assistant-message";
import {
	buildDisplayMessage,
	CATCHUP_FRAMES,
	MIN_STEP,
	nextStep,
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
	visibleUnits,
} from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/streaming-reveal";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function makeUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

function textAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "text") {
		throw new Error(`Expected text block at index ${index}`);
	}
	return block.text;
}

function thinkingAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "thinking") {
		throw new Error(`Expected thinking block at index ${index}`);
	}
	return block.thinking;
}

class RecordingComponent {
	messages: AssistantMessage[] = [];
	transientFlags: Array<boolean | undefined> = [];

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.messages.push(message);
		this.transientFlags.push(opts?.transient);
	}
}

function latestMessage(component: RecordingComponent): AssistantMessage {
	const message = component.messages.at(-1);
	if (!message) {
		throw new Error("Expected at least one rendered message");
	}
	return message;
}

function makeController(
	options: { smooth?: boolean; hideThinking?: boolean; proseOnly?: () => boolean; requestRender?: () => void } = {},
) {
	const component = new RecordingComponent();
	const controller = new StreamingRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		getHideThinkingBlock: () => options.hideThinking ?? false,
		getProseOnlyThinking: options.proseOnly ?? (() => true),
		requestRender: options.requestRender ?? (() => {}),
	});
	return { component, controller };
}

describe("streaming reveal", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("slices at grapheme boundaries without mutating the target message", () => {
		const familyEmoji = "👨‍👩‍👧‍👦";
		const target = makeMessage([{ type: "text", text: `${familyEmoji}B` }]);

		expect(visibleUnits(target, false)).toBe(2);
		const display = buildDisplayMessage(target, 1, false);

		expect(textAt(display, 0)).toBe(familyEmoji);
		expect(textAt(target, 0)).toBe(`${familyEmoji}B`);
	});

	it("excludes hidden thinking from the reveal budget and passes it through", () => {
		const thinkingBlock = { type: "thinking" as const, thinking: "thought" };
		const target = makeMessage([thinkingBlock, { type: "text", text: "answer" }]);

		expect(visibleUnits(target, true)).toBe("answer".length);
		const display = buildDisplayMessage(target, 1, true);

		expect(display.content[0]).toBe(thinkingBlock);
		expect(thinkingAt(display, 0)).toBe("thought");
		expect(textAt(display, 1)).toBe("a");
	});

	it("excludes dot-only reasoning placeholders from the reveal budget", () => {
		const thinkingBlock = { type: "thinking" as const, thinking: "...", thinkingSignature: "reasoning_content" };
		const target = makeMessage([thinkingBlock, { type: "text", text: "answer" }]);

		expect(visibleUnits(target, false)).toBe("answer".length);
		const display = buildDisplayMessage(target, 1, false);

		expect(display.content[0]).toBe(thinkingBlock);
		expect(textAt(display, 1)).toBe("a");
	});

	it("keeps pure-code thinking visible as an ascii ellipsis", () => {
		const target = makeMessage([
			{ type: "thinking", thinking: "```js\nconst x = 1;\n```" },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false)).toBe("...answer".length);
		const display = buildDisplayMessage(target, 3, false);

		expect(thinkingAt(display, 0)).toBe("...");
		expect(textAt(display, 1)).toBe("");

		const component = new AssistantMessageComponent(display);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("...");
	});

	it("refreshes prose-only setting during unsmoothed streaming updates", () => {
		let proseOnly = true;
		const target = makeMessage([{ type: "thinking", thinking: "```js\nconst x = 1;\n```" }]);
		const { component, controller } = makeController({ smooth: false, proseOnly: () => proseOnly });

		controller.begin(component, target);
		expect(thinkingAt(latestMessage(component), 0)).toBe("...");

		proseOnly = false;
		controller.setTarget(target);
		expect(thinkingAt(latestMessage(component), 0)).toBe("```js\nconst x = 1;\n```");
	});

	it("smooths thinking content when thinking is shown", () => {
		const target = makeMessage([
			{ type: "thinking", thinking: "thought" },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false)).toBe("thoughtanswer".length);
		const display = buildDisplayMessage(target, 3, false);

		expect(thinkingAt(display, 0)).toBe("tho");
		expect(textAt(display, 1)).toBe("");
	});

	it("uses an adaptive catchup step with the configured floor", () => {
		const largeBacklog = CATCHUP_FRAMES * 101;
		const step = nextStep(largeBacklog);

		expect(step).toBe(101);
		expect(step * CATCHUP_FRAMES).toBeGreaterThanOrEqual(largeBacklog);
		expect(nextStep(1)).toBe(MIN_STEP);
		expect(nextStep(MIN_STEP * CATCHUP_FRAMES)).toBe(MIN_STEP);
	});

	it("reveals cumulative targets to the exact final text with monotonic prefixes", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const first = makeMessage([{ type: "text", text: "Hello" }]);
		const second = makeMessage([{ type: "text", text: "Hello world" }]);

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(first);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		controller.setTarget(second);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		const renderedTexts = component.messages.map(message => textAt(message, 0));
		expect(renderedTexts.at(-1)).toBe("Hello world");
		for (let i = 1; i < renderedTexts.length; i++) {
			expect(renderedTexts[i].length).toBeGreaterThanOrEqual(renderedTexts[i - 1].length);
			expect("Hello world".startsWith(renderedTexts[i])).toBe(true);
		}
	});

	it("keeps grapheme counts correct when an append extends the final cluster", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		// The appended ZWJ sequence merges into the previous final grapheme:
		// "👨" + "\u200D👩" becomes a single cluster, so the cached per-block
		// count must re-segment from that cluster, not just add the suffix.
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨\u200D👩x" }]));
		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		expect(textAt(latestMessage(component), 0)).toBe("ab👨\u200D👩x");
	});

	it("renders full targets immediately when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]));
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("chunky");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("marks unsmoothed in-flight updates as transient", () => {
		const { component, controller } = makeController({ smooth: false });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]));

		expect(component.transientFlags).toEqual([true, true]);
	});

	it("keeps smooth catch-up renders transient until the final message_end render", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abc" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(textAt(latestMessage(component), 0)).toBe("abc");
		expect(component.transientFlags).not.toHaveLength(0);
		expect(component.transientFlags.every(flag => flag === true)).toBe(true);
	});

	it("stop halts pending ticker updates", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		controller.stop();
		const updates = component.messages.length;
		const lastText = textAt(latestMessage(component), 0);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(component.messages).toHaveLength(updates);
		expect(textAt(latestMessage(component), 0)).toBe(lastText);
	});

	it("snaps to full text when a tool call arrives", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("abc");

		controller.setTarget(
			makeMessage([
				{ type: "text", text: "abcdefghi" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			]),
		);
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("abcdefghi");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
