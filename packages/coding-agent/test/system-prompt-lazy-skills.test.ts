import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt, SKILLS_LAZY_AUTO_THRESHOLD } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
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

	async function render(skills: Skill[], discoveryMode?: "eager" | "auto" | "lazy"): Promise<string> {
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

	it("lists every skill in eager mode regardless of catalog size", async () => {
		const rendered = await render(makeSkills(SKILLS_LAZY_AUTO_THRESHOLD + 5), "eager");
		expect(rendered).toContain("<skills>");
		expect(rendered).toContain(`- skill-${SKILLS_LAZY_AUTO_THRESHOLD + 4}:`);
		expect(rendered).not.toContain("not listed here");
	});

	it("replaces the listing with an on-demand search notice in lazy mode", async () => {
		const rendered = await render(makeSkills(3), "lazy");
		expect(rendered).not.toContain("<skills>");
		expect(rendered).not.toContain("- skill-0:");
		expect(rendered).toContain("3 specialized skills are available but not listed");
		expect(rendered).toContain("skill://?q=<keywords>");
	});

	it("defaults to lazy mode and keeps auto as the small-catalog compatibility mode", async () => {
		const defaultRendered = await render(makeSkills(3));
		expect(defaultRendered).not.toContain("<skills>");
		expect(defaultRendered).toContain("skill://?q=<keywords>");

		const small = await render(makeSkills(SKILLS_LAZY_AUTO_THRESHOLD), "auto");
		expect(small).toContain("<skills>");
		expect(small).not.toContain("not listed here");

		const large = await render(makeSkills(SKILLS_LAZY_AUTO_THRESHOLD + 1), "auto");
		expect(large).not.toContain("<skills>");
		expect(large).toContain(`${SKILLS_LAZY_AUTO_THRESHOLD + 1} specialized skills are available but not listed`);
	});

	it("omits both listing and notice when no skills exist", async () => {
		const rendered = await render([], "lazy");
		expect(rendered).not.toContain("<skills>");
		expect(rendered).not.toContain("specialized skills are available");
	});
});
