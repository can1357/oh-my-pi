/**
 * Tests for BracketedPasteHandler
 *
 * Covers the byte-cap defense-in-depth (issue #4073 case B).
 * The normal ProcessTerminal path re-wraps StdinBuffer's bounded paste with
 * both markers so BracketedPasteHandler always receives them together; the
 * byte cap only fires on alternate callers that bypass StdinBuffer.
 */
import { describe, expect, it } from "bun:test";
import { BracketedPasteHandler } from "@oh-my-pi/pi-tui/bracketed-paste";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("BracketedPasteHandler", () => {
	describe("Byte cap (issue #4073 case B)", () => {
		it("aborts paste mode and delivers accumulated bytes when the cap is exceeded", () => {
			// A caller that bypasses StdinBuffer (feeds PASTE_START without an
			// end marker) must not accumulate memory forever. The cap fires
			// on the very chunk that would push the buffer past the limit,
			// delivering the buffered bytes so they are neither lost nor held.
			const handler = new BracketedPasteHandler({ byteLimit: 16 });
			handler.process(PASTE_START);
			const first = handler.process("0123456789");
			expect(first).toEqual({ handled: true, remaining: "" });

			const overflow = handler.process("abcdefgh");
			expect(overflow.handled).toBe(true);
			// @ts-expect-error - narrowed at runtime by the assertion above
			expect(overflow.pasteContent).toBe("0123456789abcdefgh");
			// @ts-expect-error - narrowed at runtime by the assertion above
			expect(overflow.remaining).toBe("");
		});

		it("resets state after a cap-abort so subsequent input is not eaten as paste", () => {
			const handler = new BracketedPasteHandler({ byteLimit: 8 });
			handler.process(PASTE_START);
			// One over the cap → cap-flush.
			const abort = handler.process("0123456789");
			expect(abort.handled).toBe(true);
			// A follow-up plain byte after recovery must go through as
			// unhandled so callers process it normally.
			const next = handler.process("x");
			expect(next).toEqual({ handled: false });
		});

		it("does not truncate a legitimate multi-chunk paste under the cap", () => {
			const handler = new BracketedPasteHandler({ byteLimit: 1024 });
			handler.process(PASTE_START);
			handler.process("hello ");
			handler.process("world");
			const result = handler.process(PASTE_END);
			expect(result.handled).toBe(true);
			// @ts-expect-error - handled=true carries pasteContent
			expect(result.pasteContent).toBe("hello world");
		});

		it("defaults to a generous cap that fits a small multi-chunk paste", () => {
			// Default byte limit is 64 MiB — a normal-sized paste completes
			// via the end marker, not via the cap.
			const handler = new BracketedPasteHandler();
			handler.process(PASTE_START);
			handler.process("x".repeat(100_000));
			const finish = handler.process(PASTE_END);
			expect(finish.handled).toBe(true);
			// @ts-expect-error - handled=true carries pasteContent
			expect(finish.pasteContent.length).toBe(100_000);
		});
	});

	describe("Baseline flow", () => {
		it("returns handled=false when no paste marker has been seen", () => {
			const handler = new BracketedPasteHandler();
			expect(handler.process("plain text")).toEqual({ handled: false });
		});

		it("assembles a paste delivered as a single chunk with both markers", () => {
			const handler = new BracketedPasteHandler();
			const result = handler.process(`${PASTE_START}payload${PASTE_END}tail`);
			expect(result.handled).toBe(true);
			// @ts-expect-error - handled=true carries pasteContent + remaining
			expect(result.pasteContent).toBe("payload");
			// @ts-expect-error - remaining carries post-marker input
			expect(result.remaining).toBe("tail");
		});
	});
});
