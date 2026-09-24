import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Judge, JudgmentRequest, JudgmentResult, NoulAnswer, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { runCascade } from "@oh-my-pi/pi-coding-agent/tools/jfind/cascade";
import { keywordsFromQuery } from "@oh-my-pi/pi-coding-agent/tools/jfind/keywords";
import {
	mergeHeat,
	type Passage,
	selectWindows,
	sketch,
	windows,
} from "@oh-my-pi/pi-coding-agent/tools/jfind/passages";
import { readText, ReadTextError } from "@oh-my-pi/pi-coding-agent/tools/jfind/text";
import { eligibleFile, renderTree } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import { isEnumerableScope, materializeUrlScope } from "@oh-my-pi/pi-coding-agent/tools/jfind/url-scope";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
			await expect(readText(path.join(dir, "bin.dat"), 100)).rejects.toBeInstanceOf(ReadTextError);
			const read = await readText(path.join(dir, "text.txt"), 16);
			expect(read).toEqual({ text: "first line\n", bytes: 11, truncated: true });
			const whole = await readText(path.join(dir, "text.txt"), 100);
			expect(whole.truncated).toBe(false);
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

/** Doc paths of a materialized `omp://` corpus, with `/` separators on every platform. */
async function materializedRels(dir: string): Promise<string[]> {
	return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir })))
		.map(file => file.split(path.sep).join("/"))
		.sort();
}

describe("jfind cascade", () => {
	it("verifies only sketched passages, reports merged ranges, and runs waves in parallel", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-cascade-"));
		try {
			// Enough files to need three filename batches (> 128 would be truncated).
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
				root: dir,
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
			expect(result.stats.errors).toBe(0);
			expect(result.stats.failures).toEqual([]);
			expect(judge.peak).toBeGreaterThan(1);
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
				root: dir,
				query: "token parsing",
				extraKeywords: [],
				judge,
				includeHidden: false,
			});
			expect(result.hits.map(hit => hit.rel)).toEqual(["a.ts"]);
			expect(result.stats.errors).toBe(1);
			expect(result.stats.failures).toEqual(["sketches: sketch backend down"]);
		} finally {
			await removeWithRetries(dir);
		}
	});
	it("detects enumerable URL scopes and rejects unknown docs and range selectors before judging", async () => {
		expect(isEnumerableScope("omp://")).toBe(true);
		expect(isEnumerableScope("OMP://tools/read.md")).toBe(true);
		expect(isEnumerableScope("artifact://1")).toBe(false);
		expect(isEnumerableScope("packages/tui")).toBe(false);
		await expect(materializeUrlScope("omp://nope.md")).rejects.toThrow("Documentation file not found");
		await expect(materializeUrlScope("omp://tools/read.md:1-10")).rejects.toThrow(
			"line-range selectors are not supported",
		);
	});

	it("materializes one omp doc and remaps its cascade hits to the canonical URL", async () => {
		const scope = await materializeUrlScope("omp://docs/tools/read.md");
		try {
			expect(scope.scopePath).toBe("omp://tools/read.md");
			expect(await materializedRels(scope.dir)).toEqual(["tools/read.md"]);

			const result = await runCascade({
				root: scope.dir,
				query: "read the contents of a file by path",
				extraKeywords: ["read"],
				judge: new FakeJudge(() => 0.9),
				includeHidden: false,
			});
			expect(result.hits.map(hit => scope.toUrl(hit.rel))).toEqual(["omp://tools/read.md"]);
		} finally {
			await scope.cleanup();
		}
	});

	it("expands the omp root scope to every embedded doc and cleans up after itself", async () => {
		const completions = (await InternalUrlRouter.instance().complete("omp", "")) ?? [];
		const rels = new Set(completions.map(completion => completion.value));

		const scope = await materializeUrlScope("omp://");
		try {
			const materialized = await materializedRels(scope.dir);
			expect(materialized).toHaveLength(rels.size);
			expect(materialized).toContain("tools/read.md");
			expect(await Bun.file(path.join(scope.dir, "tools", "read.md")).text()).toBe(
				(await InternalUrlRouter.instance().resolve("omp://tools/read.md")).content,
			);
			await scope.cleanup();
			expect(
				await fs.stat(scope.dir).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await scope.cleanup();
		}
	});

	it("rejects a scope path that is missing or not a directory before spending any judgment", async () => {
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
			await expect(tool.execute("x", { query: "anything", grep_keywords: [], path: "a.ts" })).rejects.toThrow(
				"Path is not a directory: a.ts",
			);
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
					root: dir,
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
