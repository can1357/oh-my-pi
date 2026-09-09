/**
 * Round-trip contract between `appendOutputNotice` (via `formatOutputNotice`)
 * and `stripOutputNotice`: anything the tool wrapper bakes into the LLM-facing
 * content body, the TUI renderer must be able to peel off so the styled
 * `⟨…⟩` warning line doesn't double-print next to the verbatim body text.
 *
 * Regression: bash/eval/ssh/browser/read all printed the same `[Showing …]`
 * string twice — once from the body content, once as the styled warning line.
 */
import { describe, expect, it } from "bun:test";
import {
	formatOutputNotice,
	type OutputMeta,
	outputMeta,
	stripOutputNotice,
} from "@oh-my-pi/pi-coding-agent/tools/output-meta";

const truncation: OutputMeta = {
	truncation: {
		direction: "middle",
		truncatedBy: "middle",
		totalLines: 8,
		totalBytes: 320,
		outputLines: 4,
		outputBytes: 105,
		headRange: { start: 1, end: 2 },
		tailRange: { start: 7, end: 8 },
		elidedLines: 4,
		elidedBytes: 215,
	},
};

const tailTruncation: OutputMeta = {
	truncation: {
		direction: "tail",
		truncatedBy: "bytes",
		totalLines: 100,
		totalBytes: 10_000,
		outputLines: 40,
		outputBytes: 4_000,
		maxBytes: 4_000,
		shownRange: { start: 61, end: 100 },
		artifactId: "abc123",
	},
};

const limitsOnly: OutputMeta = {
	limits: { matchLimit: { reached: 50, suggestion: 100 } },
};

describe("stripOutputNotice", () => {
	it("removes the exact notice appended by the wrapper for middle elision", () => {
		const body = "line1\nline2\n[…4ln elided…]\nline7\nline8";
		const notice = formatOutputNotice(truncation);
		const combined = body + notice;

		// Round-trip: the wrapper appends, the renderer peels off exactly.
		expect(stripOutputNotice(combined, truncation)).toBe(body);
	});

	it("removes the notice for tail truncation including artifact reference", () => {
		const body = "long output…";
		const notice = formatOutputNotice(tailTruncation);
		expect(notice).toContain("artifact://abc123");

		expect(stripOutputNotice(body + notice, tailTruncation)).toBe(body);
	});

	it("removes the notice for limit-only meta (no truncation)", () => {
		const body = "results…";
		const notice = formatOutputNotice(limitsOnly);
		expect(notice).toContain("matches limit reached");

		expect(stripOutputNotice(body + notice, limitsOnly)).toBe(body);
	});

	it("matches the trimEnd()'d body the renderer actually sees", () => {
		// bash.ts/eval.ts call `.trimEnd()` on the body before passing it in.
		// The notice itself ends with `]`, so trimEnd is a no-op on its tail;
		// confirm the strip still succeeds when the renderer hands us either
		// the trimmed or untrimmed form.
		const body = "the output";
		const combined = `${body}${formatOutputNotice(truncation)}\n\n`;

		// renderer trims, then strips
		expect(stripOutputNotice(combined.trimEnd(), truncation)).toBe(body);
		// renderer strips first
		expect(stripOutputNotice(combined, truncation).trimEnd()).toBe(body);
	});

	it("returns input unchanged when meta is undefined", () => {
		expect(stripOutputNotice("plain text", undefined)).toBe("plain text");
	});

	it("returns input unchanged when meta has no notice-emitting fields", () => {
		// e.g. meta carries only `source` info; formatOutputNotice yields "".
		const sourceOnly: OutputMeta = { source: { type: "path", value: "/tmp/x" } };
		expect(formatOutputNotice(sourceOnly)).toBe("");
		expect(stripOutputNotice("plain text", sourceOnly)).toBe("plain text");
	});

	it("returns input unchanged when body does not actually carry the notice (streaming case)", () => {
		// During streaming, `renderContext.output` is the live sink content
		// before wrappedExecute has appended anything. Calling stripOutputNotice
		// eagerly must not corrupt that prefix.
		const streaming = "partial output so far…";
		expect(stripOutputNotice(streaming, truncation)).toBe(streaming);
	});

	it("only strips the trailing occurrence, not a coincidental earlier match", () => {
		const noticeText = formatOutputNotice(truncation);
		// The same notice text appearing mid-body (unlikely but possible if the
		// command literally printed it) must be preserved when not at the tail.
		const body = `prefix${noticeText} middle suffix`;
		expect(stripOutputNotice(body, truncation)).toBe(body);
	});

	it("formats single-line byte windows without impossible line counts", () => {
		const meta = outputMeta()
			.truncation(
				{
					content: "head\n[…100B elided…]\ntail",
					truncated: true,
					truncatedBy: "middle",
					totalLines: 1,
					totalBytes: 200,
					outputLines: 3,
					outputBytes: 100,
					elidedBytes: 100,
					elidedLines: 0,
					headLines: 1,
					tailLines: 1,
					partialByteWindows: true,
				},
				{ direction: "middle" },
			)
			.get();

		const notice = formatOutputNotice(meta);

		expect(notice).toContain("Showing head and tail bytes of 1 line");
		expect(notice).not.toContain("Showing 3 of 1 lines");
	});
});
