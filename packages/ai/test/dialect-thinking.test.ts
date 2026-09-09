import { describe, expect, it } from "bun:test";
import {
	createInbandScanner,
	type Dialect,
	getDialectDefinition,
	type InbandScanEvent,
	type InbandScannerOptions,
} from "@oh-my-pi/pi-ai/dialect";

function scan(
	dialect: Dialect,
	text: string,
	opts: { charByChar?: boolean; options?: InbandScannerOptions } = {},
): InbandScanEvent[] {
	const scanner = createInbandScanner(dialect, opts.options);
	const events: InbandScanEvent[] = [];
	if (opts.charByChar) for (const ch of text) events.push(...scanner.feed(ch));
	else events.push(...scanner.feed(text));
	events.push(...scanner.flush());
	return events;
}

function thinkingText(events: readonly InbandScanEvent[]): string {
	return events
		.filter((e): e is Extract<InbandScanEvent, { type: "thinkingDelta" }> => e.type === "thinkingDelta")
		.map(e => e.delta)
		.join("");
}

function visibleText(events: readonly InbandScanEvent[]): string {
	return events
		.filter((e): e is Extract<InbandScanEvent, { type: "text" }> => e.type === "text")
		.map(e => e.text)
		.join("");
}

function callNames(events: readonly InbandScanEvent[]): { name: string; arguments: Record<string, unknown> }[] {
	return events
		.filter((e): e is Extract<InbandScanEvent, { type: "toolEnd" }> => e.type === "toolEnd")
		.map(e => ({ name: e.name, arguments: e.arguments }));
}

function thinkingBoundaries(events: readonly InbandScanEvent[]): number {
	return events.filter(e => e.type === "thinkingStart").length;
}

function thinkingEndCount(events: readonly InbandScanEvent[]): number {
	return events.filter(e => e.type === "thinkingEnd").length;
}

describe("gemma thought channel (<|channel>thought…<channel|>)", () => {
	const reply = "The answer is 4.";

	it("routes the thought channel to thinking, keeping it out of the reply", () => {
		const events = scan("gemma", `<|channel>thought\nlet me reason\n<channel|>${reply}`);
		expect(thinkingText(events)).toContain("let me reason");
		expect(visibleText(events).trim()).toBe(reply);
		expect(visibleText(events)).not.toContain("<|channel>");
		expect(visibleText(events)).not.toContain("<channel|>");
	});

	it("round-trips renderThinking through the scanner", () => {
		const rendered = getDialectDefinition("gemma").renderThinking("reasoning");
		expect(rendered).toBe("<|channel>thought\nreasoning<channel|>");
		const events = scan("gemma", `${rendered}reply`);
		expect(thinkingText(events)).toBe("reasoning");
		expect(visibleText(events)).toBe("reply");
	});

	it("still parses tool calls emitted after the thought channel", () => {
		const events = scan("gemma", `<|channel>thought\nplan\n<channel|><|tool_call>call:foo{x:1}<tool_call|>`);
		expect(callNames(events)).toEqual([{ name: "foo", arguments: { x: 1 } }]);
		expect(thinkingText(events)).toContain("plan");
	});

	it("yields identical thinking and calls when streamed char by char", () => {
		const input = `<|channel>thought\nstep one\n<channel|><|tool_call>call:foo{x:1}<tool_call|>done`;
		const whole = scan("gemma", input);
		const streamed = scan("gemma", input, { charByChar: true });
		expect(thinkingText(streamed)).toBe(thinkingText(whole));
		expect(callNames(streamed)).toEqual(callNames(whole));
		expect(visibleText(streamed)).toBe(visibleText(whole));
	});

	it("treats the channel as plain text when parseThinking is disabled", () => {
		const events = scan("gemma", `<|channel>thought\nx\n<channel|>${reply}`, { options: { parseThinking: false } });
		expect(thinkingBoundaries(events)).toBe(0);
		expect(visibleText(events)).toContain("<|channel>thought");
	});
});

