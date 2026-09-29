import { describe, expect, it } from "bun:test";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { ThinkingClock } from "@oh-my-pi/pi-coding-agent/utils/thinking-clock";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const partial = createAssistantMessage("");

function start(type: "thinking_start" | "text_start" | "toolcall_start", contentIndex: number): AssistantMessageEvent {
	return { type, contentIndex, partial };
}

function end(type: "thinking_end" | "text_end", contentIndex: number): AssistantMessageEvent {
	return { type, contentIndex, content: "", partial };
}

describe("ThinkingClock", () => {
	it("excludes preceding text, tool work, and gaps from later reasoning segments", () => {
		const clock = new ThinkingClock();
		clock.begin(100);
		clock.observe(start("text_start", 0), 200);
		clock.observe(end("text_end", 0), 1_000);
		clock.observe(start("thinking_start", 1), 2_000);
		expect(clock.observe(end("thinking_end", 1), 2_300)).toEqual({ 1: 300 });
		clock.observe(start("toolcall_start", 2), 3_000);
		clock.observe(start("thinking_start", 3), 9_000);
		expect(clock.observe(end("thinking_end", 3), 9_200)).toEqual({ 1: 300, 3: 200 });
		clock.observe(start("thinking_start", 4), 10_000);
		expect(clock.finish(10_050)).toEqual({ 1: 300, 3: 200, 4: 50 });
	});

	it("closes reasoning at the next thinking block without changing earlier snapshots", () => {
		const clock = new ThinkingClock();
		clock.begin(100);
		clock.observe(start("thinking_start", 0), 200);
		const first = clock.observe(start("thinking_start", 1), 300);
		expect(first).toEqual({ 0: 200 });
		expect(clock.observe(end("thinking_end", 1), 450)).toEqual({ 0: 200, 1: 150 });
		expect(first).toEqual({ 0: 200 });
	});

	it("does not restart or extend a block on duplicate starts, deltas, or closes", () => {
		const clock = new ThinkingClock();
		clock.begin(100);
		clock.observe(start("thinking_start", 0), 150);
		clock.observe(start("thinking_start", 0), 200);
		clock.observe(end("thinking_end", 0), 400);
		clock.observe(end("thinking_end", 0), 800);
		clock.observe(start("thinking_start", 0), 900);
		clock.observe({ type: "thinking_delta", contentIndex: 0, delta: "late", partial }, 950);
		expect(clock.finish(1_000)).toEqual({ 0: 300 });
		expect(clock.finish(2_000)).toBeUndefined();
	});

	it("resets completed and open measurements on new messages and provider restarts", () => {
		const clock = new ThinkingClock();
		clock.begin(100);
		clock.observe(start("thinking_start", 0), 150);
		clock.observe(end("thinking_end", 0), 200);
		clock.observe(start("thinking_start", 1), 250);
		expect(clock.observe({ type: "start", partial }, 1_000)).toBeUndefined();
		clock.observe(start("thinking_start", 0), 1_100);
		expect(clock.observe(end("thinking_end", 0), 1_200)).toEqual({ 0: 200 });
		clock.begin(2_000);
		expect(clock.finish(2_500)).toBeUndefined();
		clock.observe(start("thinking_start", 0), 3_000);
		expect(clock.finish(3_500)).toBeUndefined();
	});

	it("does not invent time for unobserved starts, and uses a first delta when a start is omitted", () => {
		const clock = new ThinkingClock();
		clock.begin(100);
		expect(clock.observe(end("thinking_end", 0), 500)).toBeUndefined();
		clock.observe({ type: "thinking_delta", contentIndex: 1, delta: "reasoning", partial }, 1_000);
		expect(clock.finish(1_125.6)).toEqual({ 1: 126 });
	});
});
