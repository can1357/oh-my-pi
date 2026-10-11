import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SkillDescriptionCatalog, SkillDescriptionStore } from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";
import { buildSystemPrompt } from "../src/system-prompt";

const original: Skill = {
	name: "browser-research",
	description:
		"Use when exploring interactive sites with JavaScript execution, authenticated sessions, and multi-step browser actions; do not use for static public web pages that can be read directly.",
	filePath: "/skills/browser-research/SKILL.md",
	baseDir: "/skills/browser-research",
	source: "test",
};

describe("skills.compressDescriptions: false (verbatim catalog)", () => {
	it("renders authored descriptions and never compresses, even over a warm cache", async () => {
		using temp = TempDir.createSync("omp-skill-description-verbatim-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const warm = new SkillDescriptionCatalog({ store, compress: async () => "Use for interactive browser tasks." });
		warm.render([original]);
		await warm.waitForPending();
		expect(new SkillDescriptionCatalog({ store }).render([original])[0]?.description).toBe(
			"Use for interactive browser tasks.",
		);

		let calls = 0;
		const verbatim = new SkillDescriptionCatalog({
			store,
			verbatim: true,
			compress: async () => {
				calls++;
				return "unused";
			},
		});
		const changed = { ...original, description: `${original.description} Also inspect accessibility trees.` };
		expect(verbatim.render([original, changed]).map(skill => skill.description)).toEqual([
			original.description,
			changed.description,
		]);
		expect(verbatim.snapshot([changed])[0]?.description).toBe(changed.description);
		const { systemPrompt } = await buildSystemPrompt({
			skills: [original],
			skillDescriptions: verbatim,
			toolNames: ["read"],
			systemPromptTemplate: "{{#each skills}}- {{name}}: {{description}}{{/each}}",
		});
		expect(systemPrompt.join("\n")).toContain(`- ${original.name}: ${original.description}`);
		await verbatim.waitForPending();
		expect(calls).toBe(0);
	});
});
