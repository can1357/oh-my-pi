import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	BUILTIN_TEAMS_SLASH_COMMANDS,
	resetTeamMembershipsForTests,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-teams";
import * as spawnSubagent from "@oh-my-pi/pi-coding-agent/task/spawn-subagent";
import {
	releaseStructuredSubagentId,
	reserveStructuredSubagentId,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	resetTeamMembershipsForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

test("team start rejects a selected broken team prompt before creating a workspace or reserving and spawning members", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-team-prompt-preflight-"));
	try {
		const agentsDir = path.join(root, ".omp", "agents");
		const teamsDir = path.join(root, ".omp", "teams");
		const workspace = path.join(root, "workspace");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.mkdir(teamsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "good.md"),
			"---\nname: good\ndescription: good\ntools: [write]\n---\nGood body\n",
		);
		await fs.writeFile(
			path.join(agentsDir, "broken.md"),
			"---\nname: broken\ndescription: broken\ntools: [write]\nteam-prompt: missing.txt\n---\nBroken body\n",
		);
		await fs.writeFile(
			path.join(teamsDir, "audit.md"),
			[
				"---",
				"name: audit",
				"description: audit team",
				`workspace: ${JSON.stringify(workspace)}`,
				"members:",
				"  - agent: good",
				"    handle: Good",
				"  - agent: broken",
				"    handle: Broken",
				"---",
				"Audit the services.",
			].join("\n"),
		);
		const outputs: string[] = [];
		const toolSession = { getArtifactsDir: () => null } as unknown as ToolSession;
		const runtime = {
			settings: Settings.isolated({ "team.enabled": true, "team.maxTeammates": 10 }),
			session: { effectiveExtensionRoots: undefined, toolSession },
			sessionManager: { getCwd: () => root },
			output: (text: string) => {
				outputs.push(text);
			},
		};
		const spawn = vi.spyOn(spawnSubagent, "spawnSubagentForSession");
		const handle = BUILTIN_TEAMS_SLASH_COMMANDS[0]!.handle as unknown as (
			command: { args: string },
			runtime: unknown,
		) => Promise<void>;
		await handle({ args: "start audit" }, runtime);
		expect(outputs.join("\n")).toContain("broken");
		expect(outputs.join("\n")).toContain("missing.txt");
		expect(outputs.join("\n")).toContain("ENOENT");
		expect(spawn).not.toHaveBeenCalled();
		expect(
			await fs.stat(workspace).then(
				() => true,
				() => false,
			),
		).toBe(false);
		for (const label of ["Good", "Broken"]) {
			const id = await reserveStructuredSubagentId(toolSession, { label });
			expect(id).toBe(label);
			releaseStructuredSubagentId(toolSession, id);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
