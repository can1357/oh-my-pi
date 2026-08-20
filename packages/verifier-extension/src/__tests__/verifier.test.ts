import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CompareRepetition } from "../index";
import {
	buildCompareBreakdown,
	buildSummaryLines,
	chooseWinner,
	extractTaggedScore,
	extractTextSource,
	isVerifierRequestParams,
	planSubagentOrchestration,
	readEvidenceBlocks,
	runVerifierRequest,
	truncate,
	weightedMean,
	weightedStdDev,
} from "../index";

describe("truncate", () => {
	it("returns text unchanged when under the limit", () => {
		const result = truncate("hello", 10);
		expect(result.text).toBe("hello");
		expect(result.truncated).toBe(false);
	});

	it("truncates text over the limit and marks truncated", () => {
		const result = truncate("a".repeat(100), 50);
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThan(100);
		expect(result.text.endsWith("... (truncated)")).toBe(true);
	});
});

describe("extractTaggedScore", () => {
	it("extracts the score from a tagged response", () => {
		const result = extractTaggedScore("Some reasoning\n<score>A</score>", "<score>");
		expect(result.score).toBeCloseTo(1, 5);
		expect(result.source).toBe("text");
	});

	it("handles lowercase tags", () => {
		const result = extractTaggedScore("<score>t</score>", "<score>");
		expect(result.score).toBeCloseTo(0, 5);
		expect(result.source).toBe("text");
	});

	it("falls back to 0.5 when the tag is missing", () => {
		const result = extractTaggedScore("No score here", "<score>");
		expect(result.score).toBeCloseTo(0.5, 5);
		expect(result.source).toBe("fallback");
	});

	it("detects mock responses", () => {
		const result = extractTaggedScore("Mock verifier response.", "<score>");
		expect(result.source).toBe("mock");
	});
});

describe("chooseWinner", () => {
	it("picks candidate_a when scoreA is higher", () => {
		expect(chooseWinner(0.8, 0.3)).toBe("candidate_a");
	});

	it("picks candidate_b when scoreB is higher", () => {
		expect(chooseWinner(0.2, 0.9)).toBe("candidate_b");
	});

	it("calls a tie when scores are within the threshold", () => {
		expect(chooseWinner(0.5, 0.51, 0.05)).toBe("tie");
	});
});

describe("planSubagentOrchestration", () => {
	it("answers directly for simple low-risk requests without a specialist match", () => {
		const plan = planSubagentOrchestration({
			request: "format this sentence",
			complexity: "single-step",
			risk: "low",
			evidenceNeed: "current-context",
			decomposability: "not-decomposable",
			dataSensitivity: "public",
			specialists: [],
		});

		expect(plan.routing).toBe("direct");
		expect(plan.mode).toBe("fast");
		expect(plan.verification).toBe("V0");
		expect(plan.subagents).toEqual([]);
	});

	it("routes independent multi-specialist work as a parallel deep plan", () => {
		const plan = planSubagentOrchestration({
			request: "review auth code for security and reliability issues",
			complexity: "multi-step",
			risk: "high",
			evidenceNeed: "multi-source",
			decomposability: "independent",
			dataSensitivity: "confidential",
			specialists: [
				{ name: "SecurityReviewer", scope: "auth security vulnerabilities", costTier: "med" },
				{ name: "ReliabilityReviewer", scope: "reliability retries timeouts", costTier: "low" },
				{ name: "Verifier", scope: "independent verification", costTier: "high", role: "verifier" },
			],
		});

		expect(plan.routing).toBe("parallel");
		expect(plan.mode).toBe("deep");
		expect(plan.verification).toBe("V3");
		expect(plan.subagents).toEqual(["SecurityReviewer", "ReliabilityReviewer"]);
		expect(plan.verifier).toBe("Verifier");
		expect(plan.hiddenRoutePlan).toContain("Use this plan privately");
	});

	it("uses recursive routing only when explicitly allowed for open-ended decomposable work", () => {
		const plan = planSubagentOrchestration({
			request: "build a product strategy using market research and architecture review",
			complexity: "open-ended",
			risk: "med",
			evidenceNeed: "multi-source",
			decomposability: "sequential",
			recursiveAllowed: true,
			specialists: [
				{ name: "Researcher", scope: "market research", costTier: "low" },
				{ name: "Architect", scope: "architecture review", costTier: "med" },
			],
		});

		expect(plan.routing).toBe("recursive");
		expect(plan.maxDepth).toBe(2);
		expect(plan.childCallLimit).toBe(12);
	});
});

