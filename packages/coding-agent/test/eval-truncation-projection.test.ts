/**
 * Eval's 3 FINAL-result truncation notice call sites (composed via
 * `.truncationFromSummary()`) are built on the same typed fact/projection
 * machinery read/grep/glob/bash use, instead of `OutputMetaBuilder`'s
 * body-baking round trip through `appendOutputNotice`. This is the FINAL
 * AgentToolResult body that feeds the LLM's context and non-ACP consumers
 * (TUI, print-mode) — the already-migrated live ACP wire path
 * (`presentation_events` producer/reducer/encoder, `LegacyEvalPresentation`,
 * `publishEvalTruncationFacts`) is untouched by this migration and not
 * exercised here.
 *
 * Byte-identity to the pre-migration text is the acceptance bar: every case
 * below cross-checks the new fact-based composition against
 * `formatTruncationMetaNotice`/`formatOutputNotice` — the exact functions the
 * legacy `appendOutputNotice` body-baking path still uses today for every
 * consumer this migration does not touch (`spillLargeResultToArtifact`,
 * `formatStyledTruncationWarning`, `publishEvalTruncationFacts`'s own `meta`
 * reads).
 *
 * The discriminating assertion is `result.details.presentationFacts`: the
 * legacy `ToolResultBuilder#truncationFromSummary` never calls `#pushFact`,
 * so this field is always `undefined` for every truncated case below on
 * that path — only the fact-based composition populates it, which is
 * exactly the shape a silent regression in fact production would break.
 *
 * Unlike bash, eval's `summarizeFinal` (eval.ts) never copies
 * `elidedBytes`/`elidedLines` from the raw `OutputSummary`, so
 * `truncationFromSummary` can never take the `direction: "middle"` branch for
 * eval directly — every `.truncationFromSummary()`-declared eval truncation is
 * `direction: "tail"`. Eval's own middle-elision case instead comes
 * from the SHARED `spillLargeResultToArtifact` wrapper every built-in tool
 * passes through regardless of whether the tool calls `.truncation()` itself
 * (see `bash-truncation-projection.test.ts`'s default-settings case and
 * `tools.test.ts`'s read-spill test for the same mechanism) — covered below in
 * its own describe block, since it needs a `sessionManager` in context.
 *
 * All 3 `.truncationFromSummary()` call sites are covered: the
 * normal-completion branch (no error), the nonzero-exit branch, and the
 * termination (timed-out) branch — each backed by a mocked `jsBackend.execute`
 * that streams enough bytes through `onChunk` to force `OutputSink`
 * truncation while returning a short `result.output`, so the combined output
 * stays well under `spillLargeResultToArtifact`'s threshold and the
 * fact-based path (not artifact spill) is what's exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { formatTruncationMetaNotice, wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

/**
 * 2000 fixed-width (50-byte), individually numbered lines — 100,000 bytes
 * total, comfortably over `OutputSink`'s 50KB default inline budget, streamed
 * through `onChunk` (so the sink's own retained-tail truncation applies)
 * while `result.output` (what feeds `combinedOutput`/`spillLargeResultToArtifact`)
 * stays short, keeping the top-level result well under the artifact-spill
 * threshold. `count` is overridable: a column cap shrinks each line, so the
 * column-cap case below needs more lines to stay over the byte threshold
 * after capping.
 */
const LINE_FILLER = "X".repeat(40);
const LINE_COUNT = 2000;
function wideLines(count = LINE_COUNT): string {
	const lines: string[] = [];
	for (let i = 1; i <= count; i++) {
		lines.push(`LINE${String(i).padStart(4, "0")}-${LINE_FILLER}`);
	}
	return `${lines.join("\n")}\n`;
}

function makeSession(cwd: string, settings = Settings.isolated()): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { path: path.join(cwd, `${id}.txt`), id };
		},
	} as unknown as ToolSession;
}

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("\n");
}

