import { describe, expect, it } from "bun:test";
import { StreamPaintEncoder } from "@oh-my-pi/pi-coding-agent/stream/paint-encoder";
import { StreamRedactor } from "@oh-my-pi/pi-coding-agent/stream/redactor";

const SIZE = { columns: 40, rows: 2 };

function paint(viewport: string[], history: string[] = []) {
	return { history, viewport, reset: false, alt: false, columns: SIZE.columns, rows: SIZE.rows };
}

describe("StreamPaintEncoder while the consumer is backpressured", () => {
	it("holds the viewport, then resends it redacted with the redactor current at resync", () => {
		const encoder = new StreamPaintEncoder(SIZE, new StreamRedactor([/alpha/g], []));
		encoder.push(paint(["prompt", "alpha beta"], ["old alpha line"]));

		// Backpressured: control frames and history only, redacted when drained.
		const held = encoder.drain({ screen: false });
		expect(held).toEqual([{ t: "history", rows: ["old •••••• line"] }]);
		expect(encoder.pending).toBe(true);

		// The secret set grows before the consumer catches up.
		encoder.setRedactor(new StreamRedactor([/alpha/g, /beta/g], []));
		encoder.resync();
		const resumed = encoder.drain();
		expect(resumed).toEqual([{ t: "viewport", rows: ["prompt", "•••••• ••••••"] }]);
		expect(JSON.stringify(resumed)).not.toContain("beta");
		expect(encoder.pending).toBe(false);
	});

	it("resends the last viewport on resync when nothing new was painted", () => {
		const encoder = new StreamPaintEncoder(SIZE, new StreamRedactor([], []));
		encoder.push(paint(["one", "two"]));
		expect(encoder.drain()).toEqual([{ t: "viewport", rows: ["one", "two"] }]);
		encoder.resync();
		expect(encoder.drain()).toEqual([{ t: "viewport", rows: ["one", "two"] }]);
	});
});