describe("weightedMean", () => {
	it("computes a weighted mean", () => {
		const items = [
			{ value: 10, weight: 1 },
			{ value: 20, weight: 2 },
		];
		expect(
			weightedMean(
				items,
				item => item.value,
				item => item.weight,
			),
		).toBeCloseTo(50 / 3, 5);
	});

	it("falls back to simple average when total weight is zero", () => {
		const items = [{ value: 10, weight: 0 }];
		expect(
			weightedMean(
				items,
				item => item.value,
				item => item.weight,
			),
		).toBe(10);
	});

	it("returns zero for an empty array", () => {
		expect(
			weightedMean(
				[],
				() => 1,
				() => 1,
			),
		).toBe(0);
	});
});

describe("weightedStdDev", () => {
	it("returns zero for an empty array", () => {
		expect(
			weightedStdDev(
				[],
				() => 1,
				() => 1,
			),
		).toBe(0);
	});

	it("returns zero for a single value", () => {
		const items = [{ value: 5, weight: 1 }];
		expect(
			weightedStdDev(
				items,
				item => item.value,
				item => item.weight,
			),
		).toBe(0);
	});

	it("computes standard deviation for weighted values", () => {
		const items = [
			{ value: 0, weight: 1 },
			{ value: 10, weight: 1 },
		];
		expect(
			weightedStdDev(
				items,
				item => item.value,
				item => item.weight,
			),
		).toBeCloseTo(5, 5);
	});
});

describe("buildCompareBreakdown", () => {
	const base: CompareRepetition = {
		rep: 1,
		order: "original",
		model: "test",
		weight: 1,
		score_a: 0.8,
		score_b: 0.3,
		canonical_score_a: 0.8,
		canonical_score_b: 0.3,
		source_a: "text",
		source_b: "text",
		response_excerpt: "ok",
	};

	it("computes breakdown for a swapped pair", () => {
		const repetitions: CompareRepetition[] = [
			{ ...base, order: "original" },
			{ ...base, order: "swapped", score_a: 0.3, score_b: 0.8, canonical_score_a: 0.8, canonical_score_b: 0.3 },
		];
		const result = buildCompareBreakdown(repetitions);
		expect(result.score_a).toBeCloseTo(0.8, 5);
		expect(result.score_b).toBeCloseTo(0.3, 5);
		expect(result.swap_consistency).toBeCloseTo(1, 5);
	});

	it("throws when repetitions are not paired", () => {
		const repetitions: CompareRepetition[] = [base];
		expect(() => buildCompareBreakdown(repetitions)).toThrow("even number of repetitions");
	});

	it("throws when adjacent repetitions share the same order", () => {
		const repetitions: CompareRepetition[] = [base, { ...base, order: "original" }];
		expect(() => buildCompareBreakdown(repetitions)).toThrow("both have order");
	});
});

describe("isVerifierRequestParams", () => {
	it("accepts a valid example shape", () => {
		const example = {
			task: "pick the best patch",
			candidates: [{ id: "a" }],
			criteria: [{ name: "correctness", description: "works" }],
		};
		expect(isVerifierRequestParams(example)).toBe(true);
	});

	it("rejects a missing task", () => {
		const example = {
			candidates: [{ id: "a" }],
			criteria: [{ name: "correctness", description: "works" }],
		};
		expect(isVerifierRequestParams(example)).toBe(false);
	});

	it("rejects a candidate without an id", () => {
		const example = {
			task: "pick the best patch",
			candidates: [{}],
			criteria: [{ name: "correctness", description: "works" }],
		};
		expect(isVerifierRequestParams(example)).toBe(false);
	});

	it("rejects a criterion without a name", () => {
		const example = {
			task: "pick the best patch",
			candidates: [{ id: "a" }],
			criteria: [{ description: "works" }],
		};
		expect(isVerifierRequestParams(example)).toBe(false);
	});
});

