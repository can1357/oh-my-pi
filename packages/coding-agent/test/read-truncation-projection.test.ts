/**
 * read's head/tail truncation notice is composed via the typed
 * fact/projection machinery instead of `OutputMetaBuilder.truncation()`'s
 * body-baking round trip through `appendOutputNotice`. Byte-identity to the
 * historical notice text is the acceptance bar — these assertions check the
 * exact strings the notice has always produced, via `ReadTool#execute`
 * directly (an integration check, not a unit test of the formatter).
 *
 * `head_lines_plus_column` is the co-occurrence case (line truncation AND the
 * per-line column cap notice joined into ONE bracket) that forced the scoping
 * decision documented on `ToolResultBuilder#truncationFact`.
 *
 * `renderTruncationWindowNotice` itself still rejects `direction: "middle"`
 * outright (asserted directly below) — `renderNoticeTrail` instead has a
 * separate `renderMiddleElisionNotice` arm for that direction, so the
 * fact/projection machinery now *does* reach bash/eval/read's middle-elision
 * case too (see `bash-truncation-projection.test.ts`'s default-settings case
 * and `tools.test.ts`'s read-spill test).
 *
 * `details.presentationFacts` carries fact **bodies**, not `ToolFact`s with
 * an identity: read holds no scoped producer to mint one, and a
 * tool-authored constant ID would collide across calls, making two
 * truncated results indistinguishable to any receipt/dedup consumer that
 * keys off fact identity. `ReadTool#modelContentProjection` therefore takes
 * only that fact-body array and returns only a trail string — its types give
 * it no way to see the raw result or replace content. The offset test below
 * drives a real path selector (`:31-`) instead of an inert `offset` property
 * the schema never consumed, so the assertion actually exercises a different
 * window rather than re-checking the default case under another name.
 *
 * read has three more call sites (archive directory listing, sqlite table
 * list, non-archive directory tree) that co-occur with a count-based
 * "N results limit reached" notice, which for a while had no `ToolFactBody`
 * counterpart. `LimitFactMeta`'s `"result_count"` discriminant (extending
 * the same `limit` kind already used for `"column"`) closes that gap: these
 * three sites now author `{kind: "limit", meta: {limit: "result_count", ...}}`
 * via `ToolResultBuilder#resultLimitFact` instead of body-baking through
 * `.limits({resultLimit})`, and `renderNoticeTrail` folds it into the same
 * trailing bracket. The archive/sqlite/tree tests below cover that path
 * directly; the rest of this file exercises the same head/tail truncation
 * fact/projection path described above, just against different fixtures.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	renderMiddleElisionNotice,
	renderNoticeTrail,
	renderTruncationWindowNotice,
} from "@oh-my-pi/pi-coding-agent/presentation/projections";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadUrlToolDetails } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool, type ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { writeArchive } from "@oh-my-pi/pi-coding-agent/utils/zip";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const COLUMN_CAP = 64;

function createSession(cwd: string, defaultLimit: number): ToolSession {
	const settings = Settings.isolated();
	settings.set("tools.outputMaxColumns", COLUMN_CAP);
	settings.set("read.summarize.enabled", false);
	settings.set("read.defaultLimit", defaultLimit);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		enableLsp: false,
	};
}

function modelText(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

/** Fixed-width, unique lines: `L0001 ...#` padded to exactly `width` bytes. */
function fixture(lines: number, width: number): string {
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) {
		const tag = `L${String(i).padStart(4, "0")}`;
		out.push(`${tag}${" ".repeat(Math.max(1, width - tag.length - 1))}#`);
	}
	return `${out.join("\n")}\n`;
}

