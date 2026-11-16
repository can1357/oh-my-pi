import { describe, expect, it } from "bun:test";
import { FencedThinkingScanner } from "@oh-my-pi/pi-ai/dialect/fenced-thinking";

interface Scan {
	thinking: string;
	closed: boolean;
	rest: string;
}

function scan(text: string, chunk: number): Scan {
	const scanner = new FencedThinkingScanner();
	let thinking = "";
	for (let i = 0; i < text.length; i += chunk) {
		const result = scanner.feed(text.slice(i, i + chunk), false);
		thinking += result.thinking;
		if (result.closed) return { thinking, closed: true, rest: result.rest + text.slice(i + chunk) };
	}
	const result = scanner.feed("", true);
	return { thinking: thinking + result.thinking, closed: result.closed, rest: result.rest };
}

// Each input mixes lines whose start rules a fence out (so later backticks are
// content) with real fences: nested language blocks, inline and bare closers.
const inputs = [
	"plan `a` then ``x`` ```not a fence\n```rs\nfn main() {}\n```\nmore `` text\n```\nVisible reply",
	"    ```indented is content\n\t```tab is content\n``two ticks`` and ```three mid-line\n```Inline reply here",
	"line one\n~~~\n```inside tilde block\n~~~\nlast line ``` with ticks",
	"no newline at all but ``` backticks in the middle and ``` again",
	"```py\nprint('x')\n```\ntrailing thinking ``",
	"a long first line of thinking\nb\nc\n```c\nx\n```\nd\n```\nafter",
];

describe("FencedThinkingScanner", () => {
	for (const [index, input] of inputs.entries()) {
		it(`scans input ${index} the same whatever the chunk size`, () => {
			const whole = scan(input, input.length);
			for (let chunk = 1; chunk <= 9; chunk++) expect(scan(input, chunk)).toEqual(whole);
		});
	}
});
