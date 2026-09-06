/**
 * A child that wrote an artifact and then failed owes the parent that artifact
 * and its real exit status. Losing either makes the parent repeat the slice;
 * reporting the failure as a bare error string, or as a success, is worse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";
import { runStructuredSubagent, StructuredSubagentError } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

const CHILD_USAGE: NonNullable<SingleResult["usage"]> = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function session(cwd: string, settings: Record<string, unknown> = {}, asyncJobManager?: AsyncJobManager): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"isolation.backend": "rcopy",
			...settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager,
	} as unknown as ToolSession;
}

function failedResult(id: string, artifactPath: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 2,
		output: "Findings: 42 rows.",
		stderr: "",
		truncated: false,
		durationMs: 3,
		tokens: 30,
		requests: 2,
		usage: CHILD_USAGE,
		error: "Subagent aborted task",
		outputPath: artifactPath,
	};
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
}

/** Write the child's `<id>.md` the way the executor does before returning. */
async function writeChildArtifact(artifactsDir: string, id: string, body: string): Promise<string> {
	await fs.mkdir(artifactsDir, { recursive: true });
	const artifactPath = path.join(artifactsDir, `${id}.md`);
	await fs.writeFile(artifactPath, body);
	return artifactPath;
}

async function runGit(repo: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if ((exitCode ?? 0) !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
}

/** A real single-commit repo so isolation preflight runs unmocked. */
async function createRepo(dir: string): Promise<void> {
	await runGit(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
	await runGit(dir, ["config", "user.email", "test@example.com"]);
	await runGit(dir, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(dir, "README.md"), "hi\n");
	await runGit(dir, ["add", "README.md"]);
	await runGit(dir, ["commit", "-q", "-m", "init"]);
}

/**
 * A child that settles cleanly and writes its artifact, followed by a real
 * post-settle failure at the isolation merge boundary.
 */
function mockPostSettleMergeFailure(): { artifactPath: () => string } {
	let artifactPath = "";
	vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
		const artifactsDir = options.baseOptions.artifactsDir;
		if (!artifactsDir) throw new Error("artifactsDir missing");
		artifactPath = await writeChildArtifact(artifactsDir, options.agentId, "Partial findings.");
		return {
			...failedResult(options.agentId, artifactPath),
			exitCode: 0,
			error: undefined,
			patchPath: path.join(artifactsDir, "child.patch"),
		};
	});
	vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockRejectedValue(new Error("merge backend unavailable"));
	return { artifactPath: () => artifactPath };
}

const managers: AsyncJobManager[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 1000 });
	}
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
});

