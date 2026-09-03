import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { parseCpuProfile, renderCpuProfile } from "@oh-my-pi/pi-coding-agent/utils/cpuprofile";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function frame(functionName: string, url?: string, lineNumber?: number) {
	return { functionName, url, lineNumber };
}

/**
 * Minimal but structurally faithful V8 CPU profile: 100 samples at 1 ms,
 * with direct recursion (layout → layout), a GC meta-frame, and 15 ms idle.
 */
const FIXTURE_PROFILE = {
	nodes: [
		{ id: 1, callFrame: frame("(root)"), hitCount: 0, children: [2, 8, 9] },
		{ id: 2, callFrame: frame("main", "file:///work/app/src/index.ts", 9), hitCount: 2, children: [3, 5] },
		{ id: 3, callFrame: frame("render", "file:///work/app/src/render.ts", 1), hitCount: 5, children: [4] },
		{ id: 4, callFrame: frame("layout", "file:///work/app/src/render.ts", 5), hitCount: 30, children: [6] },
		{ id: 5, callFrame: frame("parse", "file:///work/app/src/parse.ts", 3), hitCount: 25, children: [] },
		{ id: 6, callFrame: frame("layout", "file:///work/app/src/render.ts", 5), hitCount: 20, children: [] },
		{ id: 8, callFrame: frame("(garbage collector)"), hitCount: 3, children: [] },
		{ id: 9, callFrame: frame("(idle)"), hitCount: 15, children: [] },
	],
	startTime: 1_000,
	endTime: 101_000,
	samples: (
		[
			[2, 2],
			[3, 5],
			[4, 30],
			[6, 20],
			[5, 25],
			[8, 3],
			[9, 15],
		] as Array<[number, number]>
	).flatMap(([id, n]) => Array<number>(n).fill(id)),
	timeDeltas: Array<number>(100).fill(1_000),
};

const FIXTURE = JSON.stringify(FIXTURE_PROFILE);

describe("parseCpuProfile", () => {
	it("accepts both bare profiles and the CDP Profiler.stop wrapper", () => {
		expect(parseCpuProfile(FIXTURE)?.nodes).toHaveLength(8);
		expect(parseCpuProfile(JSON.stringify({ profile: FIXTURE_PROFILE }))?.samples).toHaveLength(100);
	});

	it("rejects text that is not a structurally valid profile", () => {
		expect(parseCpuProfile("not json")).toBeNull();
		expect(parseCpuProfile(JSON.stringify({ nodes: [], startTime: 0, endTime: 1 }))).toBeNull();
		expect(parseCpuProfile(JSON.stringify({ nodes: [{ id: 1 }], startTime: 0, endTime: 1 }))).toBeNull();
		expect(parseCpuProfile(JSON.stringify({ hello: "world" }))).toBeNull();
	});
});

describe("renderCpuProfile", () => {
	const rendered = renderCpuProfile(FIXTURE);
	if (rendered === null) throw new Error("fixture must render");

	it("reports wall clock, sample count, and on-CPU total with idle excluded", () => {
		expect(rendered).toContain("V8 CPU profile: 0.10 s wall clock, 100 samples (avg interval 1000 µs)");
		// 85 of 100 sampled ms are on CPU; 15 ms (idle) are excluded.
		expect(rendered).toContain("On-CPU total: 0.09 s (85.0% of wall clock)");
	});

	it("flattens direct recursion and shortens file URLs in hot paths", () => {
		expect(rendered).toContain("layout (…/app/src/render.ts:6) [recursive ×2]");
		expect(rendered).not.toContain("file://");
	});

	it("promotes past the synthetic (root) frame and prices subtrees in ms", () => {
		const hotPaths = rendered.slice(rendered.indexOf("## Hot paths"), rendered.indexOf("## Top functions"));
		expect(hotPaths).not.toContain("(root)");
		expect(hotPaths).toContain("    82.0  96.5%  main (…/app/src/index.ts:10)");
		expect(hotPaths).toContain("(garbage collector)");
		expect(hotPaths).not.toContain("(idle)");
	});

	it("ranks top functions by self time, merging recursive frames", () => {
		const section = rendered.slice(rendered.indexOf("## Top functions"));
		// layout aggregates both recursion levels: 30 + 20 ms.
		const order = ["layout", "parse", "render"].map(sym => section.indexOf(`  ${sym} (`));
		expect(Math.min(...order)).toBeGreaterThan(0);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(section).toContain("    50.0  58.8%  layout (…/app/src/render.ts:6)");
		expect(section).not.toContain("(idle)");
	});

	it("falls back to hitCount-based self time when sample streams are absent", () => {
		const { samples: _samples, timeDeltas: _timeDeltas, ...bare } = FIXTURE_PROFILE;
		const fromHits = renderCpuProfile(JSON.stringify(bare));
		if (fromHits === null) throw new Error("hitCount fixture must render");
		expect(fromHits).toContain("On-CPU total: 0.09 s (85.0% of wall clock)");
		expect(fromHits).toContain("    50.0  58.8%  layout (…/app/src/render.ts:6)");
		expect(fromHits).not.toContain("samples (avg interval");
	});
});

describe("read tool .cpuprofile dispatch", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cpuprofile-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(cwd: string): ToolSession {
		return {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
			settings: Settings.isolated(),
		};
	}

	function textOutput(result: AgentToolResult<ReadToolDetails>): string {
		return result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}

	it("summarizes CPU profiles, with :raw as the verbatim escape hatch", async () => {
		const filePath = path.join(tmpDir, "app.cpuprofile");
		await fs.writeFile(filePath, FIXTURE);

		const tool = new ReadTool(createSession(tmpDir));
		const summary = textOutput(await tool.execute("read-cpuprofile", { path: filePath }));
		expect(summary).toContain("V8 CPU profile");
		expect(summary).toContain("layout (…/app/src/render.ts:6) [recursive ×2]");
		expect(summary).not.toContain('"timeDeltas"');

		const raw = textOutput(await tool.execute("read-cpuprofile-raw", { path: `${filePath}:raw` }));
		expect(raw).toContain('"timeDeltas"');
	});

	it("falls back to plain text when a .cpuprofile file is not a V8 profile", async () => {
		const filePath = path.join(tmpDir, "notes.cpuprofile");
		await fs.writeFile(filePath, "these are just notes\nsecond line\n");

		const tool = new ReadTool(createSession(tmpDir));
		const output = textOutput(await tool.execute("read-notes", { path: filePath }));
		expect(output).toContain("these are just notes");
	});
});
