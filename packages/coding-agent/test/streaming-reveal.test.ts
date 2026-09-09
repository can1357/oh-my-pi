import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import {
	BlockUnitCounter,
	buildDisplayMessage,
	CATCHUP_FRAMES,
	MIN_STEP,
	nextStep,
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
	visibleUnits,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSegmenter } from "@oh-my-pi/pi-tui";

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

	// Component protocol stub — the reveal controller now hands the component
	// to `requestComponentRender`, which only exercises identity, so returning
	// an empty rendered frame is sufficient for these tests.
	render(): readonly string[] {
		return [];
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

		controller.begin(component, target, false);
		expect(thinkingAt(latestMessage(component), 0)).toBe("...");

		proseOnly = false;
		controller.setTarget(target, false);
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

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(first, false);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		controller.setTarget(second, false);
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

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		// The appended ZWJ sequence merges into the previous final grapheme:
		// "👨" + "\u200D👩" becomes a single cluster, so the cached per-block
		// count must re-segment from that cluster, not just add the suffix.
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨\u200D👩x" }]), false);
		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		expect(textAt(latestMessage(component), 0)).toBe("ab👨\u200D👩x");
	});

	it("renders full targets immediately when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]), false);
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("chunky");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("marks unsmoothed in-flight updates as transient", () => {
		const { component, controller } = makeController({ smooth: false });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]), false);

		expect(component.transientFlags).toEqual([true, true]);
	});

	it("keeps smooth catch-up renders transient until the final message_end render", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "abc" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(textAt(latestMessage(component), 0)).toBe("abc");
		expect(component.transientFlags).not.toHaveLength(0);
		expect(component.transientFlags.every(flag => flag === true)).toBe(true);
	});

	it("stop halts pending ticker updates", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]), false);
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

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("abc");

		// Production hands the reveal the tool-stripped `beforeTools` segment plus
		// an explicit `hasToolCalls` flag — the target itself never carries a
		// toolCall block, so the boundary must be signalled, not re-derived.
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]), true);
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("abcdefghi");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("snaps to full text when a tool call arrives before the first reveal tick", () => {
		// #10318: when the tool call lands before any 30fps tick runs, #revealed
		// is still 0. Without force-completing at the boundary the block commits
		// blank and the entire reply vanishes, not just its tail.
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "Let me wait for that result." }]), true);

		expect(textAt(latestMessage(component), 0)).toBe("Let me wait for that result.");
	});

	it("passes the bound component to requestRender on each smooth tick", () => {
		// The controller must hand its component to `requestRender` so the caller
		// scopes the render to that subtree via `TUI.requestComponentRender`
		// instead of forcing a full-tree walk at 30fps (issue #4377).
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "abcdef" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(requestRender).toHaveBeenCalled();
		for (const call of requestRender.mock.calls) {
			expect(call[0]).toBe(component);
		}
	});
});

/** Pure Intl.Segmenter grapheme count, independent of BlockUnitCounter's memoization. */
function refCount(text: string): number {
	let n = 0;
	for (const _segment of getSegmenter().segment(text)) n += 1;
	return n;
}

/** Pure Intl.Segmenter grapheme slice, independent of BlockUnitCounter's memoization. */
function refSlice(text: string, units: number): string {
	if (units <= 0) return "";
	let n = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		n += 1;
		if (n >= units) return text.slice(0, index + segment.length);
	}
	return text;
}

