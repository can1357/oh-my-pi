import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SpotlightClient } from "@oh-my-pi/pi-coding-agent/spotlight/client";
import { type CalledToolResult, shapeCalledTool } from "@oh-my-pi/pi-coding-agent/spotlight/index";
import { buildCallContext, callSummary } from "@oh-my-pi/pi-coding-agent/spotlight/context";
import { RecordingScorer } from "@oh-my-pi/pi-coding-agent/spotlight/scorer";
import {
	SpotlightExperiment,
	type SpotlightExperimentOptions,
	startSpotlightExperiment,
} from "@oh-my-pi/pi-coding-agent/spotlight/session";
import { countTokens } from "@oh-my-pi/pi-coding-agent/spotlight/shape/shape";
import { SPOTLIGHT_ENTRY } from "@oh-my-pi/pi-coding-agent/spotlight/types";
import { StencilCredential } from "@oh-my-pi/pi-coding-agent/stencil/credential";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { reasonShows, type SpotlightReason, spotlightDetails } from "@oh-my-pi/pi-tui/chat/spotlight";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spotlight-wire-"));
	tmpDirs.push(dir);
	return dir;
}

function entries(manager: SessionManager, type: string): Record<string, unknown>[] {
	return manager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<Record<string, unknown>> => entry.type === "custom" && entry.customType === type,
		)
		.map(entry => entry.data ?? {});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tmpDirs.splice(0)) await removeWithRetries(dir);
});

/**
 * A Spotlight endpoint stand-in: `score` rates each item, or `hang` never answers (the request runs into its
 * timeout). Warm-up requests are refused at once so none outlives a test.
 */
function fakeSpotlight(options: {
	score?: (item: string) => number;
	hang?: boolean;
	/** Sees each ranking request's `source`. */
	onSource?: (source: string) => void;
}): typeof fetch {
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as {
			items: string[];
			questions: Record<string, unknown>;
			source: string;
		};
		if (body.items.length === 1 && body.items[0] === "ok") throw new Error("warm-up refused");
		options.onSource?.(body.source);
		if (options.hang) {
			const aborted = Promise.withResolvers<never>();
			init?.signal?.addEventListener("abort", () => aborted.reject(init.signal?.reason));
			return aborted.promise;
		}
		const answers: Record<string, { scores: number[] }> = {};
		for (const id in body.questions) answers[id] = { scores: body.items.map(item => options.score?.(item) ?? 0) };
		return Response.json({ answers, usage: { input_tokens: 123 } });
	}) as typeof fetch;
}

function spotlightClient(spotlightFetch: typeof fetch, timeoutMs = 2_000): SpotlightClient {
	const credential = new StencilCredential();
	vi.spyOn(credential, "resolve").mockResolvedValue("test-token");
	return new SpotlightClient({
		url: "http://spotlight.test/v1/spotlight",
		timeoutMs,
		credential,
		fetch: spotlightFetch,
	});
}

/** A tool session with the experiment on, shaping the tools `shares.tools` names (default all). */
async function experimentSession(
	client = spotlightClient(fakeSpotlight({})),
	overrides: Record<string, unknown> = {},
	shares: SpotlightExperimentOptions = {},
): Promise<{ session: ToolSession; manager: SessionManager }> {
	return toolSession(overrides, manager => new SpotlightExperiment(client, "low", manager, shares));
}

/** A session with the experiment on that shapes no tool: every result is the plain one shaping counts against. */
function plainSession(
	overrides: Record<string, unknown> = {},
): Promise<{ session: ToolSession; manager: SessionManager }> {
	return experimentSession(undefined, overrides, { tools: [] });
}

async function toolSession(
	overrides: Record<string, unknown>,
	experiment?: (manager: SessionManager) => SpotlightExperiment,
): Promise<{ session: ToolSession; manager: SessionManager }> {
	const cwd = await tmpDir();
	const manager = SessionManager.inMemory(cwd);
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"bash.direnv": "off",
			"read.summarize.minTotalLines": 0,
			"read.summarize.unfoldUntil": 0,
			"read.summarize.unfoldLimit": 0,
			...overrides,
		}),
		spotlight: experiment?.(manager),
	};
	return { session, manager };
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

function bashOutput(output: string): bashExecutor.BashResult {
	const lines = output.split("\n").length;
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: lines,
		totalBytes: output.length,
		outputLines: lines,
		outputBytes: output.length,
	};
}

const LONG_LOG = Array.from({ length: 400 }, (_, i) =>
	i === 200
		? "ERROR: connection refused at db.ts:42"
		: `step ${i + 1}: worker-${i % 7} synced ${(i * 37) % 1000} rows from shard-${i % 5} in ${(i * 13) % 90}ms`,
).join("\n");

