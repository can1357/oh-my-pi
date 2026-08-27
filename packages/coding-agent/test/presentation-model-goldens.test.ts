import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ByteOffset, StreamId, ToolFact } from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf, byteOffset, factId, PRESENTATION_VERSION, streamId } from "@oh-my-pi/pi-agent-core/presentation";
import type { ToolPresentationView } from "../src/presentation/projections";
import { factsFor, renderModelContent, renderTuiPresentation } from "../src/presentation/projections";
import type { PresentationContentBlock } from "../src/presentation/schemas/content";
import { buildModelGoldenCorpus } from "./helpers/model-golden-corpus";

/**
 * Byte goldens for the model-facing projection.
 *
 * Model content is the one projection whose exact bytes are contractual: it enters
 * the LLM's history, is persisted, and is what compaction later re-reads.
 *
 * **These files are not regenerated from the projection.** They are transcriptions of
 * the bytes the producers put in front of the model today — captured from live runs
 * (`presentation-model-parity.test.ts` re-derives the bash ones against the real tool
 * on every run) or read off the producer's own composition code for routes that
 * cannot be driven in-process. A `UPDATE_MODEL_GOLDENS=1` escape hatch used to exist
 * and made the corpus self-referential: the formatter wrote the file it was then
 * checked against, so a projection that moved a line "passed" by rewriting the
 * expectation. Change a golden only by editing the file with the producer bytes in
 * hand.
 *
 * Scope note: the goldens lock the *projection*. The tool still composes the
 * body that actually reaches the model today, so model-facing bytes are
 * preserved by construction; these files plus the parity suite make a future
 * handover of that authority to the projection a reviewable diff instead of a
 * silent change.
 */

const GOLDEN_DIR = path.join(import.meta.dir, "__goldens__", "model-content");

/** Serialize the projected blocks in a shape where a diff is readable. */
function serialize(blocks: readonly PresentationContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			parts.push(`--- text ---\n${block.text}`);
		} else {
			parts.push(`--- image ${block.mimeType} (${block.data.length} b64 chars) ---`);
		}
	}
	return `${parts.join("\n")}\n`;
}

const corpus = buildModelGoldenCorpus();

describe("model content goldens", () => {
	for (const fixture of corpus) {
		it(`matches the golden for ${fixture.slug} (${fixture.covers})`, () => {
			const actual = serialize(renderModelContent(fixture.view));
			const file = path.join(GOLDEN_DIR, `${fixture.slug}.txt`);
			const expected = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
			expect(
				expected,
				`missing golden ${fixture.slug}.txt — write it from the producer's own model-facing bytes, never from this projection`,
			).toBeDefined();
			expect(actual).toBe(expected ?? "");
		});
	}
});

describe("model golden corpus coverage", () => {
	it("has a unique slug per fixture", () => {
		const slugs = corpus.map(fixture => fixture.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	it("covers every producer the wire matrix declares", () => {
		// Mirrors the producer axis of `COVERAGE` in `acp-producer-wire.test.ts`.
		const producers = new Set(corpus.map(fixture => fixture.covers.split(" × ")[0]));
		for (const producer of ["bash", "bash (client terminal)", "eval", "hub", "edit"]) {
			expect(producers.has(producer), `no model golden covers producer ${producer}`).toBe(true);
		}
	});

	it("covers every notice-heavy variant", () => {
		const slugs = new Set(corpus.map(fixture => fixture.slug));
		// The notice-heavy shapes worth locking down explicitly: truncation +
		// artifact spill, LSP diagnostics, timeout, nonzero exit, multi-file partial
		// edit failure, eval-with-image, column truncation.
		for (const required of [
			"bash-artifact-spill",
			"edit-lsp-diagnostics",
			"bash-timeout-local",
			"bash-nonzero-exit",
			"edit-partial-failure",
			"eval-image",
			"bash-column-truncation",
		]) {
			expect(slugs.has(required), `missing required golden ${required}`).toBe(true);
		}
	});

	it("keeps the corpus in the declared 15-25 fixture band", () => {
		// This corpus targets roughly 15-20 representative model goldens, not a
		// snapshot of every incidental string. A corpus that grows past this is a
		// signal to ask which bytes are actually contractual.
		expect(corpus.length).toBeGreaterThanOrEqual(15);
		expect(corpus.length).toBeLessThanOrEqual(25);
	});

	it("derives model/human visibility from the audience table, with exact content or exact absence", () => {
		// `renderModelContent` must show only `"all"`-audience facts and never a
		// `"human"`-only one; `renderTuiPresentation` is the inverse. The vocabulary
		// currently has real facts for both existing policy values — `wall_time`
		// (`"all"`) and `unreported_annotation` (`"human"`) — but no built-in fact uses
		// `"model"` yet (added only once there's a first concrete need for it). The
		// filter both projections share is `policy === "all" || policy === audience`,
		// which is symmetric in `"model"` and `"human"`: proving the `"human"` target
		// correctly admits `"all"`/rejects nothing-but-`"human"` and the `"model"`
		// target correctly admits `"all"`/rejects `"human"` already exercises the
		// exact branch a future `"model"`-only fact would take.
		const allFact: ToolFact = { id: factId("audience-probe:f0"), kind: "wall_time", ms: 1500 };
		const humanOnlyFact: ToolFact = {
			id: factId("audience-probe:f1"),
			kind: "unreported_annotation",
			text: "pty requested but unavailable",
		};
		const view: ToolPresentationView = {
			call: { toolCallId: "audience-probe", toolName: "bash", title: "echo hi", kind: "execute" },
			outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } },
			presentation: {
				version: PRESENTATION_VERSION,
				stream: {
					streamId: streamId("audience-probe-stream") as StreamId,
					startByte: byteOffset(0) as ByteOffset,
					endByte: byteOffset(byteLengthOf("hi\n")) as ByteOffset,
					text: "hi\n",
					gaps: [],
				},
				facts: [allFact, humanOnlyFact],
				attachments: [],
			},
		};

		// Model projection: exactly the `"all"` fact's text, never the human-only one.
		const modelBlocks = renderModelContent(view);
		const modelText = modelBlocks.find(block => block.type === "text");
		expect(modelText?.type === "text" ? modelText.text : undefined).toBe("hi\n\n\nWall time: 1.50 seconds");
		expect(modelBlocks.some(block => block.type === "text" && block.text.includes("pty requested"))).toBe(false);

		// TUI (human) projection: both facts render, each with exact text, tagged as
		// fact rows — not folded into the body.
		const tui = renderTuiPresentation(view);
		const factLines = tui.lines.filter(line => line.role === "fact").map(line => line.text);
		expect(factLines).toEqual(["Wall time: 1.50 seconds", "pty requested but unavailable"]);

		// The audience filter itself, directly: an `"all"` fact clears both targets; a
		// `"human"`-only fact clears only `"human"`.
		expect(factsFor([allFact], "model")).toEqual([allFact]);
		expect(factsFor([allFact], "human")).toEqual([allFact]);
		expect(factsFor([humanOnlyFact], "model")).toEqual([]);
		expect(factsFor([humanOnlyFact], "human")).toEqual([humanOnlyFact]);
	});
});
