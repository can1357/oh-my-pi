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
	protocol?: string;
	k?: number;
	revision?: string;
	/** Per question: id (`<caseId>:...` names its case) and the recall@10 value (null is what JSON makes of NaN). */
	questions?: [string, number | null][];
}

/** Writes the part of a result file that `diff` reads. */
async function writeResult(
	name: string,
	{ protocol = "standard", k = 10, revision = "rev", questions = [["q1", 1]] }: FakeResult,
) {
	const file = path.join(tmp, `${name}.json`);
	await Bun.write(
		file,
		JSON.stringify({
			config: { dataset: "beam-100k", datasetRevision: revision, engine: "oracle", protocol, k, gitCommit: "abc" },
			questions: questions.map(([questionId, recall]) => ({
				caseId: questionId.split(":")[0],
				questionId,
				category: "cat",
				ranked: [],
				metrics: { "recall@10": recall },
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
	expect(stdout).toContain("a: engine oracle protocol standard k 10 gitCommit abc");
	expect(stdout).toContain("b: engine oracle protocol standard k 10 gitCommit abc");
	// The bootstrap resamples cases: the output names how many questions and cases it covered.
	expect(stdout).toContain("recall@10 overall (b - a, n=3, cases=2): meanDiff 0.3333");
	expect(stdout).toContain("  cat (n=3, cases=2): ");
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
