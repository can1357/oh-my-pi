import { describe, expect, it } from "bun:test";
import {
	countTokens,
	MIN_SAVED_TOKENS,
	newShapeState,
	shapeResult,
} from "@oh-my-pi/pi-coding-agent/spotlight/shape/index";
import type {
	CallContext,
	Scorer,
	ShapedLines,
	ShapedTool,
	ShapeInput,
	ShapeOutcome,
	ShapeSink,
} from "@oh-my-pi/pi-coding-agent/spotlight/types";
import { rankPartAt, reasonShows } from "@oh-my-pi/pi-tui/chat/spotlight";

function context(over: Partial<CallContext> = {}): CallContext {
	return { task: "Fix the service.", said: "", intent: "", commands: [], source: "", ...over };
}

/** Scores each item with `rank(item)`; `null` makes every call fail. */
function scorer(rank: ((item: string) => number) | null): Scorer & { calls: number } {
	return {
		calls: 0,
		async score(items) {
			this.calls++;
			return rank ? items.map(rank) : null;
		},
	};
}

function sink(): ShapeSink & { saved: Map<string, string> } {
	const saved = new Map<string, string>();
	return {
		saved,
		async save(text: string, _label: ShapedTool) {
			const url = `artifact://${saved.size + 1}`;
			saved.set(url, text);
			return url;
		},
	};
}

function bash(command: string, text: string): ShapeInput {
	return { tool: "bash", command, text, cwd: "/nonexistent" };
}

/** `n` lines of a migration run's output. */
function migrations(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `migration ${i}: added column ledger_${i}_amount`);
}

/**
 * A valve cut's gaps and the saved copy they number lines of: bare `… [A-B]` under the footer, or a compacted view's
 * `… [N lines: read URL:A-B]`, which names the copy itself.
 */
function cutGaps(text: string): { url: string; gaps: { from: number; to: number }[] } {
	const addressed = [...text.matchAll(/^\s*… \[\d+ lines: read (\S+):(\d+)-(\d+)\]$/gm)];
	const url = /^\[cut: (\S+)\]$/m.exec(text)?.[1] ?? addressed[0]?.[1];
	if (!url) throw new Error("a cut names where its hidden lines are");
	const bare = [...text.matchAll(/^\s*… \[(\d+)-(\d+)\](?: \(\d+ commits?: [^)]*\))?$/gm)].map(m => ({
		from: Number(m[1]),
		to: Number(m[2]),
	}));
	return { url, gaps: [...bare, ...addressed.map(m => ({ from: Number(m[2]), to: Number(m[3]) }))] };
}

/** Runs `[first, last]` (1-based) of the lines a trace says the shaped text hides. */
function hiddenRuns(kept: readonly boolean[]): [number, number][] {
	const runs: [number, number][] = [];
	for (let i = 0; i < kept.length; i++) {
		if (kept[i]) continue;
		let j = i;
		while (j + 1 < kept.length && !kept[j + 1]) j++;
		runs.push([i + 1, j + 1]);
		i = j;
	}
	return runs;
}

/**
 * A changed result's line trace, checked against the lines it was shaped from as printed: every reason agrees with
 * what the text shows, every line the map names is that line verbatim, every marker stands for hidden lines only,
 * within one hidden run, and no two markers for the same line.
 */
function traceOf(out: ShapeOutcome, printed: readonly string[]): ShapedLines & { pairs: [number, number][] } {
	const trace = out.lines;
	if (!trace) throw new Error("a changed result traces its lines");
	const shaped = out.text.split("\n");
	expect(trace.kept).toHaveLength(printed.length);
	expect(trace.why).toHaveLength(printed.length);
	expect(trace.map).toHaveLength(shaped.length);
	trace.why.forEach((reason, i) => {
		if (reason !== "-") expect(reasonShows(reason)).toBe(trace.kept[i]);
	});
	const runs = hiddenRuns(trace.kept);
	const pairs: [number, number][] = [];
	trace.map.forEach((entry, k) => {
		if (typeof entry === "number") expect(shaped[k]).toBe(printed[entry - 1]);
		else if (entry) {
			const run = runs.find(([from, to]) => from <= entry[0] && entry[1] <= to);
			expect(run).toBeDefined();
			if (pairs.length) expect(entry[0]).toBeGreaterThan((pairs.at(-1) as [number, number])[1]);
			pairs.push(entry);
		}
	});
	return { ...trace, pairs };
}

