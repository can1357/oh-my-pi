import { afterAll, beforeAll, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");
// Each case spawns the CLI, which loads the harness and Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

let tmp: string;
beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-diff-"));
});
afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

interface FakeResult {
	engine?: string;
	protocol?: string;
	k?: number;
	revision?: string;
	/** Engine options as `run` records them in the config. */
	options?: { mnemopiRecall?: string; polyphonic?: boolean };
	engineInfo?: Record<string, string>;
	/**
	 * Per question: id (`<caseId>:...` names its case), the recall@10 value (null is what JSON makes of NaN) and
	 * overrides of its case, category (`cat`) and definition hash (absent, as in older files).
	 */
	questions?: [string, number | null, { caseId?: string; category?: string; definitionHash?: string }?][];
}

/** Writes the part of a result file that `diff` reads. */
async function writeResult(
	name: string,
	{
		engine = "oracle",
		protocol = "standard",
		k = 10,
		revision = "rev",
		options = { mnemopiRecall: "recall", polyphonic: false },
		engineInfo = {},
		questions = [["q1", 1]],
	}: FakeResult,
) {
	const file = path.join(tmp, `${name}.json`);
	await Bun.write(
		file,
		JSON.stringify({
			config: {
				dataset: "beam-100k",
				datasetRevision: revision,
				engine,
				engineInfo,
				protocol,
				k,
				gitCommit: "abc",
				...options,
			},
			questions: questions.map(([questionId, recall, overrides]) => ({
				caseId: questionId.split(":")[0],
				questionId,
				category: "cat",
				ranked: [],
				metrics: { "recall@10": recall },
				...overrides,
			})),
		}),
	);
	return file;
}

