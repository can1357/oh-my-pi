/**
 * A child that finished and wrote its output, followed by a failure in a later
 * step (the isolation merge), still owes the parent its exit status and the
 * artifact. Without them the parent sees a bare error and redoes the work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

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
		// Scrub host git config: a global/system core.fsmonitor, hooksPath, or
		// credential helper on the runner can spawn a daemon or block these
		// calls forever — the child git must see the same env hygiene the
		// in-process vcs wrapper applies (GIT_TERMINAL_PROMPT, askpass, locks).
		const GIT_ENV: Record<string, string> = {
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
			GIT_EDITOR: "true",
			GIT_OPTIONAL_LOCKS: "0",
		};
		const git = (...args: string[]) => {
			const proc = Bun.spawnSync(["git", ...args], {
				cwd: tempDir.path(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				env: { ...process.env, ...GIT_ENV },
			});
			if (proc.exitCode !== 0) {
				throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
			}
		};
		git("init", "-q");
		await fs.writeFile(path.join(tempDir.path(), "README.md"), "seed\n");
		git("add", "README.md");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
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

		const tool = await TaskTool.create({
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.isolation.apply": true,
				"isolation.backend": "rcopy",
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
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
});
