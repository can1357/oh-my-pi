import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createAutoresearchExtension } from "@oh-my-pi/pi-coding-agent/autoresearch";
import {
	buildExperimentState,
	computeConfidence,
	findBaselineMetric,
	findBaselineRunNumber,
	findBestKeptMetric,
	reconstructControlState,
} from "@oh-my-pi/pi-coding-agent/autoresearch/state";
import { AutoresearchStorage, closeAllAutoresearchStorages } from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import type { ExperimentResult } from "@oh-my-pi/pi-coding-agent/autoresearch/types";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { VcsGitRepo, VcsGitRepoInfo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeTempDir(): TempDir {
	return TempDir.createSync("@pi-autoresearch-test-");
}

function makeResult(partial: Partial<ExperimentResult>): ExperimentResult {
	return {
		runNumber: partial.runNumber ?? null,
		commit: partial.commit ?? "",
		metric: partial.metric ?? 0,
		metrics: partial.metrics ?? {},
		status: partial.status ?? "keep",
		description: partial.description ?? "",
		timestamp: partial.timestamp ?? 0,
		segment: partial.segment ?? 0,
		confidence: partial.confidence ?? null,
		asi: partial.asi,
		modifiedPaths: partial.modifiedPaths ?? [],
		scopeDeviations: partial.scopeDeviations ?? [],
		justification: partial.justification ?? null,
		flagged: partial.flagged ?? false,
		flaggedReason: partial.flaggedReason ?? null,
	};
}

describe("autoresearch state math", () => {
	it("findBaselineMetric returns the first kept run in the segment", () => {
		const results: ExperimentResult[] = [
			makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep" }),
			makeResult({ runNumber: 2, segment: 0, metric: 80, status: "keep" }),
			makeResult({ runNumber: 3, segment: 1, metric: 50, status: "keep" }),
		];
		expect(findBaselineMetric(results, 0)).toBe(100);
		expect(findBaselineMetric(results, 1)).toBe(50);
		expect(findBaselineRunNumber(results, 0)).toBe(1);
	});

	it("findBaselineMetric ignores flagged results", () => {
		const results: ExperimentResult[] = [
			makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep", flagged: true }),
			makeResult({ runNumber: 2, segment: 0, metric: 90, status: "keep" }),
		];
		expect(findBaselineMetric(results, 0)).toBe(90);
	});

	it("findBestKeptMetric picks the optimum given direction and excludes flagged", () => {
		const results: ExperimentResult[] = [
			makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep" }),
			makeResult({ runNumber: 2, segment: 0, metric: 60, status: "keep", flagged: true }),
			makeResult({ runNumber: 3, segment: 0, metric: 80, status: "keep" }),
		];
		expect(findBestKeptMetric(results, 0, "lower")).toBe(80);
		expect(findBestKeptMetric(results, 0, "higher")).toBe(100);
	});

	it("computeConfidence returns null with fewer than three valid runs", () => {
		const results: ExperimentResult[] = [
			makeResult({ runNumber: 1, segment: 0, metric: 10, status: "keep" }),
			makeResult({ runNumber: 2, segment: 0, metric: 12, status: "keep" }),
		];
		expect(computeConfidence(results, 0, "lower")).toBeNull();
	});

	it("computeConfidence is null when noise floor is zero", () => {
		const results: ExperimentResult[] = [
			makeResult({ runNumber: 1, segment: 0, metric: 10, status: "keep" }),
			makeResult({ runNumber: 2, segment: 0, metric: 10, status: "keep" }),
			makeResult({ runNumber: 3, segment: 0, metric: 10, status: "keep" }),
		];
		expect(computeConfidence(results, 0, "lower")).toBeNull();
	});

	it("computeConfidence excludes flagged runs from noise floor", () => {
		const noiseyAndKept: ExperimentResult[] = [
			makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep" }),
			makeResult({ runNumber: 2, segment: 0, metric: 99, status: "keep" }),
			makeResult({ runNumber: 3, segment: 0, metric: 98, status: "keep" }),
			makeResult({ runNumber: 4, segment: 0, metric: 90, status: "keep" }),
		];
		const baseConfidence = computeConfidence(noiseyAndKept, 0, "lower");
		const flagged = noiseyAndKept.map((r, i) => (i === 1 ? { ...r, flagged: true } : r));
		// dropping a normal run shouldn't make confidence null; values still vary
		expect(computeConfidence(flagged, 0, "lower")).not.toBe(baseConfidence);
	});
});

describe("AutoresearchStorage round-trip", () => {
	let dbDir: TempDir;

	beforeEach(() => {
		dbDir = makeTempDir();
	});

	afterEach(async () => {
		await Bun.sleep(0);
		await dbDir.remove().catch(() => {});
	});

	function openStorage(): AutoresearchStorage {
		return new AutoresearchStorage(dbDir.join("test.db"), dbDir.path());
	}

	it("persists sessions and exposes the active session", () => {
		const storage = openStorage();
		expect(storage.getActiveSession()).toBeNull();
		const session = storage.openSession({
			name: "speed",
			goal: "make it fast",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bun run bench",
			branch: "autoresearch/speed-20260501",
			baselineCommit: "abc1234",
			maxIterations: 25,
			scopePaths: ["src"],
			offLimits: ["test"],
			constraints: ["no api break"],
			secondaryMetrics: ["memory_mb"],
		});
		const active = storage.getActiveSession();
		expect(active?.id).toBe(session.id);
		expect(active?.name).toBe("speed");
		expect(active?.scopePaths).toEqual(["src"]);
		expect(active?.offLimits).toEqual(["test"]);
		expect(active?.secondaryMetrics).toEqual(["memory_mb"]);
		storage.close();
	});

	it("inserts a run, marks it completed, then logs and flags it", () => {
		const storage = openStorage();
		const session = storage.openSession({
			name: "speed",
			goal: null,
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: null,
			branch: null,
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		const inserted = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bun run bench",
			logPath: "/tmp/run.log",
			preRunDirtyPaths: [],
			startedAt: 1000,
		});
		expect(inserted.status).toBeNull();
		expect(storage.getPendingRun(session.id)?.id).toBe(inserted.id);

		const completed = storage.markRunCompleted({
			runId: inserted.id,
			completedAt: 5000,
			durationMs: 4000,
			exitCode: 0,
			timedOut: false,
			parsedPrimary: 42,
			parsedMetrics: { runtime_ms: 42, memory_mb: 12 },
			parsedAsi: { hypothesis: "first try" },
		});
		expect(completed.parsedPrimary).toBe(42);
		expect(completed.parsedMetrics).toEqual({ runtime_ms: 42, memory_mb: 12 });
		expect(completed.parsedAsi).toEqual({ hypothesis: "first try" });

		const logged = storage.markRunLogged({
			runId: inserted.id,
			status: "keep",
			description: "baseline",
			metric: 42,
			metrics: { memory_mb: 12 },
			asi: { hypothesis: "first try", learning: "ok" },
			commitHash: "cafef00d",
			confidence: null,
			modifiedPaths: ["src/foo.ts"],
			scopeDeviations: [],
			justification: null,
			loggedAt: 6000,
		});
		expect(logged.status).toBe("keep");
		expect(logged.metric).toBe(42);
		expect(logged.modifiedPaths).toEqual(["src/foo.ts"]);
		expect(storage.getPendingRun(session.id)).toBeNull();

		const flagged = storage.flagRun(inserted.id, "reward-hacked");
		expect(flagged.flagged).toBe(true);
		expect(flagged.flaggedReason).toBe("reward-hacked");
		storage.close();
	});

	it("bumps segment on the active session", () => {
		const storage = openStorage();
		const session = storage.openSession({
			name: "x",
			goal: null,
			primaryMetric: "m",
			metricUnit: "",
			direction: "lower",
			preferredCommand: null,
			branch: null,
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		expect(session.currentSegment).toBe(0);
		expect(storage.bumpSegment(session.id).currentSegment).toBe(1);
		expect(storage.bumpSegment(session.id).currentSegment).toBe(2);
		storage.close();
	});

	it("abandonPendingRuns marks pending rows abandoned and returns the count", () => {
		const storage = openStorage();
		const session = storage.openSession({
			name: "x",
			goal: null,
			primaryMetric: "m",
			metricUnit: "",
			direction: "lower",
			preferredCommand: null,
			branch: null,
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		const a = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "a",
			logPath: "/a",
			preRunDirtyPaths: [],
			startedAt: 1,
		});
		const b = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "b",
			logPath: "/b",
			preRunDirtyPaths: [],
			startedAt: 2,
		});
		expect(storage.abandonPendingRuns(session.id)).toBe(2);
		expect(storage.getPendingRun(session.id)).toBeNull();
		expect(storage.getRunById(a.id)?.abandonedAt).not.toBeNull();
		expect(storage.getRunById(b.id)?.abandonedAt).not.toBeNull();
		// Idempotent — running again finds nothing pending
		expect(storage.abandonPendingRuns(session.id)).toBe(0);
		storage.close();
	});

	it("buildExperimentState rebuilds the dashboard view from DB rows", () => {
		const storage = openStorage();
		const session = storage.openSession({
			name: "speed",
			goal: "fast",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bun bench",
			branch: "autoresearch/foo",
			baselineCommit: "deadbeef",
			maxIterations: null,
			scopePaths: ["src"],
			offLimits: [],
			constraints: [],
			secondaryMetrics: ["memory_mb"],
		});
		const run = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bun bench",
			logPath: "/tmp/0001/benchmark.log",
			preRunDirtyPaths: [],
			startedAt: 1,
		});
		storage.markRunCompleted({
			runId: run.id,
			completedAt: 100,
			durationMs: 99,
			exitCode: 0,
			timedOut: false,
			parsedPrimary: 50,
			parsedMetrics: { runtime_ms: 50, memory_mb: 5 },
			parsedAsi: null,
		});
		storage.markRunLogged({
			runId: run.id,
			status: "keep",
			description: "baseline",
			metric: 50,
			metrics: { memory_mb: 5 },
			asi: null,
			commitHash: "abc",
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: 200,
		});

		const refreshedSession = storage.getActiveSession();
		expect(refreshedSession).not.toBeNull();
		const state = buildExperimentState(refreshedSession!, storage.listLoggedRuns(session.id));
		expect(state.results).toHaveLength(1);
		expect(state.bestMetric).toBe(50);
		expect(state.metricName).toBe("runtime_ms");
		expect(state.notes).toBe("");
		expect(state.branch).toBe("autoresearch/foo");
		expect(state.baselineCommit).toBe("deadbeef");
		expect(state.scopePaths).toEqual(["src"]);
		storage.close();
	});

	it("storage round-trip preserves notes updates", () => {
		const storage = openStorage();
		const session = storage.openSession({
			name: "x",
			goal: null,
			primaryMetric: "m",
			metricUnit: "",
			direction: "lower",
			preferredCommand: null,
			branch: null,
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		storage.updateSession(session.id, { notes: "## Plan\n- step 1\n" });
		expect(storage.getSessionById(session.id)?.notes).toBe("## Plan\n- step 1\n");
		storage.close();
	});
});

describe("autoresearch control state", () => {
	it("treats the most recent control entry as authoritative", () => {
		const result = reconstructControlState([
			{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } } as never,
			{ type: "custom", customType: "autoresearch-control", data: { mode: "off" } } as never,
		]);
		expect(result.autoresearchMode).toBe(false);
		expect(result.lastMode).toBe("off");
	});

	it("clears the goal when the latest mode is `clear`", () => {
		const result = reconstructControlState([
			{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } } as never,
			{ type: "custom", customType: "autoresearch-control", data: { mode: "clear" } } as never,
		]);
		expect(result.goal).toBeNull();
		expect(result.lastMode).toBe("clear");
	});
});