describe("read head/tail truncation notice (composed via the fact/projection machinery, not body-baked into the output string)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-trunc-proj-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function readFile(name: string, defaultLimit: number, pathArg: string) {
		const session = createSession(tmpDir, defaultLimit);
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		return await tool.execute(`call-${name}`, { path: path.join(tmpDir, pathArg) });
	}

	it("head-truncated by line count: model text ends with the exact historical bracket, via a threaded truncation fact body", async () => {
		await fs.writeFile(path.join(tmpDir, "f.txt"), fixture(60, 20));
		const result = await readFile("head_lines", 20, "f.txt");

		expect(modelText(result)).toEndWith("\n\n[Showing lines 1-20 of 61. Use :21 to continue]");
		// The fact body is threaded through unchanged, not re-serialized into a
		// bare string — `details.meta.truncation` still carries the same
		// shape every other consumer (mapper/spill/TUI-fallback) has always read.
		const facts = result.details?.presentationFacts;
		expect(facts?.[0]?.kind).toBe("truncation");
		expect(facts?.[0]?.kind === "truncation" && facts[0].meta.direction).toBe("head");
		expect(result.details?.meta?.truncation?.direction).toBe("head");
		// No identity on the authored body — read holds no scoped producer to
		// mint a `FactId`; a tool-authored constant id would collide across
		// calls, so nothing here is `{id: ...}`.
		expect(facts?.[0]).not.toHaveProperty("id");
	});

	it("head-truncated with a real non-1 window selector (:31-): shown range and continuation reflect the actual requested window, not the line-1 case", async () => {
		await fs.writeFile(path.join(tmpDir, "f.txt"), fixture(60, 20));
		const result = await readFile("head_lines_offset", 20, "f.txt:31-");

		const text = modelText(result);
		// Genuinely distinct from the line-1 case above (shown range starts at
		// 30 — one line of leading context before the requested line 31 — not
		// 1), proving the selector actually drove a different window rather
		// than being ignored.
		expect(text).toEndWith("\n\n[Showing lines 30-50 of 61. Use :51 to continue]");
		expect(text).not.toContain("[Showing lines 1-20");
		const facts = result.details?.presentationFacts;
		expect(facts?.[0]?.kind === "truncation" && facts[0].meta.shownLineRange).toEqual({ start: 30, end: 50 });
	});

	it("head-truncated by byte budget: byte-limit annotation renders from the fact's maxBytes/truncatedBy", async () => {
		await fs.writeFile(path.join(tmpDir, "wide.txt"), fixture(60, 4096));
		const result = await readFile("head_bytes", 20, "wide.txt");

		expect(modelText(result)).toEndWith(
			"\n\n[Showing lines 1-12 of 61 (48.0KB limit). Use :13 to continue. Some lines truncated to 64 chars]",
		);
	});

	it("co-occurrence: line truncation AND the per-line column cap join into ONE bracket, not two", async () => {
		await fs.writeFile(path.join(tmpDir, "long.txt"), fixture(60, COLUMN_CAP * 3));
		const result = await readFile("head_lines_plus_column", 20, "long.txt");

		const text = modelText(result);
		expect(text).toEndWith("\n\n[Showing lines 1-20 of 61. Use :21 to continue. Some lines truncated to 64 chars]");
		// Exactly one bracket — not the notice duplicated by both the builder's
		// projection and the wrapper's default `appendOutputNotice` fallback.
		expect(text.match(/\[Showing lines/g)).toHaveLength(1);
		// Both facts threaded, both authored as bodies (no identity).
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation", "limit"]);
	});

	it("no truncation: no notice, no presentation facts", async () => {
		await fs.writeFile(path.join(tmpDir, "f.txt"), fixture(5, 20));
		const result = await readFile("no_truncation", 20, "f.txt");

		expect(modelText(result)).not.toContain("[Showing");
		expect(result.details?.presentationFacts).toBeUndefined();
	});

	it("two truncated reads in the same session never share fact identity, because neither carries one", async () => {
		// A tool-authored constant `FactId` would make
		// two truncated calls indistinguishable to a receipt/dedup consumer.
		// The fix removes identity from the tool-authored side entirely rather
		// than minting a different constant — verify no call produces an `id`.
		await fs.writeFile(path.join(tmpDir, "f.txt"), fixture(60, 20));
		const first = await readFile("call-a", 20, "f.txt");
		const second = await readFile("call-b", 20, "f.txt:31-");

		for (const result of [first, second]) {
			for (const fact of result.details?.presentationFacts ?? []) {
				expect(fact).not.toHaveProperty("id");
			}
		}
	});
});

describe("renderTruncationWindowNotice (shared by read's projection and the legacy formatTruncationMetaNotice, non-middle directions only)", () => {
	it('rejects direction: "middle" outright — that direction has its own renderMiddleElisionNotice formatter', () => {
		expect(() => renderTruncationWindowNotice({ direction: "middle", totalBytes: 100, retainedBytes: 50 })).toThrow(
			/middle/,
		);
	});
});