describe("gemini thinking fence (```thinking … ```)", () => {
	it("routes the thinking fence to thinking, keeping it out of the reply", () => {
		const events = scan("gemini", "```thinking\nreasoning\n```\nVisible answer.");
		expect(thinkingText(events).trim()).toBe("reasoning");
		expect(visibleText(events).trim()).toBe("Visible answer.");
		expect(visibleText(events)).not.toContain("```thinking");
	});

	for (const charByChar of [false, true]) {
		const mode = charByChar ? "character stream" : "whole chunk";

		it(`keeps nested Markdown fences inside thinking in ${mode}`, () => {
			const input = "```thinking\nPlan:\n```rs\nfn main() {}\n```\nThen decide.\n```Visible after";
			const events = scan("gemini", input, { charByChar });
			expect(thinkingText(events)).toBe("Plan:\n```rs\nfn main() {}\n```\nThen decide.\n");
			expect(visibleText(events)).toBe("Visible after");
			expect(thinkingBoundaries(events)).toBe(1);
			expect(thinkingEndCount(events)).toBe(1);
			expect(visibleText(events)).not.toContain("fn main");
		});
	}

	for (const { suffix, visible } of [
		{ suffix: "Visible after", visible: "Visible after" },
		{ suffix: " after", visible: " after" },
		{ suffix: "Done", visible: "Done" },
	]) {
		for (const charByChar of [false, true]) {
			const mode = charByChar ? "character stream" : "whole chunk";

			it(`treats inline close plus ${JSON.stringify(suffix)} as visible reply in ${mode}`, () => {
				const events = scan("gemini", `\`\`\`thinking\nplan\n\`\`\`${suffix}`, { charByChar });
				expect(thinkingText(events)).toBe("plan\n");
				expect(visibleText(events)).toBe(visible);
				expect(thinkingBoundaries(events)).toBe(1);
				expect(thinkingEndCount(events)).toBe(1);
			});
		}
	}

	it("round-trips renderThinking through the scanner", () => {
		const rendered = getDialectDefinition("gemini").renderThinking("reasoning");
		expect(rendered).toBe("```thinking\nreasoning\n```");
		const events = scan("gemini", `${rendered}\nreply`);
		expect(thinkingText(events).trim()).toBe("reasoning");
		expect(visibleText(events).trim()).toBe("reply");
	});

	it("still parses a tool_code block after the thinking fence", () => {
		const events = scan("gemini", "```thinking\nplan\n```\n```tool_code\nprint(default_api.foo(x=1))\n```");
		expect(callNames(events)).toEqual([{ name: "foo", arguments: { x: 1 } }]);
		expect(thinkingText(events)).toContain("plan");
	});

	it("yields identical thinking and calls when streamed char by char", () => {
		const input = "```thinking\nstep one\n```\n```tool_code\nprint(default_api.foo(x=1))\n```";
		const whole = scan("gemini", input);
		const streamed = scan("gemini", input, { charByChar: true });
		expect(thinkingText(streamed)).toBe(thinkingText(whole));
		expect(callNames(streamed)).toEqual(callNames(whole));
	});

	it("treats the fence as plain text when parseThinking is disabled", () => {
		const events = scan("gemini", "```thinking\nx\n```\nanswer", { options: { parseThinking: false } });
		expect(thinkingBoundaries(events)).toBe(0);
		expect(visibleText(events)).toContain("```thinking");
	});
});

describe("kimi think tags (<think>…</think>)", () => {
	const section =
		'<|tool_calls_section_begin|><|tool_call_begin|>functions.foo:0<|tool_call_argument_begin|>{"x":1}<|tool_call_end|><|tool_calls_section_end|>';

	it("routes <think> to thinking, keeping it out of the reply", () => {
		const events = scan("kimi", "<think>reasoning</think>The answer.");
		expect(thinkingText(events)).toBe("reasoning");
		expect(visibleText(events)).toBe("The answer.");
	});

	it("round-trips renderThinking through the scanner", () => {
		const rendered = getDialectDefinition("kimi").renderThinking("reasoning");
		expect(rendered).toBe("<think>\nreasoning\n</think>");
		const events = scan("kimi", rendered);
		expect(thinkingText(events).trim()).toBe("reasoning");
	});

	it("still parses the tool-call section after thinking", () => {
		const events = scan("kimi", `<think>plan</think>${section}`);
		expect(callNames(events)).toEqual([{ name: "foo", arguments: { x: 1 } }]);
		expect(thinkingText(events)).toBe("plan");
	});

	it("yields identical thinking and calls when streamed char by char", () => {
		const input = `<think>step one</think>${section}`;
		const whole = scan("kimi", input);
		const streamed = scan("kimi", input, { charByChar: true });
		expect(thinkingText(streamed)).toBe(thinkingText(whole));
		expect(callNames(streamed)).toEqual(callNames(whole));
	});

	it("leaves <think> as visible text when parseThinking is disabled (healing path)", () => {
		const events = scan("kimi", "<think>x</think>answer", { options: { parseThinking: false } });
		expect(thinkingBoundaries(events)).toBe(0);
		expect(visibleText(events)).toBe("<think>x</think>answer");
	});
});

describe("every dialect round-trips thinking (no missing thinking element)", () => {
	const dialects: Dialect[] = [
		"anthropic",
		"deepseek",
		"gemini",
		"gemma",
		"glm",
		"harmony",
		"hermes",
		"kimi",
		"qwen3",
		"xml",
	];
	const secret = "private chain of thought";

	for (const dialect of dialects) {
		it(`${dialect}: renderThinking is not a passthrough and parses back as thinking`, () => {
			const rendered = getDialectDefinition(dialect).renderThinking(secret);
			// A real channel wraps the text in markers, never returns it verbatim.
			expect(rendered).not.toBe(secret);
			expect(rendered.length).toBeGreaterThan(secret.length);
			const events = scan(dialect, rendered, { options: { parseThinking: true } });
			expect(thinkingText(events)).toContain(secret);
			expect(visibleText(events)).not.toContain(secret);
		});
	}
});

describe("unterminated thinking at stream end", () => {
	const cases: Array<{ dialect: Dialect; input: string }> = [
		{ dialect: "deepseek", input: "<think>partial" },
		{ dialect: "gemini", input: "```thinking\npartial" },
		{ dialect: "gemma", input: "<|channel>thought\npartial" },
		{ dialect: "glm", input: "<think>partial" },
		{ dialect: "kimi", input: "<think>partial" },
		{ dialect: "qwen3", input: "<think>partial" },
	];

	for (const { dialect, input } of cases) {
		it(`${dialect}: closes the thinking block on flush`, () => {
			const events = scan(dialect, input);
			expect(thinkingText(events)).toBe("partial");
			expect(thinkingBoundaries(events)).toBe(1);
			expect(thinkingEndCount(events)).toBe(1);
		});
	}
});