describe("spotlight shaping hooks", () => {
	const SOURCE =
		"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\treturn clean.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\treturn one + 1;\n}\n";

	it("reads a short source file whole with the experiment on, but summarizes it with the experiment off", async () => {
		const on = await experimentSession();
		const off = await toolSession({});
		for (const { session } of [on, off]) await Bun.write(path.join(session.cwd, "fixture.ts"), SOURCE);

		const onText = resultText(await new ReadTool(on.session).execute("r1", { path: "fixture.ts" }));
		const offText = resultText(await new ReadTool(off.session).execute("r1", { path: "fixture.ts" }));

		expect(onText).toContain("const clean = value.trim();");
		expect(offText).not.toContain("const clean = value.trim();");
		expect(offText).toContain("export function alpha(value: string): string { … }");
		const [entry] = entries(on.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ toolCallId: "r1", tool: "read", steps: ["none"] });
		expect(entry.outChars).toBe(entry.inChars);
	});

	it("outlines a whole source file past one read page, with real line numbers", async () => {
		const { session, manager } = await experimentSession(undefined, { readLineNumbers: true });
		const blocks = Array.from(
			{ length: 150 },
			(_, i) =>
				`export function step${i}(input: number[]): number {\n${Array.from({ length: 12 }, (_, j) => `\tconst value${j} = input.reduce((sum, item) => sum + item * ${j + 1}, ${i});`).join("\n")}\n\treturn value0;\n}\n`,
		);
		const source = `${blocks.join("\n")}\nexport function lateTarget(): string {\n\treturn "late";\n}\n`;
		const lateLine = source.split("\n").indexOf("export function lateTarget(): string {") + 1;
		expect(source.length).toBeGreaterThan(100 * 1024);
		await Bun.write(path.join(session.cwd, "big.ts"), source);

		const text = resultText(await new ReadTool(session).execute("r2", { path: "big.ts" }));

		// `N|` line numbers or `N:` hashline rows, depending on the session's edit mode.
		expect(text).toMatch(new RegExp(`(^|\\n)${lateLine}[|:]export function lateTarget\\(\\): string \\{`));
		expect(text.length).toBeLessThan(source.length / 2);
		const [entry] = entries(manager, SPOTLIGHT_ENTRY.shape);
		expect(entry.steps).toContain("outline");
	});

	it("runs bash without the output minimizer only while the experiment is on", async () => {
		const execute = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput("done"));
		for (const { session } of [await toolSession({}), await experimentSession()]) {
			await new BashTool(session).execute("b1", { command: "git status" });
		}
		expect(execute.mock.calls.map(call => call[1]?.minimize)).toEqual([true, false]);
	});

	it("cuts a long bash output to the lines Spotlight ranks highest and journals its size", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("ERROR") ? 1 : 0) }));
		const { session, manager } = await experimentSession(client);
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));

		const text = resultText(await new BashTool(session).execute("b2", { command: "./ingest.sh" }));

		expect(text).toContain("ERROR: connection refused at db.ts:42");
		expect(text).toMatch(/artifact:\/\/\d+/);
		expect(text).not.toContain("step 300:");
		const [entry] = entries(manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ toolCallId: "b2", tool: "bash", inChars: LONG_LOG.length });
		expect(entry.steps).not.toEqual(["none"]);
		expect(entry.outChars as number).toBeLessThan(LONG_LOG.length);
		expect(entry.spotlight).toMatchObject({ failures: 0, tokens: 123 });
		expect(entry.error).toBeUndefined();
	});

	it("keeps a trace on the result: tokens saved, the original as an artifact, its heat and kept lines", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("ERROR") ? 1 : 0.1) }));
		const { session, manager } = await experimentSession(client);
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));

		const cut = await new BashTool(session).execute("b4", { command: "./ingest.sh" });
		const trace = cut.details?.spotlight;
		if (!trace?.original) throw new Error("a cut result carries its original");
		expect(trace).toMatchObject({ tool: "bash", inChars: LONG_LOG.length });
		expect(trace.savedTokens).toBe(trace.inTokens - trace.outTokens);
		expect(trace.savedTokens).toBeGreaterThan(0);
		const id = trace.original.url.replace("artifact://", "");
		expect(manager.getArtifactContent(id)).toBe(LONG_LOG);
		// Line 201 is the error: the hottest line, and shown to the agent; most of the log was not. The rest tie, so
		// they share one rank.
		const heat = trace.original.heat;
		expect(heat[200]).toBe("9");
		expect(new Set([...heat.slice(0, 200), ...heat.slice(201)])).toEqual(new Set([heat[0]]));
		expect(heat[0]).not.toBe("9");
		const kept = trace.original.kept;
		expect(kept.some(([from, to]) => from <= 201 && 201 <= to)).toBe(true);
		expect(kept.reduce((n, [from, to]) => n + to - from + 1, 0)).toBeLessThan(200);
		// Why each line was shown or hidden, over the lines the heat covers, agreeing with the kept runs.
		const why = trace.original.why ?? "";
		expect(why).toHaveLength(trace.original.heat.length);
		const isKept = (line: number) => kept.some(([from, to]) => from <= line && line <= to);
		[...why].forEach((reason, i) => {
			if (reason !== "-") expect(reasonShows(reason as SpotlightReason)).toBe(isKept(i + 1));
		});
		expect(reasonShows(why[200] as SpotlightReason)).toBe(true);
		// Each line the agent saw stands for an original line, a hidden run, or nothing; the error is one of them.
		const map = trace.original.map ?? [];
		expect(map).toContain(201);
		for (const entry of map) {
			if (typeof entry === "number") expect(isKept(entry)).toBe(true);
			else if (entry) for (let line = entry[0]; line <= entry[1]; line++) expect(isKept(line)).toBe(false);
		}

		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput("done"));
		const kept2 = await new BashTool(session).execute("b5", { command: "true" });
		expect(kept2.details?.spotlight).toMatchObject({ steps: ["none"], savedTokens: 0 });
		expect(kept2.details?.spotlight?.original).toBeUndefined();
	});

	it("falls back to unranked shaping when Spotlight times out, and the call still returns its output", async () => {
		const client = spotlightClient(fakeSpotlight({ hang: true }), 30);
		const scorer = new RecordingScorer(client, "low");
		const ctx = buildCallContext([], "x", "./ingest.sh", undefined);
		expect(await scorer.score(["a", "b"], ctx)).toBeNull();
		expect(scorer.usage).toMatchObject({ calls: 1, failures: 1, failureCauses: { timeout: 1 } });

		const { session, manager } = await experimentSession(client);
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));
		const result = await new BashTool(session).execute("b3", { command: "./ingest.sh" });

		expect(result.isError).toBeUndefined();
		expect(resultText(result)).toContain(LONG_LOG.slice(LONG_LOG.lastIndexOf("\n") + 1));
		const [entry] = entries(manager, SPOTLIGHT_ENTRY.shape);
		expect(entry.spotlight).toMatchObject({ failures: 1, failureCauses: { timeout: 1 } });
		expect(entry.error).toBeUndefined();
	});

	it("reports a lost Stencil credential once per loss, not on warm-up, and again after a re-sign-in", async () => {
		const credential = new StencilCredential();
		const tokens: (string | null)[] = [null, null, null, "test-token", null];
		vi.spyOn(credential, "resolve").mockImplementation(async () => tokens.shift() ?? null);
		const client = new SpotlightClient({
			url: "http://spotlight.test/v1/spotlight",
			timeoutMs: 2_000,
			credential,
			fetch: fakeSpotlight({ score: () => 0.5 }),
		});
		let missing = 0;
		client.onCredentialMissing = () => missing++;
		const ctx = buildCallContext([], "x", "./ingest.sh", undefined);
		const score = async () => {
			const scorer = new RecordingScorer(client, "low");
			return { scores: await scorer.score(["a"], ctx), usage: scorer.usage };
		};

		// The warm-up finds no credential too, but leaves it to the first ranking: one report below, not two.
		client.warm();
		const unsigned = await score();
		expect(unsigned.scores).toBeNull();
		expect(unsigned.usage.failureCauses).toEqual({ no_credential: 1 });
		expect(missing).toBe(1);
		expect((await score()).scores).toBeNull();
		expect(missing).toBe(1);
		expect((await score()).scores).toEqual([0.5]);
		expect((await score()).scores).toBeNull();
		expect(missing).toBe(2);
	});
});