describe('renderMiddleElisionNotice (the direction: "middle" arm renderNoticeTrail dispatches to)', () => {
	it('throws for a non-"middle" direction — the counterpart guard to renderTruncationWindowNotice\'s own', () => {
		expect(() => renderMiddleElisionNotice({ direction: "head", totalBytes: 100, retainedBytes: 50 })).toThrow(
			/middle/,
		);
	});

	it("returns undefined when both totalLines and retainedLines are absent — nothing this sentence can report", () => {
		expect(renderMiddleElisionNotice({ direction: "middle", totalBytes: 100, retainedBytes: 50 })).toBeUndefined();
	});

	it("renders the full head+tail sentence byte-identically to the legacy formatTruncationMetaNotice middle branch", () => {
		expect(
			renderMiddleElisionNotice({
				direction: "middle",
				totalBytes: 2048,
				retainedBytes: 512,
				totalLines: 100,
				retainedLines: 21,
				elidedBytes: 1536,
				elidedLines: 12,
				headLineRange: { start: 1, end: 10 },
				tailLineRange: { start: 91, end: 100 },
			}),
		).toBe("Showing lines 1-10 and 91-100 of 100; 12 middle lines (1.5KB) elided");
	});

	it("singularizes a 1-line elision", () => {
		expect(
			renderMiddleElisionNotice({
				direction: "middle",
				totalBytes: 200,
				retainedBytes: 190,
				totalLines: 11,
				retainedLines: 10,
				elidedBytes: 10,
				elidedLines: 1,
				headLineRange: { start: 1, end: 5 },
				tailLineRange: { start: 7, end: 11 },
			}),
		).toBe("Showing lines 1-5 and 7-11 of 11; 1 middle line (10B) elided");
	});

	it("falls back to the plain 'N of M lines' sentence when a head or tail range is missing", () => {
		expect(
			renderMiddleElisionNotice({
				direction: "middle",
				totalBytes: 2048,
				retainedBytes: 512,
				totalLines: 100,
				retainedLines: 21,
			}),
		).toBe("Showing 21 of 100 lines; middle elided");
	});

	it("appends nextOffset and artifactId suffixes in the same order as the non-middle formatter", () => {
		expect(
			renderMiddleElisionNotice({
				direction: "middle",
				totalBytes: 2048,
				retainedBytes: 512,
				totalLines: 100,
				retainedLines: 21,
				elidedBytes: 1536,
				elidedLines: 12,
				headLineRange: { start: 1, end: 10 },
				tailLineRange: { start: 91, end: 100 },
				nextOffset: 11,
				artifactId: "7",
			}),
		).toBe(
			"Showing lines 1-10 and 91-100 of 100; 12 middle lines (1.5KB) elided. Use :11 to continue. Read artifact://7 for full output",
		);
	});
});

describe("renderNoticeTrail (the narrowed adapter contract, widened to also cover result_count limits)", () => {
	it("takes only fact bodies and returns only trail text — never content, never the raw result", () => {
		// Structural proof of the narrowed contract: the function's parameter
		// type is `readonly ToolFactBody[]`, not `AgentToolResult`, so it has no
		// way to read or replace a body; its return type is `string | undefined`,
		// not a content array, so it has no way to delete or replace anything —
		// it can only ever describe a trail for the caller to append.
		expect(renderNoticeTrail([])).toBeUndefined();
		// A middle-elision fact lacking totalLines/retainedLines is the one shape
		// `renderMiddleElisionNotice` cannot render (see its own doc comment) —
		// distinct from the middle-direction support below, which requires both.
		expect(
			renderNoticeTrail([{ kind: "truncation", meta: { direction: "middle", totalBytes: 100, retainedBytes: 50 } }]),
		).toBeUndefined();
		expect(
			renderNoticeTrail([
				{
					kind: "truncation",
					meta: {
						direction: "head",
						totalBytes: 10,
						retainedBytes: 10,
						totalLines: 5,
						shownLineRange: { start: 1, end: 3 },
					},
				},
			]),
		).toBe("\n\n[Showing lines 1-3 of 5]");
	});

	it('a full direction: "middle" fact renders through renderMiddleElisionNotice instead of declining', () => {
		expect(
			renderNoticeTrail([
				{
					kind: "truncation",
					meta: {
						direction: "middle",
						totalBytes: 2048,
						retainedBytes: 512,
						totalLines: 100,
						retainedLines: 21,
						elidedBytes: 1536,
						elidedLines: 12,
						headLineRange: { start: 1, end: 10 },
						tailLineRange: { start: 91, end: 100 },
					},
				},
			]),
		).toBe("\n\n[Showing lines 1-10 and 91-100 of 100; 12 middle lines (1.5KB) elided]");
	});

	it("a result_count limit fact alone renders its own bracket — no truncation fact required", () => {
		expect(
			renderNoticeTrail([{ kind: "limit", meta: { limit: "result_count", value: 5, suggestedValue: 10 } }]),
		).toBe("\n\n[5 results limit reached. Use limit=10 for more]");
	});

	it("a column-only limit fact with no truncation and no result_count renders nothing (column-only sites intentionally stay on the legacy notice path)", () => {
		expect(renderNoticeTrail([{ kind: "limit", meta: { limit: "column", value: 64 } }])).toBeUndefined();
	});

	it("truncation AND result_count join into ONE bracket, truncation first", () => {
		expect(
			renderNoticeTrail([
				{
					kind: "truncation",
					meta: {
						direction: "head",
						totalBytes: 10,
						retainedBytes: 10,
						totalLines: 5,
						shownLineRange: { start: 1, end: 3 },
					},
				},
				{ kind: "limit", meta: { limit: "result_count", value: 500, suggestedValue: 1000 } },
			]),
		).toBe("\n\n[Showing lines 1-3 of 5. 500 results limit reached. Use limit=1000 for more]");
	});
});

