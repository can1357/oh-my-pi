/**
 * Where an isolated child's changes land. A parent session may run from the
 * main checkout while it works in a linked worktree; the apply must follow
 * the checkout the spawn names, and a refused apply must leave the checkout
 * untouched with the patch kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BeforeSubagentApplyEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

function git(cwd: string, ...args: string[]): string {
	const out = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
	if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
	return out.stdout.toString();
}

/** A main checkout on `main` holding another session's uncommitted edit, plus a linked worktree on `feature`. */
async function mainWithLinkedWorktree(root: string): Promise<{ main: string; worktree: string }> {
	const main = path.join(root, "main");
	const worktree = path.join(root, "wt");
	await fs.mkdir(main);
	git(main, "init", "-q", "-b", "main");
	await Bun.write(path.join(main, "README.md"), "seed\n");
	git(main, "add", "README.md");
	git(main, "commit", "-q", "-m", "seed");
	git(main, "worktree", "add", "-q", "-b", "feature", worktree);
	await Bun.write(path.join(main, "README.md"), "seed\nconcurrent edit\n");
	return { main, worktree };
}

function createSession(cwd: string, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": true,
			"task.isolation.apply": true,
			"task.isolation.merge": "patch",
			"isolation.backend": "rcopy",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...extra,
	} as unknown as ToolSession;
}

/** The child reports it is running, then writes `feature.txt` in the isolated copy it was given. */
function childWritesFeatureFile(): void {
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		if (!options.worktree) throw new Error("isolated child got no worktree");
		options.onProgress?.({
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			status: "running",
			task: "Write the feature.",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		});
		await Bun.write(path.join(options.worktree, "feature.txt"), "child work\n");
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: "Write the feature.",
			exitCode: 0,
			output: "Wrote feature.txt.",
			stderr: "",
			truncated: false,
			durationMs: 3,
			tokens: 30,
			requests: 2,
		};
	});
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
});

describe("isolated apply destination", () => {
	it("applies into the checkout the spawn names and leaves the parent's dirty main byte-identical", async () => {
		using tempDir = TempDir.createSync("@omp-apply-destination-");
		const { main, worktree } = await mainWithLinkedWorktree(tempDir.path());
		const mainStatusBefore = git(main, "status", "--porcelain");
		childWritesFeatureFile();

		const tool = await TaskTool.create(createSession(main));
		const shownDestinations = new Set<string | undefined>();
		const result = await tool.execute(
			"tc-dest",
			{ agent: "worker", task: "Write the feature.", isolated: true, checkout: worktree } as TaskParams,
			undefined,
			update => {
				for (const progress of update.details?.progress ?? []) shownDestinations.add(progress.checkout);
			},
		);

		expect(result.isError).not.toBe(true);
		expect(git(main, "status", "--porcelain")).toBe(mainStatusBefore);
		expect(await Bun.file(path.join(main, "README.md")).text()).toBe("seed\nconcurrent edit\n");
		expect(await Bun.file(path.join(worktree, "feature.txt")).text()).toBe("child work\n");
		expect([...shownDestinations]).toEqual([worktree]);
	});

	it("leaves the checkout untouched and keeps the patch when an extension refuses the apply", async () => {
		using tempDir = TempDir.createSync("@omp-apply-refused-");
		const { main } = await mainWithLinkedWorktree(tempDir.path());
		const mainStatusBefore = git(main, "status", "--porcelain");
		childWritesFeatureFile();
		const events: BeforeSubagentApplyEvent[] = [];

		const tool = await TaskTool.create(
			createSession(main, {
				emitBeforeSubagentApply: async event => {
					events.push(event);
					return { block: true, reason: "main is protected; name a worktree checkout" };
				},
			}),
		);
		const result = await tool.execute("tc-refused", {
			agent: "worker",
			task: "Write the feature.",
			isolated: true,
		} as TaskParams);

		expect(await Promise.all(events.map(event => fs.realpath(event.checkout)))).toEqual([await fs.realpath(main)]);
		expect(await Bun.file(path.join(main, "feature.txt")).exists()).toBe(false);
		expect(git(main, "status", "--porcelain")).toBe(mainStatusBefore);
		const patchPath = result.details?.results[0]?.patchPath;
		expect(patchPath).toBeDefined();
		expect(await Bun.file(patchPath!).text()).toContain("feature.txt");
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("main is protected; name a worktree checkout");
		expect(text).toContain(patchPath!);
	});
});