/** A source file well past `plain`'s read page (300 lines), which shaping outlines. */
const BIG_SOURCE = Array.from(
	{ length: 120 },
	(_, i) =>
		`export function step${i}(input: number[]): number {\n${Array.from({ length: 12 }, (_, j) => `\tconst value${j} = input.reduce((sum, item) => sum + item * ${j + 1}, ${i});`).join("\n")}\n\treturn value0;\n}\n`,
).join("\n");

describe("spotlight holdout", () => {
	it("gives a held-out bash cut plain's output, and traces the cut it would have made", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("ERROR") ? 1 : 0.1) }));
		const held = await experimentSession(client, {}, { holdout: 1 });
		const plain = await plainSession();
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));

		const result = await new BashTool(held.session).execute("b1", { command: "./ingest.sh" });
		const plainResult = await new BashTool(plain.session).execute("b1", { command: "./ingest.sh" });

		expect(resultText(result)).toBe(resultText(plainResult));
		expect(resultText(result)).toContain("step 300:");
		const [entry] = entries(held.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ toolCallId: "b1", holdout: true, inChars: LONG_LOG.length });
		expect(entry.steps).not.toEqual(["none"]);
		expect(entry.outTokens as number).toBeLessThan(entry.inTokens as number);
		expect(entry.outChars as number).toBeLessThan(LONG_LOG.length);
		const trace = result.details?.spotlight;
		if (!trace?.original?.shapedUrl) throw new Error("a held-out cut keeps its would-be text");
		expect(trace).toMatchObject({ holdout: true, savedTokens: trace.inTokens - trace.outTokens });
		expect(trace.savedTokens).toBeGreaterThan(0);
		expect(held.manager.getArtifactContent(trace.original.url.replace("artifact://", ""))).toBe(LONG_LOG);
		const wouldBe = held.manager.getArtifactContent(trace.original.shapedUrl.replace("artifact://", "")) ?? "";
		expect(wouldBe).toContain("ERROR: connection refused at db.ts:42");
		expect(wouldBe).not.toContain("step 300:");
		expect(wouldBe.length).toBe(entry.outChars as number);
	});

	it("gives a held-out whole-file read plain's page, not the file shaping gathered", async () => {
		const held = await experimentSession(undefined, {}, { holdout: 1 });
		const plain = await plainSession();
		for (const { session } of [held, plain]) await Bun.write(path.join(session.cwd, "big.ts"), BIG_SOURCE);

		const result = await new ReadTool(held.session).execute("r1", { path: "big.ts" });
		const plainResult = await new ReadTool(plain.session).execute("r1", { path: "big.ts" });

		expect(resultText(result)).toBe(resultText(plainResult));
		expect(resultText(result)).not.toContain("export function step119");
		const [entry] = entries(held.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ toolCallId: "r1", tool: "read", holdout: true });
		expect(entry.steps).toContain("outline");
		// The would-be cut outlined the whole file shaping gathered, the last function included.
		const trace = spotlightDetails(result.details);
		const shapedUrl = trace?.original?.shapedUrl;
		if (!shapedUrl) throw new Error("a held-out cut keeps its would-be text");
		expect(trace).toMatchObject({ holdout: true, tool: "read" });
		expect(trace?.original?.lines).toBeGreaterThan(1_500);
		expect(held.manager.getArtifactContent(shapedUrl.replace("artifact://", ""))).toContain(
			"export function step119",
		);
	});

	it("applies every cut with holdout 0", async () => {
		const held = await experimentSession();
		await Bun.write(path.join(held.session.cwd, "big.ts"), BIG_SOURCE);

		const result = await new ReadTool(held.session).execute("r1", { path: "big.ts" });

		const text = resultText(result);
		expect(text).toContain("export function step119(input: number[]): number {");
		expect(text).toMatch(/… \[lines \d+-\d+\]/);
		const [entry] = entries(held.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry.steps).toContain("outline");
		expect(entry.holdout).toBeUndefined();
		const trace = spotlightDetails(result.details);
		expect(trace?.savedTokens).toBeGreaterThan(0);
		expect(trace?.holdout).toBeUndefined();
		expect(trace?.original?.shapedUrl).toBeUndefined();
	});

	it("never holds out a result shaping leaves unchanged", async () => {
		const { session, manager } = await experimentSession(undefined, {}, { holdout: 1 });
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput("done"));

		const result = await new BashTool(session).execute("b1", { command: "true" });

		expect(resultText(result)).toBe("done");
		expect(result.details?.spotlight).toMatchObject({ steps: ["none"], savedTokens: 0 });
		expect(result.details?.spotlight?.holdout).toBeUndefined();
		expect(entries(manager, SPOTLIGHT_ENTRY.shape)[0]?.holdout).toBeUndefined();
	});
});

describe("spotlight whole reads", () => {
	it("shows a Markdown read and bounded line ranges as plain does, but still cuts an open-ended range", async () => {
		const shaped = await experimentSession(undefined, {}, { scoreFree: 1 });
		const plain = await plainSession();
		// Every line is past the 400-character cap a cut read applies.
		const wide = Array.from({ length: 50 }, (_, i) => `const row${i} = "${String(i).repeat(600)}";`).join("\n");
		for (const { session } of [shaped, plain]) {
			await Bun.write(path.join(session.cwd, "wide.ts"), wide);
			await Bun.write(path.join(session.cwd, "wide.md"), wide);
		}
		const read = async ({ session }: { session: ToolSession }, target: string) =>
			resultText(await new ReadTool(session).execute("r1", { path: target }));

		for (const target of [
			"wide.md",
			"wide.md:1-10,20-30",
			"wide.ts:5-40",
			"wide.ts:5+30",
			"wide.ts:1-10,20-30",
			"wide.ts:raw:5-40",
			"wide.ts:-20",
		]) {
			expect(await read(shaped, target)).toBe(await read(plain, target));
		}
		expect(await read(shaped, "wide.ts:5-")).not.toBe(await read(plain, "wide.ts:5-"));
	});
});

