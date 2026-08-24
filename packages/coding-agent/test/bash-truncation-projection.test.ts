/**
 * Bash's FINAL-result truncation notice (composed via
 * `.truncationFromSummary()`) is built on the same typed fact/projection
 * machinery read/grep/glob use, instead of `OutputMetaBuilder`'s
 * body-baking round trip through `appendOutputNotice`. This is the FINAL
 * AgentToolResult body that feeds the LLM's context and non-ACP consumers
 * (TUI, print-mode) — the already-migrated live ACP wire path
 * (`presentation_events` producer/reducer/encoder, `LegacyBashPresentation`)
 * is untouched by this migration and not exercised here.
 *
 * Byte-identity to the pre-migration text is the acceptance bar: every case
 * below cross-checks the new fact-based composition against
 * `formatTruncationMetaNotice`/`formatOutputNotice` — the exact functions the
 * legacy `appendOutputNotice` body-baking path still uses today for every
 * consumer this migration does not touch (`spillLargeResultToArtifact`,
 * `formatStyledTruncationWarning`, the ACP facts publisher's own `meta` reads).
 *
 * The discriminating assertion is `result.details.presentationFacts`: the
 * legacy `ToolResultBuilder#truncationFromSummary` never calls `#pushFact`,
 * so this field stays `undefined` on that path for every case below,
 * including the truncated ones — only the fact-based composition populates
 * it, which is exactly the shape a silent regression in fact production
 * would break.
 *
 * `executeBash` reads `Settings.init()` internally rather than an injected
 * option, so every case mocks that static (matching
 * `bash-presentation-protocol.test.ts`'s own precedent) instead of passing
 * settings through `BashExecutorOptions`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { formatTruncationMetaNotice, wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * 5000 fixed-width (50-byte), individually numbered lines — 250,000 bytes
 * total, comfortably over `OutputSink`'s 50KB default inline budget even
 * after a 20-char column cap shrinks each line (which
 * `executeBash` never threads a settings override through — only
 * `headBytes`/`maxColumns` are configurable per call, see
 * `resolveOutputSinkHeadBytes`/`resolveOutputMaxColumns`).
 */
const LINE_FILLER = "X".repeat(40);
const LINE_COUNT = 5000;
const WIDE_LINE_COMMAND = `i=1; while [ $i -le ${LINE_COUNT} ]; do printf 'LINE%04d-${LINE_FILLER}\\n' "$i"; i=$((i+1)); done`;

function createSession(cwd: string, settings: Settings): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "session-1",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings,
		getClientBridge: () => undefined,
		asyncJobManager: undefined,
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { path: path.join(cwd, `${id}.txt`), id };
		},
		saveArtifact: async (text: string) => {
			const id = String(nextArtifactId++);
			await fs.writeFile(path.join(cwd, `${id}.txt`), text);
			return id;
		},
	} as unknown as ToolSession;
}

