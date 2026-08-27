/**
 * Grep's and glob's truncation + result/match-limit notices are composed via
 * the same typed fact/projection machinery `read` uses, instead of
 * `OutputMetaBuilder`'s body-baking round trip through `appendOutputNotice`.
 * Byte-identity to the pre-migration text is the acceptance bar, proven here
 * against the exact strings a pre-migration golden harness captured via
 * `GrepTool#execute`/`GlobTool#execute` directly (not a
 * unit test of the formatter).
 *
 * grep has no live `matchLimit` producer (see `presentation/projections.ts`'s
 * `renderNoticeTrail` doc comment) — its own match-count caps surface as a
 * hand-composed `limitMessage` string baked directly into the body, never
 * through `OutputMetaBuilder.matchLimit()`/`.limits({matchLimit})`, so there
 * is nothing to migrate there. Its lone-column-cap case (line truncation
 * absent, per-line column cap present) stays on the untouched `.limits()`
 * legacy path, mirroring read's own lone-`columnMax` handling.
 *
 * glob has no column cap at all; its only migrated pair is truncation +
 * `resultLimit`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GlobTool, type GlobToolDetails } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool, type GrepToolDetails } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function modelText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

/** `NEEDLE Lnnnn ----...#` padded to exactly `width` bytes, fixed and unique per line. */
function matchLine(index: number, width: number): string {
	const tag = `NEEDLE L${String(index).padStart(4, "0")}`;
	return `${tag}${"-".repeat(Math.max(1, width - tag.length - 1))}#`;
}

function fixture(lines: number, width: number): string {
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) out.push(matchLine(i, width));
	return `${out.join("\n")}\n`;
}

describe("grep head/tail truncation notice (composed via presentation facts, not string concatenation)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-trunc-proj-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function grepFile(name: string, fileName: string): Promise<AgentToolResult<GrepToolDetails>> {
		const session = createSession(tmpDir);
		const tool = wrapToolWithMetaNotice(new GrepTool(session));
		return await tool.execute(`call-${name}`, { pattern: "NEEDLE", path: fileName });
	}

	it("no truncation, no column cap: no notice, no presentation facts", async () => {
		await fs.writeFile(path.join(tmpDir, "f.txt"), fixture(3, 40));
		const result = await grepFile("none", "f.txt");

		expect(modelText(result)).not.toContain("[Showing");
		expect(modelText(result)).not.toContain("truncated to");
		expect(result.details?.presentationFacts).toBeUndefined();
	});

	it("lone per-line column cap (no line truncation) stays on the untouched .limits() legacy path — matches read's lone-columnMax precedent", async () => {
		await fs.writeFile(path.join(tmpDir, "wide.txt"), fixture(3, 900));
		const result = await grepFile("col_only", "wide.txt");

		expect(modelText(result)).toEndWith("\n\n[Some lines truncated to 512 chars]");
		expect(result.details?.presentationFacts).toBeUndefined();
		expect(result.details?.meta?.limits?.columnTruncated).toEqual({ maxColumn: 512 });
	});

	it("head-truncated by byte budget: model text ends with the exact historical bracket, via a threaded truncation fact body", async () => {
		await fs.writeFile(path.join(tmpDir, "trunc.txt"), fixture(250, 400));
		const result = await grepFile("trunc_only", "trunc.txt");

		expect(modelText(result)).toEndWith("\n\n[Showing lines 1-127 of 201 (49.9KB limit). Use :128 to continue]");
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
		expect(facts?.[0]).not.toHaveProperty("id");
		expect(result.details?.meta?.truncation?.direction).toBe("head");
	});

	it("co-occurrence: line truncation AND the per-line column cap join into ONE bracket, not two", async () => {
		await fs.writeFile(path.join(tmpDir, "wide_trunc.txt"), fixture(250, 900));
		const result = await grepFile("trunc_plus_col", "wide_trunc.txt");

		const text = modelText(result);
		expect(text).toEndWith(
			"\n\n[Showing lines 1-100 of 201 (50.0KB limit). Use :101 to continue. Some lines truncated to 512 chars]",
		);
		expect(text.match(/\[Showing lines/g)).toHaveLength(1);
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation", "limit"]);
		expect(facts?.[1]?.kind === "limit" ? facts[1].meta : undefined).toEqual({ limit: "column", value: 512 });
		// meta stays populated exactly as before for every other consumer.
		expect(result.details?.meta?.limits?.columnTruncated).toEqual({ maxColumn: 512 });
	});
});

