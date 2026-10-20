import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Judge, JudgmentRequest, JudgmentResult, NoulAnswer, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import * as natives from "@oh-my-pi/pi-natives";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { runCascade } from "@oh-my-pi/pi-coding-agent/tools/jfind/cascade";
import { keywordsFromQuery } from "@oh-my-pi/pi-coding-agent/tools/jfind/keywords";
import { grepIndex } from "@oh-my-pi/pi-coding-agent/tools/jfind/lexical";
import {
	mergeHeat,
	type Passage,
	selectWindows,
	sketch,
	windows,
} from "@oh-my-pi/pi-coding-agent/tools/jfind/passages";
import { readText, ReadTextError } from "@oh-my-pi/pi-coding-agent/tools/jfind/text";
import { eligibleFile, renderTree, resolveSearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { resolveSearchResultPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Read-tier URL filesystem rooted at `cwd`, as the `find` tool builds one per call. */
function urlFs(cwd: string): InternalUrlFilesystem {
	return new InternalUrlFilesystem({ context: { cwd }, tier: "read" });
}

describe("jfind keywords", () => {
	it("keeps quoted phrases whole, drops stopwords and numbers, and stems inflections", () => {
		expect(keywordsFromQuery('where is the "rate limit" for spawned workers after 3 retries?')).toEqual([
			"rate limit",
			"spawn",
			"worker",
			"retri",
		]);
	});
});

describe("jfind passages", () => {
	it("bounds windows by tagged bytes and never drops the final line", () => {
		const text = Array.from({ length: 12 }, (_, i) => `line${i} needle`).join("\n");
		const passages = windows(text, 64, ["needle"], [1]);
		expect(passages.length).toBeGreaterThan(1);
		for (const passage of passages) expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(64);
		expect(passages[0]!.start).toBe(1);
		expect(passages[passages.length - 1]!.end).toBe(12);
		expect(passages.every(p => p.text.startsWith(`L${p.start}| `))).toBe(true);
		expect(passages.every(p => p.score > 0)).toBe(true);
	});

	it("spreads the selection through the file when nothing matched lexically", () => {
		const passages: Passage[] = Array.from({ length: 10 }, (_, i) => ({
			start: i + 1,
			end: i + 1,
			text: "",
			score: 0,
		}));
		expect(selectWindows(passages, 4).map(p => p.start)).toEqual([1, 4, 7, 10]);
	});

	it("keeps the strongest windows in file order otherwise", () => {
		const passages: Passage[] = [1, 2, 3, 4].map(start => ({ start, end: start, text: "", score: start % 2 }));
		expect(selectWindows(passages, 2).map(p => p.start)).toEqual([1, 3]);
	});

	it("sketches keep original line coordinates and deep evidence", () => {
		const passage: Passage = {
			start: 400,
			end: 403,
			text: "L400| unrelated\nL401| // λλ\nL402| target_impl();\nL403| target helper\n",
			score: 0,
		};
		const text = sketch(passage, ["target"], [4], 100);
		expect(text).toContain("402: target_impl();");
		expect(text).toContain("403: target helper");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
		expect(text).not.toContain("L402|");
	});

	it("sketches clip multibyte text without exceeding the byte budget", () => {
		const passage: Passage = { start: 9, end: 10, text: `L9| ${"λ".repeat(300)}\nL10| needle_impl();\n`, score: 0 };
		for (let budget = 24; budget < 650; budget++) {
			const text = sketch(passage, ["needle"], [5], budget);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
			expect(text).not.toContain("\uFFFD");
		}
	});

	it("merges touching positive ranges without bridging unjudged gaps", () => {
		const merged = mergeHeat(
			[
				{ start: 10, end: 20, p: 0.6, snippet: "a" },
				{ start: 21, end: 30, p: 0.9, snippet: "b" },
				{ start: 40, end: 50, p: 0.1, snippet: "cold" },
				{ start: 60, end: 70, p: 0.5, snippet: "c" },
			],
			0.2,
		);
		expect(merged).toEqual([
			{ start: 10, end: 30, p: 0.9, snippet: "a" },
			{ start: 60, end: 70, p: 0.5, snippet: "c" },
		]);
	});
});

describe("jfind tree", () => {
	it("never lists credential material but keeps committed env templates", () => {
		expect(eligibleFile(".env", 10, true)).toBe(false);
		expect(eligibleFile("deploy/.env.production", 10, true)).toBe(false);
		expect(eligibleFile(".env.example", 10, true)).toBe(true);
		expect(eligibleFile("certs/server.PEM", 10, true)).toBe(false);
		expect(eligibleFile("node_modules/x/index.js", 10, true)).toBe(false);
		expect(eligibleFile(".github/ci.yml", 10, false)).toBe(false);
		expect(eligibleFile(".github/ci.yml", 10, true)).toBe(true);
		expect(eligibleFile("src/empty.ts", 0, true)).toBe(false);
	});

	it("renders the judge-facing tree with the question tag before each name", () => {
		const entries = [
			{ path: "/r/src/a/b/one.rs", rel: "src/a/b/one.rs", size: 2048 },
			{ path: "/r/README.md", rel: "README.md", size: 12 },
			{ path: "/r/src/two.rs", rel: "src/two.rs", size: 3 * 1024 * 1024 },
		];
		expect(renderTree(entries, i => `e${String(i).padStart(3, "0")}`)).toBe(
			[
				"# e001 README.md (12 B)",
				"",
				"# src/",
				"## e002 two.rs (3.0 MB)",
				"",
				"## a/b/",
				"### e000 one.rs (2.0 KB)",
				"",
			].join("\n"),
		);
	});
});

describe("jfind readText", () => {
	it("rejects binaries and trims a truncated read to the last full line", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-read-"));
		try {
			await Bun.write(path.join(dir, "bin.dat"), new Uint8Array([0x41, 0x00, 0x42]));
			await Bun.write(path.join(dir, "text.txt"), "first line\nsecond line\nthird");
			const filesystem = urlFs(dir);
			await expect(readText(filesystem, path.join(dir, "bin.dat"), 100)).rejects.toBeInstanceOf(ReadTextError);
			const read = await readText(filesystem, path.join(dir, "text.txt"), 16);
			expect(read).toEqual({ text: "first line\n", bytes: 11, truncated: true });
			const whole = await readText(filesystem, path.join(dir, "text.txt"), 100);
			expect(whole.truncated).toBe(false);
		} finally {
			await removeWithRetries(dir);
		}
	});
});

describe("jfind lexical index", () => {
	it("counts keyword occurrences case-insensitively over every streamed matching line", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-lexical-"));
		try {
			// Far more matching lines than one streamed batch carries.
			await Bun.write(path.join(dir, "dense.txt"), "ΣΊΣΥΦΟΣ Service_Tier service_tier\n".repeat(3_000));
			await Bun.write(path.join(dir, "other.txt"), "SERVICE_TIER\nunrelated\n");
			const index = await grepIndex(dir, ["Σίσυφος", "service_tier"], {
				includeHidden: false,
				filesystem: urlFs(dir).shellFilesystem(),
			});
			expect(index.filesScanned).toBe(2);
			expect(Object.fromEntries(index.perFileKw)).toEqual({ "dense.txt": [3_000, 6_000], "other.txt": [0, 1] });
		} finally {
			await removeWithRetries(dir);
		}
	});
});

