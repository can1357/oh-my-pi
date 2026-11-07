import { afterEach, describe, expect, it } from "bun:test";
import { OutputSink } from "../src/tools/streaming-output";

const SIXEL = "\x1bPq#0;2;100;0;0~~\x1b\\";
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

function enableSixelPassthrough(): void {
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
}

afterEach(() => {
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
});

describe("OutputSink frame line boundaries", () => {
	it("flushes a held carriage-return newline before a frame from the next chunk", async () => {
		// Failure mode: per-span normalization holds a trailing `\r` until the
		// next *text* span, and a payload span is not text, so the newline only
		// surfaced at dump() time. The progress text and the frame then share one
		// row, and the row the frame occupies is closed by a newline that arrives
		// after it — a terminal replaying this output renders `before<frame>`.
		enableSixelPassthrough();
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });
		await sink.push("before\r");
		await sink.push(SIXEL);
		const dumped = await sink.dump();

		expect(dumped.output).toBe(`before\n${SIXEL}`);
		expect(chunks.join("")).toBe(`before\n${SIXEL}`);
	});

	it("flushes a held carriage-return newline inside the chunk that carries the frame", async () => {
		// Same held-newline leak, reached through a single chunk: the text span
		// ends on the CR, so the synthesized newline has to land between the text
		// and the payload, not between the payload and the text that follows it.
		enableSixelPassthrough();
		const sink = new OutputSink();
		await sink.push(`before\r${SIXEL}after`);
		const dumped = await sink.dump();

		expect(dumped.output).toBe(`before\n${SIXEL}after`);
	});
});
