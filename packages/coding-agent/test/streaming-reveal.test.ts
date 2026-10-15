import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { formatThinkingForDisplay } from "@oh-my-pi/pi-tui/chat/thinking-display";
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
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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

	it("keeps the answer at its reveal position when thinking visibility toggles after the answer is reached", async () => {
		// Hiding a long thinking prefix mid-stream must not snap the answer to
		// 100%, and showing it again must not spend the answer's budget on the
		// freshly shown prefix. The aggregate reveal count is spent from the
		// first visible block, so the controller re-anchors per block instead of
		// clamping the old thinking-plus-answer count to the text total.
		const thinking = "reasoning through the answer ".repeat(12);
		const answer = "the visible answer tail that the user is reading".repeat(4);
		let hideThinking = false;
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => hideThinking,
			getProseOnlyThinking: () => true,
			requestRender: () => {},
		});

		vi.useFakeTimers();
		controller.begin(component, makeMessage([{ type: "thinking", thinking }]), false);
		// Stream the thinking prefix out, then land the answer mid-reveal, so the
		// reveal position sits inside the answer text, past the whole prefix.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 4);
		for (let step = 1; step <= 10; step++) {
			const text = answer.slice(0, Math.floor((answer.length * step) / 10));
			controller.setTarget(
				makeMessage([
					{ type: "thinking", thinking },
					{ type: "text", text },
				]),
				false,
			);
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		const revealed = textAt(latestMessage(component), 1);
		expect(revealed.length).toBeGreaterThan(0);
		expect(revealed.length).toBeLessThan(answer.length);

		// Hide the prefix: the answer keeps exactly the units it had revealed.
		hideThinking = true;
		controller.resyncVisibility();
		expect(textAt(latestMessage(component), 1)).toBe(revealed);

		// Show it again: the answer does not give its units back to the prefix.
		hideThinking = false;
		controller.resyncVisibility();
		expect(textAt(latestMessage(component), 1)).toBe(revealed);
		const shownBlock = latestMessage(component).content[0];
		expect(shownBlock?.type).toBe("thinking");
		if (shownBlock?.type === "thinking") {
			expect(shownBlock.thinking.length).toBeGreaterThan(0);
			expect("rawThinking" in shownBlock).toBe(true);
		}
	});

	it("restores the reveal-shaped thinking prefix across a hide/show round trip", async () => {
		// Smooth reveal still part-way through a thinking-only prefix, then two
		// Ctrl+T presses before the answer advances. The hide pass drops the
		// block from view; the show pass must restore the prefix the user already
		// watched stream out. Crediting the whole regenerated block instead
		// flashes the remaining reasoning to completion (#15336).
		const thinking = "reasoning through the problem ".repeat(12);
		const full = formatThinkingForDisplay(thinking, true);
		let hideThinking = false;
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => hideThinking,
			getProseOnlyThinking: () => true,
			requestRender: () => {},
		});

		vi.useFakeTimers();
		controller.begin(component, makeMessage([{ type: "thinking", thinking }]), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 3);
		const partial = thinkingAt(latestMessage(component), 0);
		expect(partial.length).toBeGreaterThan(0);
		expect(partial.length).toBeLessThan(full.length);

		// Hide, then show again while the frontier is still inside thinking.
		hideThinking = true;
		controller.resyncVisibility();
		hideThinking = false;
		controller.resyncVisibility();
		expect(thinkingAt(latestMessage(component), 0)).toBe(partial);

		// The reveal keeps pacing from the restored prefix instead of snapping.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(thinkingAt(latestMessage(component), 0).length).toBeGreaterThan(partial.length);
	});

	it("keeps a fully revealed thinking block whole when prose-only expands its fence", async () => {
		// Prose-only mode elides a fenced-code prefix down to a trailing ellipsis.
		// Turning it off expands that prefix back to the full fence, so a block
		// the reveal already consumed whole must stay whole at its new size: a
		// resync that re-credits only the old short size leaves buildDisplayMessage
		// spending the answer's saved units on the expanded fence, which blanks
		// the answer and retypes it as the reveal catches up.
		const thinking = [
			"Analyzing the request before answering.",
			"```js",
			"const value = compute(42);",
			"console.log(value);",
			"```",
		].join("\n");
		const answer = "the visible answer tail that the user is reading".repeat(4);
		let proseOnly = true;
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => false,
			getProseOnlyThinking: () => proseOnly,
			requestRender: () => {},
		});

		vi.useFakeTimers();
		controller.begin(component, makeMessage([{ type: "thinking", thinking }]), false);
		// Reveal the prose-shaped prefix out completely.
		for (let frame = 0; frame < 40; frame++) {
			if (thinkingAt(latestMessage(component), 0) === formatThinkingForDisplay(thinking, true)) break;
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		expect(thinkingAt(latestMessage(component), 0)).toBe(formatThinkingForDisplay(thinking, true));

		// Stream the answer in faster than the reveal paces it, so the frontier
		// ends up past the whole prefix and inside the answer.
		for (let end = 10; end <= answer.length; end += 10) {
			controller.setTarget(
				makeMessage([
					{ type: "thinking", thinking },
					{ type: "text", text: answer.slice(0, end) },
				]),
				false,
			);
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		const revealedBefore = textAt(latestMessage(component), 1);
		expect(revealedBefore.length).toBeGreaterThan(0);
		expect(revealedBefore.length).toBeLessThan(answer.length);

		// Prose-only off: the fence expands, and the answer must not pay for it.
		proseOnly = false;
		controller.resyncVisibility();
		expect(textAt(latestMessage(component), 1)).toBe(revealedBefore);
		// The prefix was fully consumed, so it renders whole at the expanded size.
		expect(thinkingAt(latestMessage(component), 0)).toBe(formatThinkingForDisplay(thinking, false));
	});

	it("does not spend the answer's reveal budget on a thinking block revealed past the frontier", async () => {
		// `thinking -> text -> thinking`, reveal still part-way through the text
		// while both thinking blocks are hidden. Showing thinking makes both
		// blocks newly visible; the one AFTER the text is past the reveal
		// frontier, so crediting it whole raises the aggregate budget that
		// buildDisplayMessage spends from the first block — the preceding text
		// then consumes those units and the visible answer jumps forward or
		// completes. Only blocks at or before the frontier may be snapped whole.
		const leading = "reasoning through the problem ".repeat(6);
		const trailing = "double-checking the result ".repeat(6);
		const answer = "the answer that must not jump forward".repeat(3);
		let hideThinking = true;
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => hideThinking,
			getProseOnlyThinking: () => true,
			requestRender: () => {},
		});

		vi.useFakeTimers();
		controller.begin(
			component,
			makeMessage([
				{ type: "thinking", thinking: leading },
				{ type: "text", text: "" },
			]),
			false,
		);
		// Land the answer while the reveal paces it, so the frontier sits inside
		// the text with both thinking blocks still hidden.
		for (let end = 8; end <= answer.length; end += 8) {
			controller.setTarget(
				makeMessage([
					{ type: "thinking", thinking: leading },
					{ type: "text", text: answer.slice(0, end) },
					{ type: "thinking", thinking: trailing },
				]),
				false,
			);
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		const revealedBefore = textAt(latestMessage(component), 1);
		expect(revealedBefore.length).toBeGreaterThan(0);
		expect(revealedBefore.length).toBeLessThan(answer.length);

		// Show thinking: the leading block is before the frontier and renders
		// whole; the trailing one is past it and stays unrevealed, so the answer
		// keeps exactly the units it had.
		hideThinking = false;
		controller.resyncVisibility();
		expect(textAt(latestMessage(component), 1)).toBe(revealedBefore);
		expect(thinkingAt(latestMessage(component), 0)).toBe(formatThinkingForDisplay(leading, true));
		expect(thinkingAt(latestMessage(component), 2)).toBe("");
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

	it("detects an in-place rewrite of a value-equal replacement of the snapped content", () => {
		// The unchanged-target shortcut must follow the live blocks: after a
		// flush hands over equal-valued fresh blocks, an in-place rewrite of THOSE
		// blocks still repaints.
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(makeMessage([{ type: "text", text: "streamed abc" }]), true);
		const snapped = component.messages.length;

		const replacement = makeMessage([{ type: "text", text: "streamed abc" }]);
		controller.setTarget(replacement, true);
		expect(component.messages).toHaveLength(snapped);

		(replacement.content[0] as Extract<AssistantMessage["content"][number], { type: "text" }>).text = "streamed xyz";
		controller.setTarget(replacement, true);
		expect(component.messages).toHaveLength(snapped + 1);
		expect(textAt(latestMessage(component), 0)).toBe("streamed xyz");
	});

	it("detects an in-place rewrite nested inside a snapped block", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		const block = { type: "text" as const, text: "streamed abc", meta: { revision: 1 } };
		const message = makeMessage([block]);
		controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
		controller.setTarget(message, true);
		const snapped = component.messages.length;

		controller.setTarget(message, true);
		expect(component.messages).toHaveLength(snapped);

		block.meta.revision = 2;
		controller.setTarget(message, true);
		expect(component.messages).toHaveLength(snapped + 1);
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

	it("clamps the reveal budget at zero when hiding thinking mid-reveal", () => {
		// When the provider has already supplied a later block while smooth reveal
		// is still part-way through an earlier one, hiding thinking makes
		// `remaining` smaller than `before` for the thinking block. Subtracting
		// the whole block makes it negative, and the subsequent text block then
		// contributes a negative `spent` value to `revealed`. The answer text
		// must not be blanked out by the fictitious negative offset.
		const thinking = "reasoning through the problem ".repeat(20);
		const answer = "the answer that must remain visible".repeat(3);
		let hideThinking = false;
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => hideThinking,
			getProseOnlyThinking: () => true,
			requestRender: () => {},
		});

		vi.useFakeTimers();
		controller.begin(component, makeMessage([{ type: "thinking", thinking }]), false);
		// Advance a few frames so reveal is partway through the thinking block.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 3);

		// Provider supplies the answer while reveal is still inside thinking.
		controller.setTarget(
			makeMessage([
				{ type: "thinking", thinking },
				{ type: "text", text: answer },
			]),
			false,
		);

		// Hide thinking while reveal lags inside the preceding thinking run.
		hideThinking = true;
		controller.resyncVisibility();

		// Advance the timer: the answer should reveal from a clamped
		// (non-negative) offset, not from a fictitious negative one.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		const revealedText = textAt(latestMessage(component), 1);
		expect(revealedText.length).toBeGreaterThan(0);

		// The answer must stay visible — a negative offset would blank it out.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(textAt(latestMessage(component), 1).length).toBeGreaterThan(0);
	});
});
