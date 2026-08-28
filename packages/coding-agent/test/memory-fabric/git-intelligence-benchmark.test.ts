import { describe, expect, it } from "bun:test";

import type { GitCommitRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/git-intelligence";
import {
	formatBenchmarkSummary,
	runHeldOutBenchmark,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/git-intelligence-benchmark";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

function iso(daysAgo: number): string {
	return new Date(NOW - daysAgo * DAY_MS).toISOString();
}

let shaSeq = 0;

function mkCommit(daysAgo: number, paths: string[], overrides: Partial<GitCommitRecord> = {}): GitCommitRecord {
	const at = iso(daysAgo);
	return {
		sha: `sha_${(shaSeq++).toString(36).padStart(4, "0")}`,
		parentIds: ["parent"],
		authoredAt: at,
		committedAt: at,
		authorName: "alice",
		authorEmail: "alice@example.com",
		subject: `change ${paths.length} files`,
		files: paths.map(path => ({ path, status: "modified" as const, additions: 3, deletions: 1, binary: false })),
		isMerge: false,
		isRevert: false,
		...overrides,
	};
}

/** 10 older training commits where a.ts and b.ts always co-change, then recent repeats. */
function coupledHistory(): GitCommitRecord[] {
	const commits: GitCommitRecord[] = [];
	for (let i = 0; i < 10; i++) {
		commits.push(mkCommit(60 - i, ["src/a.ts", "src/b.ts"]));
	}
	commits.push(mkCommit(2, ["src/a.ts", "src/b.ts"]));
	commits.push(mkCommit(1, ["src/a.ts", "src/b.ts"]));
	return commits;
}

describe("runHeldOutBenchmark", () => {
	it("returns an inert observe summary for empty history", () => {
		const summary = runHeldOutBenchmark([]);
		expect(summary.mode).toBe("observe");
		expect(summary.sampleCount).toBe(0);
		expect(summary.skipped).toBe(0);
		expect(summary.samples).toEqual([]);
	});

	it("predicts a strongly coupled partner with perfect precision and recall", () => {
		const summary = runHeldOutBenchmark(coupledHistory(), { holdOut: 2, topK: 3 });
		expect(summary.sampleCount).toBe(2);
		expect(summary.skipped).toBe(0);
		expect(summary.meanPrecision).toBe(1);
		expect(summary.meanRecall).toBe(1);
		const sample = summary.samples[0];
		expect(sample?.queryPath).toBe("src/a.ts");
		expect(sample?.truePositives).toBe(1);
	});

	it("never trains on the evaluated commit or later ones", () => {
		// The pairing exists ONLY in the held-out commits; training history has
		// no co-change signal for it, so an honest benchmark predicts nothing.
		const commits: GitCommitRecord[] = [];
		for (let i = 0; i < 8; i++) {
			commits.push(mkCommit(60 - i, [`src/solo-${i}.ts`, "src/other.ts"]));
		}
		commits.push(mkCommit(1, ["src/x.ts", "src/y.ts"]));
		const summary = runHeldOutBenchmark(commits, { holdOut: 1, topK: 3 });
		expect(summary.sampleCount).toBe(0);
		expect(summary.skipped).toBe(1);
	});

	it("skips merges, small commits, and cold starts instead of padding zeros", () => {
		const commits = [
			...coupledHistory(),
			mkCommit(0.5, ["src/a.ts", "src/b.ts"], { isMerge: true, parentIds: ["p1", "p2"] }),
			mkCommit(0.25, ["src/a.ts"]),
		];
		const summary = runHeldOutBenchmark(commits, { holdOut: 4, topK: 3 });
		expect(summary.sampleCount).toBe(2);
		expect(summary.skipped).toBe(2);
	});

	it("requires minimum training history before counting a sample", () => {
		const commits = [mkCommit(3, ["src/a.ts", "src/b.ts"]), mkCommit(2, ["src/a.ts", "src/b.ts"])];
		const summary = runHeldOutBenchmark(commits, { holdOut: 2, minTraining: 5 });
		expect(summary.sampleCount).toBe(0);
		expect(summary.skipped).toBe(2);
	});

	it("ignores binary files when picking queries and ground truth", () => {
		const history = coupledHistory();
		const last = history[history.length - 1];
		last?.files.push({ path: "assets/logo.png", status: "modified", additions: 0, deletions: 0, binary: true });
		const summary = runHeldOutBenchmark(history, { holdOut: 1, topK: 3 });
		expect(summary.sampleCount).toBe(1);
		expect(summary.samples[0]?.actual).toHaveLength(1);
	});

	it("fails open on malformed input instead of throwing", () => {
		const junk = [null, 42, { sha: 1 }] as unknown as GitCommitRecord[];
		const summary = runHeldOutBenchmark(junk);
		expect(summary.mode).toBe("observe");
		expect(summary.sampleCount).toBe(0);
	});

	it("does not mutate the input array", () => {
		const commits = coupledHistory();
		const before = JSON.stringify(commits);
		runHeldOutBenchmark(commits, { holdOut: 2 });
		expect(JSON.stringify(commits)).toBe(before);
	});
});

describe("formatBenchmarkSummary", () => {
	it("states sample count, skips, and honest means", () => {
		const text = formatBenchmarkSummary(runHeldOutBenchmark(coupledHistory(), { holdOut: 2, topK: 3 }));
		expect(text).toContain("2 samples");
		expect(text).toContain("0 skipped");
		expect(text).toContain("top-3");
		expect(text).toContain("mean precision 100.0%");
		expect(text).toContain("mean recall 100.0%");
	});
});
