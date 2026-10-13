import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("GrepTool semicolon internal-URL path lists", () => {
	let tmpDir: string;
	let skillBodyNeedle: string;
	let absFile: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-semicolon-"));
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();

		const skillDir = path.join(tmpDir, "skills", "demo");
		await fs.mkdir(skillDir, { recursive: true });
		skillBodyNeedle = "skill body needle in instructions";
		await Bun.write(path.join(skillDir, "SKILL.md"), `---\nname: demo\n---\n\n# Demo\n\n${skillBodyNeedle}\n`);
		setActiveSkills([
			{
				name: "demo",
				description: "demo skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);

		absFile = path.join(tmpDir, "abs-target.md");
		await Bun.write(absFile, "abs path needle\n");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
	});

	function createSession(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		} as ToolSession;
	}

	it("finds matches from every part of a `;` list mixing an internal URL and an absolute path", async () => {
		const tool = new GrepTool(createSession());

		const result = await tool.execute("semicolon-list", {
			pattern: "needle",
			path: `skill://demo;${absFile}`,
		});

		const text = getResultText(result);
		expect(text).toContain(skillBodyNeedle);
		expect(text).toContain("abs path needle");
	});

	it("finds body text of the skill instruction file through bare skill://", async () => {
		const tool = new GrepTool(createSession());

		const result = await tool.execute("skill-body", {
			pattern: "skill body needle in instructions",
			path: "skill://demo",
		});

		expect(getResultText(result)).toContain(skillBodyNeedle);
	});

	it("keeps a plain single path unchanged", async () => {
		const tool = new GrepTool(createSession());

		const result = await tool.execute("plain-path", {
			pattern: "needle",
			path: absFile,
		});

		const text = getResultText(result);
		expect(text).toContain("abs path needle");
		expect(text).not.toContain(skillBodyNeedle);
	});
});
