/**
 * A child that finished and wrote its output, followed by a failure in a later
 * step (the isolation merge), still owes the parent its exit status and the
 * artifact. Without them the parent sees a bare error and redoes the work.
 * A call that ran several children is an error when any one of them failed
 * this way, the same as a one-child call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

const BLOCKING_AGENT: AgentDefinition = {
	name: "reviewer",
	description: "Test reviewer the parent waits on",
	systemPrompt: "Review the work.",
	source: "bundled",
	blocking: true,
};

async function initRepo(dir: string): Promise<void> {
	const git = (...args: string[]) => {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd: dir,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "true",
				GIT_EDITOR: "true",
				GIT_OPTIONAL_LOCKS: "0",
			},
		});
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
		}
	};
	git("init", "-q");
	await fs.writeFile(path.join(dir, "README.md"), "seed\n");
	git("add", "README.md");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
}

function createSession(
	cwd: string,
	settings: Record<string, unknown> = {},
	asyncJobManager?: AsyncJobManager,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": true,
			"task.isolation.apply": true,
			"isolation.backend": "rcopy",
			...settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager,
	} as unknown as ToolSession;
}

function finishedChild(id: string, agent: string): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "Do the assigned work.",
		exitCode: 0,
		output: `${id} finished.`,
		stderr: "",
		truncated: false,
		durationMs: 3,
		tokens: 30,
		requests: 2,
	};
}

/**
 * Every child exits 0. An isolated child's checkout stops being a git
 * repository once it finishes, so its merge step throws; a plain child has
 * nothing to merge.
 */
async function finishChildrenThenBreakMerge(dir: string): Promise<void> {
	await initRepo(dir);
	vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions, agentId }) => {
		await fs.rm(path.join(dir, ".git"), { recursive: true, force: true });
		return finishedChild(agentId, baseOptions.agent.name);
	});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
		finishedChild(options.id, options.agent.name),
	);
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
});

describe("failed child evidence", () => {
	it("hands the parent the finished child's exit status and readable artifact when the merge throws", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		await initRepo(tempDir.path());
		let artifactPath = "";
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions, agentId }) => {
			// The real isolation context was prepared; the checkout stops being a
			// git repository after the child finishes, so the merge step throws.
			await fs.rm(path.join(tempDir.path(), ".git"), { recursive: true, force: true });
			const artifactsDir = baseOptions.artifactsDir;
			if (!artifactsDir) throw new Error("artifactsDir missing");
			artifactPath = path.join(artifactsDir, `${agentId}.md`);
			await fs.writeFile(artifactPath, "Findings: 42 rows.");
			return {
				index: 0,
				id: agentId,
				agent: "worker",
				agentSource: "bundled",
				task: "Inspect the target.",
				exitCode: 0,
				output: "Findings: 42 rows.",
				stderr: "",
				truncated: false,
				durationMs: 3,
				tokens: 30,
				requests: 2,
				outputPath: artifactPath,
				patchPath: path.join(artifactsDir, `${agentId}.patch`),
			};
		});

		const tool = await TaskTool.create(createSession(tempDir.path()));
		const result = await tool.execute("tc-failed", {
			agent: "worker",
			task: "Inspect the target.",
			isolated: true,
		} as TaskParams);

		const text = result.content.find(part => part.type === "text");
		const salvaged = result.details?.results[0];
		expect(result.isError).toBe(true);
		expect(salvaged?.exitCode).toBe(0);
		expect(salvaged?.outputPath).toBe(artifactPath);
		expect(text?.type === "text" ? text.text : "").toContain(`exit 0. Its output is at \`agent://${salvaged?.id}\``);
		// The artifact the failure points at survives the run's cleanup.
		const resolved = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${salvaged?.id}`));
		expect(resolved.content).toBe("Findings: 42 rows.");
		await fs.rm(path.dirname(artifactPath), { recursive: true, force: true });
	});

	it.each([
		{ lane: "one child's merge throws", isolated: true },
		{ lane: "both children finish", isolated: false },
	])("marks a two-child call an error only when a child failed: $lane", async ({ isolated }) => {
		using tempDir = TempDir.createSync("@omp-failed-child-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		await finishChildrenThenBreakMerge(tempDir.path());

		const tool = await TaskTool.create(createSession(tempDir.path(), { "async.enabled": false }));
		const result = await tool.execute("tc-two-children", {
			context: "Shared context.",
			tasks: [
				{ name: "Changer", agent: "worker", task: "Change the file.", isolated },
				{ name: "Reader", agent: "worker", task: "Read the file." },
			],
		});

		// Only the child whose merge threw carries an error; the sibling's row stays clean.
		expect(result.details?.results.map(row => row.error !== undefined)).toEqual([isolated, false]);
		expect(result.isError === true).toBe(isolated);
	});

	it("marks a mixed call an error when its blocking child's merge throws", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [AGENT, BLOCKING_AGENT],
			projectAgentsDir: null,
		});
		await finishChildrenThenBreakMerge(tempDir.path());
		const manager = new AsyncJobManager({ onJobComplete: () => {} });

		try {
			const tool = await TaskTool.create(createSession(tempDir.path(), { "async.enabled": true }, manager));
			const result = await tool.execute("tc-mixed", {
				context: "Shared context.",
				tasks: [
					{ name: "Reviewer", agent: "reviewer", task: "Review the change.", isolated: true },
					{ name: "Builder", agent: "worker", task: "Build the change." },
				],
			});
			await manager.getJob("Builder")?.promise;

			// The blocking child ran inline and the other became a background job.
			expect(result.details?.results.map(row => row.id)).toEqual(["Reviewer"]);
			expect(result.isError).toBe(true);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