interface AutoresearchCommandHarness {
	command: RegisteredCommand;
	ctx: ExtensionCommandContext;
	execCalls: Array<{ args: string[]; command: string }>;
	sentMessages: string[];
	notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }>;
}

function createCommandHarness(
	cwd: string,
	execImpl?: (command: string, args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>,
): AutoresearchCommandHarness {
	const execCalls: Array<{ args: string[]; command: string }> = [];
	const sentMessages: string[] = [];
	const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
	let command: RegisteredCommand | undefined;

	const runGitMock = async (args: string[]) => {
		execCalls.push({ args: [...args], command: "git" });
		return execImpl ? execImpl("git", args) : { code: 0, stderr: "", stdout: "" };
	};

	const repoInfo: VcsGitRepoInfo = {
		commonDir: `${cwd}/.git`,
		gitDir: `${cwd}/.git`,
		gitEntryPath: `${cwd}/.git`,
		headPath: `${cwd}/.git/HEAD`,
		isReftable: false,
		repoRoot: cwd,
	};
	const repository = {
		checkoutNewBranch: async (branchName: string) => {
			const result = await runGitMock(["checkout", "-b", branchName]);
			if (result.code !== 0) throw new Error(result.stderr || "git checkout failed");
		},
		currentBranch: async () => {
			const result = await runGitMock(["branch", "--show-current"]);
			if (result.code !== 0) return null;
			const branch = result.stdout.trim();
			return branch.length > 0 ? branch : null;
		},
		info: () => repoInfo,
		prefixOf: () => {
			execCalls.push({ args: ["rev-parse", "--show-prefix"], command: "git" });
			return "";
		},
		refExists: async (refName: string) => {
			const result = await runGitMock(["show-ref", "--verify", "--quiet", refName]);
			return result.code === 0;
		},
		statusPorcelain: async () => {
			const result = await runGitMock(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
			if (result.code !== 0) throw new Error(result.stderr || "git status failed");
			return result.stdout;
		},
	} as unknown as VcsGitRepo;
	vi.spyOn(vcs, "git").mockReturnValue(repository);
	vi.spyOn(vcs, "requireGit").mockReturnValue(repository);
	vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfo);
	vi.spyOn(vcs, "isPureJj").mockReturnValue(false);

	const api = {
		appendEntry(): void {},
		exec: async (commandName: string, args: string[]) => {
			execCalls.push({ args: [...args], command: commandName });
			return execImpl ? execImpl(commandName, args) : { code: 0, stderr: "", stdout: "" };
		},
		on(): void {},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
			command = { name, ...options };
		},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools(): string[] {
			return [];
		},
		setActiveTools: async (): Promise<void> => {},
		sendUserMessage(content: string | unknown[]): void {
			if (typeof content !== "string") {
				throw new Error("Expected autoresearch command to send plain text");
			}
			sentMessages.push(content);
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	if (!command) throw new Error("Expected autoresearch command to register");

	const ctx = {
		abort(): void {},
		branch: async () => ({ cancelled: false }),
		compact: async () => {},
		cwd,
		getContextUsage: () => undefined,
		hasUI: false,
		isIdle: () => true,
		model: undefined,
		modelRegistry: {},
		newSession: async () => ({ cancelled: false }),
		reload: async () => {},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "session-1",
		},
		switchSession: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			confirm: async () => false,
			custom: async () => undefined,
			input: async () => undefined,
			notify(message: string, type?: "info" | "warning" | "error"): void {
				notifications.push({ message, type });
			},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			setFooter(): void {},
			setHeader(): void {},
			setStatus(): void {},
			setTitle(): void {},
			setWidget(): void {},
			setWorkingMessage(): void {},
		},
		waitForIdle: async () => {},
	} as unknown as ExtensionCommandContext;

	return { command, ctx, execCalls, sentMessages, notifications };
}

