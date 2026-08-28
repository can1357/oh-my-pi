import { describe, expect, test } from "bun:test";
import { compactionLabel, compactionMethodLabel, compactTokens } from "../src/rpc/compaction";
import { TranscriptModel } from "../src/rpc/transcript";

/*
 * The strings below are the engine's, not invented: they are built in
 * `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts`. Pinning them
 * here is what makes parsing prose defensible — if omp rewords the line, this
 * fails instead of the banner silently never coming down.
 */
/*
 * The engine's own wording, so the desktop and the terminal name the same
 * event the same way. What used to live here — regexes over the sentence
 * `/compact` printed — is gone: both compaction paths now emit typed events.
 */
describe("naming a compaction", () => {
	test("method labels match the terminal's divider", () => {
		expect(compactionMethodLabel("remote")).toBe("remote-compacted");
		expect(compactionMethodLabel("handoff")).toBe("handed-off");
		expect(compactionMethodLabel("shake")).toBe("shaken");
		// An omp new enough to invent a method still gets a sentence.
		expect(compactionMethodLabel("something-new")).toBe("compacted");
		expect(compactionMethodLabel(undefined)).toBe("compacted");
	});

	test("token counts read like the status bar", () => {
		expect(compactTokens(87272)).toBe("87.3K");
		expect(compactTokens(940)).toBe("940");
	});

	test("labels an automatic pass the way the terminal narrates it", () => {
		expect(compactionLabel({ origin: "auto", reason: "overflow", action: "remote" })).toBe(
			"Context overflow detected, Auto server compaction…",
		);
		expect(compactionLabel({ origin: "auto", reason: "threshold", action: "snapcompact" })).toBe("Auto-snapcompact…");
	});

	test("a manual pass names its method once the engine reports one", () => {
		expect(compactionLabel({ origin: "manual" })).toBe("Compacting context…");
		expect(compactionLabel({ origin: "manual", action: "remote" })).toBe("Compacting · remote-compacted…");
	});

	test("an unknown reason or action still produces a sentence", () => {
		expect(compactionLabel({ origin: "auto" })).toBe("Auto context-full maintenance…");
	});
});

describe("the transcript records the boundary", () => {
	test("a finished compaction becomes a boundary", () => {
		const model = new TranscriptModel();
		const changed = model.apply({
			type: "auto_compaction_end",
			action: "remote",
			aborted: false,
			willRetry: false,
			tokensAfter: 32599,
			result: { summary: "Kept the decisions.", shortSummary: "Remote compaction", tokensBefore: 87272 },
		});

		expect(changed).toBe(true);
		expect(model.entries).toHaveLength(1);
		expect(model.entries[0]).toMatchObject({
			kind: "compaction",
			method: "remote",
			tokensBefore: 87272,
			tokensAfter: 32599,
		});
	});

	/*
	 * The row means "everything above here was replaced". A cancelled or skipped
	 * pass replaced nothing, so drawing it would misdescribe the transcript.
	 */
	test("a cancelled pass leaves no boundary", () => {
		const model = new TranscriptModel();
		expect(
			model.apply({
				type: "auto_compaction_end",
				action: "remote",
				aborted: true,
				willRetry: false,
				result: undefined,
			}),
		).toBe(false);
		expect(model.entries).toHaveLength(0);
	});

	test("a skipped pass leaves no boundary either", () => {
		const model = new TranscriptModel();
		expect(
			model.apply({
				type: "auto_compaction_end",
				action: "shake",
				aborted: false,
				willRetry: false,
				skipped: true,
				result: undefined,
			}),
		).toBe(false);
		expect(model.entries).toHaveLength(0);
	});

	/*
	 * Reopening is the case that matters most: the compaction is hours old, the
	 * messages it replaced are gone, and this row is the only thing that says
	 * where they went.
	 */
	test("a replayed session shows the compaction in its place", () => {
		const model = new TranscriptModel();
		model.hydrate([
			{ role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 },
			{
				role: "compactionSummary",
				summary: "Kept the architecture decisions and the failing test.",
				shortSummary: "Remote compaction",
				tokensBefore: 87272,
				tokensAfter: 32599,
				method: "remote",
			},
			{ role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 2 },
		]);

		expect(model.entries.map(entry => entry.kind)).toEqual(["message", "compaction", "message"]);
		expect(model.entries[1]).toMatchObject({
			kind: "compaction",
			method: "remote",
			tokensBefore: 87272,
			tokensAfter: 32599,
			shortSummary: "Remote compaction",
		});
	});

	test("a summary with no counts still marks the boundary", () => {
		const model = new TranscriptModel();
		model.hydrate([{ role: "compactionSummary", summary: "…" }]);
		expect(model.entries[0]).toMatchObject({ kind: "compaction", tokensBefore: undefined });
	});
});