/** Judge that answers every noul from `answer(request, key)` and records concurrency. */
class FakeJudge implements Judge {
	readonly label = "fake";
	inFlight = 0;
	peak = 0;
	requests: JudgmentRequest[] = [];
	constructor(readonly answer: (request: JudgmentRequest, key: string) => number | Error) {}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.requests.push(request);
		this.inFlight++;
		this.peak = Math.max(this.peak, this.inFlight);
		try {
			// Yield once so sibling workers of the dispatcher overlap this call.
			await Promise.resolve();
			const answers: Record<string, NoulAnswer> = {};
			for (const key in request.questions) {
				const value = this.answer(request, key);
				if (value instanceof Error) throw value;
				answers[key] = { type: "noul", noul: value };
			}
			return {
				api: "typesafe",
				provider: "fake",
				model: "fake",
				answers: answers as JudgmentResult<Q>["answers"],
				usage: tokenUsage(100, 0, 0.001),
			};
		} finally {
			this.inFlight--;
		}
	}
}

function stateOf(request: JudgmentRequest): Record<string, unknown> {
	return request.state as Record<string, unknown>;
}

describe("jfind cascade", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("verifies only sketched passages, reports merged ranges, and runs waves in parallel", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-"));
		try {
			// 72 files, so two 64-question filename batches (> 128 would be truncated).
			for (let i = 0; i < 70; i++) {
				await Bun.write(path.join(dir, "pkg", `filler${i}.ts`), `export const filler${i} = ${i};\n`);
			}
			const target = Array.from({ length: 600 }, (_, i) =>
				i === 250 ? "function retryBudget() { return attempts * 2; } // retry" : `const noise${i} = ${i};`,
			).join("\n");
			await Bun.write(path.join(dir, "src", "retry.ts"), target);
			await Bun.write(path.join(dir, "src", "other.ts"), "export const unrelated = 1;\n");

			const judge = new FakeJudge((request, key) => {
				const state = stateOf(request);
				if ("tree" in state) return String(state.tree).includes(`${key} retry.ts`) ? 0.9 : 0.1;
				if ("files" in state) {
					const card = (state.passages as Record<string, [string, string]>)[key]!;
					return card[1].includes("retryBudget") ? 0.8 : 0.2;
				}
				const passage = (state.passages as Record<string, string>)[key]!;
				return passage.includes("retryBudget") ? 0.95 : 0.3;
			});
			const result = await runCascade({
				root: { path: dir, type: "directory" },
				filesystem: urlFs(dir),
				query: "how is the retry budget computed?",
				extraKeywords: ["attempts"],
				judge,
				includeHidden: false,
			});

			expect(result.keywords).toEqual(["retry", "budget", "comput", "attempts"]);
			expect(result.hits.map(hit => hit.rel)).toEqual(["src/retry.ts"]);
			const hit = result.hits[0]!;
			expect(hit.nameScore).toBe(0.9);
			expect(hit.contentScore).toBe(0.95);
			expect(hit.ranges).toHaveLength(1);
			expect(hit.ranges[0]!.start).toBeLessThanOrEqual(251);
			expect(hit.ranges[0]!.end).toBeGreaterThanOrEqual(251);
			expect(hit.ranges[0]!.snippet).toBe("const noise0 = 0;");

			// Wave 1 judged every listed file by name; wave 3 verified only the routed sketch.
			const nameRequests = judge.requests.filter(request => "tree" in stateOf(request));
			const verifyRequests = judge.requests.filter(request => "file" in stateOf(request));
			expect(nameRequests).toHaveLength(2);
			expect(verifyRequests).toHaveLength(1);
			expect(Object.keys(verifyRequests[0]!.questions)).toEqual(["p00"]);
			expect(result.stats.judged).toBe(72);
			expect(result.stats.failed).toBe(0);
			expect(result.coverage).toBe("complete");
			expect(result.stats.failures).toEqual([]);
			expect(judge.peak).toBeGreaterThan(1);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("finds an owner in an explicit file when a sketch lacks the surrounding explanation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-single-file-"));
		try {
			const file = path.join(dir, "authority.md");
			const body = Array.from({ length: 67 }, (_, i) => {
				if (i === 60) return "The Valmont coil reservation workflow is owned by the Production Planning team.";
				if (i === 64) return "The same team signs off on requests before dispatch.";
				return `Background on inventory planning, section ${i + 1}: ${"general policy ".repeat(3)}`;
			}).join("\n");
			await Bun.write(file, body);
			const judge = new FakeJudge((request, key) => {
				const state = stateOf(request);
				if ("tree" in state) return 0.9;
				const passage = (state.passages as Record<string, string | [string, string]>)[key]!;
				const text = typeof passage === "string" ? passage : passage[1];
				return text.includes("owned by the Production Planning team") &&
					text.includes("same team signs off on requests")
					? 0.95
					: 0.1;
			});
			const result = await runCascade({
				root: { path: file, type: "file", size: Buffer.byteLength(body) },
				filesystem: urlFs(dir),
				query: "who owns coil reservation and inventory transfer approvals",
				extraKeywords: ["coil reservation", "owned by"],
				judge,
				includeHidden: false,
			});
			expect(result.hits.map(hit => hit.rel)).toEqual([file]);
			expect(result.hits[0]!.ranges).toEqual([expect.objectContaining({ start: 1, end: 67, p: 0.95 })]);
			expect(result.hits[0]!.truncated).toBe(false);
			// A named file needs no filename ranking or sketch routing.
			expect(judge.requests.filter(request => "tree" in stateOf(request))).toHaveLength(0);
			expect(judge.requests.filter(request => "files" in stateOf(request))).toHaveLength(0);
			expect(result.stats.mapCards).toBe(0);
			expect(result.stats.windowsPruned).toBe(0);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("verifies the final passage of an explicitly named file past the per-file window budget", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-long-file-"));
		try {
			const file = path.join(dir, "authority.md");
			// 30 windows of 8 KiB: more than the 24 windows a directory search
			// spends on one file, fewer than the passage budget.
			const body = Array.from({ length: 30 }, (_, i) =>
				i === 29
					? "The Production Planning team owns coil reservation approvals."
					: `section ${i}: ${"x".repeat(8170)}`,
			).join("\n");
			await Bun.write(file, body);
			const judge = new FakeJudge((request, key) => {
				const state = stateOf(request);
				if ("file" in state) {
					return (state.passages as Record<string, string>)[key]!.includes("Production Planning team") ? 0.9 : 0.1;
				}
				return 0.1;
			});
			const result = await runCascade({
				root: { path: file, type: "file", size: Buffer.byteLength(body) },
				filesystem: urlFs(dir),
				query: "who owns coil reservation approvals?",
				extraKeywords: ["coil reservation"],
				judge,
				includeHidden: false,
			});
			// The whole file is judged: every one of its 30 windows is verified.
			const judged = judge.requests
				.filter(request => "file" in stateOf(request))
				.reduce(
					(total, request) => total + Object.keys(stateOf(request).passages as Record<string, string>).length,
					0,
				);
			expect(judged).toBe(30);
			expect(result.hits[0]!.ranges).toEqual([expect.objectContaining({ start: 30, end: 30, p: 0.9 })]);
			expect(result.hits[0]!.truncated).toBe(false);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("refuses a named file whose windows outgrow the verification budget instead of sampling it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-over-budget-"));
		try {
			const file = path.join(dir, "authority.md");
			// 60 windows of 4 KiB whose text shares no keyword with the query.
			// Sampling them would spread the windows through the file and could
			// drop the one holding the answer, with no truncation flag to show
			// for it: the search would report a clean "no hits".
			const body = Array.from({ length: 60 }, (_, i) =>
				i === 2
					? `The Production Planning team signs off on the aeon release. ${"x".repeat(4030)}`
					: `section ${i}: ${"x".repeat(4090)}`,
			).join("\n");
			await Bun.write(file, body);
			const judge = new FakeJudge((request, key) => {
				const state = stateOf(request);
				if ("file" in state) {
					return (state.passages as Record<string, string>)[key]!.includes("Production Planning team") ? 0.9 : 0.1;
				}
				return 0.1;
			});
			await expect(
				runCascade({
					root: { path: file, type: "file", size: Buffer.byteLength(body) },
					filesystem: urlFs(dir),
					query: "who is in charge of the quarterly rollout?",
					extraKeywords: [],
					judge,
					includeHidden: false,
				}),
			).rejects.toThrow("60 passages exceed the 40-passage budget");
			// A refusal, not an empty result: nothing was judged at all.
			expect(judge.requests).toHaveLength(0);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("never runs the native lexical scan for an explicitly named file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-noscan-"));
		try {
			const file = path.join(dir, "authority.md");
			const body = "The Production Planning team owns coil reservation approvals.\n";
			await Bun.write(file, body);
			const scan = vi.spyOn(natives, "grep");
			const result = await runCascade({
				root: { path: file, type: "file", size: Buffer.byteLength(body) },
				filesystem: urlFs(dir),
				query: "who owns coil reservation approvals?",
				extraKeywords: ["coil reservation"],
				judge: new FakeJudge(() => 0.9),
				includeHidden: false,
			});
			expect(scan).not.toHaveBeenCalled();
			expect(result.hits.map(hit => hit.rel)).toEqual([file]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("rejects an explicit file whose line cannot be judged in full", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-clipped-file-"));
		try {
			const file = path.join(dir, "authority.md");
			const body = `${"x".repeat(9000)}\nThe Production Planning team owns coil reservations.`;
			await Bun.write(file, body);
			await expect(
				runCascade({
					root: { path: file, type: "file", size: Buffer.byteLength(body) },
					filesystem: urlFs(dir),
					query: "who owns inventory transfers?",
					extraKeywords: [],
					judge: new FakeJudge(() => 0.1),
					includeHidden: false,
				}),
			).rejects.toThrow("a line exceeds the 8.0KB passage limit");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("refuses an explicitly named file too large to read instead of reporting a miss", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-oversized-file-"));
		try {
			const file = path.join(dir, "authority.md");
			// Past the whole-file budget the passage budget can judge, so the
			// file cannot be judged whole.
			const body = `${"x".repeat(1023)}\n`.repeat(4200);
			await Bun.write(file, body);
			const judge = new FakeJudge(() => 0.1);
			await expect(
				runCascade({
					root: { path: file, type: "file", size: Buffer.byteLength(body) },
					filesystem: urlFs(dir),
					query: "who owns coil reservation approvals?",
					extraKeywords: ["coil reservation"],
					judge,
					includeHidden: false,
				}),
			).rejects.toThrow("exceeds the 320.0KB read limit");
			// A refusal, not an empty result: nothing was judged at all.
			expect(judge.requests).toHaveLength(0);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("keeps a source line that looks like a line tag intact when judging a named file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-literal-tag-"));
		try {
			const file = path.join(dir, "authority.md");
			// The source line starts with the same text the window format adds, so
			// a judge that strips the tag must still see the author's own prefix.
			const body = "L1| The Production Planning team owns coil reservation approvals.\n";
			await Bun.write(file, body);
			const judged: string[] = [];
			const judge = new FakeJudge((request, key) => {
				const state = stateOf(request);
				if (!("file" in state)) return 0.1;
				const passage = (state.passages as Record<string, string>)[key]!;
				judged.push(passage);
				return passage.includes("L1| The Production Planning team") ? 0.9 : 0.1;
			});
			const result = await runCascade({
				root: { path: file, type: "file", size: Buffer.byteLength(body) },
				filesystem: urlFs(dir),
				query: "who owns coil reservation approvals?",
				extraKeywords: ["coil reservation"],
				judge,
				includeHidden: false,
			});
			// The literal prefix reaches the judge alongside the window tag.
			expect(judged.join("\n")).toContain("L1| The Production Planning team");
			expect(result.hits.map(hit => hit.rel)).toEqual([file]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("routes sketches onward when their judgment fails and reports the failure", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-fail-"));
		try {
			await Bun.write(path.join(dir, "a.ts"), "export function parseToken() { return 1; }\n");
			const judge = new FakeJudge(request => {
				const state = stateOf(request);
				if ("files" in state) return new Error("sketch backend down");
				return 0.7;
			});
			const result = await runCascade({
				root: { path: dir, type: "directory" },
				filesystem: urlFs(dir),
				query: "token parsing",
				extraKeywords: [],
				judge,
				includeHidden: false,
			});
			expect(result.hits.map(hit => hit.rel)).toEqual(["a.ts"]);
			expect(result.stats.failed).toBe(1);
			expect(result.coverage).toBe("partial");
			expect(result.stats.failures).toEqual(["sketches: sketch backend down"]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("reports unavailable, not an empty result, when every judge request fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-down-"));
		try {
			await Bun.write(path.join(dir, "auth.ts"), "export function refreshToken() { return 1; }\n");
			vi.spyOn(ChainJudge.prototype, "judge").mockRejectedValue(new Error("402 billing account rejected"));
			const tool = new FindTool({
				cwd: dir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "find.enabled": "on" }),
				modelRegistry: {} as never,
			});
			const result = await tool.execute("x", { query: "token refresh", grep_keywords: ["refreshToken"] });
			expect(result.isError).toBe(true);
			expect(result.details?.coverage).toBe("unavailable");
			expect(result.details?.stats.failed).toBe(result.details?.stats.requests);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toStartWith('find unavailable for "token refresh"');
			expect(text).not.toContain("no hits");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("keeps an empty result complete when the judge answered and nothing matched", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-empty-"));
		try {
			await Bun.write(path.join(dir, "a.ts"), "export const unrelated = 1;\n");
			const result = await runCascade({
				root: { path: dir, type: "directory" },
				filesystem: urlFs(dir),
				query: "token parsing",
				extraKeywords: [],
				judge: new FakeJudge(() => 0.05),
				includeHidden: false,
			});
			expect(result.hits).toEqual([]);
			expect(result.coverage).toBe("complete");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("counts unusable answers apart from failed requests", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-garbled-"));
		try {
			await Bun.write(path.join(dir, "a.ts"), "export function parseToken() { return 1; }\n");
			const judge = new FakeJudge(request => {
				const state = stateOf(request);
				if ("tree" in state) return Number.NaN;
				if ("files" in state) return new Error("sketch backend down");
				return 0.7;
			});
			const result = await runCascade({
				root: { path: dir, type: "directory" },
				filesystem: urlFs(dir),
				query: "token parsing",
				extraKeywords: [],
				judge,
				includeHidden: false,
			});
			// One filename request answered with garbage, one sketch request threw, one verification succeeded.
			expect(result.stats).toMatchObject({ requests: 3, failed: 1, unanswered: 1 });
			expect(result.coverage).toBe("partial");
			expect(result.hits.map(hit => hit.rel)).toEqual(["a.ts"]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("resolves URL scopes in place and rejects unknown docs and range selectors before judging", async () => {
		const filesystem = urlFs(process.cwd());
		expect(await resolveSearchRoot(filesystem, "omp://", process.cwd())).toEqual({
			path: "omp://",
			type: "directory",
		});
		expect(await resolveSearchRoot(filesystem, "omp://tools/read.md", process.cwd())).toMatchObject({
			path: "omp://tools/read.md",
			type: "file",
		});
		await expect(resolveSearchRoot(filesystem, "omp://nope.md", process.cwd())).rejects.toThrow(
			"Path not found: omp://nope.md",
		);
		await expect(resolveSearchRoot(filesystem, "omp://tools/read.md:1-10", process.cwd())).rejects.toThrow(
			"line-range selectors are not supported",
		);
	});

	it("searches a single omp doc in place and reports hits as its URL", async () => {
		const filesystem = urlFs(process.cwd());
		const root = await resolveSearchRoot(filesystem, "omp://tools/read.md", process.cwd());
		const result = await runCascade({
			root,
			filesystem,
			query: "read the contents of a file by path",
			extraKeywords: ["read"],
			judge: new FakeJudge(() => 0.9),
			includeHidden: false,
		});
		expect(result.stats.listed).toBe(1);
		expect(result.hits.map(hit => resolveSearchResultPath(root.path, hit.rel))).toEqual(["omp://tools/read.md"]);
	});

	it("walks the omp root in place: every embedded doc is listed and hits resolve to doc URLs", async () => {
		const completions = (await InternalUrlRouter.instance().complete("omp", "")) ?? [];
		const docs = new Set(completions.map(completion => completion.value));
		const filesystem = urlFs(process.cwd());
		const root = await resolveSearchRoot(filesystem, "omp://", process.cwd());
		const judge = new FakeJudge((request, key) => {
			const state = stateOf(request);
			if ("tree" in state) return String(state.tree).includes(`${key} read.md`) ? 0.9 : 0.1;
			if ("files" in state) {
				const [fileKey] = (state.passages as Record<string, [string, string]>)[key]!;
				return (state.files as Record<string, string>)[fileKey] === "tools/read.md" ? 0.9 : 0.1;
			}
			return state.file === "tools/read.md" ? 0.95 : 0.1;
		});
		const result = await runCascade({
			root,
			filesystem,
			query: "read the contents of a file by path",
			extraKeywords: ["read"],
			judge,
			includeHidden: false,
		});
		expect(result.stats.listed).toBe(docs.size);
		expect(result.hits.map(hit => resolveSearchResultPath(root.path, hit.rel))).toEqual(["omp://tools/read.md"]);
	});

	it("rejects a missing scope path or a line selector before spending any judgment", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-scope-"));
		try {
			await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
			const tool = new FindTool({
				cwd: dir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "find.enabled": "on" }),
			});
			await expect(tool.execute("x", { query: "anything", grep_keywords: [], path: "nope" })).rejects.toThrow(
				"Path not found: nope",
			);
			await expect(
				tool.execute("x", { query: "anything", grep_keywords: [], path: "omp://tools/read.md:1-10" }),
			).rejects.toThrow("line-range selectors are not supported");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("stops promptly when aborted mid-wave", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-abort-"));
		try {
			await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
			const controller = new AbortController();
			const judge = new FakeJudge(() => {
				controller.abort();
				return 0.5;
			});
			await expect(
				runCascade({
					root: { path: dir, type: "directory" },
					filesystem: urlFs(dir),
					query: "anything at all",
					extraKeywords: [],
					judge,
					includeHidden: false,
					signal: controller.signal,
				}),
			).rejects.toThrow("Operation aborted");
		} finally {
			await removeWithRetries(dir);
		}
	});
});
