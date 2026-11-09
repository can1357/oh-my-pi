import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const dirs: string[] = [];
function fixture(): { root: string; agents: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-prompt-"));
	dirs.push(root);
	const agents = path.join(root, ".omp", "agents");
	fs.mkdirSync(path.join(agents, "prompts"), { recursive: true });
	return { root, agents };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
});

describe("agent team prompts", () => {
	test("parses team flags without changing unspecified definitions", () => {
		expect(parseAgentFields({ name: "worker", description: "Fixture", team: true })?.team).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "Fixture", team: "false" })?.team).toBe(false);
		expect(parseAgentFields({ name: "worker", description: "Fixture" })?.team).toBeUndefined();
	});

	test("loads relative team prompt separately from the normal body", async () => {
		const { root, agents } = fixture();
		fs.writeFileSync(
			path.join(agents, "worker.md"),
			"---\nname: team-fixture\ndescription: Fixture\nteam: false\nteam-prompt: prompts/team.md\n---\nNormal instructions.\n",
		);
		fs.writeFileSync(path.join(agents, "prompts", "team.md"), "Team instructions.\n");
		const agent = (await discoverAgents(root, root)).agents.find(a => a.name === "team-fixture");
		expect(agent?.team).toBe(false);
		expect(agent?.systemPrompt.trim()).toBe("Normal instructions.");
		expect(agent?.teamSystemPrompt).toBe("Team instructions.\n");
	});

	test("reports a missing team prompt instead of falling back", async () => {
		const { root, agents } = fixture();
		fs.writeFileSync(
			path.join(agents, "scout.md"),
			"---\nname: scout\ndescription: Override\nteam-prompt: prompts/missing.md\n---\nNormal instructions.\n",
		);
		const agent = (await discoverAgents(root, root)).agents.find(candidate => candidate.name === "scout");
		expect(agent?.description).toBe("Override");
		expect(agent?.teamPromptError).toContain(path.join("prompts", "missing.md"));
		expect(agent?.teamPromptError).toContain("ENOENT");
		expect(agent?.teamSystemPrompt).toBeUndefined();
	});

	test.each(["scout", "reviewer"])("bundles a distinct team prompt for %s", name => {
		const agent = getBundledAgent(name);
		expect(agent?.teamSystemPrompt).toBeTruthy();
		expect(agent?.teamSystemPrompt).not.toBe(agent?.systemPrompt);
		expect(agent?.teamSystemPrompt).toContain("lead");
		expect(agent?.teamSystemPrompt).toContain("read-only");
	});
	test("bundled variants retain their distinct role instructions", () => {
		expect(getBundledAgent("scout")?.teamSystemPrompt).toContain("architecture");
		expect(getBundledAgent("scout")?.teamSystemPrompt).toContain("alternate strategy");
		expect(getBundledAgent("reviewer")?.teamSystemPrompt).toContain("provable impact");
		expect(getBundledAgent("reviewer")?.teamSystemPrompt).toContain("consuming dispatch point");
	});
});