function modelText(result: AgentToolResult<BashToolDetails>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

describe("bash final-result truncation notice (composed via presentation facts, not string concatenation)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-trunc-proj-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	async function runBash(
		name: string,
		command: string,
		settingOverrides: Partial<Record<SettingPath, unknown>>,
	): Promise<AgentToolResult<BashToolDetails>> {
		const settings = Settings.isolated(settingOverrides);
		// `executeBash` (`exec/bash-executor.ts`) reads the process-global
		// `Settings.init()` singleton, not an injected option — mock it per case
		// so `headBytes`/`maxColumns` reach the real `OutputSink`.
		vi.spyOn(Settings, "init").mockResolvedValue(settings);
		const session = createSession(tmpDir, settings);
		const tool = wrapToolWithMetaNotice(new BashTool(session));
		return await tool.execute(`call-${name}`, { command, pty: false });
	}

	it("no truncation, no column cap: no notice, no presentation facts", async () => {
		const result = await runBash("none", "echo hi", {
			"tools.artifactHeadBytes": 0,
			"tools.outputMaxColumns": 0,
		});

		expect(modelText(result)).not.toContain("[Showing");
		expect(modelText(result)).not.toContain("truncated to");
		expect(result.details?.presentationFacts).toBeUndefined();
	});

	it("tail-direction truncation only: byte-identical to the legacy formatter, via a threaded truncation fact", async () => {
		const result = await runBash("tail_only", WIDE_LINE_COMMAND, {
			"tools.artifactHeadBytes": 0, // tail-only (no head retention) forces direction: "tail"
			"tools.outputMaxColumns": 0,
		});

		const meta = result.details?.meta;
		expect(meta?.truncation).toBeDefined();
		expect(meta?.truncation?.direction).toBe("tail");
		expect(meta?.limits?.columnTruncated).toBeUndefined();

		// Cross-check: the new fact-based composition must produce byte-identical
		// text to what the untouched legacy formatter computes from the very same
		// `meta` — the exact function `spillLargeResultToArtifact`,
		// `formatStyledTruncationWarning`, and the ACP facts publisher still use.
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
	});

	it("tail-direction truncation AND a per-line column cap join into ONE bracket, matching the legacy joined-notice order", async () => {
		const result = await runBash("tail_plus_column", WIDE_LINE_COMMAND, {
			"tools.artifactHeadBytes": 0,
			"tools.outputMaxColumns": 20, // well under the 49-char fixture lines
		});

		const meta = result.details?.meta;
		expect(meta?.truncation?.direction).toBe("tail");
		expect(meta?.limits?.columnTruncated).toBeDefined();

		// The legacy `formatOutputNotice` bracket order is truncation, then the
		// column notice, joined with ". " inside one bracket — exactly what
		// `renderNoticeTrail` reproduces for the fact-based path.
		const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}. Some lines truncated to ${meta!.limits!.columnTruncated!.maxColumn} chars]`;
		const text = modelText(result);
		expect(text).toEndWith(expectedBracket);
		expect(text.match(/\[Showing|\[Elided/g)).toHaveLength(1);

		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation", "limit"]);
		expect(facts?.[1]?.kind === "limit" ? facts[1].meta : undefined).toEqual({
			limit: "column",
			value: meta!.limits!.columnTruncated!.maxColumn,
		});
	});

	it("middle-direction (head+tail retention) truncation now renders through the typed fact/projection path, byte-identical to the legacy formatter", async () => {
		const result = await runBash("middle", WIDE_LINE_COMMAND, {
			"tools.artifactHeadBytes": 5, // >0 head retention forces middle elision
			"tools.outputMaxColumns": 0,
		});

		const meta = result.details?.meta;
		expect(meta?.truncation?.direction).toBe("middle");

		// `renderNoticeTrail` renders middle-elision truncation via
		// `renderMiddleElisionNotice`, which must reproduce the legacy
		// `formatTruncationMetaNotice` middle branch byte-for-byte. The
		// discriminating assertion is `presentationFacts`: the legacy
		// body-baking path never populates it, so only the fact-based
		// composition can produce it here — the byte-identity assertion alone
		// would keep passing even if fact production silently regressed.
		const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}]`;
		expect(modelText(result)).toEndWith(expectedBracket);

		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
		expect(facts?.[0]).not.toHaveProperty("id");
		const truncationFact = facts?.[0]?.kind === "truncation" ? facts[0].meta : undefined;
		expect(truncationFact).toEqual({
			direction: "middle",
			totalBytes: meta!.truncation!.totalBytes,
			retainedBytes: meta!.truncation!.outputBytes,
			totalLines: meta!.truncation!.totalLines,
			retainedLines: meta!.truncation!.outputLines,
			elidedBytes: meta!.truncation!.elidedBytes,
			elidedLines: meta!.truncation!.elidedLines,
			headLineRange: meta!.truncation!.headRange,
			tailLineRange: meta!.truncation!.tailRange,
			nextOffset: meta!.truncation!.nextOffset,
			artifactId: meta!.truncation!.artifactId,
		});
	});

	it("middle-direction truncation under PRODUCTION-DEFAULT settings (no overrides): still byte-identical via the fact path", async () => {
		// `tools.artifactHeadBytes` defaults to 20 (>0), so an untouched default
		// session hits middle elision on any oversized bash run — this is the
		// dominant real-world case for middle elision, not an edge case.
		const result = await runBash("middle_default", WIDE_LINE_COMMAND, {});

		const meta = result.details?.meta;
		expect(meta?.truncation?.direction).toBe("middle");

		const expectedBracket = `\n\n[${formatTruncationMetaNotice(meta!.truncation!)}]`;
		expect(modelText(result)).toEndWith(expectedBracket);

		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
	});

	it("middle-direction truncation AND a per-line column cap join into ONE bracket, matching the legacy joined-notice order", async () => {
		const result = await runBash("middle_plus_column", WIDE_LINE_COMMAND, {
			"tools.artifactHeadBytes": 5,
			"tools.outputMaxColumns": 20,
		});

		const meta = result.details?.meta;
		expect(meta?.truncation?.direction).toBe("middle");
		expect(meta?.limits?.columnTruncated).toBeDefined();

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

	it("lone per-line column cap (output under threshold, so no truncation): stays on the untouched legacy path", async () => {
		// A single line just over the column cap but the whole run stays well
		// under the spill threshold, so `meta.truncation` is never set.
		const result = await runBash("column_only", `printf 'LINE0001-${LINE_FILLER}\\n'`, {
			"tools.artifactHeadBytes": 0,
			"tools.outputMaxColumns": 20,
		});

		const meta = result.details?.meta;
		expect(meta?.truncation).toBeUndefined();
		expect(meta?.limits?.columnTruncated).toEqual({ maxColumn: 20 });

		const expectedBracket = `\n\n[Some lines truncated to ${meta!.limits!.columnTruncated!.maxColumn} chars]`;
		expect(modelText(result)).toEndWith(expectedBracket);
		// No truncation fact exists to anchor a bracket on, matching
		// `renderNoticeTrail`'s (and read/grep's own precedent's) refusal to
		// render a lone column notice — the field stays undefined entirely.
		expect(result.details?.presentationFacts).toBeUndefined();
	});
});
