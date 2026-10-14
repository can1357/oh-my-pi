import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
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
import { ReadTool } from "../../src/tools/read";
import { expandDelimitedPathEntries, resolveReadPath, splitDelimitedPathEntry } from "../../src/tools/path-utils";

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

		for (const [target, diagnosis] of [
			["skill://demo;*.md", "Cannot search skill://: skill:// URL requires a skill name: skill://<name>"],
			[
				"skill://demo;missing.md",
				"Cannot search skill://demo;missing.md: Unknown skill: demo;missing.md\nAvailable: demo",
			],
			["skill://demo;nope", "Cannot search skill://demo;nope: Unknown skill: demo;nope\nAvailable: demo"],
		] as const) {
			// A glob is parsed below skill:// after delimiter recovery; prove the
			// recovery step itself retained the exact authored target as well.
			expect(await expandDelimitedPathEntries([target], tmpDir)).toEqual([target]);
			await expect(tool.execute("semicolon-whole", { pattern: "needle", path: target })).rejects.toMatchObject({
				message: diagnosis,
			});
		}
	});

	it("gives a literal `;` in a routed URL path precedence over an existing relative tail", async () => {
		await Bun.write(path.join(tmpDir, "b.md"), "relative tail needle\n");
		await Bun.write(path.join(tmpDir, "skills", "demo", "a;b.md"), "literal resource needle\n");
		const tool = new GrepTool(createSession());

		const result = await tool.execute("semicolon-literal", { pattern: "needle", path: "skill://demo/a;b.md" });
		const text = getResultText(result);
		expect(text).toContain("literal resource needle");
		expect(result.details?.searchPath).toBe("skill://demo/a;b.md");
		expect(text).not.toContain("relative tail needle");
	});

	it("fans out a URL with path segments followed by either UNC spelling", async () => {
		const url = "skill://demo/subdir";
		const uncStat = await fs.lstat(absFile);
		const realLstat = nodeFs.promises.lstat.bind(nodeFs.promises);
		for (const tail of [String.raw`\\server\share\file.md`, "//server/share/file.md"]) {
			// Linux cannot stat a native Windows UNC share. Supply only that
			// literal-existence result; run the real canonical delimiter parser
			// and cross-platform anchor classifier without changing platform.
			const resolvedUnc = resolveReadPath(tail, tmpDir);
			const literalProbe = spyOn(nodeFs.promises, "lstat").mockImplementation((async (target: nodeFs.PathLike) =>
				target === resolvedUnc ? uncStat : realLstat(target)) as typeof nodeFs.promises.lstat);
			try {
				expect(await expandDelimitedPathEntries([`${url};${tail}`], tmpDir)).toEqual([url, tail]);
			} finally {
				literalProbe.mockRestore();
			}
		}
	});

	it("searches, finds, and reads a routed resource ending in a literal semicolon without truncating its target", async () => {
		await Bun.write(path.join(tmpDir, "skills", "demo", "a"), "wrong resource needle\n");
		await Bun.write(path.join(tmpDir, "skills", "demo", "a;"), "trailing semicolon needle\n");
		const target = "skill://demo/a;";
		const result = await new GrepTool(createSession()).execute("trailing-semicolon-search", {
			pattern: "needle",
			path: target,
		});
		const text = getResultText(result);
		expect(text).toContain("trailing semicolon needle");
		expect(result.details?.searchPath).toBe(target);
		expect(text).not.toContain("wrong resource needle");
		const found = await new GlobTool(createSession()).execute("trailing-semicolon-find", { path: target });
		expect(found.details?.files).toEqual([target]);
		const read = await new ReadTool(createSession()).execute("trailing-semicolon-read", { path: target });
		const readText = getResultText(read);
		expect(readText).toContain("trailing semicolon needle");
		expect(readText).not.toContain("wrong resource needle");
	});

	it("covers the routed-predicate parser boundary for a trailing semicolon and two URLs", async () => {
		const router = InternalUrlRouter.instance();
		const options = { routedUrlPredicate: (entry: string) => router.canHandle(entry) };
		expect(await splitDelimitedPathEntry("skill://demo/a;", tmpDir, options)).toBeNull();
		expect(await splitDelimitedPathEntry("skill://demo/a;skill://demo/b", tmpDir, options)).toEqual([
			"skill://demo/a",
			"skill://demo/b",
		]);
	});
});