describe("eval final-result truncation notice (composed via presentation facts, not string concatenation)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-trunc-proj-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("no truncation, no column cap: no notice, no presentation facts", async () => {
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.("hi\n");
			return { output: "hi\n", exitCode: 0, termination: undefined, displayOutputs: [] as unknown[] };
		}) as never);

		const tool = wrapToolWithMetaNotice(new EvalTool(makeSession(tmpDir)));
		const result = (await tool.execute("call-none", { language: "js", code: "print('hi')" })) as {
			content: Array<{ type: string; text?: string }>;
			details?: EvalToolDetails;
		};

		expect(modelText(result)).not.toContain("[Showing");
		expect(result.details?.presentationFacts).toBeUndefined();
	});

	it("normal completion, tail-direction truncation only: byte-identical to the legacy formatter, via a threaded truncation fact", async () => {
		const wide = wideLines();
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.(wide);
			return { output: wide, exitCode: 0, termination: undefined, displayOutputs: [] as unknown[] };
		}) as never);

		const tool = wrapToolWithMetaNotice(new EvalTool(makeSession(tmpDir)));
		const result = (await tool.execute("call-tail", { language: "js", code: "print(wide)" })) as {
			content: Array<{ type: string; text?: string }>;
			details?: EvalToolDetails;
		};

		const meta = result.details?.meta;
		expect(meta?.truncation).toBeDefined();
		expect(meta?.truncation?.direction).toBe("tail");
		expect(meta?.limits?.columnTruncated).toBeUndefined();

		// Cross-check: the new fact-based composition must produce byte-identical
		// text to what the untouched legacy formatter computes from the very same
		// `meta` — the exact function `spillLargeResultToArtifact`,
		// `formatStyledTruncationWarning`, and `publishEvalTruncationFacts` still use.
		const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}]`;
		expect(modelText(result)).toEndWith(expectedBracket);

		// Discriminating assertion: absent entirely on the pre-migration source,
		// since `ToolResultBuilder#truncationFromSummary` never calls `#pushFact`.
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
		expect(facts?.[0]).not.toHaveProperty("id");
		const truncationFact = facts?.[0]?.kind === "truncation" ? facts[0].meta : undefined;
		expect(truncationFact).toEqual({
			direction: "tail",
			totalBytes: meta!.truncation!.totalBytes,
			retainedBytes: meta!.truncation!.outputBytes,
			totalLines: meta!.truncation!.totalLines,
			retainedLines: meta!.truncation!.outputLines,
			shownLineRange: meta!.truncation!.shownRange,
			truncatedBy: meta!.truncation!.truncatedBy === "middle" ? undefined : meta!.truncation!.truncatedBy,
			maxBytes: meta!.truncation!.maxBytes,
			nextOffset: meta!.truncation!.nextOffset,
			artifactId: meta!.truncation!.artifactId,
		});
		// eval always allocates an output artifact, unlike read/grep/glob/bash's
		// tests — confirm the artifact-suffix branch of the shared formatter
		// (`renderTruncationWindowNotice`'s `artifactId != null` arm) is live and
		// byte-identical here, not merely the no-artifact case.
		expect(meta!.truncation!.artifactId).toBeDefined();
		expect(modelText(result)).toContain(`artifact://${meta!.truncation!.artifactId}`);
	});

	it("tail truncation AND a per-line column cap join into ONE bracket on the nonzero-exit branch, matching legacy order", async () => {
		const wide = wideLines(4000); // 20-char column cap shrinks each line ~2.5x; need more lines to stay >50KB after capping
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.(wide);
			return { output: wide, exitCode: 3, termination: undefined, displayOutputs: [] as unknown[] };
		}) as never);

		const settings = Settings.isolated();
		settings.set("tools.outputMaxColumns", 20); // well under the 49-char fixture lines
		const tool = wrapToolWithMetaNotice(new EvalTool(makeSession(tmpDir, settings)));
		const result = (await tool.execute("call-exit-column", { language: "js", code: "process.exit(3)" })) as {
			content: Array<{ type: string; text?: string }>;
			details?: EvalToolDetails;
			isError?: boolean;
		};

		expect(result.isError).toBe(true);
		const meta = result.details?.meta;
		expect(meta?.truncation?.direction).toBe("tail");
		expect(meta?.limits?.columnTruncated).toBeDefined();

		// The legacy `formatOutputNotice` bracket order is truncation, then the
		// column notice, joined with ". " inside one bracket — exactly what
		// `renderNoticeTrail` reproduces for the fact-based path.
		const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}. Some lines truncated to ${meta!.limits!.columnTruncated!.maxColumn} chars]`;
		const text = modelText(result);
		expect(text).toEndWith(expectedBracket);
		expect(text.match(/\[Showing/g)).toHaveLength(1);

		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation", "limit"]);
		expect(facts?.[1]?.kind === "limit" ? facts[1].meta : undefined).toEqual({
			limit: "column",
			value: meta!.limits!.columnTruncated!.maxColumn,
		});
	});

	it("tail truncation on the termination (timed-out) branch: byte-identical, threaded fact present", async () => {
		const wide = wideLines();
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.(wide);
			return {
				output: wide,
				exitCode: undefined,
				termination: { kind: "timed_out", timeoutMs: 1000 },
				displayOutputs: [] as unknown[],
			};
		}) as never);

		const tool = wrapToolWithMetaNotice(new EvalTool(makeSession(tmpDir)));
		const result = (await tool.execute("call-timeout", { language: "js", code: "while(true){}" })) as {
			content: Array<{ type: string; text?: string }>;
			details?: EvalToolDetails;
			isError?: boolean;
		};

		expect(result.isError).toBe(true);
		expect(result.details?.termination).toEqual({ kind: "timed_out", timeoutMs: 1000 });
		const meta = result.details?.meta;
		expect(meta?.truncation?.direction).toBe("tail");

		const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}]`;
		expect(modelText(result)).toEndWith(expectedBracket);

		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
	});

	it("lone per-line column cap (output under threshold, so no truncation): stays on the untouched legacy path", async () => {
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			const line = `LINE0001-${LINE_FILLER}\n`;
			options.onChunk?.(line);
			return { output: line, exitCode: 0, termination: undefined, displayOutputs: [] as unknown[] };
		}) as never);

		const settings = Settings.isolated();
		settings.set("tools.outputMaxColumns", 20);
		const tool = wrapToolWithMetaNotice(new EvalTool(makeSession(tmpDir, settings)));
		const result = (await tool.execute("call-column-only", { language: "js", code: "print(line)" })) as {
			content: Array<{ type: string; text?: string }>;
			details?: EvalToolDetails;
		};

		const meta = result.details?.meta;
		expect(meta?.truncation).toBeUndefined();
		expect(meta?.limits?.columnTruncated).toEqual({ maxColumn: 20 });

		const expectedBracket = `\n\n[Some lines truncated to ${meta!.limits!.columnTruncated!.maxColumn} chars]`;
		expect(modelText(result)).toEndWith(expectedBracket);
		// No truncation fact exists to anchor a bracket on, matching
		// `renderNoticeTrail`'s (and read/grep/bash's own precedent's) refusal to
		// render a lone column notice — the field stays undefined entirely.
		expect(result.details?.presentationFacts).toBeUndefined();
	});
});