describe("extractTextSource", () => {
	it("reads a text file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-test-"));
		const filePath = path.join(tempDir, "candidate.txt");
		await fs.writeFile(filePath, "hello world");
		try {
			const result = await extractTextSource(tempDir, "candidate", { path: "candidate.txt" }, 100);
			expect(result.text).toBe("hello world");
			expect(result.source).toBe(filePath);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects a binary file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-test-"));
		const filePath = path.join(tempDir, "candidate.bin");
		await fs.writeFile(filePath, Buffer.from([0x00, 0x01, 0x02]));
		try {
			await expect(extractTextSource(tempDir, "candidate", { path: "candidate.bin" }, 100)).rejects.toThrow(
				"binary",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects an oversized file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-test-"));
		const filePath = path.join(tempDir, "candidate.txt");
		await fs.writeFile(filePath, "x".repeat(100));
		try {
			await expect(extractTextSource(tempDir, "candidate", { path: "candidate.txt" }, 10)).rejects.toThrow(
				"too large",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("readEvidenceBlocks", () => {
	it("reads evidence files", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-test-"));
		const filePath = path.join(tempDir, "evidence.txt");
		await fs.writeFile(filePath, "test log");
		try {
			const blocks = await readEvidenceBlocks(tempDir, ["evidence.txt"], 100);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.content).toBe("test log");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects binary evidence", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-test-"));
		const filePath = path.join(tempDir, "evidence.bin");
		await fs.writeFile(filePath, Buffer.from([0x00, 0x01]));
		try {
			await expect(readEvidenceBlocks(tempDir, ["evidence.bin"], 100)).rejects.toThrow("binary");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildSummaryLines calibration rendering", () => {
	it("renders calibrated pairwise line when calibrated scores are present", () => {
		const result: any = {
			mode: "compare",
			winner: {
				id: "a",
				wins: 1,
				mean_pair_score: 0.8,
				mean_pair_confidence: 0.9,
				summary: "good",
			},
			ranking: [
				{ id: "a", wins: 1, mean_pair_score: 0.8, mean_pair_confidence: 0.9, summary: "good" },
				{ id: "b", wins: 0, mean_pair_score: 0.2, mean_pair_confidence: 0.9, summary: "bad" },
			],
			pairwise: [
				{
					candidate_a: "a",
					candidate_b: "b",
					score_a: 0.8,
					score_b: 0.2,
					margin: 0.6,
					confidence: 0.9,
					disagreement: 0,
					vote_margin: 1.0,
					winner: "a",
					calibrated_score_a: 0.95,
					calibrated_score_b: 0.05,
					calibrated_margin: 0.9,
					model_breakdown: [],
					criteria: [],
				},
			],
			estimated_calls: 2,
		};
		const lines = buildSummaryLines("compare", "gemini-python", [], [], result, false);
		expect(lines.some(l => l.includes("Calibrated pairwise (a vs b): a=0.950, b=0.050 (margin +0.900)"))).toBe(true);
	});
});

describe("runVerifierRequest python backend with calibration", () => {
	it("executes lav_runner.py, performs calibration lookup, and populates calibrated summary lines", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-cal-test-"));
		const calPath = path.join(tempDir, "calibration.json");

		const scriptsDir = path.join(import.meta.dir, "..", "..", "skills", "llm-as-verifier", "scripts");
		const pythonBin = Bun.which("python") ?? Bun.which("python3") ?? "python";
		const pyScript = `import sys, os; sys.path.insert(0, r"${scriptsDir}"); from harness.fusion.verifier_calibration import judge_config_key; import lav_runner; print(judge_config_key("gemini-2.5-flash", 1, prompt_digest=lav_runner.verifier_protocol_digest()))`;
		const pyDigestProc = Bun.spawn([pythonBin, "-c", pyScript], { stdout: "pipe", stderr: "pipe" });
		const digestOut = (await new Response(pyDigestProc.stdout).text()).trim();
		expect(digestOut.length).toBe(16);

		const registry = {
			[digestOut]: {
				config_digest: digestOut,
				platt_a: 2.0,
				platt_b: -1.0,
				model: "gemini-2.5-flash",
				n_verifications: 1,
			},
		};
		await Bun.write(calPath, JSON.stringify(registry));

		const mockPi: any = {
			exec: async (cmd: string, args: string[]) => {
				const resolvedBin = Bun.which(cmd) ?? Bun.which("python") ?? Bun.which("python3") ?? cmd;
				const proc = Bun.spawn([resolvedBin, ...args], { stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				const code = await proc.exited;
				return { code, stdout, stderr };
			},
		};
		const mockCtx: any = {
			cwd: tempDir,
			modelRegistry: {
				find: (provider: string, id: string) => ({
					provider,
					id,
					name: id,
					api: "google",
					contextWindow: 1048576,
					maxTokens: 8192,
					supportsTools: true,
				}),
				getAll: () => [
					{
						provider: "google",
						id: "gemini-2.5-flash",
						name: "gemini-2.5-flash",
					},
				],
			},
		};
		try {
			const run = await runVerifierRequest(mockPi, mockCtx, {
				backend: "gemini-python",
				mode: "compare",
				task: "Test task",
				candidates: [
					{ id: "cand-1", content: "pass all tests" },
					{ id: "cand-2", content: "fail tests" },
				],
				criteria: [{ name: "correctness", description: "is it correct" }],
				nVerifications: 1,
				mock: true,
				calibrationPath: calPath,
			});

			expect(run.summaryLines.some(l => l.includes("Calibrated pairwise (cand-1 vs cand-2)"))).toBe(true);
			const pair = (run.parsed.result as any).pairwise[0];
			expect(pair.calibrated_score_a).toBeDefined();
			expect(pair.calibrated_score_b).toBeDefined();
			expect(pair.calibrated_margin).toBeDefined();
			expect(pair.calibrated_score_a).toBeGreaterThan(0);
			expect(pair.calibrated_score_b).toBeLessThan(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