describe("autoresearch slash command", () => {
	const cleanups: TempDir[] = [];
	let dbOverride: TempDir | undefined;

	beforeEach(() => {
		dbOverride = TempDir.createSync("@pi-autoresearch-cmd-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride.path();
		cleanups.push(dbOverride);
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		for (const dir of cleanups.splice(0)) {
			dir.removeSync();
		}
	});

	it("enables autoresearch with a notify when invoked bare in a clean repo", async () => {
		const dir = makeTempDir().path();
		const harness = createCommandHarness(dir, async (_command, args) => {
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stderr: "", stdout: "main\n" };
			if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
			if (args[0] === "show-ref") return { code: 1, stderr: "", stdout: "" };
			if (args[0] === "checkout") return { code: 0, stderr: "", stdout: "" };
			return { code: 0, stderr: "", stdout: "" };
		});
		await harness.command.handler("", harness.ctx);
		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications.some(n => n.message.includes("Autoresearch enabled"))).toBe(true);
	});

	it("forwards a slash argument as the user message and creates a slug branch", async () => {
		const dir = makeTempDir().path();
		const harness = createCommandHarness(dir, async (_command, args) => {
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stderr: "", stdout: "main\n" };
			if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
			if (args[0] === "show-ref") return { code: 1, stderr: "", stdout: "" };
			if (args[0] === "checkout") return { code: 0, stderr: "", stdout: "" };
			return { code: 0, stderr: "", stdout: "" };
		});
		await harness.command.handler("reduce edit benchmark runtime variance", harness.ctx);
		expect(harness.sentMessages).toEqual(["reduce edit benchmark runtime variance"]);
		const checkout = harness.execCalls.find(c => c.command === "git" && c.args[0] === "checkout");
		expect(checkout?.args[2]).toMatch(/^autoresearch\/reduce-edit-benchmark-runtime-variance-\d{8}$/);
	});

	it("aborts with an error when the worktree is dirty", async () => {
		const dir = makeTempDir().path();
		const harness = createCommandHarness(dir, async (_command, args) => {
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stderr: "", stdout: "main\n" };
			if (args[0] === "status") return { code: 0, stderr: "", stdout: " M src/foo.ts\n" };
			if (args[0] === "show-ref") return { code: 1, stderr: "", stdout: "" };
			return { code: 0, stderr: "", stdout: "" };
		});
		await harness.command.handler("", harness.ctx);
		expect(harness.notifications.some(n => n.type === "error" && n.message.includes("dirty"))).toBe(true);
		// Should abort: no enabled notification, no checkout, no message sent
		expect(harness.notifications.some(n => n.message.includes("Autoresearch enabled"))).toBe(false);
		expect(harness.execCalls.find(c => c.command === "git" && c.args[0] === "checkout")).toBeUndefined();
		expect(harness.sentMessages).toEqual([]);
	});
});

describe("autoresearch tool-call hook", () => {
	const cleanups: TempDir[] = [];
	let dbOverride: TempDir;

	beforeEach(() => {
		dbOverride = TempDir.createSync("@pi-autoresearch-hook-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride.path();
		cleanups.push(dbOverride);
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		for (const dir of cleanups.splice(0)) {
			dir.removeSync();
		}
	});

	it("does not register a tool_call hook (post-hoc accountability replaces edit guards)", () => {
		const handlers = new Map<string, unknown>();
		const api = {
			appendEntry(): void {},
			on(event: string, handler: unknown): void {
				handlers.set(event, handler);
			},
			registerCommand(): void {},
			registerShortcut(): void {},
			registerTool(): void {},
			getActiveTools(): string[] {
				return [];
			},
			async setActiveTools(): Promise<void> {},
			sendMessage(): void {},
			sendUserMessage(): void {},
		} as unknown as ExtensionAPI;
		createAutoresearchExtension(api);
		expect(handlers.has("tool_call")).toBe(false);
	});
});
