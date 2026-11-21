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

// Lines whose start rules a fence out (so later backticks are content), real
// fences (nested language blocks, inline, bare, indented and CRLF closers), and
// tails only the end of the stream resolves.
const cases: Array<[input: string, expected: Scan]> = [
	[
		"plan `a` then ``x`` ```not a fence\n```rs\nfn main() {}\n```\nmore `` text\n```\nVisible reply",
		{
			thinking: "plan `a` then ``x`` ```not a fence\n```rs\nfn main() {}\n```\nmore `` text\n",
			closed: true,
			rest: "\nVisible reply",
		},
	],
	[
		"    ```indented is content\n\t```tab is content\n``two ticks`` and ```three mid-line\n```Inline reply here",
		{
			thinking: "    ```indented is content\n\t```tab is content\n``two ticks`` and ```three mid-line\n",
			closed: true,
			rest: "Inline reply here",
		},
	],
	[
		"line one\n~~~\n```inside tilde block\n~~~\nlast line ``` with ticks",
		{ thinking: "line one\n~~~\n```inside tilde block\n~~~\nlast line ``` with ticks", closed: false, rest: "" },
	],
	[
		"no newline at all but ``` backticks in the middle and ``` again",
		{ thinking: "no newline at all but ``` backticks in the middle and ``` again", closed: false, rest: "" },
	],
	[
		"```py\nprint('x')\n```\ntrailing thinking ``",
		{ thinking: "```py\nprint('x')\n```\ntrailing thinking ``", closed: false, rest: "" },
	],
	[
		"a long first line of thinking\nb\nc\n```c\nx\n```\nd\n```\nafter",
		{ thinking: "a long first line of thinking\nb\nc\n```c\nx\n```\nd\n", closed: true, rest: "\nafter" },
	],
	["x\n  ```Reply text", { thinking: "x\n", closed: true, rest: "Reply text" }],
	["x\n   ```\nReply", { thinking: "x\n", closed: true, rest: "\nReply" }],
	["x\r\n```\r\nReply", { thinking: "x\r\n", closed: true, rest: "\nReply" }],
	["x\n```py", { thinking: "x\n", closed: true, rest: "py" }],
	["x\n```", { thinking: "x\n", closed: true, rest: "" }],
];

describe("FencedThinkingScanner", () => {
	for (const [index, [input, expected]] of cases.entries()) {
		it(`scans case ${index} the same whatever the chunk size`, () => {
			for (let chunk = 1; chunk <= 9; chunk++) expect(scan(input, chunk)).toEqual(expected);
			expect(scan(input, input.length)).toEqual(expected);
		});
	}
});