async function diff(a: string, b: string): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn([process.execPath, RUN, "diff", a, b], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

it("diff prints both configs and compares matching results", async () => {
	const a = await writeResult("ok-a", {
		questions: [
			["c1:q1", 0],
			["c1:q2", 1],
			["c2:q3", 1],
		],
	});
	const b = await writeResult("ok-b", {
		questions: [
			["c1:q2", 1],
			["c2:q3", 1],
			["c1:q1", 1],
		],
	});
	const { stdout, code } = await diff(a, b);
	expect(code).toBe(0);
	expect(stdout).toContain(
		"a: engine oracle protocol standard k 10 mnemopiRecall recall polyphonic false gitCommit abc",
	);
	expect(stdout).toContain(
		"b: engine oracle protocol standard k 10 mnemopiRecall recall polyphonic false gitCommit abc",
	);
	// The bootstrap resamples cases: the output names how many questions and cases it covered.
	expect(stdout).toContain("recall@10 overall (b - a, n=3, cases=2): meanDiff 0.3333");
	expect(stdout).toContain("  cat (n=3, cases=2): ");
});

it("diff resamples cases, not questions: correlated questions do not make a win significant", async () => {
	// 10 cases of 10 questions; every question of a case moves the same way: b wins 7 cases and loses 3.
	// Resampling the 100 questions would put the interval above 0 and print "helps".
	const ids = Array.from({ length: 100 }, (_, i) => `c${Math.floor(i / 10)}:q${i}`);
	const wins = (id: string): boolean => Number(id.slice(1, id.indexOf(":"))) < 7;
	const a = await writeResult("cluster-a", { questions: ids.map(id => [id, wins(id) ? 0 : 1]) });
	const b = await writeResult("cluster-b", { questions: ids.map(id => [id, wins(id) ? 1 : 0]) });
	const { stdout, code } = await diff(a, b);
	expect(code).toBe(0);
	expect(stdout).toContain("recall@10 overall (b - a, n=100, cases=10): meanDiff 0.4000 CI [-0.2000, 1.0000]");
	expect(stdout).toContain("  cat (n=100, cases=10): meanDiff 0.4000 CI [-0.2000, 1.0000]");
	expect(stdout).toContain("verdict: neutral");
});

it("diff over a single case prints no interval and insufficient data", async () => {
	const ids = ["c1:q1", "c1:q2", "c1:q3"];
	const a = await writeResult("single-a", { questions: ids.map(id => [id, 0]) });
	const b = await writeResult("single-b", { questions: ids.map(id => [id, 1]) });
	const { stdout, code } = await diff(a, b);
	expect(code).toBe(0);
	expect(stdout).toContain("recall@10 overall (b - a, n=3, cases=1): meanDiff 1.0000 CI n/a (fewer than 2 cases)");
	expect(stdout).toContain("verdict: insufficient data");
});

it("diff rejects results run under different protocols", async () => {
	const a = await writeResult("proto-a", { protocol: "standard" });
	const b = await writeResult("proto-b", { protocol: "fts-only" });
	const { stdout, stderr, code } = await diff(a, b);
	expect(code).toBe(1);
	expect(stderr).toContain("protocol differs: standard vs fts-only");
	expect(stdout).toContain("b: engine oracle protocol fts-only k 10");
});

it("diff rejects results run with different k", async () => {
	const a = await writeResult("k-a", { k: 10 });
	const b = await writeResult("k-b", { k: 50 });
	const { stderr, code } = await diff(a, b);
	expect(code).toBe(1);
	expect(stderr).toContain("k differs: 10 vs 50");
});

it("diff rejects results from different dataset revisions", async () => {
	const a = await writeResult("rev-a", { revision: "r1" });
	const b = await writeResult("rev-b", { revision: "r2" });
	const { stderr, code } = await diff(a, b);
	expect(code).toBe(1);
	expect(stderr).toContain("datasetRevision differs: r1 vs r2");
});

it("diff compares runs whose engine options differ, naming both configurations", async () => {
	const plain = await writeResult("opt-plain", { engine: "mnemopi" });
	const poly = await writeResult("opt-poly", {
		engine: "mnemopi",
		options: { mnemopiRecall: "recall", polyphonic: true },
	});
	const enhanced = await writeResult("opt-enh", {
		engine: "mnemopi",
		options: { mnemopiRecall: "enhanced", polyphonic: false },
	});
	const mnemosynePoly = await writeResult("opt-msy", {
		engine: "mnemosyne",
		options: { mnemopiRecall: "recall", polyphonic: true },
	});
	// An ablation of one engine (polyphonic off vs on, recall vs enhanced) is a valid paired comparison.
	const polyphonic = await diff(plain, poly);
	expect(polyphonic.code).toBe(0);
	expect(polyphonic.stdout).toContain("b: engine mnemopi protocol standard k 10 mnemopiRecall recall polyphonic true");
	expect(polyphonic.stdout).toContain("recall@10 overall");
	const recallPath = await diff(plain, enhanced);
	expect(recallPath.code).toBe(0);
	expect(recallPath.stdout).toContain(
		"b: engine mnemopi protocol standard k 10 mnemopiRecall enhanced polyphonic false",
	);
	const across = await diff(enhanced, mnemosynePoly);
	expect(across.code).toBe(0);
	expect(across.stdout).toContain("a: engine mnemopi protocol standard k 10 mnemopiRecall enhanced polyphonic false");
	expect(across.stdout).toContain("b: engine mnemosyne protocol standard k 10 mnemopiRecall recall polyphonic true");
});

it("diff warns that with-sleep recall is not comparable across engines", async () => {
	const mnemopi = await writeResult("sleep-mnemopi", { engine: "mnemopi", protocol: "with-sleep" });
	const mnemosyne = await writeResult("sleep-mnemosyne", { engine: "mnemosyne", protocol: "with-sleep" });
	const across = await diff(mnemopi, mnemosyne);
	expect(across.code).toBe(0);
	expect(across.stderr).toContain("warning: with-sleep credits a summary hit with every message it covers");
	const same = await diff(mnemopi, mnemopi);
	expect(same.code).toBe(0);
	expect(same.stderr).not.toContain("with-sleep");
	const standard = await diff(
		await writeResult("standard-mnemopi", { engine: "mnemopi" }),
		await writeResult("standard-mnemosyne", { engine: "mnemosyne" }),
	);
	expect(standard.stderr).not.toContain("with-sleep");
});

it("diff rejects upstream-compat results", async () => {
	const a = await writeResult("compat-a", { protocol: "upstream-compat" });
	const b = await writeResult("compat-b", { protocol: "upstream-compat" });
	const { stderr, code } = await diff(a, b);
	expect(code).toBe(1);
	expect(stderr).toContain("upstream-compat results have no primary metric");
});

it("diff rejects duplicate question ids and differing question sets", async () => {
	const ok = await writeResult("set-ok", {
		questions: [
			["q1", 1],
			["q2", 1],
		],
	});
	const dup = await writeResult("set-dup", {
		questions: [
			["q1", 1],
			["q1", 1],
		],
	});
	const other = await writeResult("set-other", {
		questions: [
			["q1", 1],
			["q3", 1],
		],
	});
	expect((await diff(ok, dup)).stderr).toContain("b: duplicate question id q1");
	expect((await diff(dup, ok)).stderr).toContain("a: duplicate question id q1");
	const mismatch = await diff(ok, other);
	expect(mismatch.code).toBe(1);
	expect(mismatch.stderr).toContain("question sets differ");
});

it("diff names the first question without a finite primary metric", async () => {
	const ok = await writeResult("nan-ok", {
		questions: [
			["q1", 1],
			["q2", 0],
		],
	});
	const bad = await writeResult("nan-bad", {
		questions: [
			["q1", 1],
			["q2", null],
		],
	});
	const { stderr, code } = await diff(ok, bad);
	expect(code).toBe(1);
	expect(stderr).toContain("b: question q2 has no finite recall@10");
});

it("diff rejects a question whose case or category differs between the files, in either order", async () => {
	const ok = await writeResult("label-ok", {
		questions: [
			["c1:q1", 1],
			["c2:q2", 0],
		],
	});
	const moved = await writeResult("label-case", {
		questions: [
			["c1:q1", 1],
			["c2:q2", 0, { caseId: "c1" }],
		],
	});
	const recategorised = await writeResult("label-category", {
		questions: [
			["c1:q1", 1, { category: "other" }],
			["c2:q2", 0],
		],
	});
	for (const [a, b] of [
		[ok, moved],
		[moved, ok],
	]) {
		const { stderr, code } = await diff(a, b);
		expect(code).toBe(1);
		expect(stderr).toContain("question c2:q2 is in case");
	}
	expect((await diff(ok, moved)).stderr).toContain("question c2:q2 is in case c2 in a but c1 in b");
	for (const [a, b] of [
		[ok, recategorised],
		[recategorised, ok],
	]) {
		const { stderr, code } = await diff(a, b);
		expect(code).toBe(1);
		expect(stderr).toContain("question c1:q1 has category");
	}
	expect((await diff(ok, recategorised)).stderr).toContain("question c1:q1 has category cat in a but other in b");
});

it("diff rejects a question whose query text or gold set changed, in either order", async () => {
	const v1 = await writeResult("def-1", { questions: [["c1:q1", 1, { definitionHash: "aa" }]] });
	const v2 = await writeResult("def-2", { questions: [["c1:q1", 1, { definitionHash: "bb" }]] });
	for (const [a, b] of [
		[v1, v2],
		[v2, v1],
	]) {
		const { stderr, code } = await diff(a, b);
		expect(code).toBe(1);
		expect(stderr).toContain("question c1:q1 has a different query text or gold set in a and b");
	}
	const same = await diff(v1, v1);
	expect(same.code).toBe(0);
	expect(same.stderr).not.toContain("not verified");
});

it("diff accepts a file without question fingerprints and warns that definitions were not verified", async () => {
	const current = await writeResult("def-current", { questions: [["c1:q1", 1, { definitionHash: "aa" }]] });
	const legacy = await writeResult("def-legacy", { questions: [["c1:q1", 1]] });
	for (const [a, b] of [
		[current, legacy],
		[legacy, current],
	]) {
		const { stderr, code } = await diff(a, b);
		expect(code).toBe(0);
		expect(stderr).toContain("query text and gold sets were not verified");
	}
});

it("diff names each side's Mnemopi embedder when the config records one", async () => {
	const js = await writeResult("emb-js", { engine: "mnemopi", engineInfo: { embedder: "js" } });
	const python = await writeResult("emb-py", { engine: "mnemopi", engineInfo: { embedder: "python" } });
	const oracle = await writeResult("emb-none", {});
	const { stdout, code } = await diff(js, python);
	expect(code).toBe(0);
	expect(stdout).toContain("a: engine mnemopi embedder js protocol standard");
	expect(stdout).toContain("b: engine mnemopi embedder python protocol standard");
	expect((await diff(oracle, oracle)).stdout).toContain("a: engine oracle protocol standard");
});