describe("spotlight raw reads and path lists", () => {
	/** Twelve Python functions: long enough to be outlined and cut when shaped. */
	const SOURCE = Array.from({ length: 12 }, (_, k) => [
		`def handler${k}(payload, ledger):`,
		...Array.from(
			{ length: 20 },
			(_, j) => `    total_${j} = payload["amount"] * ${j} + ledger[${k}][${j}]  # step ${j}`,
		),
		"    return total_0",
		"",
	])
		.flat()
		.join("\n");
	/** Lines past the 400-character cap a cut read applies. */
	const WIDE = Array.from({ length: 50 }, (_, i) => `const row${i} = "${String(i).repeat(600)}";`).join("\n");

	async function sessions() {
		const shaped = await experimentSession(undefined, {}, { scoreFree: 1 });
		const plain = await plainSession();
		for (const { session } of [shaped, plain]) {
			await Bun.write(path.join(session.cwd, "raw.py"), SOURCE);
			await Bun.write(path.join(session.cwd, "wide.ts"), WIDE);
			await Bun.write(path.join(session.cwd, "b.txt"), "b\n");
		}
		return { shaped, plain };
	}

	it("returns a `:raw` read's bytes, also when repeated, and journals it as a raw read", async () => {
		const { shaped, plain } = await sessions();
		const tool = new ReadTool(shaped.session);

		expect(resultText(await tool.execute("r1", { path: "raw.py:raw" }))).toBe(SOURCE);
		expect(resultText(await tool.execute("r2", { path: "raw.py:raw" }))).toBe(SOURCE);
		const ranged = await tool.execute("r3", { path: "raw.py:20-140:raw" });
		const plainRanged = await new ReadTool(plain.session).execute("r3", { path: "raw.py:20-140:raw" });
		expect(resultText(ranged)).toBe(resultText(plainRanged));
		const journal = entries(shaped.manager, SPOTLIGHT_ENTRY.shape);
		expect(journal.map(entry => (entry.stats as Record<string, number>).rawReads)).toEqual([1, 1, 1]);
	});

	it("returns a URL `:raw` read's fetched bytes", async () => {
		const { shaped } = await sessions();
		const body = Array.from({ length: 200 }, (_, i) => `row ${i}: the ledger reconciles against shard ${i % 4}`).join(
			"\n",
		);
		vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));

		const result = await new ReadTool(shaped.session).execute("r1", { path: "https://example.test/data.txt:raw" });

		expect(resultText(result)).toBe(body);
		expect(entries(shaped.manager, SPOTLIGHT_ENTRY.shape)[0]?.stats).toMatchObject({ rawReads: 1 });
	});

	it("shapes each part of a path list on its own, as one call with one journal entry and one windowed trace", async () => {
		const { shaped, plain } = await sessions();
		const target = "raw.py;raw.py:raw;wide.ts:5-40;b.txt";
		const plainRead = async (path: string) => resultText(await new ReadTool(plain.session).execute("p", { path }));

		const result = await new ReadTool(shaped.session).execute("list", { path: target });
		const text = resultText(result);

		// The `:raw` part and the bounded range stay as their own reads show them; the whole source file is outlined.
		expect(text).toContain(SOURCE);
		expect(text).toContain(await plainRead("wide.ts:5-40"));
		expect(text.length).toBeLessThan((await plainRead(target)).length);
		const journal = entries(shaped.manager, SPOTLIGHT_ENTRY.shape);
		expect(journal.map(entry => entry.toolCallId)).toEqual(["list"]);
		expect(journal[0]?.steps).toContain("outline");
		expect(journal[0]?.stats).toMatchObject({ rawReads: 1, wholeReads: 1 });
		// Each part is its own window of the original; the `:raw` part has no file window.
		const windows = spotlightDetails(result.details)?.original?.windows;
		expect(windows?.map(window => window.path)).toEqual(["raw.py", undefined, "wide.ts", "b.txt"]);
	});

	it("keeps the trace's line map on the lines the model saw when a part carries a repeat-read hint", async () => {
		const { shaped } = await sessions();
		const tool = new ReadTool(shaped.session);
		for (const id of ["l1", "l2"]) await tool.execute(id, { path: "b.txt;raw.py" });

		// The third identical read of `b.txt` gets the loop hint, between it and `raw.py`.
		const result = await tool.execute("l3", { path: "b.txt;raw.py" });
		const model = resultText(result).split("\n");
		const original = spotlightDetails(result.details)?.original;

		expect(resultText(result)).toContain("You have received this identical output 3 times");
		const files: Record<string, string[]> = { "b.txt": ["b"], "raw.py": SOURCE.split("\n") };
		const lines = (original?.windows ?? []).flatMap(window =>
			files[window.path ?? ""].slice(window.start - 1, window.start - 1 + window.lines),
		);
		const map = original?.map ?? [];
		expect(map.length).toBe(model.length);
		// A shown line maps to its original line; a gap marker to the run it hides.
		map.forEach((entry, k) => {
			if (typeof entry === "number") expect(model[k]).toContain(lines[entry - 1]);
			else if (entry) expect(model[k]).toContain("… [");
		});
	});

	it("leaves a path list no part of which is cut as its parts read, with no original", async () => {
		const { shaped, plain } = await sessions();
		for (const { session } of [shaped, plain]) await Bun.write(path.join(session.cwd, "wide.md"), WIDE);

		const result = await new ReadTool(shaped.session).execute("list", { path: "wide.ts:5-40;wide.md" });

		expect(resultText(result)).toBe(
			resultText(await new ReadTool(plain.session).execute("list", { path: "wide.ts:5-40;wide.md" })),
		);
		expect(spotlightDetails(result.details)?.original).toBeUndefined();
		expect(entries(shaped.manager, SPOTLIGHT_ENTRY.shape).map(entry => entry.toolCallId)).toEqual(["list"]);
	});

	it("does not collapse a list part against an earlier part of the same list", async () => {
		const { shaped } = await sessions();

		const text = resultText(await new ReadTool(shaped.session).execute("list", { path: "raw.py;raw.py" }));

		expect(text).not.toContain("as shown before");
	});
});

