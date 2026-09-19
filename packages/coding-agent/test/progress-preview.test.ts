import { describe, expect, test } from "bun:test";
import { PROGRESS_LIMITS } from "@oh-my-pi/pi-coding-agent/async/progress-limits";
import {
	buildLineSnappedPreview,
	buildProgressPreview,
	flattenPreviewText,
	mergeProgressPreviews,
	ProgressPreviewAccumulator,
} from "@oh-my-pi/pi-coding-agent/session/progress-preview";

describe("progress preview line snapping", () => {
	test("truncated head ends and tail begins on complete lines", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `chatty line ${i + 1}`);
		const preview = buildLineSnappedPreview(lines.join("\n"));
		expect(preview.truncated).toBe(true);
		expect(lines).toContain(preview.head!.split("\n").at(-1)!);
		expect(lines).toContain(preview.tail!.split("\n")[0]!);
	});

	test("single oversized line keeps the byte split", () => {
		const preview = buildLineSnappedPreview("x".repeat(PROGRESS_LIMITS.PREVIEW_BYTES + 100));
		expect(preview.truncated).toBe(true);
		expect(preview.head!.length).toBeGreaterThan(0);
		expect(preview.tail!.length).toBeGreaterThan(0);
	});

	test("source-truncated window that fits the budget splits between complete lines", () => {
		const preview = buildLineSnappedPreview("line 1\nline 2\nline 98\nline 99", true);
		expect(preview.truncated).toBe(true);
		expect(preview.head).toBe("line 1\nline 2");
		expect(preview.tail).toBe("line 98\nline 99");
	});

	test("fitting window keeps its exact text even when source-truncated", () => {
		const text = `partial\n${"H".repeat(250)}${"T".repeat(250)}\nfinal`;
		const preview = buildProgressPreview(text, true);
		expect(preview.truncated).toBe(true);
		expect(preview.text).toBe(text);
	});

	test("empty previews return valid previews and preserve source truncation", () => {
		expect(mergeProgressPreviews(buildProgressPreview(""), buildProgressPreview(""))).toEqual({
			text: "",
			truncated: false,
		});
		expect(mergeProgressPreviews({ truncated: true }, { text: "visible output", truncated: false })).toEqual({
			text: "visible output",
			truncated: true,
		});
		expect(mergeProgressPreviews(buildProgressPreview("", true), buildProgressPreview(""))).toEqual({
			text: "",
			truncated: true,
		});
	});

	test("oversized byte split rejoins to a prefix and suffix of the source", () => {
		const text = Array.from({ length: 400 }, (_, i) => `wire line ${i + 1}`).join("\n");
		const preview = buildProgressPreview(text);
		expect(preview.truncated).toBe(true);
		expect(text.startsWith(preview.head!)).toBe(true);
		expect(text.endsWith(preview.tail!)).toBe(true);
	});

	test("repeated rate-limit merges never fabricate mid-line seams", () => {
		// Reproduces the dogfood corruption: windows merged round after round
		// produced "cha\ntty line 47"-style splits at every byte seam.
		let entry = { text: Array.from({ length: 100 }, (_, i) => `chatty line ${i + 1}`).join("\n"), truncated: false };
		for (let round = 1; round <= 4; round++) {
			const next = Array.from({ length: 100 }, (_, i) => `chatty line ${round * 100 + i + 1}`).join("\n");
			const preview = mergeProgressPreviews(
				buildProgressPreview(entry.text, entry.truncated),
				buildProgressPreview(next, false),
			);
			entry = { text: flattenPreviewText(preview), truncated: preview.truncated };
		}
		expect(entry.truncated).toBe(true);
		for (const line of entry.text.split("\n")) {
			expect(line).toMatch(/^chatty line \d+$/);
		}
	});

	test("accumulator keeps raw window edges for transport fidelity", () => {
		const accumulator = new ProgressPreviewAccumulator();
		for (let i = 1; i <= 400; i++) accumulator.append(`accumulated line ${i}`);
		const preview = accumulator.take()!;
		expect(preview.truncated).toBe(true);
		expect(preview.head!.startsWith("accumulated line 1\n")).toBe(true);
		expect(preview.tail!.endsWith("accumulated line 400")).toBe(true);
	});
	test("empty previews merge into an explicit empty preview", () => {
		expect(mergeProgressPreviews({ text: "", truncated: false }, { truncated: false })).toEqual({
			text: "",
			truncated: false,
		});
	});
});
