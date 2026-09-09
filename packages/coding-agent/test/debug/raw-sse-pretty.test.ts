import { describe, expect, it } from "bun:test";
import { expandPrettyDataLines } from "@oh-my-pi/pi-coding-agent/debug/raw-sse";

// Wide enough that `truncateToWidth` would clip the payload in the viewer; matches
// what real Codex `response.output_item.done` frames look like on the wire.
function wideObjectLine(): string {
	const payload = {
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1234567890",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello there, this is a long enough message" }],
		},
	};
	return `data: ${JSON.stringify(payload)}`;
}

describe("expandPrettyDataLines", () => {
	it("expands wide JSON `data:` payloads into multi-line indented `data:` entries", () => {
		const input = [`: ws ← response.output_item.done`, `event: response.output_item.done`, wideObjectLine()];

		const out = expandPrettyDataLines(input);

		// Comment + event: lines pass through.
		expect(out[0]).toBe(input[0]);
		expect(out[1]).toBe(input[1]);

		// Original payload spans many lines now, each prefixed with `data: `.
		const dataLines = out.slice(2);
		expect(dataLines.length).toBeGreaterThan(1);
		for (const line of dataLines) {
			expect(line.startsWith("data: ")).toBe(true);
		}

		// The expanded JSON, with `data: ` stripped, round-trips to the original payload.
		const rejoined = dataLines.map(line => line.slice("data: ".length)).join("\n");
		expect(JSON.parse(rejoined)).toEqual(JSON.parse(wideObjectLine().slice("data: ".length)));
	});

	it("leaves short single-line payloads alone so small deltas stay compact", () => {
		const input = [
			`: ws ← response.output_text.delta`,
			`event: response.output_text.delta`,
			`data: {"type":"response.output_text.delta","delta":"hi"}`,
		];
		expect(expandPrettyDataLines(input)).toEqual([...input]);
	});

	it("falls back to the raw line when the payload is wide but not JSON", () => {
		// Wide enough to cross the threshold but doesn't start with `{` or `[`.
		const wideNonJson = `data: ${"x".repeat(200)}`;
		const out = expandPrettyDataLines([wideNonJson]);
		expect(out).toEqual([wideNonJson]);
	});

	it("falls back when the payload is wide JSON-looking text but parses as invalid", () => {
		const wideBrokenJson = `data: {"unterminated":"${"x".repeat(200)}`;
		const out = expandPrettyDataLines([wideBrokenJson]);
		expect(out).toEqual([wideBrokenJson]);
	});

	it("preserves non-`data:` lines (event/comment) verbatim regardless of length", () => {
		const wideComment = `: ${"x".repeat(300)}`;
		const wideEvent = `event: ${"x".repeat(300)}`;
		const out = expandPrettyDataLines([wideComment, wideEvent]);
		expect(out).toEqual([wideComment, wideEvent]);
	});
});