describe("spotlight plain baseline", () => {
	const FULL = Array.from({ length: 3_000 }, (_, i) =>
		i === 2_900
			? "ERROR: connection refused at db.ts:42"
			: `step ${i + 1}: worker-${i % 7} synced ${(i * 37) % 1000} rows from shard-${i % 5}`,
	).join("\n");

	/** Every bash call spills: the sink keeps the last 300 lines and the session holds the whole output. */
	async function spill(manager: SessionManager): Promise<void> {
		const artifactId = await manager.saveArtifact(FULL, "bash");
		if (artifactId === undefined) throw new Error("the in-memory session keeps artifacts");
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			...bashOutput(FULL.split("\n").slice(-300).join("\n")),
			truncated: true,
			artifactId,
			totalLines: 3_000,
			totalBytes: FULL.length,
		});
	}

	/** What the model gets under plain: the sink's capped tail and its truncation notice. */
	async function plainText(): Promise<string> {
		const plain = await plainSession();
		const result = await new BashTool(plain.session).execute("b1", { command: "./ingest.sh" });
		return resultText(result) + formatOutputNotice(result.details?.meta);
	}

	it("counts a spilled bash output's saving against the capped text plain shows, not the whole artifact", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("ERROR") ? 1 : 0.1) }));
		const shaping = await experimentSession(client);
		await spill(shaping.manager);

		const cut = await new BashTool(shaping.session).execute("b1", { command: "./ingest.sh" });

		const plain = await plainText();
		expect(plain).toContain("artifact://");
		const trace = cut.details?.spotlight;
		if (!trace?.original) throw new Error("the spilled output was shaped whole and cut");
		expect(trace.inChars).toBe(FULL.length);
		expect(trace).toMatchObject({ plainChars: plain.length, plainTokens: countTokens(plain) });
		expect(trace.savedTokens).toBe((trace.plainTokens ?? 0) - trace.outTokens);
		expect(trace.savedTokens).toBeGreaterThan(0);
		expect(trace.savedTokens).toBeLessThan((trace.inTokens - trace.outTokens) / 4);
		const [entry] = entries(shaping.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ plainChars: trace.plainChars, plainTokens: trace.plainTokens });
	});

	it("cuts a rerun of a spilled output like the first run, rather than showing it whole as a re-ask", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("ERROR") ? 1 : 0.1) }));
		const { session, manager } = await experimentSession(client);
		await spill(manager);
		const bash = new BashTool(session);
		await bash.execute("b1", { command: "./ingest.sh" });

		// The rerun brings back every line the first cut hid; it is not the agent asking for them.
		const again = await bash.execute("b2", { command: "./ingest.sh" });

		const trace = again.details?.spotlight;
		expect(trace?.steps).not.toContain("plain-cap");
		expect(trace?.original).toBeDefined();
		expect(resultText(again).length).toBeLessThan((await plainText()).length / 4);
		const [, entry] = entries(manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({
			toolCallId: "b2",
			stats: expect.not.objectContaining({ reasks: expect.anything() }),
		});
	});
});

describe("spotlight column-capped output", () => {
	const ITEMS = Array.from({ length: 400 }, (_, i) => ({
		id: i,
		name: `item${i}`,
		// Five statuses, so the rows repeat no few shapes and the cut keeps a full window.
		flag: i === 317 ? "on_hold" : ["ok", "shipped", "packed", "returned", "billed"][i % 5],
	}));
	const FULL = JSON.stringify({ items: ITEMS });

	it("gives a short cut of the whole artifact over the column cap's preview, counting what it costs", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("on_hold") ? 1 : 0.05) }));
		const { session, manager } = await experimentSession(client);
		const artifactId = await manager.saveArtifact(FULL, "bash");
		if (artifactId === undefined) throw new Error("the in-memory session keeps artifacts");
		const preview = `${FULL.slice(0, 768)}…`;
		const capped: bashExecutor.BashResult = {
			...bashOutput(preview),
			artifactId,
			totalBytes: FULL.length,
			columnMax: 768,
			columnTruncatedLines: 1,
			columnTruncatedRange: { first: 1, last: 1 },
		};
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(capped);

		const result = await new BashTool(session).execute("b1", { command: "./orders.sh" });

		const trace = result.details?.spotlight;
		expect(trace?.inChars).toBe(FULL.length);
		expect(resultText(result)).toContain("317|item317|on_hold");
		expect(trace?.steps).not.toContain("plain-cap");
		expect(trace?.savedTokens).toBe((trace?.plainTokens ?? 0) - (trace?.outTokens ?? 0));
		expect(trace?.savedTokens).toBeLessThan(0);
	});

	it("still says a timed-out command timed out when its cut comes from the artifact", async () => {
		const client = spotlightClient(fakeSpotlight({ score: item => (item.includes("on_hold") ? 1 : 0.05) }));
		const { session, manager } = await experimentSession(client);
		const artifactId = await manager.saveArtifact(FULL, "bash");
		if (artifactId === undefined) throw new Error("the in-memory session keeps artifacts");
		// The sink puts its timeout notice above the preview; the artifact holds only what the command printed.
		const preview = `[Command timed out after 1 seconds]\n${FULL.slice(0, 768)}…`;
		const timedOut: bashExecutor.BashResult = {
			...bashOutput(preview),
			exitCode: undefined,
			timedOut: true,
			artifactId,
			totalBytes: FULL.length,
			columnMax: 768,
			columnTruncatedLines: 1,
			columnTruncatedRange: { first: 1, last: 1 },
		};
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(timedOut);

		const result = await new BashTool(session).execute("b1", { command: "./orders.sh", timeout: 1 });

		expect(result.details?.spotlight?.inChars).toBe(FULL.length);
		expect(result.isError).toBe(true);
		expect(resultText(result).match(/\[Command timed out after 1 seconds\]/g)).toHaveLength(1);
	});
});

describe("spotlight score-free coin", () => {
	it("draws holdout, then score-free, stopping at the first landed", async () => {
		const draws: number[] = [];
		let calls = 0;
		const experiment = new SpotlightExperiment(
			spotlightClient(fakeSpotlight({})),
			"low",
			SessionManager.inMemory(await tmpDir()),
			{ holdout: 0.15, scoreFree: 0.5 },
			() => draws[calls++] ?? 1,
		);
		const draw = (coins: number[]) => {
			draws.splice(0, draws.length, ...coins);
			calls = 0;
			return { coins: experiment.drawCoins(), drawn: calls };
		};

		// A landed holdout coin draws nothing more.
		expect(draw([0.1])).toEqual({ coins: { holdout: true, scoreFree: false }, drawn: 1 });
		// Not held out: score-free is drawn next.
		expect(draw([0.9, 0.5])).toEqual({ coins: { holdout: false, scoreFree: false }, drawn: 2 });
		expect(draw([0.9, 0.3])).toEqual({ coins: { holdout: false, scoreFree: true }, drawn: 2 });
	});

	const DOC = ["# Service", ""]
		.concat(
			...["Deploy steps", "History", "Licensing", "Contributors"].map(heading => [
				`## ${heading}`,
				...Array.from(
					{ length: 24 },
					(_, i) => `${heading} paragraph ${i + 1} explains one more detail at length.`,
				),
				"",
			]),
		)
		.join("\n");
	const cases: { call: "bash" | "big.ts" | "deploy.txt"; step: string }[] = [
		{ call: "bash", step: "window" },
		{ call: "big.ts", step: "outline" },
		{ call: "deploy.txt", step: "docs" },
	];
	for (const { call, step } of cases) {
		it(`cuts by the no-score ${step} rule without asking Spotlight (${call})`, async () => {
			let scored = 0;
			const client = spotlightClient(
				fakeSpotlight({
					score: () => {
						scored++;
						return 1;
					},
				}),
			);
			const { session, manager } = await experimentSession(client, {}, { scoreFree: 1 });
			await Bun.write(path.join(session.cwd, "big.ts"), BIG_SOURCE);
			await Bun.write(path.join(session.cwd, "deploy.txt"), DOC);
			vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));

			const result =
				call === "bash"
					? await new BashTool(session).execute("c1", { command: "./ingest.sh" })
					: await new ReadTool(session).execute("c1", { path: call });

			const [entry] = entries(manager, SPOTLIGHT_ENTRY.shape);
			expect(entry).toMatchObject({ scoreFree: true, spotlight: { calls: 0 } });
			expect(entry.holdout).toBeUndefined();
			expect(entry.steps).toContain(step);
			expect(scored).toBe(0);
			const trace = spotlightDetails(result.details);
			expect(trace).toMatchObject({ scoreFree: true });
			expect(trace?.savedTokens).toBeGreaterThan(0);
			expect(trace?.request).toBeUndefined();
			if (call === "deploy.txt") {
				// The section whose heading the conversation names stays; the others fold.
				const text = resultText(result);
				expect(text).toContain("Deploy steps paragraph 24");
				expect(text).not.toContain("Licensing paragraph 12");
			}
		});
	}
});

