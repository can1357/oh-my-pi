/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		setKittyProtocolActive(false);
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		emittedSequences = [];
		buffer.on("data", (sequence: string) => {
			emittedSequences.push(sequence);
		});
	});

	afterEach(() => {
		// Kill pending flush/watchdog timers: a stale timer from a prior test's
		// buffer would otherwise emit into the current test's emittedSequences
		// (the data listener closes over the reassigned module variable).
		buffer.destroy();
		setKittyProtocolActive(false);
	});

	// Helper to process data through the buffer
	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	// Poll until `predicate` holds. Fixed sleeps race the flush timer chain
	// (timeout -> setTimeout(0) deferral): under parallel test load, an expired
	// sleep with an older deadline resolves before the deferral fires, so the
	// assertion would observe pre-flush state. The deadline only guards against
	// a hung test; the caller's expect() reports the real failure.
	async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate() && Date.now() < deadline) {
			await Bun.sleep(2);
		}
	}

	describe("Regular Characters", () => {
		it("should handle unicode characters", () => {
			processInput("hello \u4e16\u754c");
			expect(emittedSequences).toEqual(["h", "e", "l", "l", "o", " ", "\u4e16", "\u754c"]);
		});

		it("emits surrogate-pair code points as one text sequence", () => {
			processInput("🙂");
			expect(emittedSequences).toEqual(["🙂"]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b");

			processInput("[<35");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			expect(emittedSequences).toEqual([]);

			processInput("1;");
			expect(emittedSequences).toEqual([]);

			processInput("5H");
			expect(emittedSequences).toEqual(["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
		});

		it("reassembles an OSC whose ST is split exactly at the chunk boundary", () => {
			// Chunk 1 ends on the ESC of `ESC \`; chunk 2 opens with the `\`.
			// The resume overlap (`resumeSearchFrom - 1`) must re-inspect the
			// trailing ESC, or the terminator is never seen and the payload
			// leaks via timeout flush as raw bytes.
			processInput("\x1b]52;c;aGVsbG8=\x1b");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b]52;c;aGVsbG8=\x1b");

			processInput("\\");
			expect(emittedSequences).toEqual(["\x1b]52;c;aGVsbG8=\x1b\\"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("reassembles a DCS whose ST is split exactly at the chunk boundary", () => {
			processInput("\x1bPq#0;2;0;0;0\x1b");
			expect(emittedSequences).toEqual([]);

			processInput("\\");
			expect(emittedSequences).toEqual(["\x1bPq#0;2;0;0;0\x1b\\"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should flush incomplete sequence after timeout", async () => {
			// Non-mouse CSI partial: ambiguous, so it flushes after the timeout.
			processInput("\x1b[1;5");
			expect(emittedSequences).toEqual([]);

			// Wait for the flush timeout to deliver the partial
			await waitUntil(() => emittedSequences.length > 0);

			expect(emittedSequences).toEqual(["\x1b[1;5"]);
		});

		it("should hold a split SGR mouse partial past the flush timeout and reassemble it", async () => {
			// `\x1b[<…` is unambiguously a mouse report: the partial must never
			// flush on timeout, or its tail leaks as typed text (settings search
			// filling with `[<35;8;16M`).
			processInput("\x1b[<35;8;16");
			await Bun.sleep(30);
			expect(emittedSequences).toEqual([]);

			processInput("M");
			expect(emittedSequences).toEqual(["\x1b[<35;8;16M"]);
		});

		it("should deliver a held mouse partial raw once the hold cap expires", async () => {
			const capped = new StdinBuffer({ timeout: 5, partialHoldTimeout: 20 });
			const emitted: string[] = [];
			capped.on("data", sequence => emitted.push(sequence));
			try {
				capped.process("\x1b[<35;8;16");
				await waitUntil(() => emitted.length > 0);
				// Tail never arrived: delivered as one raw sequence (ESC intact,
				// so downstream treats it as control data, not typed text).
				expect(emitted).toEqual(["\x1b[<35;8;16"]);
			} finally {
				capped.destroy();
			}
		});

		it("should hold a lone ESC while the kitty protocol is active and join the mouse tail", async () => {
			setKittyProtocolActive(true);
			try {
				// Under kitty the ESC key arrives as \x1b[27u, so a bare \x1b is
				// always the head of a split sequence.
				processInput("\x1b");
				await Bun.sleep(30);
				expect(emittedSequences).toEqual([]);

				processInput("[<35;8;16M");
				expect(emittedSequences).toEqual(["\x1b[<35;8;16M"]);
			} finally {
				setKittyProtocolActive(false);
			}
		});

		it("should flush a lone ESC after timeout when the kitty protocol is inactive", async () => {
			// Legacy terminals: a bare ESC is a real keypress and must not lag
			// behind the flush timeout by more than the deferral.
			processInput("\x1b");
			await waitUntil(() => emittedSequences.length > 0);
			expect(emittedSequences).toEqual(["\x1b"]);
		});
	});

	describe("Double-ESC disambiguation", () => {
		it("joins a held bare ESC with a following CSI into one meta sequence", async () => {
			processInput("\x1b");
			processInput("\x1b[B");
			await waitUntil(() => emittedSequences.length > 0);
			expect(emittedSequences).toEqual(["\x1b\x1b[B"]);
		});

		it("splits a bare ESC from a following SGR mouse report", async () => {
			processInput("\x1b");
			processInput("\x1b[<35;22;17M");
			await waitUntil(() => emittedSequences.length > 0);
			expect(emittedSequences).toEqual(["\x1b", "\x1b[<35;22;17M"]);
		});

		it("splits a trailing double-ESC into two ESC events after the timeout", async () => {
			// A bare `\x1b\x1b` is two real Esc keypresses (or legacy alt+esc).
			// `parseKey` returns undefined for the combined chunk, so emitting it
			// as one swallows double-escape gestures (#3857). Split on flush so
			// downstream handlers fire twice.
			processInput("\x1b\x1b");
			expect(emittedSequences).toEqual([]);
			await waitUntil(() => emittedSequences.length >= 2);
			expect(emittedSequences).toEqual(["\x1b", "\x1b"]);
		});

		it("preserves legacy Alt chords batched after a bare ESC", () => {
			processInput("\x1b\x1bX");
			expect(emittedSequences).toEqual(["\x1b", "\x1bX"]);

			emittedSequences = [];
			processInput("\x1b\x1bd");
			expect(emittedSequences).toEqual(["\x1b", "\x1bd"]);

			emittedSequences = [];
			processInput("\x1b\x1b\x7f");
			expect(emittedSequences).toEqual(["\x1b", "\x1b\x7f"]);
		});

		it("consumes a whole meta-CSI arrow in one chunk", () => {
			processInput("\x1b\x1b[A");
			expect(emittedSequences).toEqual(["\x1b\x1b[A"]);
		});
	});

	describe("Mixed Content", () => {
		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			expect(emittedSequences).toEqual(["a", "b", "c"]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toEqual(["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			processInput("\x1b[97u\x1b[97;1:3u");
			expect(emittedSequences).toEqual(["\x1b[97u", "\x1b[97;1:3u"]);
		});

		it("should handle multiple batched Kitty events", () => {
			// Press 'a', release 'a', press 'b', release 'b'
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			expect(emittedSequences).toEqual(["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			// Delete key release
			processInput("\x1b[3;1:3~");
			expect(emittedSequences).toEqual(["\x1b[3;1:3~"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			expect(emittedSequences).toEqual(["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	describe("Kitty Printable Dedup Window", () => {
		it("swallows the immediate bare duplicate of a kitty printable", () => {
			// Buggy double-report: CSI-u event plus the bare char in one write.
			processInput("\x1b[97ua");
			expect(emittedSequences).toEqual(["\x1b[97u"]);
		});

		it("does not swallow a real keystroke after the dedup window expires", async () => {
			processInput("\x1b[97u");
			await Bun.sleep(50);
			processInput("a");
			expect(emittedSequences).toEqual(["\x1b[97u", "a"]);
		});
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			expect(emittedSequences).toEqual(["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			expect(emittedSequences).toEqual(["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			expect(emittedSequences).toEqual(["\x1b[<35;15;10m"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			expect(emittedSequences).toEqual(["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			expect(emittedSequences).toEqual(["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			expect(buffer.getBuffer()).toBe("\x1b[M");

			processInput(" a");
			expect(buffer.getBuffer()).toBe("\x1b[M a");

			processInput("b");
			expect(emittedSequences).toEqual(["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			// Empty string emits an empty data event
			expect(emittedSequences).toEqual([""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			// After timeout, should emit
			await waitUntil(() => emittedSequences.length > 0);
			expect(emittedSequences).toEqual(["\x1b"]);
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			const flushed = buffer.flush();
			expect(flushed).toEqual(["\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			expect(emittedSequences).toEqual(["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			expect(emittedSequences).toEqual([longSeq]);
		});
	});

	describe("Large Plain-Text Bursts", () => {
		it("splits a large non-bracketed burst into per-character events quickly", () => {
			// Pins the O(n) scan: the prior per-iteration slice/Array.from made
			// this O(n²) — a 64KB burst would blow the test timeout.
			const content = "0123456789abcdef".repeat(4096); // 64 KB
			processInput(content);
			expect(emittedSequences.length).toBe(content.length);
			expect(emittedSequences[0]).toBe("0");
			expect(emittedSequences[emittedSequences.length - 1]).toBe("f");
		});

		it("keeps escape parsing and surrogate pairs intact inside a burst", () => {
			processInput("abc🙂\x1b[A\u{1f389}def\x1b[<35;20;5m\x1b");
			expect(emittedSequences).toEqual([
				"a",
				"b",
				"c",
				"🙂",
				"\x1b[A",
				"\u{1f389}",
				"d",
				"e",
				"f",
				"\x1b[<35;20;5m",
			]);
			expect(buffer.getBuffer()).toBe("\x1b");
		});
	});

	describe("Flush", () => {
		it("should flush incomplete sequences", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			expect(flushed).toEqual(["\x1b[<35"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			expect(flushed).toEqual([]);
		});

		it("should emit flushed data via timeout", async () => {
			processInput("\x1b[1;5");
			expect(emittedSequences).toEqual([]);

			// Wait for the flush timeout to deliver the partial
			await waitUntil(() => emittedSequences.length > 0);

			expect(emittedSequences).toEqual(["\x1b[1;5"]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.clear();
			expect(buffer.getBuffer()).toBe("");
			expect(emittedSequences).toEqual([]);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];
		let emittedPasteEnters: (string | undefined)[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			// Collect emitted sequences
			emittedSequences = [];
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});

			// Collect paste events
			emittedPaste = [];
			emittedPasteEnters = [];
			buffer.on("paste", (data: string, enter?: string) => {
				emittedPaste.push(data);
				emittedPasteEnters.push(enter);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]); // No data events during paste
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			expect(emittedPaste).toEqual([]);

			processInput("hello ");
			expect(emittedPaste).toEqual([]);

			processInput("world\x1b[201~");
			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			expect(emittedSequences).toEqual(["a", "b"]);
			expect(emittedPaste).toEqual(["pasted"]);
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			expect(emittedPaste).toEqual(["line1\nline2\nline3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello \u4e16\u754c \u{1f389}\x1b[201~");

			expect(emittedPaste).toEqual(["Hello \u4e16\u754c \u{1f389}"]);
			expect(emittedSequences).toEqual([]);
		});

		it("assembles paste when the end marker is split across chunks", () => {
			processInput("\x1b[200~hello world\x1b[201");
			expect(emittedPaste).toEqual([]);

			processInput("~");
			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]);
		});

		it("assembles paste when the start and end markers arrive one byte at a time", () => {
			for (const ch of "\x1b[200~ab\x1b[201~") {
				processInput(ch);
			}
			expect(emittedPaste).toEqual(["ab"]);
			expect(emittedSequences).toEqual([]);
		});

		it("preserves trailing input after a boundary-split end marker", () => {
			processInput("\x1b[200~paste\x1b");
			processInput("[201~x");
			expect(emittedPaste).toEqual(["paste"]);
			expect(emittedPasteEnters).toEqual([undefined]);
			expect(emittedSequences).toEqual(["x"]);
		});

		// A paste-and-Enter burst arrives in one read from automation and from
		// terminals that batch input. Splitting it lets an overlay the paste opens
		// swallow the Enter, so the Enter stays on the paste event in both keyboard
		// encodings; anything else after the paste keeps the normal data route.
		for (const [label, enter] of [
			["legacy \\r", "\r"],
			["legacy \\n", "\n"],
			["kitty CSI-u", "\x1b[13u"],
			["kitty CSI-u with explicit no-modifier field", "\x1b[13;1u"],
		] as const) {
			it(`keeps a same-read Enter (${label}) on the paste event`, () => {
				processInput(`\x1b[200~paste\x1b[201~${enter}`);
				expect(emittedPaste).toEqual(["paste"]);
				expect(emittedPasteEnters).toEqual([enter]);
				expect(emittedSequences).toEqual([]);
			});
		}

		it("routes bytes after the attached Enter as ordinary input", () => {
			processInput("\x1b[200~paste\x1b[201~\rnext");
			expect(emittedPasteEnters).toEqual(["\r"]);
			expect(emittedSequences).toEqual(["n", "e", "x", "t"]);
		});

		for (const [label, sequence] of [
			["a modified kitty Enter", "\x1b[13;2u"],
			["a DA1 terminal report", "\x1b[?1;2c"],
			["an arrow key", "\x1b[A"],
			["printable text", "x"],
		] as const) {
			it(`leaves ${label} after a paste on the data route`, () => {
				processInput(`\x1b[200~paste\x1b[201~${sequence}`);
				expect(emittedPaste).toEqual(["paste"]);
				expect(emittedPasteEnters).toEqual([undefined]);
				expect(emittedSequences).toEqual([sequence]);
			});
		}

		it("does not attach an Enter that arrives in a later read", async () => {
			processInput("\x1b[200~paste\x1b[201~");
			processInput("\r");
			expect(emittedPasteEnters).toEqual([undefined]);
			await waitUntil(() => emittedSequences.length === 1);
			expect(emittedSequences).toEqual(["\r"]);
		});

		it("does not end the paste on a partial end-marker prefix in the body", () => {
			// Body contains the first five bytes of the end marker but no `~`.
			processInput("\x1b[200~before\x1b[201");
			expect(emittedPaste).toEqual([]);

			processInput("after\x1b[201~");
			expect(emittedPaste).toEqual(["before\x1b[201after"]);
			expect(emittedSequences).toEqual([]);
		});

		it("reconstructs a large paste delivered in many small chunks", () => {
			const content = "0123456789abcdef".repeat(8192); // 128 KB
			processInput("\x1b[200~");
			for (let i = 0; i < content.length; i += 64) {
				processInput(content.slice(i, i + 64));
			}
			processInput("\x1b[201~");

			expect(emittedPaste).toEqual([content]);
			expect(emittedSequences).toEqual([]);
		});
	});

	describe("Raw multiline paste burst (issue #5841)", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });
			emittedSequences = [];
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});
			emittedPaste = [];
			buffer.on("paste", (data: string) => {
				emittedPaste.push(data);
			});
		});

		it("coalesces an unbracketed CR-delimited burst into one paste instead of per-line submits", () => {
			// Codex desktop delivers Cmd+V without \x1b[200~…\x1b[201~ markers, so
			// each interior CR would otherwise fire a submit and split the block.
			processInput("line 1\rline 2\rline 3");
			expect(emittedPaste).toEqual(["line 1\rline 2\rline 3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("coalesces an unbracketed LF-delimited burst too", () => {
			processInput("line 1\nline 2\nline 3");
			expect(emittedPaste).toEqual(["line 1\nline 2\nline 3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("coalesces a CRLF-delimited three-line burst", () => {
			processInput("line 1\r\nline 2\r\nline 3");
			expect(emittedPaste).toEqual(["line 1\r\nline 2\r\nline 3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("coalesces one raw paste split across adjacent stdin reads", () => {
			processInput("line 1\r");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual([]);

			processInput("line 2\rline 3");
			expect(emittedPaste).toEqual(["line 1\rline 2\rline 3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("coalesces a paste whose first line was already delivered before a break-only read", () => {
			processInput("line 1");
			processInput("\r");
			processInput("line 2\rline 3");

			expect(emittedSequences.join("")).toBe("line 1");
			expect(emittedPaste).toEqual(["\rline 2\rline 3"]);
		});

		it("leaves a single Enter batched with a following keystroke on the normal path", async () => {
			// The event loop can batch one Enter plus the next typed char into a
			// single stdin read; that is byte-identical to a two-line paste, so it
			// must keep the Enter's submit rather than coalesce (PR #5843 review).
			processInput("a\rb");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual([]);
			await waitUntil(() => emittedSequences.length === 3);
			expect(emittedSequences).toEqual(["a", "\r", "b"]);
		});

		it("leaves a two-line burst on the normal path (one interior break is ambiguous)", async () => {
			processInput("foo\rbar");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual([]);
			await waitUntil(() => emittedSequences.length === 7);
			expect(emittedSequences).toEqual(["f", "o", "o", "\r", "b", "a", "r"]);
		});

		it("leaves a lone Enter as a normal submit keypress", async () => {
			processInput("\r");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual([]);
			await waitUntil(() => emittedSequences.length === 1);
			expect(emittedSequences).toEqual(["\r"]);
		});

		it("leaves typed text with a trailing Enter on the normal path", async () => {
			processInput("hello\r");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual([]);
			await waitUntil(() => emittedSequences.length === 6);
			expect(emittedSequences).toEqual(["h", "e", "l", "l", "o", "\r"]);
		});

		it("does not coalesce a run of bare Enters", async () => {
			processInput("\r\r");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual([]);
			await waitUntil(() => emittedSequences.length === 2);
			expect(emittedSequences).toEqual(["\r", "\r"]);
		});

		it("keeps a single-line burst on the per-character data path", () => {
			processInput("hello world");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences.join("")).toBe("hello world");
		});

		it("does not treat an escape-bearing chunk as a raw burst", () => {
			// A CSI arrow key next to a CR must keep its escape parsing.
			processInput("\x1b[A\rx");
			expect(emittedPaste).toEqual([]);
			expect(emittedSequences).toEqual(["\x1b[A", "\r", "x"]);
		});
	});

	describe("Paste Recovery", () => {
		it("recovers from a lost end marker via the inactivity watchdog", async () => {
			buffer = new StdinBuffer({ timeout: 10, pasteTimeout: 20 });
			const pastes: string[] = [];
			const data: string[] = [];
			buffer.on("paste", d => pastes.push(d));
			buffer.on("data", s => data.push(s));

			buffer.process("\x1b[200~lost marker content");
			expect(pastes).toEqual([]);

			await waitUntil(() => pastes.length > 0);
			expect(pastes).toEqual(["lost marker content"]);

			// Input is alive again after recovery.
			buffer.process("a");
			expect(data).toEqual(["a"]);
		});

		it("re-arms the watchdog while paste chunks keep arriving", async () => {
			buffer = new StdinBuffer({ timeout: 10, pasteTimeout: 50 });
			const pastes: string[] = [];
			buffer.on("paste", d => pastes.push(d));

			buffer.process("\x1b[200~part1 ");
			await Bun.sleep(20);
			buffer.process("part2");
			await Bun.sleep(20);
			expect(pastes).toEqual([]); // still inside the re-armed window

			buffer.process("\x1b[201~");
			expect(pastes).toEqual(["part1 part2"]);
		});

		it("aborts paste mode when the byte cap is exceeded", () => {
			buffer = new StdinBuffer({ timeout: 10, pasteByteLimit: 8 });
			const pastes: string[] = [];
			const data: string[] = [];
			buffer.on("paste", d => pastes.push(d));
			buffer.on("data", s => data.push(s));

			buffer.process("\x1b[200~0123456789abcdef");
			expect(pastes).toEqual(["0123456789abcdef"]);

			buffer.process("x");
			expect(data).toEqual(["x"]);
		});
	});

	describe("Malformed Escape Bounds (issue #4073 case A)", () => {
		it("caps a malformed CSI without terminator so a single process() stays bounded", () => {
			// The prior grow-and-recheck inner loop rescanned every prefix on
			// each call; a streamed run with no final byte in 0x40-0x7E left
			// the whole prefix in the buffer and re-inspected it forever.
			const input = `\x1b[${";".repeat(200_000)}`;
			processInput(input);
			// Cap-flush emitted the leading capped prefix as one raw sequence
			// so progress is guaranteed; the rest is per-scalar plain text.
			expect(emittedSequences.length).toBeGreaterThan(0);
			expect(emittedSequences[0]!.length).toBeLessThan(input.length);
			expect(buffer.getBuffer().length).toBe(0);
		});

		it("resumes OSC terminator search across chunks — chunked payload stays O(total)", () => {
			// A legit chunked OSC 5522 payload must not force a full re-scan
			// of the accumulated buffer per chunk. Delivery completes on the
			// terminator; only the assembled sequence is emitted.
			const chunkSize = 4096;
			const chunkCount = 128;
			const chunk = "a".repeat(chunkSize);
			processInput("\x1b]5522;type=read;");
			for (let i = 0; i < chunkCount - 1; i++) processInput(chunk);
			processInput(`${chunk.slice(0, chunkSize - 1)}\x07`);
			expect(emittedSequences.length).toBe(1);
			expect(emittedSequences[0]!.startsWith("\x1b]5522;")).toBe(true);
			expect(emittedSequences[0]!.endsWith("\x07")).toBe(true);
			expect(buffer.getBuffer().length).toBe(0);
		});

		it("caps a streamed CSI garbage run so the buffer never grows without bound", () => {
			// Streaming a malformed CSI (no terminator) in many small chunks
			// used to accumulate the whole run in #buffer, giving O(n^2)
			// cumulative work. After the cap fires, the buffer resets so
			// subsequent chunks are re-scanned fresh.
			processInput("\x1b[");
			// Ten 8 KiB chunks — first two exceed MAX_CSI_BYTES (4 KiB) and
			// force a cap-flush; the buffer must not retain the full run.
			for (let i = 0; i < 10; i++) processInput(";".repeat(8192));
			expect(buffer.getBuffer().length).toBeLessThan(8192);
		});

		it("resets the string-search hint before processing paste remainder", () => {
			// A stale OSC/DCS/APC resume offset must not be reused after paste
			// mode clears the buffer. Otherwise a complete post-paste string
			// sequence whose terminator is before the old offset is retained
			// and later flushed together with trailing text.
			processInput(`\x1b]${"x".repeat(100)}`);
			processInput("\x1b[200~paste\x1b[201~\x1b]z\x07abc");

			expect(emittedSequences).toEqual(["\x1b]z\x07", "a", "b", "c"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("discards an unterminated OSC delivered as one oversized chunk instead of typing its tail", () => {
			// MAX_STRING_SEQ_BYTES = 16 MiB. A chunk whose OSC payload exceeds
			// the cap with no BEL/ST is torn protocol data: delivering it as
			// raw sequences used to type the tail into the focused component
			// as thousands of keystrokes. The junk head is dropped and discard
			// mode swallows everything up to the stream's own terminator.
			const cap = 16 * 1024 * 1024;
			const head = "\x1b]5522;";
			processInput(`${head}${"a".repeat(cap - head.length)}xy`);

			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("");

			// Still mid-string: further payload is swallowed, not typed.
			processInput("zzzz");
			expect(emittedSequences).toEqual([]);

			// The torn string's own terminator ends discard mode; input after
			// it parses normally.
			processInput("tail\x1b\\\x1b]z\x07abc");
			expect(emittedSequences).toEqual(["\x1b]z\x07", "a", "b", "c"]);
			expect(buffer.getBuffer()).toBe("");
		});
	});

	describe("Torn String Sequences (kitty OSC 5522 paste spam)", () => {
		it("swallows a torn kitty OSC 5522 packet instead of typing its base64 tail", async () => {
			// Regression: a stall past the incomplete-sequence flush window mid
			// packet during a kitty OSC 5522 clipboard read (image paste) tore
			// the packet — the flushed head reached the editor as an unknown
			// escape and the packet's remaining base64 was typed into the
			// composer as plain text, while the read state machine still
			// completed and inserted the corrupt image: image chip + base64
			// spam.
			setKittyProtocolActive(true);
			buffer.destroy();
			buffer = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});

			const okPacket = "\x1b]5522;type=read:status=OK\x1b\\";
			processInput(`${okPacket}\x1b]5522;type=read:status=DATA:mime=aW1hZ2UvcG5n;${"A".repeat(512)}`);
			expect(emittedSequences).toEqual([okPacket]);

			// Stall past timeout + partial hold: the torn head is dropped, not
			// delivered as a key.
			await waitUntil(() => buffer.getBuffer().length === 0);
			expect(emittedSequences).toEqual([okPacket]);

			// The packet tail (base64 + ST) arrives after the stall: swallowed,
			// not typed. The next packet is delivered intact.
			processInput(`${"B".repeat(512)}\x1b\\`);
			const donePacket = "\x1b]5522;type=read:status=DONE\x1b\\";
			processInput(donePacket);
			expect(emittedSequences).toEqual([okPacket, donePacket]);
		});

		it("detects a split ST terminator while discarding a torn string tail", async () => {
			setKittyProtocolActive(true);
			buffer.destroy();
			buffer = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b]5522;type=read:status=DATA:mime=Lg==;partial");
			await waitUntil(() => buffer.getBuffer().length === 0);
			expect(emittedSequences).toEqual([]);

			// Terminator split across reads: trailing ESC held, backslash in
			// the next chunk completes ST and what follows resumes as keys.
			processInput("tail\x1b");
			processInput("\\ok");
			expect(emittedSequences).toEqual(["o", "k"]);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.destroy();
			expect(buffer.getBuffer()).toBe("");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			// Wait longer than timeout
			await Bun.sleep(15);

			// Should not have emitted anything
			expect(emittedSequences).toEqual([]);
		});
	});
});