describe("failed child artifact hand-back", () => {
	it("keeps a failed child's artifact readable through its agent:// handle", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-");
		mockDiscovery();
		let artifactPath = "";
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (!options.artifactsDir) throw new Error("artifactsDir missing");
			artifactPath = await writeChildArtifact(options.artifactsDir, options.id, "Findings: 42 rows.");
			return failedResult(options.id, artifactPath);
		});

		const execution = await runStructuredSubagent({
			session: session(tempDir.path()),
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "worker",
		});

		expect(execution.result.exitCode).toBe(2);
		expect(execution.result.error).toBe("Subagent aborted task");
		expect(execution.result.outputPath).toBe(artifactPath);
		// The artifact the failure points at must survive the run's cleanup.
		expect(await fs.readFile(artifactPath, "utf-8")).toBe("Findings: 42 rows.");
		const resolved = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${execution.result.id}`));
		expect(resolved.content).toBe("Findings: 42 rows.");
	});

	it("carries the child's exit status and artifact on a post-settle failure", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-postsettle-");
		await createRepo(tempDir.path());
		mockDiscovery();
		const child = mockPostSettleMergeFailure();

		const failure = await runStructuredSubagent({
			session: session(tempDir.path(), { "task.isolation.enabled": true, "task.isolation.apply": true }),
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "worker",
			isolation: { requested: true },
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(StructuredSubagentError);
		const error = failure as StructuredSubagentError;
		expect(error.kind).toBe("execution");
		expect(error.result?.exitCode).toBe(0);
		expect(error.result?.outputPath).toBe(child.artifactPath());
		expect(error.message).toContain("merge backend unavailable");
		expect(error.message).toContain(`agent://${error.result?.id}`);
		expect(error.message).toContain(child.artifactPath());
		expect(await fs.readFile(child.artifactPath(), "utf-8")).toBe("Partial findings.");
	});

	it("hands the task tool the child's result and artifact while still reporting failure", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-tasktool-");
		await createRepo(tempDir.path());
		mockDiscovery();
		const child = mockPostSettleMergeFailure();

		const tool = await TaskTool.create(
			session(tempDir.path(), { "task.isolation.enabled": true, "task.isolation.apply": true }),
		);
		const result = await tool.execute("tc-failed", {
			agent: "worker",
			task: "Inspect the target.",
			isolated: true,
		} as TaskParams);

		const text = result.content.find(part => part.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain("Task execution failed");
		expect(result.details?.results).toHaveLength(1);
		const salvaged = result.details?.results[0];
		expect(salvaged?.output).toBe("Findings: 42 rows.");
		expect(result.details?.outputPaths).toEqual([child.artifactPath()]);
		expect(result.details?.usage?.input).toBe(CHILD_USAGE.input);
		const resolved = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${salvaged?.id}`));
		expect(resolved.content).toBe("Partial findings.");
	});

	it("renders the salvaged row as a merge failure instead of a completed agent", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-render-");
		await createRepo(tempDir.path());
		mockDiscovery();
		mockPostSettleMergeFailure();

		const tool = await TaskTool.create(
			session(tempDir.path(), { "task.isolation.enabled": true, "task.isolation.apply": true }),
		);
		const result = await tool.execute("tc-failed-render", {
			agent: "worker",
			task: "Inspect the target.",
			isolated: true,
		} as TaskParams);

		// The renderer is what the operator actually reads. It re-derives
		// pass/fail from the salvaged row, so a kept `exitCode: 0` must not
		// render the row as done.
		// The renderer reads the global settings for its model badge.
		await Settings.init({ inMemory: true });
		const theme = (await getThemeByName("dark"))!;
		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult(result, { expanded: true, isPartial: false, spinnerFrame: 0 }, theme)
				.render(120)
				.join("\n"),
		);
		const salvagedId = result.details?.results[0]?.id ?? "";
		expect(salvagedId).not.toBe("");
		const row = rendered.split("\n").find(line => line.includes(salvagedId));
		expect(row).toContain("merge failed");
		expect(row).not.toContain("done");
	});

	it("fails the async job when a dispatched child settles cleanly but its merge does not", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-async-");
		await createRepo(tempDir.path());
		mockDiscovery();
		const child = mockPostSettleMergeFailure();
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});
		managers.push(manager);

		const tool = await TaskTool.create(
			session(tempDir.path(), { "task.isolation.enabled": true, "task.isolation.apply": true }, manager),
		);
		const spawn = await tool.execute("tc-failed-async", {
			agent: "worker",
			task: "Inspect the target.",
			isolated: true,
		} as TaskParams);

		const jobId = spawn.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		// The child's own exit code is 0 — the merge is what failed. Anything
		// polling this job (progress row, orchestrating parent) must be told the
		// isolated edit never landed.
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("failed");
		expect(job?.errorText).toContain("merge backend unavailable");
		expect(delivered.map(entry => entry.jobId)).toEqual([jobId!]);
		expect(delivered[0]?.text).toContain("merge backend unavailable");
		// The salvaged artifact still has to reach the parent through the handle.
		expect(await fs.readFile(child.artifactPath(), "utf-8")).toBe("Partial findings.");
	});

	it("reports a batch as failed when one of its inline children fails to merge", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-batch-");
		await createRepo(tempDir.path());
		mockDiscovery();
		mockPostSettleMergeFailure();

		// No job manager: both items run inline through the fanout, whose merged
		// payload is the only thing the caller ever sees.
		const tool = await TaskTool.create(
			session(tempDir.path(), {
				"task.batch": true,
				"task.isolation.enabled": true,
				"task.isolation.apply": true,
			}),
		);
		const result = await tool.execute("tc-failed-batch", {
			context: "Both items touch the same isolated checkout.",
			isolated: true,
			tasks: [
				{ name: "WorkerA", agent: "worker", task: "Inspect A." },
				{ name: "WorkerB", agent: "worker", task: "Inspect B." },
			],
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(result.details?.results.map(entry => entry.id).sort()).toEqual(["WorkerA", "WorkerB"]);
	});
});