/**
 * `grep`'s grouped output: `files` files under `# src/`, each `## moduleN.ts` with `perFile` matches and their context
 * lines; module 17's fifth match is the one the task needs.
 */
function grepOutput(files: number, perFile = 10): string {
	const out = ["# src/"];
	for (let f = 0; f < files; f++) {
		out.push(`## module${f}.ts`);
		for (let m = 0; m < perFile; m++) {
			const line = 10 + m * 7;
			out.push(` ${line - 1}|\tconst options${m} = resolveOptions(input, ${f});`);
			out.push(
				f === 17 && m === 4
					? `*${line}|\tthrow new Error("refused");`
					: `*${line}|\tconst value${m} = loadSetting(options${m}, "key-${f}-${m}");`,
			);
			out.push(` ${line + 1}|\treturn value${m};`, "...");
		}
		out.push("");
	}
	return out.join("\n");
}

/** A tool without shaping of its own, wrapped as sessions wrap every tool, returning `text`. */
function fakeTool(name: string, text: string): AgentTool {
	return wrapToolWithMetaNotice({
		name,
		label: name,
		description: `fake ${name}`,
		parameters: {},
		async execute() {
			return { content: [{ type: "text", text }] };
		},
	} as unknown as AgentTool);
}

/** The context the agent loop hands a call it dispatched; `calls` is the batch (default: the call alone). */
function agentContext(
	session: ToolSession,
	manager: SessionManager,
	calls?: { id: string; name: string }[],
): AgentToolContext {
	return {
		sessionManager: manager,
		settings: session.settings,
		spotlightShape: (call: CalledToolResult) => shapeCalledTool(session, call),
		...(calls ? { toolCall: { batchId: "batch", index: 0, total: calls.length, toolCalls: calls } } : {}),
	} as unknown as AgentToolContext;
}

/** Runs `tool` as the agent's call `id`. */
function agentCall(
	tool: AgentTool,
	{ session, manager }: { session: ToolSession; manager: SessionManager },
	id: string,
	args: Record<string, unknown> = {},
): Promise<AgentToolResult> {
	return tool.execute(id, args, undefined, undefined, agentContext(session, manager, [{ id, name: tool.name }]));
}

/** Spills past 8 KB, showing about 2 KB of head and 2 KB of tail. */
const SMALL_SPILL = {
	"tools.artifactSpillThreshold": 8,
	"tools.artifactHeadBytes": 2,
	"tools.artifactTailBytes": 2,
};

