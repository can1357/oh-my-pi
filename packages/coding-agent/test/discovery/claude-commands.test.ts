import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@pk-nerdsaver-ai/pi-coding-agent/capability/fs";
import { type SlashCommand, slashCommandCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

describe("Claude Code slash command discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-commands-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await removeWithRetries(root);
	});

	test("loads subdirectory commands under both basename and namespace names", async () => {
		await writeFile(path.join(project, ".claude", "commands", "triage.md"), "Triage prompt\n");
		await writeFile(path.join(project, ".claude", "commands", "opsx", "apply.md"), "Apply prompt\n");
		await writeFile(path.join(home, ".claude", "commands", "team", "audit.md"), "Audit prompt\n");

		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const names = result.items.map(command => command.name);

		expect(result.warnings).toEqual([]);
		expect(names).toContain("triage");
		expect(names).toContain("apply");
		expect(names).toContain("opsx:apply");
		expect(names).toContain("audit");
		expect(names).toContain("team:audit");
	});
	test("keeps root commands ahead of nested basename duplicates", async () => {
		const rootApply = path.join(project, ".claude", "commands", "apply.md");
		const nestedApply = path.join(project, ".claude", "commands", "agent", "apply.md");
		await writeFile(rootApply, "Root apply prompt\n");
		await writeFile(nestedApply, "Nested apply prompt\n");

		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const apply = result.items.find(command => command.name === "apply");
		const agentApply = result.items.find(command => command.name === "agent:apply");

		expect(result.warnings).toEqual([]);
		expect(apply?.path).toBe(rootApply);
		expect(apply?.content).toBe("Root apply prompt\n");
		expect(agentApply?.path).toBe(nestedApply);
		expect(agentApply?.content).toBe("Nested apply prompt\n");
	});
});