describe("spotlight shaping", () => {
	it("outlines a long source read: a body the conversation names stays open, the rest fold to exact file lines", async () => {
		// Ten top-level functions of 20 body lines each, read from file line 41 on.
		const names = ["alphaHandler", "betaHandler", "computeRetryDelay", "deltaHandler", "epsilonHandler"];
		const lines: string[] = [];
		for (let k = 0; k < 10; k++) {
			lines.push(`function ${names[k % 5]}${k}(a) {`);
			for (let j = 0; j < 19; j++) lines.push(`  const v${j} = a * ${j} + ${k};`);
			lines.push("  return a;", "}", "");
		}
		const first = 41;
		const shown = lines.map((l, i) => `${first + i}|${l}`);
		const input: ShapeInput = {
			tool: "read",
			text: `[src/retry.ts#ab12]\n${shown.join("\n")}`,
			read: { path: "src/retry.ts", lines, shown, firstLine: first, selected: true },
			cwd: "/nonexistent",
		};
		const out = await shapeResult(
			input,
			context({ said: "The bug is in computeRetryDelay2, which ignores Retry-After." }),
			scorer(null),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toEqual(["outline"]);
		expect(out.stats.fallbacks).toBe(1);
		const text = out.text.split("\n");
		// The named function (k = 2, file lines 87-109) is shown whole, prefixes kept.
		expect(text).toContain("87|function computeRetryDelay2(a) {");
		expect(text).toContain("106|  const v18 = a * 18 + 2;");
		// Every other body folds to its exact file lines: function k's body is lines 42 + 23k … 61 + 23k.
		for (const k of [0, 1, 3, 9]) expect(text).toContain(`  … [lines ${42 + 23 * k}-${61 + 23 * k}]`);
		expect(text[0]).toBe("[src/retry.ts#ab12]");
	});

	it("keeps the body of a method the intent names, behind a multi-line signature, through an outline's cut", async () => {
		// 120 methods whose signatures span lines: the body block's own header is `): void {`, which names nothing.
		const lines = ["export class Router {"];
		for (let k = 0; k < 120; k++) {
			lines.push(`\thandleRequestNumber${k}(`, "\t\trequest: Request,", "\t\tresponse: Response,", "\t): void {");
			for (let j = 0; j < 6; j++) lines.push(`\t\tconst field${j} = request.body.items[${j}].value * ${k};`);
			lines.push("\t}", "");
		}
		lines.push("}");
		const shown = lines.map((l, i) => `${i + 1}|${l}`);

		const out = await shapeResult(
			{
				tool: "read",
				text: `[src/router.ts#ab12]\n${shown.join("\n")}`,
				read: { path: "src/router.ts", lines, shown, firstLine: 1, selected: false },
				cwd: "/nonexistent",
			},
			context({ intent: "how handleRequestNumber42 builds its fields" }),
			scorer(() => 0.2),
			newShapeState(),
			sink(),
		);

		expect(out.steps).toEqual(["outline", "window"]);
		for (let j = 0; j < 6; j++) expect(out.text).toContain(`const field${j} = request.body.items[${j}].value * 42;`);
	});

	it("cuts a long outlined read in file line numbers only, recovering from the file", async () => {
		// 100 functions of 6 body lines: the outline stays over 12k characters, so the valve cuts it.
		const lines: string[] = [];
		for (let k = 0; k < 100; k++) {
			lines.push(`export function handleRequestNumber${k}(request: Request, response: Response): void {`);
			for (let j = 0; j < 6; j++) lines.push(`  const field${j} = request.body.items[${j}].value * ${k};`);
			lines.push("}", "");
		}
		const shown = lines.map((l, i) => `${i + 1}|${l}`);
		const store = sink();
		const out = await shapeResult(
			{
				tool: "read",
				text: shown.join("\n"),
				read: { path: "src/big.ts", lines, shown, firstLine: 1, selected: false },
				cwd: "/nonexistent",
			},
			context(),
			scorer(item => (item.includes("Number42(") ? 1 : 0.2)),
			newShapeState(),
			store,
		);
		expect(out.steps).toEqual(["outline", "window"]);
		expect(store.saved.size).toBe(0);
		const body = out.text.split("\n");
		// Shown lines, folds and cuts together cover the file's lines 1…n exactly once, in order, with no copy to name.
		let next = 1;
		let cuts = 0;
		for (const l of body) {
			const line = /^(\d+)\|/.exec(l)?.[1];
			const range = line
				? [line, line]
				: (/^\s*… \[lines (\d+)-(\d+)\]$/.exec(l) ?? /^\s*… \[(\d+)-(\d+)\]$/.exec(l))?.slice(1);
			if (!range) throw new Error(`a line that numbers no file line: ${l}`);
			if (/^\s*… \[\d/.test(l)) cuts++;
			expect(Number(range[0])).toBe(next);
			next = Number(range[1]) + 1;
		}
		expect(next).toBe(lines.length + 1);
		expect(cuts).toBeGreaterThan(0);
	});

	it("reports each file line of a cut outline with its Spotlight score and whether the agent was shown it", async () => {
		// The outline scores the file's own lines, the cut its prefixed view; both land on the same window lines.
		const lines: string[] = [];
		for (let k = 0; k < 100; k++) {
			lines.push(`export function handleRequestNumber${k}(request: Request, response: Response): void {`);
			for (let j = 0; j < 6; j++) lines.push(`  const field${j} = request.body.items[${j}].value * ${k};`);
			lines.push("}", "");
		}
		const first = 301;
		const shown = lines.map((l, i) => `${first + i}|${l}`);
		const out = await shapeResult(
			{
				tool: "read",
				text: `[src/big.ts#ab12]\n${shown.join("\n")}`,
				read: { path: "src/big.ts", lines, shown, firstLine: first, selected: false },
				cwd: "/nonexistent",
			},
			context(),
			scorer(item => (item.includes("Number42(") ? 1 : 0.2)),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toEqual(["outline", "window"]);
		const report = out.lines;
		if (!report) throw new Error("a changed read reports its lines");
		expect(report.scores).toHaveLength(lines.length);
		const printed = new Set(out.text.split("\n").map(l => Number(/^(\d+)\|/.exec(l)?.[1])));
		lines.forEach((line, i) => {
			expect(report.kept[i]).toBe(printed.has(first + i));
			if (line.trim()) expect(report.scores[i]).toBe(line.includes("Number42(") ? 1 : 0.2);
		});
		expect(report.kept.filter(Boolean).length).toBeGreaterThan(0);
		expect(report.kept.filter(k => !k).length).toBeGreaterThan(lines.length / 2);
	});

	it("cuts a long result to the top-ranked lines, each gap pointing at its lines in the saved copy", async () => {
		const lines = Array.from({ length: 200 }, (_, i) =>
			i === 120
				? "ERROR worker 7: NEEDLE connection reset by peer"
				: `INFO request ${i} served in ${i % 17} ms by node-${i % 5}`,
		);
		const text = lines.join("\n");
		const store = sink();
		const out = await shapeResult(
			bash("cat logs/worker.log", text),
			context({ intent: "why did worker 7 drop the connection" }),
			scorer(item => (item.includes("NEEDLE") ? 1 : 0.01)),
			newShapeState(),
			store,
		);
		expect(out.steps).toEqual(["window"]);
		expect(out.text.length).toBeLessThan(3_600);
		expect(out.text).toContain("ERROR worker 7: NEEDLE connection reset by peer");
		const { url, gaps } = cutGaps(out.text);
		expect(gaps.length).toBeGreaterThan(0);
		const saved = store.saved.get(url)?.split("\n") ?? [];
		for (const gap of gaps) {
			const hidden = saved.slice(gap.from - 1, gap.to);
			expect(hidden).toEqual(lines.slice(gap.from - 1, gap.to));
			for (const l of hidden) expect(out.text.split("\n")).not.toContain(l);
		}
	});

	it("traces a cut: why each line shows, how the valve ranked them, what each shaped line stands for", async () => {
		const lines = Array.from({ length: 200 }, (_, i) =>
			i === 120
				? "ERROR worker 7: NEEDLE connection reset by peer"
				: `INFO request ${i} ${["served in", "queued for", "parsed in", "routed in", "cached for"][i % 5]} ${i % 17} ms by node-${i % 5}`,
		);
		const out = await shapeResult(
			bash("cat logs/worker.log", lines.join("\n")),
			context({ intent: "why did worker 7 drop the connection" }),
			scorer(item => (item.includes("NEEDLE") ? 1 : 0.01)),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toEqual(["window"]);
		const trace = traceOf(out, lines);
		const why = trace.why.join("");
		// The first three and last four lines are the frame; the error won on its score and brought its neighbours.
		expect(why.slice(0, 3)).toBe("sss");
		expect(why.slice(-4)).toBe("ssss");
		expect(why.slice(119, 122)).toBe("cac");
		expect(why).not.toContain("-");
		trace.kept.forEach((kept, i) => {
			if (!kept) expect(why[i]).toBe("b");
		});
		expect(why).toContain("b");
		// Every hidden run is one marker's, and every marker one run's.
		expect(trace.pairs).toEqual(hiddenRuns(trace.kept));

		const rank = trace.rank;
		if (!rank) throw new Error("a cut traces its ranking");
		expect(rank.parts).toHaveLength(1);
		const score = (i: number) => rankPartAt(rank.values[0], i, rank.max);
		const chosen = [...why].flatMap((r, i) => (r === "a" ? [score(i)] : []));
		expect(rank.cutoff).toBeCloseTo(Math.min(...chosen), 2);
		expect(rank.budget).toBe(3_000);
		expect(rank.used).toBeLessThanOrEqual(rank.budget ?? 0);
		if (!rank.last) throw new Error("a window traces its last pick");
		expect(why[rank.last.line - 1]).toBe("a");
		expect(rank.last.chars).toBeGreaterThan(lines[rank.last.line - 1].length);
	});

	it("traces a hidden line that equals a shown one as hidden, under the marker that names its run", async () => {
		// Line 61 is the same text as line 120, the error's neighbour, which the cut shows right after its first gap.
		// It is longer than the other lines, so the cut's last single-line picks don't show it.
		const warn = "WARN backoff: retrying the upstream request after 250 ms with jitter enabled";
		const lines = Array.from({ length: 200 }, (_, i) =>
			i === 120
				? "ERROR worker 7: NEEDLE connection reset by peer"
				: i === 60 || i === 119
					? warn
					: `INFO request ${i} ${["served in", "queued for", "parsed in", "routed in", "cached for"][i % 5]} ${i % 17} ms by node-${i % 5}`,
		);
		const out = await shapeResult(
			bash("cat logs/worker.log", lines.join("\n")),
			context({ intent: "why did worker 7 drop the connection" }),
			scorer(item => (item.includes("NEEDLE") ? 1 : 0.01)),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toEqual(["window"]);
		const shaped = out.text.split("\n");
		// The warning is shown once, right after the marker that hides its twin.
		expect(shaped.filter(l => l === warn)).toHaveLength(1);
		const after = shaped.indexOf(warn);
		expect(shaped[after - 1]).toMatch(/^… \[\d+-119\]$/);
		const trace = traceOf(out, lines);
		// The marker names its run up to line 119: all of it hidden, line 61 too; the line after it is line 120.
		const pair = trace.map[after - 1];
		if (!Array.isArray(pair)) throw new Error("the marker stands for its run");
		expect(pair[0]).toBeLessThanOrEqual(61);
		expect(pair[1]).toBe(119);
		expect(trace.map.slice(after, after + 2)).toEqual([120, 121]);
		expect(trace.kept[60]).toBe(false);
		expect(trace.why[60]).toBe("b");
		expect(trace.kept[119]).toBe(true);
		expect(trace.why[119]).toBe("c");
		expect(trace.kept.slice(pair[0] - 1, pair[1]).every(k => !k)).toBe(true);
		expect(trace.why).not.toContain("-");
		expect(trace.pairs).toEqual(hiddenRuns(trace.kept));
	});

	it("traces an outline: signatures stay, a named body opens, a hot body opens on rank, the rest fold", async () => {
		// Twelve functions of 20 body lines each, read from file line 41 on: function k's body is window lines
		// 2 + 23k … 21 + 23k. The keep budget (15% of 276 lines) fits the named body and one ranked body.
		const names = ["alphaHandler", "betaHandler", "computeRetryDelay", "deltaHandler", "epsilonHandler"];
		const lines: string[] = [];
		for (let k = 0; k < 12; k++) {
			lines.push(`function ${names[k % 5]}${k}(a) {`);
			for (let j = 0; j < 19; j++) lines.push(`  const v${j} = a * ${j} + ${k};`);
			lines.push("  return a;", "}", "");
		}
		const shown = lines.map((l, i) => `${41 + i}|${l}`);
		const out = await shapeResult(
			{
				tool: "read",
				text: `[src/retry.ts#ab12]\n${shown.join("\n")}`,
				read: { path: "src/retry.ts", lines, shown, firstLine: 41, selected: true },
				cwd: "/nonexistent",
			},
			context({ said: "The bug is in computeRetryDelay2, which ignores Retry-After." }),
			scorer(item => (item.includes("epsilonHandler4") ? 1 : 0.1)),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toEqual(["outline"]);
		const trace = traceOf(out, shown);
		const body = (k: number) => trace.why.slice(1 + 23 * k, 21 + 23 * k).join("");
		expect(trace.why[23 * 2]).toBe("s");
		expect(body(2)).toBe("n".repeat(20));
		expect(body(4)).toBe("a".repeat(20));
		for (const k of [0, 1, 3, 5, 11]) {
			expect(body(k)).toBe("f".repeat(20));
			expect(trace.map).toContainEqual([2 + 23 * k, 21 + 23 * k]);
		}
		expect(trace.why[21]).toBe("s");
		expect(trace.why).not.toContain("-");
		// The header stands for no line of the window.
		expect(trace.map[0]).toBeNull();
		expect(trace.pairs).toEqual(hiddenRuns(trace.kept));

		const rank = trace.rank;
		if (!rank) throw new Error("an outline that opens bodies on rank traces its ranking");
		expect(rank.parts).toHaveLength(1);
		expect(rank.cutoff).toBe(1);
		expect(rankPartAt(rank.values[0], 23 * 4 + 5, rank.max)).toBeCloseTo(1, 2);
		expect(rankPartAt(rank.values[0], 5, rank.max)).toBeCloseTo(0.1, 2);
		expect(rank.last?.line).toBe(23 * 4 + 2);
	});

	it("shows the run around the hottest line of a best body too long for the keep budget, folding the rest", async () => {
		// A class body of eight flat declaration paragraphs (window lines 13-91, 1-based) is the window's best block
		// but outgrows the keep budget (15% of 238 lines); paragraph 2 (lines 33-41) holds the hottest line.
		const lines = Array.from({ length: 10 }, (_, i) => `// header ${i}`);
		lines.push("class Engine {", "public:");
		for (let p = 0; p < 8; p++) {
			for (let j = 0; j < 8; j++) lines.push(`\t/// member ${p} doc ${j}`);
			lines.push(`\tvirtual void member${p}() = 0;`, "");
		}
		lines.push("};", "");
		for (let k = 0; k < 12; k++) {
			lines.push(`void cold${k}() {`);
			for (let j = 0; j < 9; j++) lines.push(`  int v${j} = ${k};`);
			lines.push("}", "");
		}
		const shown = lines.map((l, i) => `${i + 1}|${l}`);
		const out = await shapeResult(
			{
				tool: "read",
				text: `[src/engine.h#ab12]\n${shown.join("\n")}`,
				read: { path: "src/engine.h", lines, shown, firstLine: 1, selected: false },
				cwd: "/nonexistent",
			},
			context(),
			scorer(item => (item.includes("member 2 doc 4") ? 1 : 0.1)),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toEqual(["outline"]);
		const trace = traceOf(out, shown);
		expect(trace.why.slice(32, 41).join("")).toBe("a".repeat(9));
		expect(trace.map).toContainEqual([13, 32]);
		expect(trace.map).toContainEqual([42, 91]);
		expect(trace.rank?.last?.line).toBe(33);
	});

	it("falls back to head + tail when Spotlight does not answer, and still cuts to the budget", async () => {
		const lines = Array.from({ length: 150 }, (_, i) => `row ${String(i).padStart(4, "0")} value=${"x".repeat(40)}`);
		const out = await shapeResult(
			bash("ls -la /data/rows", lines.join("\n")),
			context(),
			scorer(null),
			newShapeState(),
			sink(),
		);
		expect(out.steps).toContain("window");
		expect(out.stats.fallbacks).toBe(1);
		const shown = out.text.split("\n");
		// One contiguous middle run hidden; the head and the tail stay.
		const gaps = shown.filter(l => /^… \[\d+-\d+\]$/.test(l));
		expect(gaps).toHaveLength(1);
		const [, a, b] = /^… \[(\d+)-(\d+)\]$/.exec(gaps[0]) ?? [];
		expect(shown).toContain(lines[0]);
		expect(shown).toContain(lines.at(-1) ?? "");
		expect(shown).toContain(lines[Number(a) - 2]);
		expect(shown).toContain(lines[Number(b)]);
		expect(out.text.length).toBeLessThan(3_600);
	});

	it("leaves the session's shaping state as it was when a cut's saved copy cannot be written", async () => {
		const state = newShapeState();
		const lines = Array.from({ length: 150 }, (_, i) => `row ${String(i).padStart(4, "0")} value=${"x".repeat(40)}`);
		const input = bash("./dump.sh", lines.join("\n"));
		const failing: ShapeSink = {
			async save() {
				throw new Error("session released");
			},
		};
		await expect(shapeResult(input, context(), scorer(null), state, failing)).rejects.toThrow("session released");

		// Had the failed cut recorded what it hid, the same output would now read as a re-ask and come back whole.
		const out = await shapeResult(input, context(), scorer(null), state, sink());

		expect(out.steps).toContain("window");
		expect(out.stats.reasks).toBeUndefined();
	});

	it("drops a reshape that saves fewer than MIN_SAVED_TOKENS: a short run of lines seen before stays whole", async () => {
		const state = newShapeState();
		const first = migrations(5);
		await shapeResult(bash("bin/migrate --dry-run", first.join("\n")), context(), scorer(null), state, sink());
		const input = bash("bin/migrate", ["Applying migrations to staging", ...first, "Done: 5 applied"].join("\n"));
		const collapsed = [
			"Applying migrations to staging",
			"… [5 lines as shown before: read artifact://1:2-6]",
			"Done: 5 applied",
		].join("\n");
		// The collapse would save tokens, just not enough.
		expect(countTokens(collapsed)).toBeLessThan(countTokens(input.text));
		expect(countTokens(input.text) - countTokens(collapsed)).toBeLessThan(MIN_SAVED_TOKENS);

		const store = sink();
		const out = await shapeResult(input, context(), scorer(null), state, store);

		expect(out.text).toBe(input.text);
		expect(out.steps).toEqual(["none"]);
		expect(out.stats.reverted).toBe(1);
		expect(out.outTokens).toBe(out.inTokens);
		expect(out.lines).toBeUndefined();
		// Nothing names a saved copy in the text the agent gets, so none is written.
		expect(store.saved.size).toBe(0);
	});

	it("shapes a read with no file window (a fetched page) as text, but leaves page-backs and skills whole", async () => {
		const page = [
			"URL: https://example.com/changelog",
			"Content-Type: text/html",
			"",
			...Array.from(
				{ length: 150 },
				(_, i) => `- Fixed release ${i}: session restore dropped the provider token ${i * 7}`,
			),
		].join("\n");
		const read = (path: string): ShapeInput => ({ tool: "read", path, text: page, cwd: "/nonexistent" });
		const store = sink();
		const out = await shapeResult(
			read("https://example.com/changelog"),
			context(),
			scorer(() => 0.3),
			newShapeState(),
			store,
		);
		expect(out.steps).toContain("window");
		expect(out.text.length).toBeLessThan(page.length / 2);
		expect([...store.saved.values()]).toContain(page);

		for (const [path, stat] of [
			["artifact://3", "pageBacks"],
			["skill://deploy", "wholeReads"],
		] as const) {
			const kept = await shapeResult(
				read(path),
				context(),
				scorer(() => 0.3),
				newShapeState(),
				sink(),
			);
			expect(kept.text).toBe(page);
			expect(kept.stats[stat]).toBe(1);
		}
	});

	it("collapses a run of lines the agent has already seen into one marker", async () => {
		const state = newShapeState();
		const first = migrations(14);
		await shapeResult(
			bash("bin/migrate --dry-run", first.join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);
		const again = ["Applying migrations to staging", ...first, "Done: 14 applied, 0 failed"];
		const out = await shapeResult(
			bash("bin/migrate", again.join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);
		expect(out.steps).toEqual(["seen"]);
		expect(out.text).toBe(
			[
				"Applying migrations to staging",
				"… [14 lines as shown before: read artifact://1:2-15]",
				"Done: 14 applied, 0 failed",
			].join("\n"),
		);
		// The fourteen lines are hidden as seen before, under the marker; nothing decided on the two around them.
		const trace = traceOf(out, again);
		expect(trace.why.join("")).toBe(`-${"r".repeat(14)}-`);
		expect(trace.map).toEqual([1, [2, 15], 16]);
		expect(trace.rank).toBeUndefined();
	});

	it("collapses seen lines only in the order the agent saw them: a dropped or changed line splits the marker", async () => {
		const state = newShapeState();
		const first = migrations(20);
		await shapeResult(
			bash("bin/migrate --dry-run", [...first.slice(0, 14), "took 41ms", ...first.slice(14)].join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);
		// Migration 6 is gone and the short timing line changed: every long line was seen, but not in this order.
		const again = [
			"Applying migrations to staging",
			...first.slice(0, 6),
			...first.slice(7, 14),
			"took 52ms",
			...first.slice(14),
			"Done: 19 applied, 0 failed",
		];

		const out = await shapeResult(
			bash("bin/migrate", again.join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);

		expect(out.text).toBe(
			[
				"Applying migrations to staging",
				"… [6 lines as shown before: read artifact://1:2-7]",
				"… [7 lines as shown before: read artifact://1:8-14]",
				"took 52ms",
				"… [6 lines as shown before: read artifact://1:16-21]",
				"Done: 19 applied, 0 failed",
			].join("\n"),
		);
	});

	it("keeps the last line of output that repeats an earlier run but stops short of it", async () => {
		const state = newShapeState();
		const first = migrations(30);
		await shapeResult(
			bash("bin/migrate --dry-run", first.join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);
		const store = sink();

		const out = await shapeResult(
			bash("bin/migrate", first.slice(0, 25).join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			store,
		);

		const lines = out.text.split("\n");
		expect(lines[0]).toBe("… [24 lines as shown before: read artifact://1:1-24]");
		expect(lines[1]).toBe(first[24]);
		expect(store.saved.get("artifact://1")?.split("\n").slice(0, 24)).toEqual(first.slice(0, 24));
	});

	it("cuts output repeating one line shape to the lines that differ and its ends, naming the shape it hid", async () => {
		const lines = Array.from({ length: 2000 }, (_, i) =>
			i === 1233 ? "ERROR: db connection refused at step 1234 (ECONNREFUSED)" : `info: step ${i + 1} ok`,
		);

		const out = await shapeResult(
			bash("./steps.sh", lines.join("\n")),
			context({ intent: "why was the db connection refused" }),
			scorer(() => 0.5),
			newShapeState(),
			sink(),
		);

		expect(out.text).toContain(lines[1233]);
		expect(out.text).toContain(lines[1999]);
		expect(out.text).toMatch(
			/^\[uniform: hidden lines: 1,9\d\d match "info: step N ok" \(N: any number\); 1 line differs \(line 1234\), shown\]$/m,
		);
		expect(out.text.length).toBeLessThan(1_000);
	});

	it("keeps a line an intent names by a compound of short parts, such as a gen:rpc script", async () => {
		// Six runners, so the script lines are no few repeated shapes and only the intent can keep gen:rpc.
		const runners = ["bun", "node", "tsc --build", "oxlint", "bunx vitest", "deno run"];
		const scripts = Array.from(
			{ length: 120 },
			(_, i) => `    "task-${i}": "${runners[i % 6]} scripts/task-${i}.ts",`,
		);
		// In the middle, away from the head and tail every cut keeps.
		const text = [
			"{",
			'  "scripts": {',
			...scripts.slice(0, 60),
			'    "gen:rpc": "bun scripts/gen-rpc/index.ts",',
			...scripts.slice(60),
			"  }",
			"}",
		].join("\n");

		const out = await shapeResult(
			bash("cat scripts.txt", text),
			context({ intent: "the gen:rpc script" }),
			scorer(() => 0.2),
			newShapeState(),
			sink(),
		);

		expect(out.text).toContain('"gen:rpc": "bun scripts/gen-rpc/index.ts"');
	});

	it("counts the lines that differ in uniform output by their own shapes", async () => {
		const lines = Array.from({ length: 1500 }, (_, k) => {
			const i = k + 1;
			if (i % 97 === 0) return `WARN cache ${i} evicted early`;
			if (i % 311 === 0) return `ERROR shard ${i % 7} unreachable`;
			return `INFO req ${i} ok in ${i % 40}ms`;
		});

		const out = await shapeResult(
			bash("./serve.sh", lines.join("\n")),
			context(),
			scorer(() => 0.2),
			newShapeState(),
			sink(),
		);

		expect(out.text).toContain(
			'19 lines differ (15 like "WARN cache N evicted early", 4 like "ERROR shard N unreachable"), all shown]',
		);
	});

	it("shows a sub-agent's report and an edit's result whole up to 12k characters, and cuts them past it", async () => {
		const report = (n: number) =>
			Array.from(
				{ length: n },
				(_, i) => `- Step ${i + 1}: the marker at line ${i * 7} named its read, and the follow-up returned it.`,
			).join("\n");
		const shape = (input: ShapeInput) =>
			shapeResult(
				input,
				context(),
				scorer(() => 0.2),
				newShapeState(),
				sink(),
			);
		const agentRun = 'PI_X=1 bun src/cli.ts -p "$(cat probe.md)"';

		for (const input of [
			{ tool: "wait", command: "wait", text: report(80), cwd: "/nonexistent" },
			{ tool: "edit", command: "edit", text: report(80), cwd: "/nonexistent" },
			bash(agentRun, report(80)),
		]) {
			expect((await shape(input)).text).toBe(input.text);
		}
		expect((await shape(bash("./report.sh", report(80)))).text).not.toBe(report(80));
		expect((await shape(bash(agentRun, report(200)))).text).not.toBe(report(200));
	});

	it("keeps a diff whole up to 12k characters and cuts it past it, while a search that size is cut", async () => {
		const matches = (n: number) =>
			Array.from(
				{ length: n },
				(_, i) =>
					`src/temporal/${["instant", "duration", "zoned"][i % 3]}.c:${100 + i * 37}:    tz = ti_tz_find_id(ctx, name_${i});`,
			).join("\n");
		const diff = (n: number) =>
			[
				"diff --git a/quickjs.c b/quickjs.c",
				"--- a/quickjs.c",
				"+++ b/quickjs.c",
				...Array.from({ length: n }, (_, i) =>
					i % 10 === 0
						? `@@ -${i * 9},7 +${i * 9},8 @@ static int two_way_${i}(void)`
						: `${["+", "-", " "][i % 3]}    shift[${i}] = needle_len - ${i};`,
				),
			].join("\n");
		const shape = (command: string, text: string) =>
			shapeResult(
				bash(command, text),
				context(),
				scorer(() => 0.2),
				newShapeState(),
				sink(),
			);

		expect(matches(160).length).toBeGreaterThan(9_000);
		expect((await shape('rg -n "ti_tz_find_id\\(" temporal', matches(160))).text).not.toBe(matches(160));

		expect(diff(260).length).toBeGreaterThan(8_000);
		expect((await shape("git diff master -- quickjs.c", diff(260))).text).toBe(diff(260));
		expect((await shape("git diff master -- quickjs.c", diff(500))).text).not.toBe(diff(500));
	});

	it("shows the signature above a C function's lone opening brace when a cut keeps the brace", async () => {
		const lines: string[] = [];
		for (let k = 0; k < 120; k++) {
			lines.push(`static int tz_rule_${k}(int a, int b)`, "{");
			for (let j = 0; j < 19; j++) lines.push(`    int v${j} = a * ${j} + ${k};`);
			lines.push("    return a;", "}", "");
		}
		const shown = lines.map((l, i) => `${i + 1}|${l}`);

		const out = await shapeResult(
			{
				tool: "read",
				text: `[temporal/timezone.c#ab12]\n${shown.join("\n")}`,
				read: { path: "temporal/timezone.c", lines, shown, firstLine: 1, selected: false },
				cwd: "/nonexistent",
			},
			context(),
			scorer(() => 0.2),
			newShapeState(),
			sink(),
		);

		expect(out.steps).toContain("window");
		const text = out.text.split("\n").map(l => l.replace(/^\d+\|/, ""));
		const braces = text.flatMap((l, i) => (l === "{" ? [i] : []));
		expect(braces.length).toBeGreaterThan(2);
		for (const i of braces) expect(text[i - 1]).toMatch(/^static int tz_rule_\d+\(int a, int b\)$/);
	});

	it("leads a changed command output with its exit status, and leaves an unchanged one as it is", async () => {
		const lines = Array.from({ length: 2000 }, (_, i) => `info: step ${i + 1} ok`);

		const cut = await shapeResult(
			{ ...bash("./steps.sh", lines.join("\n")), exitCode: 3 },
			context(),
			scorer(() => 0.5),
			newShapeState(),
			sink(),
		);
		const short = await shapeResult(
			{ ...bash("./steps.sh", "done"), exitCode: 3 },
			context(),
			scorer(() => 0.5),
			newShapeState(),
			sink(),
		);

		expect(cut.text.split("\n")[0]).toBe("[exit code 3]");
		expect(short.text).toBe("done");
	});

	it("shows the commit header of a git log line the cut keeps", async () => {
		const commits = Array.from({ length: 15 }, (_, c) => [
			`commit ${String(c).padStart(2, "0")}${"a".repeat(38)}`,
			`Author: dev${c} <dev${c}@example.com>`,
			`Date:   Mon Nov ${c + 1} 10:00:00 2026 +0100`,
			"",
			`    change ${c}`,
			"",
			...Array.from({ length: 12 }, (_, f) => ` src/area${c}/file${f}.ts | ${f + 3} ++--`),
			` 12 files changed, ${c * 7} insertions(+), ${c} deletions(-)`,
			"",
		]);
		const text = commits.flat().join("\n");

		const out = await shapeResult(
			bash("git log --stat -n 15", text),
			context({ intent: "which commit changed src/area7/file4.ts" }),
			scorer(item => (item.includes("area7/file4.ts") ? 1 : 0.01)),
			newShapeState(),
			sink(),
		);

		const shown = out.text.split("\n");
		expect(shown).toContain(" src/area7/file4.ts | 7 ++--");
		expect(shown).toContain(commits[7][0]);
		expect(shown).toContain(commits[7][1]);
		expect(shown).toContain(commits[7][4]);
		expect(shown).toContain(commits[7][18]);
		// A gap hiding whole commits says how many and which.
		expect(out.text).toMatch(/^… \[\d+-\d+\] \(\d+ commits: \d\da{5}(?:, \d\da{5})*(?:, …)?\)$/m);
	});

	it("points a collapse at the run's own artifact when it numbers the same lines, saving no copy", async () => {
		const state = newShapeState();
		const first = migrations(30);
		await shapeResult(
			bash("bin/migrate --dry-run", first.join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);
		const again = ["Applying migrations to staging", ...first, "Done: 30 applied, 0 failed"];
		const store = sink();

		const out = await shapeResult(
			{ ...bash("bin/migrate", again.join("\n")), artifact: "artifact://42" },
			context(),
			scorer(() => 0.5),
			state,
			store,
		);

		expect(out.text.split("\n")[1]).toBe("… [30 lines as shown before: read artifact://42:2-31]");
		expect(store.saved.size).toBe(0);
	});

	it("collapses seen lines the call's intent names: they are in the agent's context already", async () => {
		const first = migrations(30);
		const again = ["Applying migrations to staging", ...first, "Done: 30 applied, 0 failed"];
		const state = newShapeState();
		await shapeResult(
			bash("bin/migrate --dry-run", first.join("\n")),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);

		const out = await shapeResult(
			bash("bin/migrate", again.join("\n")),
			context({ intent: "which migration added ledger_5_amount" }),
			scorer(() => 0.5),
			state,
			sink(),
		);

		expect(out.text.split("\n")).toEqual([
			"Applying migrations to staging",
			"… [30 lines as shown before: read artifact://1:2-31]",
			"Done: 30 applied, 0 failed",
		]);
	});

	it("numbers the short rows a cut hid as a gap, never as shown before, when nothing was shown yet", async () => {
		const items = Array.from({ length: 400 }, (_, i) => ({
			id: i,
			name: `item${i}`,
			flag: i === 317 ? "on_hold" : "ok",
		}));

		const out = await shapeResult(
			bash("./orders.sh", JSON.stringify({ items })),
			context({ intent: "which order is on hold" }),
			scorer(item => (item.includes("on_hold") ? 1 : 0.05)),
			newShapeState(),
			sink(),
		);

		expect(out.text).toContain("317|item317|on_hold");
		expect(out.text).not.toContain("as shown before");
		expect(cutGaps(out.text).gaps.length).toBeGreaterThan(0);
	});

	it("leaves a source read and an ASCII picture whole, but cuts command output of the same size", async () => {
		const code = Array.from(
			{ length: 120 },
			(_, i) => `    total_${i} = compute_partial(rows[${i}], weights, offset=${i})  # step ${i}`,
		);
		const shown = code.map((l, i) => `${i + 1}|${l}`);
		const read: ShapeInput = {
			tool: "read",
			text: shown.join("\n"),
			read: { path: "pkg/agg.py", lines: code, shown, firstLine: 1, selected: true },
			cwd: "/nonexistent",
		};
		const rank = scorer(() => 0.3);
		const whole = await shapeResult(read, context(), rank, newShapeState(), sink());
		expect(whole.text).toBe(read.text);
		expect(whole.steps).toEqual(["none"]);

		const grid = Array.from({ length: 60 }, (_, r) =>
			Array.from({ length: 80 }, (_, c) => ((r * 7 + c * 3) % 11 < 4 ? "#" : ".")).join(""),
		).join("\n");
		const picture = await shapeResult(bash("./render --ascii", grid), context(), rank, newShapeState(), sink());
		expect(picture.text).toBe(grid);

		const listing = await shapeResult(bash("ls -R pkg", code.join("\n")), context(), rank, newShapeState(), sink());
		expect(listing.steps).toContain("window");
		expect(listing.text.length).toBeLessThan(code.join("\n").length / 2);
	});

	it("shows a re-ask of lines a cut hid whole", async () => {
		const state = newShapeState();
		const lines = Array.from(
			{ length: 300 },
			(_, i) =>
				`2026-10-29T10:${String(i % 60).padStart(2, "0")} job-${i} finished status=${["ok", "retried", "skipped", "deferred", "merged"][i % 5]}`,
		);
		const first = await shapeResult(
			bash("cat logs/jobs.log", lines.join("\n")),
			context(),
			scorer(item => (item.includes("job-1 ") ? 1 : 0)),
			state,
			sink(),
		);
		expect(first.steps).toEqual(["window"]);
		const [gap] = cutGaps(first.text).gaps.sort((a, b) => b.to - b.from - (a.to - a.from));
		const reask = lines.slice(gap.from - 1, gap.to).join("\n");
		expect(reask.length).toBeGreaterThan(3_900);
		const out = await shapeResult(
			bash(`sed -n '${gap.from},${gap.to}p' logs/jobs.log`, reask),
			context(),
			scorer(() => 0.5),
			state,
			sink(),
		);
		expect(out.text).toBe(reask);
		expect(out.stats.reasks).toBe(1);
	});

	it("cuts a test run to its failures and summary, gaps pointing into the saved log", async () => {
		const log = [
			"============================= test session starts ==============================",
			...Array.from({ length: 80 }, (_, i) => `tests/test_api.py::test_case_${i} PASSED`),
			"=================================== FAILURES ===================================",
			"_____________________________ test_retry_after _______________________________",
			"    def test_retry_after():",
			">       assert delay(429, {'Retry-After': '3'}) == 3",
			"E       AssertionError: assert 1 == 3",
			"tests/test_api.py:42: AssertionError",
			"=========================== short test summary info ============================",
			"FAILED tests/test_api.py::test_retry_after - AssertionError: assert 1 == 3",
			"========================= 1 failed, 80 passed in 2.31s =========================",
		].join("\n");
		const store = sink();
		const out = await shapeResult(
			bash("pytest -q tests", log),
			context(),
			scorer(() => 0.5),
			newShapeState(),
			store,
		);
		expect(out.steps).toEqual(["tests"]);
		expect(out.text).toContain("E       AssertionError: assert 1 == 3");
		expect(out.text).toContain("FAILED tests/test_api.py::test_retry_after - AssertionError: assert 1 == 3");
		expect(out.text).toContain("========================= 1 failed, 80 passed in 2.31s =========================");
		const gap = /… \[(\d+) lines: read (artifact:\/\/\d+):(\d+)-(\d+)\]/.exec(out.text);
		expect(gap).not.toBeNull();
		const [, count, url, a, b] = gap ?? [];
		const hidden = (store.saved.get(url) ?? "").split("\n").slice(Number(a) - 1, Number(b));
		expect(hidden).toHaveLength(Number(count));
		expect(hidden.every(l => l.endsWith(" PASSED"))).toBe(true);
	});

	it("compacts a JSON dump to a table and cuts it, hidden rows readable from the saved view", async () => {
		const records = Array.from({ length: 400 }, (_, i) => ({
			id: i,
			sku: `SKU-${i}`,
			status: i === 377 ? "on_hold" : "released",
			qty: i * 3,
		}));
		const store = sink();
		const out = await shapeResult(
			bash("python3 dump_orders.py", JSON.stringify(records, null, 2)),
			context({ intent: "which orders are on hold" }),
			scorer(item => (item.includes("on_hold") ? 1 : 0.05)),
			newShapeState(),
			store,
		);
		expect(out.steps).toEqual(["dump", "window"]);
		expect(out.text).toContain("(400 rows) id|sku|status|qty");
		expect(out.text).toContain("377|SKU-377|on_hold|1131");
		const { url, gaps } = cutGaps(out.text);
		const saved = (store.saved.get(url) ?? "").split("\n");
		const header = saved.indexOf("(400 rows) id|sku|status|qty");
		expect(saved.slice(header + 1, header + 401)).toEqual(records.map(r => `${r.id}|${r.sku}|${r.status}|${r.qty}`));
		expect(gaps.length).toBeGreaterThan(0);
		// Rows begin with ids: every gap names its read, so none reads as a number in the data.
		expect(out.text).not.toMatch(/^\s*… \[\d+-\d+\]$/m);
		// The table's header sits outside the run of rows: it is not one of the lines that differ.
		expect(out.text).toMatch(/1 line differs \(line \d+\), shown\]/);
		const shown = out.text.split("\n");
		for (const gap of gaps) for (const row of saved.slice(gap.from - 1, gap.to)) expect(shown).not.toContain(row);
	});
});