describe("BlockUnitCounter.slice", () => {
	it("matches a pure segmenter reference for fixed-text growing units", () => {
		const counter = new BlockUnitCounter();
		const text = "café 👨‍👩‍👧‍👦 naïve 日本語 ❤️";
		const total = refCount(text);
		for (let units = 0; units <= total; units++) {
			expect(counter.slice(0, text, units)).toBe(refSlice(text, units));
		}
	});

	it("re-segments the boundary cluster when an append extends it (no stale slice)", () => {
		const counter = new BlockUnitCounter();
		// "a" cached at 1 grapheme; appending a combining mark keeps it 1 cluster
		// but changes the cluster's code units — the slice must not return stale "a".
		expect(counter.slice(0, "a", 1)).toBe("a");
		expect(counter.slice(0, "a\u0301", 1)).toBe("a\u0301");
		// A ZWJ append merges the previous final cluster into a family emoji.
		const merged = new BlockUnitCounter();
		expect(merged.slice(0, "ab👨", 3)).toBe("ab👨");
		expect(merged.slice(0, "ab👨\u200D👩x", 3)).toBe("ab👨\u200D👩");
	});

	it("keeps separate block indices independent", () => {
		const counter = new BlockUnitCounter();
		const a = "hello world";
		const b = "café résumé";
		const ta = refCount(a);
		const tb = refCount(b);
		for (let units = 0; units <= ta; units++) expect(counter.slice(0, a, units)).toBe(refSlice(a, units));
		for (let units = 0; units <= tb; units++) expect(counter.slice(1, b, units)).toBe(refSlice(b, units));
		// Re-slicing block 0 after touching block 1 still matches the reference.
		expect(counter.slice(0, a, ta)).toBe(a);
	});

	it("matches the reference after a shrink and regrow", () => {
		const counter = new BlockUnitCounter();
		const text = "the quick brown fox jumps over";
		const total = refCount(text);
		expect(counter.slice(0, text, total)).toBe(text);
		expect(counter.slice(0, text, 2)).toBe(refSlice(text, 2));
		expect(counter.slice(0, text, total - 1)).toBe(refSlice(text, total - 1));
	});

	it("matches the reference when the text is fully replaced", () => {
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "first block of text", 3)).toBe(refSlice("first block of text", 3));
		expect(counter.slice(0, "completely different café content", 5)).toBe(
			refSlice("completely different café content", 5),
		);
	});

	it("matches the reference under seeded append + monotonic reveal (fuzz)", () => {
		// Deterministic PRNG so the fuzz is reproducible across runs.
		let state = 0x1234abcd;
		const rand = (): number => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return ((state >>> 0) % 100000) / 100000;
		};
		// Appendable chunks include lone combining marks / ZWJ so appends randomly
		// merge into the previous boundary cluster, stressing that invariant.
		const chunks = ["a", "bc ", "e", "\u0301", "👨", "\u200D👩", "日", "本", "❤️", "xy", " ", "z"];
		const counter = new BlockUnitCounter();
		let text = "";
		let revealed = 0;
		for (let step = 0; step < 400; step++) {
			if (rand() < 0.6 || text.length === 0) {
				text += chunks[Math.floor(rand() * chunks.length)]!;
			}
			const total = refCount(text);
			// Monotonic reveal advance, with an occasional reset to a small value
			// to exercise the full re-segment path.
			revealed = rand() < 0.05 ? Math.floor(rand() * 3) : Math.min(total, revealed + 1 + Math.floor(rand() * 6));
			if (revealed < 0) revealed = 0;
			expect(counter.slice(0, text, revealed)).toBe(refSlice(text, revealed));
		}
	});
});