describe("eval spill-triggered middle-elision truncation (outputMetaFactBodies no longer bails on direction: middle)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-middle-spill-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("routes a spill-triggered middle-elision notice through the fact/projection path, byte-identical to the legacy formatter", async () => {
		// A short (well-under-inline-budget) streamed chunk but a large
		// `result.output` — `spillLargeResultToArtifact` measures the combined
		// text content of `result.content`, not what passed through `onChunk`,
		// so this exceeds the (tiny, overridden) spill threshold without ever
		// triggering `OutputSink`'s own inline truncation.
		const lines: string[] = [];
		for (let i = 1; i <= 400; i++) {
			lines.push(`eval-line-${String(i).padStart(4, "0")}`.padEnd(40, "."));
		}
		const bigOutput = lines.join("\n");
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.(bigOutput);
			return { output: bigOutput, exitCode: 0, termination: undefined, displayOutputs: [] as unknown[] };
		}) as never);

		const spillSettings = Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 5,
			"tools.artifactHeadBytes": 1, // >0 head retention forces middle elision
		});
		const spillManager = SessionManager.create(tmpDir, path.join(tmpDir, "spill-sessions"));
		await spillManager.ensureOnDisk();
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => spillManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			settings: spillSettings,
		} as unknown as ToolSession;
		const rawEvalTool = new EvalTool(session);
		const tool = wrapToolWithMetaNotice(rawEvalTool);
		const context = { sessionManager: spillManager, settings: spillSettings } as unknown as AgentToolContext;

		try {
			const result = (await tool.execute(
				"call-middle-spill",
				{ language: "js", code: "print(bigOutput)" },
				undefined,
				undefined,
				context,
			)) as { content: Array<{ type: string; text?: string }>; details?: EvalToolDetails };

			const meta = result.details?.meta;
			expect(meta?.truncation?.artifactId).toBeDefined();
			expect(meta?.truncation?.direction).toBe("middle");

			// Byte-identity: the re-derived fact must render the
			// exact same text `spillLargeResultToArtifact`'s untouched legacy
			// composer (`formatTruncationMetaNotice`) computes from the same
			// post-spill `meta`.
			const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}]`;
			expect(modelText(result)).toEndWith(expectedBracket);

			// A middle-elision spill on a producer using the fact/projection
			// path must produce a re-derived fact for the middle direction too,
			// not `undefined`.
			const facts = result.details?.presentationFacts;
			expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
			expect(facts?.[0]?.kind === "truncation" ? facts[0].meta.direction : undefined).toBe("middle");
			expect(facts?.[0]?.kind === "truncation" ? facts[0].meta.artifactId : undefined).toBe(
				meta!.truncation!.artifactId,
			);
		} finally {
			await spillManager.close();
		}
	});
});
