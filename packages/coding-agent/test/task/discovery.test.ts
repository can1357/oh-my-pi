import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const OMP_AGENT_MD = [
	"---",
	"name: omp-test-agent",
	"description: OMP-native test agent.",
	"---",
	"You are an OMP task agent.",
].join("\n");

const CLAUDE_AGENT_MD = [
	"---",
	"name: cc-test-agent",
	"description: Test Claude Code agent.",
	"tools: Read, Grep, Glob, Bash",
	"model: sonnet",
	"color: purple",
	"---",
	"You are a Claude Code custom subagent.",
].join("\n");

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(tempHome);
	});

	test("loads OMP agents but skips Claude Code custom agents", async () => {
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "agents", "omp-test-agent.md"), OMP_AGENT_MD);

		await fs.mkdir(path.join(tempHome, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(tempHome, ".claude", "agents", "user-cc-test-agent.md"), CLAUDE_AGENT_MD);
		await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "agents", "project-cc-test-agent.md"), CLAUDE_AGENT_MD);

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("omp-test-agent");
		expect(names).not.toContain("cc-test-agent");
		expect(projectAgentsDir).toBe(path.join(projectDir, ".omp", "agents"));
	});
});