describe("glob truncation + resultLimit notice (composed via presentation facts, not string concatenation)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-trunc-proj-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function globPattern(name: string, pattern: string): Promise<AgentToolResult<GlobToolDetails>> {
		const session = createSession(tmpDir);
		const tool = wrapToolWithMetaNotice(new GlobTool(session));
		return await tool.execute(`call-${name}`, { path: pattern });
	}

	it("no truncation, no result limit: no notice, no presentation facts", async () => {
		const dir = path.join(tmpDir, "few");
		await fs.mkdir(dir, { recursive: true });
		for (let i = 1; i <= 5; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), "x");

		const result = await globPattern("none", "few/**/*.txt");
		expect(modelText(result)).not.toContain("[");
		expect(result.details?.presentationFacts).toBeUndefined();
	});

	it("result limit reached (no truncation): limit-only notice via a threaded result_count fact", async () => {
		const dir = path.join(tmpDir, "many");
		await fs.mkdir(dir, { recursive: true });
		for (let i = 1; i <= 260; i++) {
			await fs.writeFile(path.join(dir, `f${String(i).padStart(4, "0")}.txt`), "x");
		}

		const result = await globPattern("limit_only", "many/**/*.txt");
		const text = modelText(result);

		expect(text).toEndWith("\n\n[200 results limit reached. Use limit=400 for more]");
		expect(text.match(/\[/g)).toHaveLength(1);
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["limit"]);
		expect(facts?.[0]?.kind === "limit" ? facts[0].meta : undefined).toEqual({
			limit: "result_count",
			value: 200,
			suggestedValue: 400,
		});
		expect(result.details?.meta?.limits?.resultLimit).toEqual({ reached: 200, suggestion: 400 });
	});

	it("head-truncated by byte budget (no result limit): truncation-only bracket via a threaded truncation fact", async () => {
		const long = "a".repeat(240);
		const dir = path.join(tmpDir, "deep");
		for (let i = 1; i <= 150; i++) {
			const entryDir = path.join(
				dir,
				`${long}${String(i).padStart(4, "0")}`,
				`${long}b${String(i).padStart(4, "0")}`,
			);
			await fs.mkdir(entryDir, { recursive: true });
			await fs.writeFile(path.join(entryDir, "f.txt"), "x");
		}

		const result = await globPattern("trunc_only", "deep/**/*.txt");
		const text = modelText(result);

		expect(text).toEndWith("\n\n[Showing lines 1-205 of 301 (49.9KB limit). Use :206 to continue]");
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["truncation"]);
		expect(result.details?.meta?.truncation?.direction).toBe("head");
	});

	it("truncation AND result limit join into ONE bracket, truncation first regardless of authoring order", async () => {
		const long = "a".repeat(240);
		const dir = path.join(tmpDir, "both");
		for (let i = 1; i <= 260; i++) {
			const entryDir = path.join(
				dir,
				`${long}${String(i).padStart(4, "0")}`,
				`${long}b${String(i).padStart(4, "0")}`,
			);
			await fs.mkdir(entryDir, { recursive: true });
			await fs.writeFile(path.join(entryDir, "f.txt"), "x");
		}

		const result = await globPattern("both", "both/**/*.txt");
		const text = modelText(result);

		expect(text).toEndWith(
			"\n\n[Showing lines 1-205 of 401 (49.9KB limit). Use :206 to continue. 200 results limit reached. Use limit=400 for more]",
		);
		expect(text.match(/\[Showing lines/g)).toHaveLength(1);
		// Declared order mirrors the call site (`.resultLimitFact` before
		// `.truncationFact`); the rendered bracket order (asserted above) is
		// fixed by the shared projection regardless of declaration order.
		const facts = result.details?.presentationFacts;
		expect(facts?.map(f => f.kind)).toEqual(["limit", "truncation"]);
	});
});