describe("spotlight shaping of any tool", () => {
	const OUTPUT = grepOutput(24);
	const NEEDED = 'throw new Error("refused")';
	const ARGS = { pattern: "loadSetting|Error", path: "src" };
	/**
	 * Spotlight ranking the needed line first, grep's `...` separators last and the rest by file, earlier files higher
	 * (scores of no ties: equal scores rank by position).
	 */
	const ranked = (onSource?: (source: string) => void) =>
		spotlightClient(
			fakeSpotlight({
				score: item => {
					if (item.includes("refused")) return 1;
					if (item.trim() === "...") return 0;
					const file = /(?:input, |key-)(\d+)/.exec(item);
					return file ? 0.4 - Number(file[1]) / 100 : 0.1;
				},
				onSource,
			}),
		);
	it("cuts a long grep output to the ranked lines under their file headings, recoverable from its artifact", async () => {
		const sources: string[] = [];
		const run = await experimentSession(ranked(source => sources.push(source)));
		expect(OUTPUT.length).toBeLessThan(50 * 1024);

		const result = await agentCall(fakeTool("grep", OUTPUT), run, "g1", ARGS);

		const text = resultText(result);
		expect(text).toContain(NEEDED);
		const before = text.slice(0, text.indexOf(NEEDED));
		expect(before.slice(before.lastIndexOf("## "))).toMatch(/^## module17\.ts\n/);
		expect(text).toContain("# src/");
		expect(text.length).toBeLessThan(OUTPUT.length / 4);
		expect(sources).toContain(callSummary("grep", ARGS));
		// Every hidden run reads back from the saved copy the last line names.
		const footer = /\[cut: (artifact:\/\/(\d+))\]$/.exec(text);
		if (!footer) throw new Error("a cut names where its hidden lines are");
		const saved = run.manager.getArtifactContent(footer[2]) ?? "";
		expect(saved).toBe(OUTPUT);
		// The trace's original is that same copy, not a second one.
		expect(result.details?.spotlight?.original?.url).toBe(footer[1]);
		const markers = [...text.matchAll(/… \[(\d+)-(\d+)\]/g)];
		expect(markers.length).toBeGreaterThan(0);
		for (const [, from, to] of markers) {
			const hidden = OUTPUT.split("\n").slice(Number(from) - 1, Number(to));
			expect(saved.split("\n").slice(Number(from) - 1, Number(to))).toEqual(hidden);
		}

		const trace = spotlightDetails(result.details);
		if (!trace?.original) throw new Error("a cut result carries its original");
		expect(trace).toMatchObject({
			tool: "grep",
			inChars: OUTPUT.length,
			plainChars: OUTPUT.length,
			plainTokens: countTokens(OUTPUT),
		});
		expect(trace.savedTokens).toBe(countTokens(OUTPUT) - trace.outTokens);
		expect(trace.savedTokens).toBeGreaterThan(0);
		expect(run.manager.getArtifactContent(trace.original.url.replace("artifact://", ""))).toBe(OUTPUT);
		const [entry] = entries(run.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ toolCallId: "g1", tool: "grep", plainTokens: countTokens(OUTPUT) });
		expect(entry.steps).toContain("window");
	});

	it("counts a spilled output's saving against the wrapper's capped text and shapes it whole", async () => {
		const big = grepOutput(40);
		const plain = await plainSession(SMALL_SPILL);
		const plainResult = await agentCall(fakeTool("grep", big), plain, "g1", ARGS);
		const plainText = resultText(plainResult);
		expect(plainText).toContain("artifact://");
		expect(plainText.length).toBeLessThan(big.length / 4);

		const run = await experimentSession(ranked(), SMALL_SPILL);
		const result = await agentCall(fakeTool("grep", big), run, "g1", ARGS);

		expect(resultText(result)).toContain(NEEDED);
		expect(result.details?.meta?.truncation).toBeUndefined();
		const trace = spotlightDetails(result.details);
		expect(trace).toMatchObject({
			inChars: big.length,
			plainChars: plainText.length,
			plainTokens: countTokens(plainText),
		});
		expect(trace?.savedTokens).toBe((trace?.plainTokens ?? 0) - (trace?.outTokens ?? 0));
	});

	it("gives a held-out cut the wrapper's text and traces the would-be cut", async () => {
		const run = await experimentSession(ranked(), {}, { holdout: 1 });

		const result = await agentCall(fakeTool("find", OUTPUT), run, "f1", ARGS);

		expect(resultText(result)).toBe(OUTPUT);
		const trace = spotlightDetails(result.details);
		const shapedUrl = trace?.original?.shapedUrl;
		if (!shapedUrl) throw new Error("a held-out cut keeps its would-be text");
		expect(trace).toMatchObject({ holdout: true, tool: "find", plainTokens: countTokens(OUTPUT) });
		expect(trace?.savedTokens).toBeGreaterThan(0);
		expect(run.manager.getArtifactContent(shapedUrl.replace("artifact://", ""))).toContain(NEEDED);
		expect(entries(run.manager, SPOTLIGHT_ENTRY.shape)[0]).toMatchObject({ tool: "find", holdout: true });
	});

	it("shapes by the no-score rules without asking Spotlight when the score-free coin lands", async () => {
		const sources: string[] = [];
		const run = await experimentSession(
			ranked(source => sources.push(source)),
			{},
			{ scoreFree: 1 },
		);

		const result = await agentCall(fakeTool("glob", OUTPUT), run, "g1", ARGS);

		expect(sources).toEqual([]);
		expect(spotlightDetails(result.details)).toMatchObject({ scoreFree: true, tool: "glob" });
		const [entry] = entries(run.manager, SPOTLIGHT_ENTRY.shape);
		expect(entry).toMatchObject({ scoreFree: true, spotlight: { calls: 0 } });
		expect(entry.steps).not.toEqual(["none"]);
	});

	it("cuts a rerun of a spilled grep output instead of showing it whole as a re-ask", async () => {
		const big = grepOutput(40);
		const plain = await plainSession(SMALL_SPILL);
		const plainText = resultText(await agentCall(fakeTool("grep", big), plain, "g1", ARGS));
		const run = await experimentSession(ranked(), SMALL_SPILL);
		await agentCall(fakeTool("grep", big), run, "g1", ARGS);

		const again = await agentCall(fakeTool("grep", big), run, "g2", ARGS);

		expect(spotlightDetails(again.details)?.steps).toContain("window");
		expect(spotlightDetails(again.details)?.steps).not.toContain("plain-cap");
		expect(resultText(again).length).toBeLessThan(plainText.length);
	});

	/** A short board: its ten open items repeat in the next board, and save enough tokens to collapse. */
	const OPEN = Array.from(
		{ length: 10 },
		(_, i) => `- [open] step ${i + 1}: wire the edit gate into the read tool's shaping`,
	);
	const BOARD = ["board: 10 open, 1 done", ...OPEN, "- [done] draw the holdout coin first"];
	const NEXT_BOARD = ["board: 10 open, 2 done", ...OPEN, "- [done] add the edit gate setting"].join("\n");

	it("collapses a run of lines already shown in a short result when the collapse saves enough tokens", async () => {
		const run = await experimentSession(ranked());
		await agentCall(fakeTool("board", BOARD.join("\n")), run, "t1");

		const again = await agentCall(fakeTool("board", NEXT_BOARD), run, "t2");

		expect(resultText(again)).toBe(
			[
				"board: 10 open, 2 done",
				"… [10 lines as shown before: read artifact://0:2-11]",
				"- [done] add the edit gate setting",
			].join("\n"),
		);
		const entry = entries(run.manager, SPOTLIGHT_ENTRY.shape)[1];
		expect(entry).toMatchObject({ toolCallId: "t2", steps: ["seen"], stats: { short: 1, seenLines: 10 } });
	});

	it("passes a short result whole when its runs already shown are too short to pay for a marker", async () => {
		const short = [
			"lint summary for the workspace",
			"ok: lint is clean",
			"ok: types are clean",
			"ok: tests pass",
		].join("\n");
		const run = await experimentSession(ranked());
		await agentCall(fakeTool("check", short), run, "c1");

		const again = await agentCall(fakeTool("check", short), run, "c2");

		expect(resultText(again)).toBe(short);
		const entry = entries(run.manager, SPOTLIGHT_ENTRY.shape)[1];
		expect(entry).toMatchObject({ toolCallId: "c2", steps: ["none"], stats: { short: 1 } });
	});

	/** The model's context the session reports, as the loop builds it. */
	const call = (...ids: string[]) =>
		({
			role: "assistant",
			content: ids.map(id => ({ type: "toolCall", id, name: "board", arguments: {} })),
			timestamp: 0,
		}) as unknown as Message;
	const shown = (id: string, result: AgentToolResult) =>
		({
			role: "toolResult",
			toolCallId: id,
			toolName: "board",
			content: result.content,
			isError: false,
			timestamp: 0,
		}) as Message;

	it("counts as seen only what is still in the model's context: a compaction forgets the lines it took out", async () => {
		const run = await experimentSession(ranked());
		let context: Message[] = [{ role: "user", content: "triage the board", timestamp: 0 }, call("t1")];
		run.session.getContextMessages = () => context;
		const board = fakeTool("board", BOARD.join("\n"));
		const next = fakeTool("board", NEXT_BOARD);
		context.push(shown("t1", await agentCall(board, run, "t1")), call("t2"));
		expect(resultText(await agentCall(next, run, "t2"))).toMatch(
			/… \[10 lines as shown before: read artifact:\/\/\d+:2-11\]/,
		);

		// A compaction leaves its summary and the new turn: the boards are gone from the context.
		context = [{ role: "user", content: "Summary: the board was triaged.", timestamp: 0 }, call("t3")];
		const afterCompaction = await agentCall(next, run, "t3");

		expect(resultText(afterCompaction)).toBe(NEXT_BOARD);
	});

	it("counts a sibling call's result of the same turn as seen before it lands in the context", async () => {
		const run = await experimentSession(ranked());
		const context: Message[] = [{ role: "user", content: "triage the board", timestamp: 0 }, call("t1", "t2")];
		run.session.getContextMessages = () => context;

		await agentCall(fakeTool("board", BOARD.join("\n")), run, "t1");
		const sibling = await agentCall(fakeTool("board", NEXT_BOARD), run, "t2");

		expect(resultText(sibling)).toMatch(/… \[10 lines as shown before: read artifact:\/\/\d+:2-11\]/);
	});

	it("shapes and journals only the tools spotlight.experiment.tools names", async () => {
		const run = await experimentSession(ranked(), {}, { tools: ["glob"] });
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));

		const grep = await agentCall(fakeTool("grep", OUTPUT), run, "g1", ARGS);
		const bash = await new BashTool(run.session).execute("b1", { command: "./ingest.sh" });
		const glob = await agentCall(fakeTool("glob", OUTPUT), run, "g2", ARGS);

		expect(resultText(grep)).toBe(OUTPUT);
		expect(spotlightDetails(grep.details)).toBeUndefined();
		expect(resultText(bash)).toContain("step 300:");
		expect(resultText(glob)).not.toBe(OUTPUT);
		expect(entries(run.manager, SPOTLIGHT_ENTRY.shape).map(entry => entry.tool)).toEqual(["glob"]);
		const experiment = run.session.spotlight as SpotlightExperiment;
		expect(experiment.sessionEntry().tools).toEqual(["glob"]);
	});

	it("leaves read, bash and eval to their own shaping, once per call", async () => {
		const run = await experimentSession(ranked());
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashOutput(LONG_LOG));
		await Bun.write(path.join(run.session.cwd, "big.ts"), BIG_SOURCE);

		const bash = wrapToolWithMetaNotice(new BashTool(run.session)) as unknown as AgentTool;
		const read = wrapToolWithMetaNotice(new ReadTool(run.session)) as unknown as AgentTool;
		await agentCall(bash, run, "b1", { command: "./ingest.sh" });
		await agentCall(read, run, "r1", { path: "big.ts" });

		expect(entries(run.manager, SPOTLIGHT_ENTRY.shape).map(entry => [entry.toolCallId, entry.tool])).toEqual([
			["b1", "bash"],
			["r1", "read"],
		]);
	});

	it("leaves calls the agent did not make whole: another tool's call, or one outside the loop", async () => {
		const run = await experimentSession(ranked());
		const grep = fakeTool("grep", OUTPUT);

		const nested = await grep.execute(
			"w1",
			ARGS,
			undefined,
			undefined,
			agentContext(run.session, run.manager, [{ id: "w1", name: "write" }]),
		);
		const scripted = await grep.execute("e1", ARGS, undefined, undefined, agentContext(run.session, run.manager));

		expect(resultText(nested)).toBe(OUTPUT);
		expect(resultText(scripted)).toBe(OUTPUT);
		expect(entries(run.manager, SPOTLIGHT_ENTRY.shape)).toEqual([]);
	});

	it("names a call by its tool and arguments, without the intent", () => {
		expect(callSummary("grep", { pattern: "x", path: "src", i: "find x" })).toBe('grep {"pattern":"x","path":"src"}');
		expect(callSummary("todo", {})).toBe("todo");
		expect(callSummary("wait", undefined)).toBe("wait");
	});
});

