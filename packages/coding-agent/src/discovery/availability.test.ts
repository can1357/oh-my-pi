/**
 * Agent availability parsing from frontmatter.
 *
 * OpenCode `mode` and Copilot `user-invocable` / `disable-model-invocation`
 * frontmatter control which session roles an agent may serve. Absent both →
 * "all" (backward compatible); when both schemas are present the more
 * restrictive wins (Copilot fields take precedence over OpenCode `mode`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	resolveEffectiveSubagentPolicy,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function agentMd(name: string, extraFrontmatter: string[] = []): string {
	return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", `You are ${name}.`].join("\n");
}

describe("agent availability", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-availability-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });

		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.writeFile(path.join(agentsDir, "subagent-mode.md"), agentMd("subagent-mode", ["mode: subagent"]));
		await fs.writeFile(
			path.join(agentsDir, "copilot-subagent.md"),
			agentMd("copilot-subagent", ["user-invocable: false"]),
		);
		await fs.writeFile(
			path.join(agentsDir, "copilot-primary.md"),
			agentMd("copilot-primary", ["disable-model-invocation: true"]),
		);
		await fs.writeFile(path.join(agentsDir, "primary-mode.md"), agentMd("primary-mode", ["mode: primary"]));
		await fs.writeFile(path.join(agentsDir, "no-availability.md"), agentMd("no-availability"));
		await fs.writeFile(
			path.join(agentsDir, "restrictive-wins.md"),
			agentMd("restrictive-wins", ["mode: all", "user-invocable: false"]),
		);
		await fs.writeFile(
			path.join(agentsDir, "both-gates.md"),
			agentMd("both-gates", ["user-invocable: false", "disable-model-invocation: true"]),
		);
		await fs.writeFile(
			path.join(agentsDir, "contradictory-primary.md"),
			agentMd("contradictory-primary", ["mode: primary", "user-invocable: false"]),
		);
		await fs.writeFile(
			path.join(agentsDir, "contradictory-subagent.md"),
			agentMd("contradictory-subagent", ["mode: subagent", "disable-model-invocation: true"]),
		);
		await fs.writeFile(
			path.join(agentsDir, "non-contradictory-primary.md"),
			agentMd("non-contradictory-primary", ["mode: primary", "user-invocable: true"]),
		);
		await fs.writeFile(
			path.join(agentsDir, "non-contradictory-all.md"),
			agentMd("non-contradictory-all", ["mode: all", "disable-model-invocation: false"]),
		);
	});

	afterEach(async () => {
		enableProvider("omp-plugins");
		clearOmpExtensionCliRoots();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	async function discovered(name: string) {
		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === name);
		expect(agent).toBeDefined();
		return agent;
	}

	test("parses OpenCode mode: subagent", async () => {
		expect((await discovered("subagent-mode"))?.availability).toBe("subagent");
	});

	test("parses Copilot user-invocable: false", async () => {
		expect((await discovered("copilot-subagent"))?.availability).toBe("subagent");
	});

	test("parses Copilot disable-model-invocation: true", async () => {
		expect((await discovered("copilot-primary"))?.availability).toBe("primary");
	});

	test("parses OpenCode mode: primary", async () => {
		expect((await discovered("primary-mode"))?.availability).toBe("primary");
	});

	test("defaults to all when no availability frontmatter is present", async () => {
		expect((await discovered("no-availability"))?.availability).toBe("all");
	});

	test("restrictive wins when both schemas are present", async () => {
		expect((await discovered("restrictive-wins"))?.availability).toBe("subagent");
	});

	test("both Copilot gates deny both roles (unavailable)", async () => {
		expect((await discovered("both-gates"))?.availability).toBe("unavailable");
	});

	test("contradictory gates: mode: primary + user-invocable: false → unavailable", async () => {
		expect((await discovered("contradictory-primary"))?.availability).toBe("unavailable");
	});

	test("contradictory gates: mode: subagent + disable-model-invocation: true → unavailable", async () => {
		expect((await discovered("contradictory-subagent"))?.availability).toBe("unavailable");
	});

	test("non-contradictory: mode: primary + user-invocable: true → primary", async () => {
		expect((await discovered("non-contradictory-primary"))?.availability).toBe("primary");
	});

	test("non-contradictory: mode: all + disable-model-invocation: false → all", async () => {
		expect((await discovered("non-contradictory-all"))?.availability).toBe("all");
	});

	test("rejects primary agents from subagent spawning", async () => {
		const session = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.enabled": false,
				"task.enableLsp": true,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getPlanModeState: () => undefined,
		} as unknown as ToolSession;
		const request: StructuredSubagentRequest = {
			session,
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "primary-mode",
		};

		await expect(resolveEffectiveSubagentPolicy(request)).rejects.toThrow(
			'Agent "primary-mode" is primary/main-session-only and cannot be spawned as a subagent.',
		);
	});
});