describe("frame-skip coalescing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces caught-up target deltas to at most one render per reveal frame", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const base = "abcdefghij";
		const tail = "x".repeat(30);
		const fullText = base + tail;

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: base }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);
		expect(textAt(latestMessage(component), 0)).toBe(base);

		// 30 deltas at 5x the reveal cadence (each 1 unit of growth).
		const before = component.messages.length;
		let text = base;
		for (let i = 0; i < 30; i++) {
			text += tail[i];
			controller.setTarget(makeMessage([{ type: "text", text }]), false);
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS / 5);
		}
		const burstRenders = component.messages.length - before;
		expect(burstRenders).toBeLessThanOrEqual(
			Math.ceil((30 * STREAMING_REVEAL_FRAME_MS) / 5 / STREAMING_REVEAL_FRAME_MS) + 1,
		);
		expect(burstRenders).toBeLessThan(30);

		// The final drain renders the full text.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 20);
		expect(textAt(latestMessage(component), 0)).toBe(fullText);
	});

	it("renders toolCall targets synchronously even when a drain is pending", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "hi" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("hi");

		// Same reveal budget as "hi" -> caught up: drain is deferred to a tick.
		controller.setTarget(makeMessage([{ type: "text", text: "yo" }]), false);
		const pending = component.messages.length;
		expect(textAt(latestMessage(component), 0)).toBe("hi");
		controller.setTarget(makeMessage([{ type: "text", text: "yo" }]), true);
		// The toolCall boundary still renders synchronously, before any tick.
		expect(component.messages.length).toBe(pending + 1);
		expect(textAt(latestMessage(component), 0)).toBe("yo");
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 4);
		expect(component.messages.length).toBe(pending + 1);
	});

	it("does not rebuild an unchanged target after the tool-call boundary", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "before tool" }]), true);
		const snapped = component.messages.length;

		// Cumulative tool argument deltas repeat the unchanged beforeTools segment.
		controller.setTarget(makeMessage([{ type: "text", text: "before tool" }]), true);
		expect(component.messages).toHaveLength(snapped);

		// A provider rewrite of the leading segment must still repaint, even when
		// the replacement has the same reveal-unit count.
		controller.setTarget(makeMessage([{ type: "text", text: "after  tool" }]), true);
		expect(component.messages).toHaveLength(snapped + 1);
		expect(textAt(latestMessage(component), 0)).toBe("after  tool");
	});

	it("detects an in-place block rewrite of the snapped tool-boundary content", () => {
		// OpenAI Responses reuses the cumulative output object and can replace
		// streamed text with authoritative terminal content in place. Aliasing the
		// snapped array would compare it to itself and keep the stale text; an
		// immutable snapshot must still repaint even when the rewrite has the same
		// grapheme count.
		vi.useFakeTimers();
		const { component, controller } = makeController();

		const message = makeMessage([{ type: "text", text: "streamed abc" }]);
		const block = message.content[0]! as Extract<AssistantMessage["content"][number], { type: "text" }>;
		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(message, true);
		const snapped = component.messages.length;

		// Same array, same length, block rewritten in place.
		block.text = "streamed xyz";
		controller.setTarget(message, true);
		expect(component.messages).toHaveLength(snapped + 1);
		expect(textAt(latestMessage(component), 0)).toBe("streamed xyz");
	});

	it("keeps synchronous per-setTarget renders when smooth streaming is off", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController({ smooth: false });

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "one" }]), false);
		const before = component.messages.length;
		controller.setTarget(makeMessage([{ type: "text", text: "one two" }]), false);

		expect(component.messages.length).toBe(before + 1);
		expect(textAt(latestMessage(component), 0)).toBe("one two");
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(component.messages.length).toBe(before + 1);
	});
	it("cancels a pending drain when smooth streaming is turned off", () => {
		vi.useFakeTimers();
		let smooth = true;
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => smooth,
			getHideThinkingBlock: () => false,
			getProseOnlyThinking: () => true,
			requestRender: () => {},
		});

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "hi" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		controller.setTarget(makeMessage([{ type: "text", text: "yo" }]), false);

		smooth = false;
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghij" }]), false);
		expect(textAt(latestMessage(component), 0)).toBe("abcdefghij");

		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("abcdefghij");
		controller.stop();
	});

	it("flushes the trailing delta at the next tick and stops the timer", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "hi" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("hi");

		controller.setTarget(makeMessage([{ type: "text", text: "hi!" }]), false);
		const before = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(component.messages.length).toBe(before + 1);
		expect(textAt(latestMessage(component), 0)).toBe("hi!");

		const flushed = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 4);
		expect(component.messages.length).toBe(flushed);
	});

	it("re-arms the timer for caught-up deltas and renders nothing while idle", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "hi" }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("hi");

		// Caught up: "yo" has the same reveal budget, so the render is deferred.
		controller.setTarget(makeMessage([{ type: "text", text: "yo" }]), false);
		const before = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(component.messages.length).toBe(before + 1);
		expect(textAt(latestMessage(component), 0)).toBe("yo");

		// No further deltas: subsequent ticks render nothing.
		const drained = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 4);
		expect(component.messages.length).toBe(drained);
	});
});
