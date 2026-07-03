import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const READ_TOOL = new Map([["read", { label: "Read", description: "Read files" }]]);

function makeSkills(count: number): Skill[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `skill-${i}`,
		description: `Description of skill ${i}`,
		filePath: `/skills/skill-${i}/SKILL.md`,
		baseDir: `/skills/skill-${i}`,
		source: "test",
	}));
}

describe("system prompt lazy skill discovery", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-lazy-skills-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-lazy-skills-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(skills: Skill[], discoveryMode?: "lazy"): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills,
			rules: [],
			tools: READ_TOOL,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			skillsSettings: discoveryMode ? { discoveryMode } : undefined,
		});
		return systemPrompt.join("\n\n");
	}

	it("replaces the listing with an on-demand search notice in lazy mode", async () => {
		const rendered = await render(makeSkills(3), "lazy");
		expect(rendered).not.toContain("<skills>");
		expect(rendered).not.toContain("- skill-0:");
		expect(rendered).toContain("3 specialized skills are available but not listed");
		expect(rendered).toContain("skill://?q=<keywords>");
	});

	it("defaults to request-only discovery and ignores prompt listing for every catalog size", async () => {
		const defaultRendered = await render(makeSkills(3));
		expect(defaultRendered).not.toContain("<skills>");
		expect(defaultRendered).toContain("skill://?q=<keywords>");

		const many = await render(makeSkills(100), "lazy");
		expect(many).not.toContain("<skills>");
		expect(many).toContain("100 specialized skills are available but not listed");
	});

	it("omits both listing and notice when no skills exist", async () => {
		const rendered = await render([], "lazy");
		expect(rendered).not.toContain("<skills>");
		expect(rendered).not.toContain("specialized skills are available");
	});
});