describe("spotlight session entry", () => {
	it("journals the session entry on a session change only when the journal's last one differs", async () => {
		const manager = SessionManager.inMemory(await tmpDir());
		// A journal from before the toggle carries only an arm assignment: it gets a session entry.
		manager.appendCustomEntry("spotlight:assignment", { arm: "plain", findRanker: "judge", holdout: 0.15 });
		const client = spotlightClient(fakeSpotlight({}));
		const experiment = new SpotlightExperiment(client, "low", manager, { holdout: 0.15 });
		experiment.onSessionChange();
		experiment.onSessionChange();
		new SpotlightExperiment(client, "low", manager, { holdout: 0.3 }).onSessionChange();

		expect(entries(manager, SPOTLIGHT_ENTRY.session).map(entry => entry.holdout)).toEqual([0.15, 0.3]);
	});

	it("starts nothing while the experiment is off", async () => {
		const manager = SessionManager.inMemory(await tmpDir());
		expect(startSpotlightExperiment(Settings.isolated({}), manager)).toBeUndefined();
		expect(entries(manager, SPOTLIGHT_ENTRY.session)).toEqual([]);
	});
});

describe("spotlight call context", () => {
	it("carries the task, the call's turn text and the last three earlier bash commands, oldest first", () => {
		const bash = (id: string, command: string) => ({
			type: "toolCall" as const,
			id,
			name: "bash",
			arguments: { command },
		});
		const messages = [
			{ role: "user", content: "fix the flaky test", timestamp: 0 },
			{ role: "assistant", content: [bash("a", "ls"), bash("b", "git status")] },
			{ role: "user", content: [{ type: "text", text: "steer" }], timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "Running it." }, bash("c", "bun test")] },
			{
				role: "assistant",
				content: [
					bash("d", "cat log"),
					{ type: "text", text: "Now the suite." },
					bash("now", "bun test --rerun"),
					bash("later", "echo after"),
				],
			},
		] as unknown as AgentMessage[];

		const ctx = buildCallContext(messages, "now", "bun test --rerun", "  rerun the suite ");
		expect(ctx).toEqual({
			task: "fix the flaky test",
			said: "Now the suite.",
			intent: "rerun the suite",
			commands: ["git status", "bun test", "cat log"],
			source: "bun test --rerun",
		});
	});
});
