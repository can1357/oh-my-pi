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
import { GlobTool } from "../../src/tools/glob";
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

	it("fans out for find (GlobTool) too", async () => {
		const tool = new GlobTool(createSession());

		const result = await tool.execute("semicolon-find", { path: `skill://demo;${absFile}` });

		const text = getResultText(result);
		expect(text).toContain("SKILL.md");
		expect(text).toContain("abs-target.md");
	});

	it("keeps a list with a glob or missing local part whole (strict rule)", async () => {
		const tool = new GrepTool(createSession());

		for (const target of ["skill://demo;*.md", "skill://demo;missing.md", "skill://demo;nope"]) {
			let message = "";
			try {
				await tool.execute("semicolon-whole", { pattern: "needle", path: target });
			} catch (err) {
				message = String(err instanceof Error ? err.message : err);
			}
			expect(message).not.toBe("");
			expect(message).not.toContain("abs path needle");
		}
	});

	it("gives a literal `;` in a routed URL path precedence over an existing relative tail", async () => {
		await Bun.write(path.join(tmpDir, "b.md"), "relative tail needle\n");
		const tool = new GrepTool(createSession());

		let message = "";
		let text = "";
		try {
			text = getResultText(
				await tool.execute("semicolon-literal", { pattern: "needle", path: "skill://demo/a;b.md" }),
			);
		} catch (err) {
			message = String(err instanceof Error ? err.message : err);
		}
		expect(`${text}${message}`).not.toContain("relative tail needle");
	});
});
