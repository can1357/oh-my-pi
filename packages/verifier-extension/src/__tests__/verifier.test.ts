import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@pk-nerdsaver-ai/pi-coding-agent";
import verifierExtension, {
	buildCompareBreakdown,
	buildSummaryLines,
	type CompareRepetition,
	chooseWinner,
	createWorkspaceAuditRequest,
	criteriaFromVerifierContract,
	extractTaggedScore,
	extractTextSource,
	isVerifierRequestParams,
	planSubagentOrchestration,
	readEvidenceBlocks,
	readVerifierModelSpec,
	runVerifierRequest,
	runVerifierSlashCommand,
	selectOverallWinner,
	truncate,
	type VerifierRequestParams,
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

describe("selectOverallWinner", () => {
	it("abstains for an equal top ranking and keeps a decisive top rank", () => {
		expect(
			selectOverallWinner([
				{ wins: 1, mean_pair_score: 0.5 },
				{ wins: 1, mean_pair_score: 0.5 },
			]),
		).toBeNull();
		expect(
			selectOverallWinner([
				{ wins: 2, mean_pair_score: 0.5 },
				{ wins: 1, mean_pair_score: 0.9 },
			]),
		).toEqual({ wins: 2, mean_pair_score: 0.5 });
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

describe("/verify workspace audit", () => {
	it("registers the verifier slash command with the extension", () => {
		const registerCommand = vi.fn();
		const typeFactory = new Proxy(
			{},
			{
				get: () => () => ({}),
			},
		);
		const pi = {
			setLabel: vi.fn(),
			typebox: { Type: typeFactory },
			registerTool: vi.fn(),
			registerCommand,
		} as unknown as ExtensionAPI;

		verifierExtension(pi);

		expect(registerCommand).toHaveBeenCalledWith(
			"verify",
			expect.objectContaining({
				description: expect.stringContaining("tracked workspace diff"),
				handler: expect.any(Function),
			}),
		);
	});

	it("turns explicit acceptance bullets into narrow verifier criteria", () => {
		const criteria = criteriaFromVerifierContract(
			"Objective: ship the installer\n\nAcceptance:\n- npm remains the default\n- unsupported binaries fail before download",
		);

		expect(criteria.map(criterion => criterion.description)).toEqual([
			"npm remains the default",
			"unsupported binaries fail before download",
		]);
	});

	it("accepts numbered and inline acceptance criteria", () => {
		expect(
			criteriaFromVerifierContract(
				"Objective: ship safely\n\nAcceptance criteria:\n1. focused tests pass\n2) no unsupported fallback",
			).map(criterion => criterion.description),
		).toEqual(["focused tests pass", "no unsupported fallback"]);
		expect(
			criteriaFromVerifierContract("Objective: ship safely\nAcceptance: focused tests pass")[0]?.description,
		).toBe("focused tests pass");
	});

	it("fails closed when explicit acceptance criteria cannot be parsed", () => {
		expect(() => criteriaFromVerifierContract("Objective: ship safely")).toThrow("Include an Acceptance: section");
		expect(() => criteriaFromVerifierContract("Objective: ship safely\nAcceptance:\nfocused tests pass")).toThrow(
			"The Acceptance: section must contain",
		);
		const tooManyCriteria = Array.from({ length: 7 }, (_, index) => `- criterion ${index + 1}`).join("\n");
		expect(() => criteriaFromVerifierContract(`Objective: ship safely\nAcceptance:\n${tooManyCriteria}`)).toThrow(
			"The Acceptance: section supports at most 6 criteria.",
		);
	});

	it("reads the verifier model from the active extension context", () => {
		const getSetting = vi.fn(() => " independent/verifier ");
		const ctx = { getSetting } as unknown as ExtensionContext;

		expect(readVerifierModelSpec(ctx)).toBe("independent/verifier");
		expect(getSetting).toHaveBeenCalledWith("delegate.verifierModel");
		expect(readVerifierModelSpec({} as ExtensionContext)).toBe("pi/task");
	});

	it("builds a single-candidate audit using the configured verifier model", () => {
		const request = createWorkspaceAuditRequest(
			"Objective: preserve behavior\n\nAcceptance:\n- focused tests pass",
			{ diff: "diff --git a/file.ts b/file.ts\n+fixed", status: " M file.ts" },
			"independent/verifier",
		);

		expect(request).toMatchObject({
			backend: "pi-model-ensemble",
			mode: "audit",
			model: "independent/verifier",
			maxCandidateChars: 40000,
			maxEvidenceChars: 20000,
			candidates: [{ id: "workspace-diff" }],
		});
		expect(request.criteria.map(criterion => criterion.id)).toEqual(["acceptance-1"]);
	});

	it("rejects a workspace audit when there is no tracked diff", () => {
		expect(() =>
			createWorkspaceAuditRequest(
				"Objective: preserve behavior",
				{ diff: "", status: "?? untracked.ts" },
				"independent/verifier",
			),
		).toThrow("No tracked workspace diff is available to audit.");
	});

	it("fails before verification when workspace evidence would be truncated", () => {
		expect(() =>
			createWorkspaceAuditRequest(
				"Objective: preserve behavior\n\nAcceptance:\n- focused tests pass",
				{ diff: "x".repeat(40001), status: "" },
				"independent/verifier",
			),
		).toThrow("Tracked workspace diff is 40001 characters; /verify supports at most 40000.");
	});

	it("rejects an empty non-interactive request before reading git", async () => {
		const exec = vi.fn();
		const pi = { exec } as unknown as ExtensionAPI;
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
		} as unknown as ExtensionContext;

		await expect(
			runVerifierSlashCommand(pi, ctx, "", {
				readModelSpec: () => "independent/verifier",
				runRequest: async () => ({ summaryLines: [] }),
			}),
		).rejects.toThrow("Usage: /verify <objective and acceptance criteria>");
		expect(exec).not.toHaveBeenCalled();
	});

	it("surfaces git capture failures without launching the verifier", async () => {
		const runRequest = vi.fn(async () => ({ summaryLines: [] }));
		const exec = vi.fn(async (_command: string, args: string[]) => ({
			stdout: "",
			stderr: args[0] === "diff" ? "fatal: not a git repository" : "",
			code: args[0] === "diff" ? 128 : 0,
			killed: false,
		}));
		const pi = { exec } as unknown as ExtensionAPI;
		const ctx = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;

		await expect(
			runVerifierSlashCommand(pi, ctx, "Objective: preserve behavior\n\nAcceptance:\n- focused tests pass", {
				readModelSpec: () => "independent/verifier",
				runRequest,
			}),
		).rejects.toThrow("fatal: not a git repository");
		expect(runRequest).not.toHaveBeenCalled();
	});

	it("launches from an empty slash command through the criteria editor", async () => {
		let capturedRequest: VerifierRequestParams | undefined;
		const editor = vi.fn(async () => "Objective: preserve behavior\n\nAcceptance:\n- focused tests pass");
		const notify = vi.fn();
		const exec = vi.fn(async (_command: string, args: string[]) => ({
			stdout: args[0] === "diff" ? "diff --git a/file.ts b/file.ts\n+fixed" : " M file.ts",
			stderr: "",
			code: 0,
			killed: false,
		}));
		const pi = { exec } as unknown as ExtensionAPI;
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { editor, notify },
		} as unknown as ExtensionContext;

		const launched = await runVerifierSlashCommand(pi, ctx, "", {
			readModelSpec: () => "independent/verifier",
			runRequest: async (_pi, _ctx, params) => {
				capturedRequest = params;
				return { summaryLines: ["audit complete"] };
			},
		});

		expect(launched).toBe(true);
		expect(editor).toHaveBeenCalledWith(
			"LLM verifier objective and acceptance criteria",
			expect.stringContaining("Acceptance:"),
			undefined,
			{ promptStyle: true },
		);
		expect(capturedRequest).toMatchObject({
			model: "independent/verifier",
			criteria: [{ description: "focused tests pass" }],
		});
		expect(notify).toHaveBeenCalledWith("audit complete", "info");
		expect(exec).toHaveBeenNthCalledWith(1, "git", ["diff", "--no-ext-diff", "HEAD"], {
			cwd: process.cwd(),
			timeout: 30000,
		});
		expect(exec).toHaveBeenNthCalledWith(2, "git", ["status", "--short"], { cwd: process.cwd(), timeout: 30000 });
	});
});

describe("runVerifierRequest task-model default", () => {
	it("resolves pi/task through the extension model facade and uses the native backend", async () => {
		const taskModel = {
			provider: "kimi-code",
			id: "kimi-for-coding",
			name: "kimi-for-coding",
			api: "openai-completions",
			contextWindow: 1048576,
			maxTokens: 8192,
			supportsTools: true,
		};
		const resolveCalls: string[] = [];
		const ctx: any = {
			cwd: process.cwd(),
			models: {
				resolve: (spec: string) => {
					resolveCalls.push(spec);
					return taskModel;
				},
			},
			modelRegistry: { getAll: () => [] },
		};

		const run = await runVerifierRequest({} as any, ctx, {
			mode: "compare",
			task: "Test task",
			candidates: [
				{ id: "cand-1", content: "pass all tests" },
				{ id: "cand-2", content: "fail tests" },
			],
			criteria: [{ name: "Overall correctness", description: "Overall correctness" }],
			mock: true,
		});

		expect(resolveCalls).toEqual(["pi/task"]);
		expect(run.backend).toBe("pi-model-ensemble");
		expect(run.resolvedModels).toEqual([
			{ spec: "pi/task", provider: "kimi-code", id: "kimi-for-coding", display: "kimi-code:kimi-for-coding" },
		]);
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

	it("renders a top-level tie without promoting the first ranked candidate", () => {
		const result: any = {
			mode: "compare",
			winner: null,
			ranking: [
				{ id: "a", wins: 1, mean_pair_score: 0.5, mean_pair_confidence: 0.8, summary: "a" },
				{ id: "b", wins: 1, mean_pair_score: 0.5, mean_pair_confidence: 0.8, summary: "b" },
			],
			pairwise: [],
			estimated_calls: 2,
		};
		const lines = buildSummaryLines("compare", "gemini-python", [], [], result, true);
		expect(lines).toContain("Winner: tie");
		expect(lines).toContain("Winner confidence: 0.000");
		expect(lines).not.toContain("Winner: a");
	});
});

describe("runVerifierRequest Python backend with calibration", () => {
	it("executes lav_runner.py, performs calibration lookup, and populates calibrated summary lines", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-cal-test-"));
		const calPath = path.join(tempDir, "calibration.json");

		const scriptsDir = path.join(import.meta.dir, "..", "..", "skills", "llm-as-verifier", "scripts");
		const pythonBin = Bun.which("python") ?? Bun.which("python3") ?? "python";
		const pyScript = `import sys; sys.path.insert(0, r"${scriptsDir}"); from harness.fusion.verifier_calibration import CANONICAL_CALIBRATION_CRITERIA, compute_criteria_digest, judge_config_key; import lav_runner; print(judge_config_key("gemini-2.5-flash", 1, prompt_digest=lav_runner.verifier_protocol_digest(), criteria_digest=compute_criteria_digest(CANONICAL_CALIBRATION_CRITERIA), scorer_id="lav-swap-agg-v1"))`;
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
				model: "google:gemini-2.5-flash",
				mode: "compare",
				task: "Test task",
				candidates: [
					{ id: "cand-1", content: "pass all tests" },
					{ id: "cand-2", content: "fail tests" },
				],
				criteria: [{ name: "Overall correctness", description: "Overall correctness" }],
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

describe("runVerifierRequest calibration backend gate", () => {
	it("rejects calibrationPath outside the gemini-python backend", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-cal-gate-test-"));
		const mockCtx: any = {
			cwd: tempDir,
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id, name: id }),
				getAll: () => [],
			},
		};
		try {
			await expect(
				runVerifierRequest({} as any, mockCtx, {
					backend: "pi-model-ensemble",
					mode: "compare",
					task: "Test task",
					candidates: [
						{ id: "cand-1", content: "pass all tests" },
						{ id: "cand-2", content: "fail tests" },
					],
					criteria: [{ name: "Overall correctness", description: "Overall correctness" }],
					mock: true,
					calibrationPath: "/tmp/x.json",
				}),
			).rejects.toThrow("calibrationPath is only supported for backend gemini-python");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("runVerifierRequest Python default calibration compatibility", () => {
	it("applies a default-note canonical-criteria fit at five verifications", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lav-default-cal-test-"));
		const calPath = path.join(tempDir, "calibration.json");
		const scriptsDir = path.join(import.meta.dir, "..", "..", "skills", "llm-as-verifier", "scripts");
		const pythonBin = Bun.which("python") ?? Bun.which("python3") ?? "python";
		const pyScript = `import sys; sys.path.insert(0, r"${scriptsDir}"); from harness.fusion.verifier_calibration import CANONICAL_CALIBRATION_CRITERIA, compute_criteria_digest, judge_config_key; import lav_runner; print(judge_config_key("9router/gemini-3-5-flash-medium-round-robin", 5, prompt_digest=lav_runner.verifier_protocol_digest(), criteria_digest=compute_criteria_digest(CANONICAL_CALIBRATION_CRITERIA), scorer_id="lav-swap-agg-v1"))`;
		const pyDigestProc = Bun.spawn([pythonBin, "-c", pyScript], { stdout: "pipe", stderr: "pipe" });
		const digestOut = (await new Response(pyDigestProc.stdout).text()).trim();
		expect(digestOut.length).toBe(16);
		await Bun.write(
			calPath,
			JSON.stringify({
				[digestOut]: { config_digest: digestOut, platt_a: 2.0, platt_b: -1.0 },
			}),
		);

		const mockPi: any = {
			exec: async (cmd: string, args: string[]) => {
				const resolvedBin = Bun.which(cmd) ?? Bun.which("python") ?? Bun.which("python3") ?? cmd;
				const proc = Bun.spawn([resolvedBin, ...args], { stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				return { code: await proc.exited, stdout, stderr };
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
						provider: "9router",
						id: "gemini-3-5-flash-medium-round-robin",
						name: "gemini-3-5-flash-medium-round-robin",
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
				criteria: [{ name: "Overall correctness", description: "Overall correctness" }],
				nVerifications: 5,
				mock: true,
				calibrationPath: calPath,
			});
			expect(run.summaryLines.some(line => line.includes("Calibrated pairwise"))).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
