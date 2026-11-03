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

/** A valve cut's gaps `… [A-B]` and the saved copy its footer says they number lines of. */
function cutGaps(text: string): { url: string; gaps: { from: number; to: number }[] } {
	const url = /^\[cut: A-B in a … marker are lines A-B of (\S+) \(read /m.exec(text)?.[1];
	if (!url) throw new Error("a cut names where its hidden lines are");
	const gaps = [...text.matchAll(/^\s*… \[(\d+)-(\d+)\]$/gm)].map(m => ({ from: Number(m[1]), to: Number(m[2]) }));
	return { url, gaps };
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
		expect(text.at(-1)).toBe("[folded: read src/retry.ts:A-B prints a shown range]");
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
		expect(body.at(-1)).toBe("[cut: A-B in a … marker are lines A-B of src/big.ts (read src/big.ts:A-B)]");
		// Shown lines, folds and cuts together cover the file's lines 1…n exactly once, in order.
		let next = 1;
		let cuts = 0;
		for (const l of body) {
			const line = /^(\d+)\|/.exec(l)?.[1];
			const range = line
				? [line, line]
				: (/^\s*… \[lines (\d+)-(\d+)\]$/.exec(l) ?? /^\s*… \[(\d+)-(\d+)\]$/.exec(l))?.slice(1);
			if (!range) {
				expect(l).toMatch(/^\[(folded|cut): /);
				continue;
			}
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
				: `INFO request ${i} served in ${i % 17} ms by node-${i % 5}`,
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
					: `INFO request ${i} served in ${i % 17} ms by node-${i % 5}`,
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
		// Ten functions of 20 body lines each, read from file line 41 on: function k's body is window lines
		// 2 + 23k … 21 + 23k.
		const names = ["alphaHandler", "betaHandler", "computeRetryDelay", "deltaHandler", "epsilonHandler"];
		const lines: string[] = [];
		for (let k = 0; k < 10; k++) {
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
		for (const k of [0, 1, 3, 5, 9]) {
			expect(body(k)).toBe("f".repeat(20));
			expect(trace.map).toContainEqual([2 + 23 * k, 21 + 23 * k]);
		}
		expect(trace.why[21]).toBe("s");
		expect(trace.why).not.toContain("-");
		// The header and the fold note stand for no line of the window.
		expect(trace.map[0]).toBeNull();
		expect(trace.map.at(-1)).toBeNull();
		expect(trace.pairs).toEqual(hiddenRuns(trace.kept));

		const rank = trace.rank;
		if (!rank) throw new Error("an outline that opens bodies on rank traces its ranking");
		expect(rank.parts).toHaveLength(1);
		expect(rank.cutoff).toBe(1);
		expect(rankPartAt(rank.values[0], 23 * 4 + 5, rank.max)).toBeCloseTo(1, 2);
		expect(rankPartAt(rank.values[0], 5, rank.max)).toBeCloseTo(0.1, 2);
		expect(rank.last?.line).toBe(23 * 4 + 2);
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

	it("drops a reshape that saves fewer than MIN_SAVED_TOKENS: a short run of lines seen before stays whole", async () => {
		const state = newShapeState();
		const first = migrations(5);
		await shapeResult(bash("bin/migrate --dry-run", first.join("\n")), context(), scorer(null), state, sink());
		const input = bash("bin/migrate", ["Applying migrations to staging", ...first, "Done: 5 applied"].join("\n"));
		const collapsed = [
			"Applying migrations to staging",
			"… [5 lines as shown before: 2-6]",
			"Done: 5 applied",
			"[cut: A-B in a … marker are lines A-B of artifact://1 (read artifact://1:A-B)]",
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
				"… [14 lines as shown before: 2-15]",
				"Done: 14 applied, 0 failed",
				"[cut: A-B in a … marker are lines A-B of artifact://1 (read artifact://1:A-B)]",
			].join("\n"),
		);
		// The fourteen lines are hidden as seen before, under the marker; nothing decided on the two around them.
		const trace = traceOf(out, again);
		expect(trace.why.join("")).toBe(`-${"r".repeat(14)}-`);
		expect(trace.map).toEqual([1, [2, 15], 16, null]);
		expect(trace.rank).toBeUndefined();
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
		expect(lines[0]).toBe("… [24 lines as shown before: 1-24]");
		expect(lines[1]).toBe(first[24]);
		expect(store.saved.get("artifact://1")?.split("\n").slice(0, 24)).toEqual(first.slice(0, 24));
	});

	it("shows a seen line the call's intent names, and still collapses lines a generic intent word names", async () => {
		const first = migrations(30);
		const again = ["Applying migrations to staging", ...first, "Done: 30 applied, 0 failed"];
		const shape = async (intent: string) => {
			const state = newShapeState();
			await shapeResult(
				bash("bin/migrate --dry-run", first.join("\n")),
				context(),
				scorer(() => 0.5),
				state,
				sink(),
			);
			return shapeResult(
				bash("bin/migrate", again.join("\n")),
				context({ intent }),
				scorer(() => 0.5),
				state,
				sink(),
			);
		};

		const named = await shape("which migration added ledger_5_amount");
		const generic = await shape("did every migration apply");

		expect(named.text.split("\n").slice(0, 4)).toEqual([
			"Applying migrations to staging",
			"… [5 lines as shown before: 2-6]",
			first[5],
			"… [24 lines as shown before: 8-31]",
		]);
		expect(generic.text).not.toContain(first[5]);
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
			(_, i) => `2026-10-29T10:${String(i % 60).padStart(2, "0")} job-${i} finished status=ok`,
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
		const shown = out.text.split("\n");
		for (const gap of gaps) for (const row of saved.slice(gap.from - 1, gap.to)) expect(shown).not.toContain(row);
	});
});