describe("read's count-based listing caps (archive directory, sqlite table list, non-archive directory tree)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-count-limit-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function readPath(name: string, pathArg: string) {
		const session = createSession(tmpDir, 20);
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		return await tool.execute(`call-${name}`, { path: pathArg });
	}

	it("archive directory listing over the 500-entry default cap: limit-only notice (no co-occurring truncation), via a threaded result_count fact", async () => {
		const archivePath = path.join(tmpDir, "bundle.zip");
		const entries: Array<readonly [string, string]> = [];
		for (let i = 1; i <= 520; i++) entries.push([`e${String(i).padStart(4, "0")}.txt`, ""]);
		await writeArchive(archivePath, "zip", entries);

		const result = await readPath("archive_result_limit", archivePath);
		const text = modelText(result);

		expect(text).toEndWith("\n\n[500 results limit reached. Use limit=1000 for more]");
		expect(text.match(/\[/g)).toHaveLength(1);
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["limit"]);
		expect(facts?.[0]?.kind === "limit" ? facts[0].meta : undefined).toEqual({
			limit: "result_count",
			value: 500,
			suggestedValue: 1000,
		});
	});

	it("sqlite table list over the 500-table default cap, co-occurring with byte truncation: ONE bracket, result_count after the truncation window", async () => {
		const dbPath = path.join(tmpDir, "many-tables.db");
		const db = new Database(dbPath);
		try {
			// Fixed-width, unique names (`t0001_...`) long enough that 500 lines
			// of `renderTableList` output (~130B/line) clears the 50KB inline
			// truncation budget too — the discriminating co-occurrence case.
			for (let i = 1; i <= 520; i++) {
				const tag = `t${String(i).padStart(4, "0")}`;
				const name = `${tag}${"_".repeat(120 - tag.length)}`;
				db.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`);
			}
		} finally {
			db.close();
		}

		const result = await readPath("sqlite_result_limit_plus_truncation", dbPath);
		const text = modelText(result);

		expect(text).toMatch(
			/\n\n\[Showing lines 1-\d+ of 500 \(50\.0KB limit\)\. Use :\d+ to continue\. 500 results limit reached\. Use limit=1000 for more\]$/,
		);
		// Exactly one bracket, not the notice duplicated by both the builder's
		// projection and the wrapper's default `appendOutputNotice` fallback.
		expect(text.match(/\[Showing lines/g)).toHaveLength(1);
		const facts = result.details?.presentationFacts;
		// `renderNoticeTrail` composes the bracket in a fixed order
		// regardless of authoring order (asserted above via the text match);
		// the *declared* order here reflects the call site's own
		// `.resultLimitFact(...)` before `.truncationFact(...)`.
		expect(facts?.map(f => f.kind)).toEqual(["limit", "truncation"]);
		expect(facts?.[0]?.kind === "limit" ? facts[0].meta : undefined).toEqual({
			limit: "result_count",
			value: 500,
			suggestedValue: 1000,
		});
		// The legacy `details.meta` shape is still populated exactly as before —
		// every other `details.meta` consumer (ACP mapper, spill, TUI fallback)
		// keeps reading precisely what it always has.
		expect(result.details?.meta?.limits?.resultLimit).toEqual({ reached: 500, suggestion: 1000 });
		expect(result.details?.meta?.truncation?.direction).toBe("head");
	});

	it("non-archive directory tree: a subdirectory beyond the 12-entry per-dir cap trips the tree's own resultLimit(1) notice", async () => {
		const subDir = path.join(tmpDir, "many");
		await fs.mkdir(subDir);
		for (let i = 1; i <= 15; i++) {
			await fs.writeFile(path.join(subDir, `f${String(i).padStart(2, "0")}.txt`), "");
		}

		const result = await readPath("dir_tree_result_limit", tmpDir);
		const text = modelText(result);

		expect(text).toEndWith("\n\n[1 results limit reached. Use limit=2 for more]");
		expect(text.match(/\[/g)).toHaveLength(1);
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["limit"]);
		expect(facts?.[0]?.kind === "limit" ? facts[0].meta : undefined).toEqual({
			limit: "result_count",
			value: 1,
			suggestedValue: 2,
		});
	});
});

describe("read's URL fetch delegate (executeReadUrl, fetch.ts)", () => {
	// `executeReadUrl` is invoked from `ReadTool#execute` (read.ts) — the same
	// wrapped instance whose `modelContentProjection` renders read's other
	// truncation sites, so a fact authored here must be picked up identically.
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-url-trunc-proj-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	function urlSession(): ToolSession {
		const settings = Settings.isolated({ "fetch.enabled": true });
		let nextArtifactId = 0;
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => null,
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => {
				const id = String(nextArtifactId++);
				return { id, path: path.join(tmpDir, `artifact-${id}.log`) };
			},
			settings,
			enableLsp: false,
		};
	}

	/** Fixed-width, unique lines: `L0001 ...#` padded to exactly `width` bytes. */
	function urlFixture(lines: number, width: number): string {
		const out: string[] = [];
		for (let i = 1; i <= lines; i++) {
			const tag = `L${String(i).padStart(4, "0")}`;
			out.push(`${tag}${" ".repeat(Math.max(1, width - tag.length - 1))}#`);
		}
		return `${out.join("\n")}\n`;
	}

	it("head-truncated URL fetch: model text ends with the exact historical bracket, via a threaded truncation fact body carrying the artifact id", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			finalUrl: "https://example.com/big.txt",
			contentType: "text/plain",
			content: urlFixture(400, 20),
		});

		const session = urlSession();
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const result = await tool.execute("call-url-head", { path: "https://example.com/big.txt" });
		const text = modelText(result as AgentToolResult<ReadToolDetails>);

		// URL output is prefixed with a 6-line header (URL/Content-Type/Method/blank/---/blank),
		// so 400 fixture lines + trailing "\n" + the header contribute 406 total lines.
		expect(text).toEndWith(
			"\n\n[Showing lines 1-300 of 406. Use :301 to continue. Read artifact://0 for full output]",
		);
		expect(text.match(/\[Showing lines/g)).toHaveLength(1);

		const details = result.details as ReadUrlToolDetails | undefined;
		const facts = details?.presentationFacts;
		expect(facts?.[0]?.kind).toBe("truncation");
		expect(facts?.[0]?.kind === "truncation" && facts[0].meta.direction).toBe("head");
		expect(facts?.[0]?.kind === "truncation" && facts[0].meta.artifactId).toBe("0");
		expect(facts?.[0]).not.toHaveProperty("id");
		// `details.meta` stays populated exactly as before for every other
		// consumer (ACP mapper, `spillLargeResultToArtifact`, `renderReadUrlResult`).
		expect(details?.meta?.truncation?.direction).toBe("head");
		expect(details?.meta?.truncation?.artifactId).toBe("0");
	});

	it("un-truncated URL fetch: no notice, no presentation facts", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			finalUrl: "https://example.com/small.txt",
			contentType: "text/plain",
			content: urlFixture(5, 20),
		});

		const session = urlSession();
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const result = await tool.execute("call-url-small", { path: "https://example.com/small.txt" });
		const text = modelText(result as AgentToolResult<ReadToolDetails>);

		expect(text).not.toContain("[Showing");
		expect((result.details as ReadUrlToolDetails | undefined)?.presentationFacts).toBeUndefined();
	});
});
