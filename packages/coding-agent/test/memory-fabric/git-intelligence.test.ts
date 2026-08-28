import { describe, expect, it } from "bun:test";

import {
	analyze,
	analyzeChurn,
	analyzeCoChange,
	analyzeContribution,
	assessHistoryQuality,
	buildLogArgs,
	buildPathIdentities,
	DEFAULT_GIT_INTELLIGENCE_CONFIG,
	decayWeight,
	emitFeedback,
	evaluateAdvisory,
	GIT_LOG_FORMAT,
	type GitCommitRecord,
	GitIntelligence,
	type GitIntelligenceConfig,
	InMemoryFeedbackJournal,
	isTestPath,
	makeFeedbackEvent,
	parseGitLog,
	relatedTests,
	renderAdvisoryText,
	toToolAdvisory,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/git-intelligence";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

function iso(daysAgo: number): string {
	return new Date(NOW - daysAgo * DAY_MS).toISOString();
}

let shaSeq = 0;

interface FileSpec {
	path: string;
	previousPath?: string;
	status?: GitCommitRecord["files"][number]["status"];
}

function mkCommit(daysAgo: number, paths: Array<string | FileSpec>, author = "alice"): GitCommitRecord {
	const at = iso(daysAgo);
	return {
		sha: `sha_${(shaSeq++).toString(36).padStart(4, "0")}`,
		parentIds: ["parent"],
		authoredAt: at,
		committedAt: at,
		authorName: author,
		authorEmail: `${author}@example.com`,
		subject: `change ${paths.length} files`,
		files: paths.map(p => {
			const spec: FileSpec = typeof p === "string" ? { path: p } : p;
			return {
				path: spec.path,
				previousPath: spec.previousPath,
				status: spec.status ?? "modified",
				additions: 3,
				deletions: 1,
				binary: false,
			};
		}),
		isMerge: false,
		isRevert: false,
	};
}

/** Enough spread-out commits to clear the default cold-start gate. */
function warmHistory(): GitCommitRecord[] {
	const commits: GitCommitRecord[] = [];
	for (let i = 0; i < 60; i++) {
		commits.push(mkCommit(1 + i, [`src/core.ts`, `src/helper-${i % 7}.ts`], i % 3 === 0 ? "bob" : "alice"));
	}
	return commits;
}

function enabledConfig(overrides: Partial<GitIntelligenceConfig> = {}): GitIntelligenceConfig {
	return { ...DEFAULT_GIT_INTELLIGENCE_CONFIG, enabled: true, mode: "suggest", ...overrides };
}

describe("memory-fabric git-intelligence log parsing", () => {
	it("builds git log args with framing, rename detection, and caps", () => {
		expect(buildLogArgs()).toEqual(["log", "-z", "--numstat", `--format=${GIT_LOG_FORMAT}`, "--find-renames"]);
		const args = buildLogArgs({ findCopies: true, firstParentOnly: true, maxCount: 50, range: "main..HEAD" });
		expect(args).toContain("--find-copies");
		expect(args).toContain("--first-parent");
		expect(args).toContain("--max-count=50");
		expect(args[args.length - 1]).toBe("main..HEAD");
	});

	it("parses framed commits with numstat, renames, and binary markers", () => {
		const header = ["abc123", "p1 p2", iso(2), iso(1), "Alice", "a@example.com", "Add feature"].join("\x1f");
		const numstat = ["5\t2\tsrc/a.ts", "3\t0\t", "src/old.ts", "src/new.ts", "-\t-\tassets/logo.png"].join("\0");
		const raw = `\x1e${header}\0${numstat}`;
		const commits = parseGitLog(raw);
		expect(commits).toHaveLength(1);
		const c = commits[0];
		expect(c?.sha).toBe("abc123");
		expect(c?.isMerge).toBe(true);
		expect(c?.subject).toBe("Add feature");
		expect(c?.files).toHaveLength(3);
		expect(c?.files[0]).toMatchObject({ path: "src/a.ts", status: "modified", additions: 5, deletions: 2 });
		expect(c?.files[1]).toMatchObject({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" });
		expect(c?.files[2]).toMatchObject({ path: "assets/logo.png", binary: true });
	});

	it("returns empty for empty input and flags reverts", () => {
		expect(parseGitLog("")).toEqual([]);
		const header = ["def456", "p1", iso(1), iso(1), "Bob", "b@example.com", 'Revert "Add feature"'].join("\x1f");
		const commits = parseGitLog(`\x1e${header}\0`);
		expect(commits[0]?.isRevert).toBe(true);
		expect(commits[0]?.isMerge).toBe(false);
	});
});

describe("memory-fabric git-intelligence path identity", () => {
	it("follows renames so history survives a path change", () => {
		const commits = [
			mkCommit(10, [{ path: "src/a.ts", status: "added" }]),
			mkCommit(8, ["src/a.ts"]),
			mkCommit(5, [{ path: "src/b.ts", previousPath: "src/a.ts", status: "renamed" }]),
		];
		const index = buildPathIdentities(commits);
		const byNew = index.resolve("src/b.ts");
		const byOld = index.resolve("src/a.ts");
		expect(byNew).toBeDefined();
		expect(byNew?.id).toBe(byOld?.id);
		expect(byNew?.currentPath).toBe("src/b.ts");
		expect(byNew?.historicalPaths).toContain("src/a.ts");
		expect(byNew?.confidence).toBe(1);
	});

	it("tracks delete + restore on one identity and lowers confidence on convergence", () => {
		const commits = [
			mkCommit(10, [{ path: "src/x.ts", status: "added" }]),
			mkCommit(8, [{ path: "src/x.ts", status: "deleted" }]),
			mkCommit(6, [{ path: "src/x.ts", status: "added" }]),
			mkCommit(4, [{ path: "src/y.ts", status: "added" }]),
			mkCommit(2, [{ path: "src/x.ts", previousPath: "src/y.ts", status: "renamed" }]),
		];
		const index = buildPathIdentities(commits);
		const winner = index.resolve("src/x.ts");
		expect(winner?.confidence).toBe(0.5);
		const restored = [...index.identities.values()].find(i => i.lineage.some(l => l.kind === "restored"));
		expect(restored).toBeDefined();
	});

	it("detects test paths", () => {
		expect(isTestPath("test/memory-fabric/git-intelligence.test.ts")).toBe(true);
		expect(isTestPath("src/__tests__/thing.ts")).toBe(true);
		expect(isTestPath("src/foo.spec.tsx")).toBe(true);
		expect(isTestPath("src/foo.ts")).toBe(false);
	});
});

describe("memory-fabric git-intelligence analyzers", () => {
	it("decayWeight halves per half-life and floors at minWeight", () => {
		const policy = { halfLifeDays: 100, minWeight: 0.01 };
		expect(decayWeight(0, policy)).toBe(1);
		expect(decayWeight(100, policy)).toBeCloseTo(0.5, 10);
		expect(decayWeight(200, policy)).toBeCloseTo(0.25, 10);
		expect(decayWeight(100_000, policy)).toBe(0.01);
	});

	it("grades history quality through the cold-start gate", () => {
		const config = DEFAULT_GIT_INTELLIGENCE_CONFIG;
		expect(assessHistoryQuality([], config).level).toBe("insufficient");
		expect(assessHistoryQuality([mkCommit(1, ["a.ts"]), mkCommit(2, ["a.ts"])], config).level).toBe("insufficient");
		const warm = warmHistory();
		expect(assessHistoryQuality(warm, config).level).toBe("sufficient");
		const cramped = Array.from({ length: 60 }, (_, i) => mkCommit(i % 3, [`f${i}.ts`]));
		const report = assessHistoryQuality(cramped, config);
		expect(report.level).toBe("limited");
		expect(report.reasons.length).toBeGreaterThan(0);
	});

	it("ranks churn by decayed activity with percentiles", () => {
		const commits = [
			...Array.from({ length: 8 }, (_, i) => mkCommit(1 + i, ["src/hot.ts"])),
			mkCommit(300, ["src/cold.ts"]),
		];
		const index = buildPathIdentities(commits);
		const churn = analyzeChurn(commits, index, DEFAULT_GIT_INTELLIGENCE_CONFIG.churn, NOW);
		const hot = churn.get(index.resolve("src/hot.ts")?.id ?? "");
		const cold = churn.get(index.resolve("src/cold.ts")?.id ?? "");
		expect(hot?.commitCount).toBe(8);
		expect(hot?.churnPercentile).toBe(1);
		expect(cold?.churnPercentile).toBe(0);
		expect((hot?.decayedCommitCount ?? 0) > (cold?.decayedCommitCount ?? 0)).toBe(true);
	});

	it("builds sparse co-change with minShared filtering and confidence", () => {
		const commits = [
			mkCommit(1, ["src/a.ts", "src/b.ts"]),
			mkCommit(2, ["src/a.ts", "src/b.ts"]),
			mkCommit(3, ["src/a.ts", "src/b.ts"]),
			mkCommit(4, ["src/a.ts", "src/once.ts"]),
			mkCommit(5, ["src/a.ts"]),
		];
		const index = buildPathIdentities(commits);
		const co = analyzeCoChange(commits, index, DEFAULT_GIT_INTELLIGENCE_CONFIG.coChange, NOW);
		const aId = index.resolve("src/a.ts")?.id ?? "";
		const partners = co.partners.get(aId) ?? [];
		expect(partners.map(p => p.path)).toEqual(["src/b.ts"]); // "once" fails minShared=2
		expect(partners[0]?.rawSupport).toBe(3);
		expect(partners[0]?.confidence).toBeCloseTo(3 / 5, 10); // 3 shared of 5 changes to a.ts
	});

	it("keeps only top-K partners and skips sprawling commits", () => {
		const policy = { ...DEFAULT_GIT_INTELLIGENCE_CONFIG.coChange, topK: 2, minShared: 1, maxFilesPerCommit: 5 };
		const commits = [
			mkCommit(1, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
			mkCommit(2, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
			mkCommit(
				3,
				Array.from({ length: 10 }, (_, i) => `bulk/${i}.ts`),
			),
		];
		const index = buildPathIdentities(commits);
		const co = analyzeCoChange(commits, index, policy, NOW);
		const aId = index.resolve("src/a.ts")?.id ?? "";
		expect((co.partners.get(aId) ?? []).length).toBeLessThanOrEqual(2);
		expect(co.prunedEdges).toBeGreaterThan(0);
		expect(co.partners.get(index.resolve("bulk/0.ts")?.id ?? "")).toBeUndefined();
	});

	it("recommends co-changing tests for a source file", () => {
		const commits = [
			mkCommit(1, ["src/a.ts", "test/a.test.ts"]),
			mkCommit(2, ["src/a.ts", "test/a.test.ts"]),
			mkCommit(3, ["src/a.ts", "src/b.ts"]),
			mkCommit(4, ["src/a.ts", "src/b.ts"]),
		];
		const index = buildPathIdentities(commits);
		const co = analyzeCoChange(commits, index, { ...DEFAULT_GIT_INTELLIGENCE_CONFIG.coChange, minShared: 2 }, NOW);
		const recs = relatedTests(index.resolve("src/a.ts")?.id ?? "", co);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.testPath).toBe("test/a.test.ts");
		expect(recs[0]?.rawSupport).toBe(2);
		expect(recs[0]?.coChangeConfidence).toBeGreaterThan(0);
	});

	it("computes contribution concentration and bus factor", () => {
		const commits = [
			...Array.from({ length: 9 }, (_, i) => mkCommit(1 + i, ["src/solo.ts"], "alice")),
			mkCommit(20, ["src/solo.ts"], "bob"),
			...Array.from({ length: 5 }, (_, i) => mkCommit(1 + i, ["src/shared.ts"], i % 2 === 0 ? "alice" : "bob")),
		];
		const index = buildPathIdentities(commits);
		const contribution = analyzeContribution(commits, index, DEFAULT_GIT_INTELLIGENCE_CONFIG.contribution, NOW);
		const solo = contribution.get(index.resolve("src/solo.ts")?.id ?? "");
		const shared = contribution.get(index.resolve("src/shared.ts")?.id ?? "");
		expect(solo?.busFactor).toBe(1);
		expect(solo?.topAuthorShare).toBeGreaterThan(0.8);
		expect(shared?.busFactor).toBe(2);
	});
});

describe("memory-fabric git-intelligence guardian advisory", () => {
	it("suppresses when disabled and on insufficient history", () => {
		const analysis = analyze(warmHistory(), DEFAULT_GIT_INTELLIGENCE_CONFIG, NOW);
		const disabled = evaluateAdvisory({
			targetPath: "src/core.ts",
			analysis,
			config: DEFAULT_GIT_INTELLIGENCE_CONFIG,
		});
		expect(disabled.disposition).toBe("suppressed");
		expect(disabled.reasons).toContain("disabled");

		const config = enabledConfig();
		const cold = analyze([mkCommit(1, ["src/core.ts"])], config, NOW);
		const trace = evaluateAdvisory({ targetPath: "src/core.ts", analysis: cold, config });
		expect(trace.disposition).toBe("suppressed");
		expect(trace.reasons.some(r => r.startsWith("cold-start-silence"))).toBe(true);
	});

	it("emits an explainable trace in suggest mode for a risky file", () => {
		const config = enabledConfig();
		const analysis = analyze(warmHistory(), config, NOW);
		const trace = evaluateAdvisory({ targetPath: "src/core.ts", analysis, config });
		expect(trace.disposition).toBe("emitted");
		expect(trace.riskScore).toBeGreaterThanOrEqual(config.riskThreshold);
		expect(trace.factors.filter(f => f.value >= 0).length).toBeGreaterThan(0);
		expect(trace.coChangeSuggestions.length).toBeGreaterThan(0);
		expect(trace.coChangeSuggestions.length).toBeLessThanOrEqual(config.maxSuggestions);

		const advisory = toToolAdvisory(trace);
		expect(advisory).not.toBeNull();
		expect(advisory?.text).toContain("src/core.ts");
		expect(advisory?.memoryIds).toEqual([]);
		expect(["info", "warning"]).toContain(advisory?.severity ?? "");
	});

	it("observe mode traces the decision but never surfaces it", () => {
		const config = enabledConfig({ mode: "observe" });
		const analysis = analyze(warmHistory(), config, NOW);
		const trace = evaluateAdvisory({ targetPath: "src/core.ts", analysis, config });
		expect(trace.disposition).toBe("suppressed");
		expect(trace.reasons).toContain("observe-mode: traced but not surfaced");
		expect(toToolAdvisory(trace)).toBeNull();
	});

	it("downgrades active mode to suggest on limited history and marks it provisional", () => {
		const config = enabledConfig({ mode: "active" });
		const cramped = Array.from({ length: 60 }, (_, i) => mkCommit(i % 3, ["src/core.ts", `src/h${i % 4}.ts`]));
		const analysis = analyze(cramped, config, NOW);
		expect(analysis.quality.level).toBe("limited");
		const trace = evaluateAdvisory({ targetPath: "src/core.ts", analysis, config });
		expect(trace.mode).toBe("suggest");
		expect(trace.provisional).toBe(true);
	});

	it("applies a bounded working-tree boost to dirty neighbours", () => {
		const config = enabledConfig();
		const analysis = analyze(warmHistory(), config, NOW);
		const base = evaluateAdvisory({ targetPath: "src/core.ts", analysis, config });
		const boosted = evaluateAdvisory({
			targetPath: "src/core.ts",
			analysis,
			config,
			workingTree: { dirtyPaths: new Set(["src/helper-1.ts"]), maxBoost: 0.5 },
		});
		const baseWeight = base.coChangeSuggestions.find(p => p.path === "src/helper-1.ts")?.weight ?? 0;
		const boostedWeight = boosted.coChangeSuggestions.find(p => p.path === "src/helper-1.ts")?.weight ?? 0;
		expect(boostedWeight).toBeGreaterThan(baseWeight);
		expect(boostedWeight - baseWeight).toBeLessThanOrEqual(config.workingTree.maxBoost + 1e-9);
	});

	it("renders bus-factor and related-test lines in the advisory text", () => {
		const config = enabledConfig();
		const commits = [
			...Array.from({ length: 60 }, (_, i) => mkCommit(1 + i, ["src/risky.ts", "test/risky.test.ts"], "alice")),
		];
		const analysis = analyze(commits, config, NOW);
		const trace = evaluateAdvisory({ targetPath: "src/risky.ts", analysis, config });
		const text = renderAdvisoryText(trace);
		expect(text).toContain("Git behavioral note");
		expect(text).toContain("Bus factor 1");
		expect(text).toContain("test/risky.test.ts");
	});
});

describe("memory-fabric git-intelligence feedback loop", () => {
	function sampleTrace() {
		const config = enabledConfig();
		const analysis = analyze(warmHistory(), config, NOW);
		return evaluateAdvisory({ targetPath: "src/core.ts", analysis, config });
	}

	it("builds a frozen, deterministic feedback event", () => {
		const trace = sampleTrace();
		const event = makeFeedbackEvent({
			projectId: "proj-1",
			trace,
			outcome: "surfaced-proceeded",
			latencyMs: 12,
			advisoryText: "abcdefgh",
			now: () => new Date(NOW),
			hash: text => `h${text.length.toString(36)}`,
		});
		expect(Object.isFrozen(event)).toBe(true);
		expect(event.id.startsWith("fb_h")).toBe(true);
		expect(event.decidedAt).toBe(new Date(NOW).toISOString());
		expect(event.tokenCount).toBe(2);
		expect(event.latencyMs).toBe(12);
		expect(event.relatedTestCount).toBe(trace.relatedTests.length);
		const again = makeFeedbackEvent({
			projectId: "proj-1",
			trace,
			outcome: "surfaced-proceeded",
			latencyMs: 12,
			advisoryText: "abcdefgh",
			now: () => new Date(NOW),
			hash: text => `h${text.length.toString(36)}`,
		});
		expect(again.id).toBe(event.id);
	});

	it("journals events per project and fails open on sink errors", async () => {
		const trace = sampleTrace();
		const journal = new InMemoryFeedbackJournal();
		const event = makeFeedbackEvent({
			projectId: "proj-1",
			trace,
			outcome: "suppressed",
			latencyMs: -5,
			now: () => new Date(NOW),
		});
		expect(event.latencyMs).toBe(0);
		await emitFeedback(journal.sink, event);
		expect(journal.size).toBe(1);
		expect(journal.forProject("proj-1")).toHaveLength(1);
		expect(journal.forProject("other")).toHaveLength(0);

		let seen: unknown = null;
		await emitFeedback(
			() => {
				throw new Error("journal down");
			},
			event,
			error => {
				seen = error;
			},
		);
		expect(seen).toBeInstanceOf(Error);
		await emitFeedback(undefined, event); // no sink: no-op, no throw
	});
});

describe("memory-fabric git-intelligence facade", () => {
	function fakeRunGit(commits: GitCommitRecord[], exitCode = 0) {
		const raw = commits
			.map(c => {
				const parents = c.parentIds.join(" ");
				const fields = [c.sha, parents, c.authoredAt, c.committedAt, c.authorName, c.authorEmail, c.subject];
				const header = fields.join("\x1f");
				const numstat = c.files.map(f => `${f.additions}\t${f.deletions}\t${f.path}`).join("\0");
				return `\x1e${header}\0${numstat}`;
			})
			.join("");
		const calls: string[][] = [];
		const runGit = (args: string[], _opts: { cwd: string }) => {
			calls.push(args);
			return Promise.resolve({ stdout: raw, exitCode });
		};
		return { runGit, calls };
	}

	it("stays disabled by default and fails open everywhere", async () => {
		const { runGit } = fakeRunGit(warmHistory());
		const gi = new GitIntelligence({ cwd: "/repo", runGit });
		expect(gi.state).toBe("disabled");
		await gi.warm();
		expect(gi.state).toBe("disabled");
		expect(gi.isReady).toBe(false);
		expect(gi.advise("src/core.ts")).toBeNull();
		expect(gi.adviseTrace("src/core.ts")).toBeNull();
		expect(gi.coChangePairCount()).toBe(0);
		expect(gi.indexedCommitCount()).toBe(0);
		expect(gi.pathIdentityCount()).toBe(0);
	});

	it("warms once, advises deterministically, and can be marked stale", async () => {
		// Reset parentIds to single-parent so quality counts them (fixture default is fine).
		const commits = warmHistory();
		const { runGit, calls } = fakeRunGit(commits);
		const gi = new GitIntelligence({
			cwd: "/repo",
			runGit,
			config: { enabled: true, mode: "suggest" },
			now: () => NOW,
			maxCount: 500,
		});
		await Promise.all([gi.warm(), gi.warm()]);
		expect(calls).toHaveLength(1); // concurrent warms share one build
		expect(calls[0]).toContain("--max-count=500");
		expect(gi.isReady).toBe(true);
		expect(gi.indexedCommitCount()).toBe(commits.length);
		expect(gi.pathIdentityCount()).toBeGreaterThan(0);
		expect(gi.coChangePairCount()).toBeGreaterThan(0);

		const advisory = gi.advise("src/core.ts");
		expect(advisory).not.toBeNull();
		expect(advisory?.text).toContain("src/core.ts");

		gi.markStale();
		expect(gi.state).toBe("stale");
		expect(gi.isReady).toBe(false);
	});

	it("fails open when git itself fails", async () => {
		const { runGit } = fakeRunGit([], 128);
		const gi = new GitIntelligence({ cwd: "/repo", runGit, config: { enabled: true, mode: "suggest" } });
		await gi.warm();
		expect(gi.state).toBe("failed");
		expect(gi.advise("src/core.ts")).toBeNull();
	});
});
