import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SkillDescriptionCatalog } from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";
import { buildSystemPrompt } from "../src/system-prompt";

function fixtureSkill(name: string): Skill {
	return {
		name,
		description: `Routing hint for ${name}.`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
	};
}

const FIXTURES = ["alpha", "beta", "gamma", "delta", "epsilon"].map(fixtureSkill);
const OVERFLOW_DESCRIPTION = "+3 more not listed — run `read skill://<name>` or /skill:<name> when relevant";

describe("skill catalog prompt cap", () => {
	it("renders every skill when the cap is 0 (default, unlimited)", () => {
		using temp = TempDir.createSync("omp-skill-cap-");
		const catalog = new SkillDescriptionCatalog({ dbPath: temp.join("skills.db") });
		const rendered = catalog.render(FIXTURES, 0);
		expect(rendered.map(entry => entry.name)).toEqual(FIXTURES.map(skill => skill.name));
	});

	it("renders the first N skills plus exactly one overflow line with the remaining count", () => {
		using temp = TempDir.createSync("omp-skill-cap-");
		const catalog = new SkillDescriptionCatalog({ dbPath: temp.join("skills.db") });
		const rendered = catalog.render(FIXTURES, 2);
		expect(rendered).toHaveLength(3);
		expect(rendered.slice(0, 2).map(entry => entry.name)).toEqual(["alpha", "beta"]);
		const overflow = rendered[2];
		expect(overflow?.name).toBe("more-skills");
		expect(overflow?.description).toBe(OVERFLOW_DESCRIPTION);
	});

	it("renders no overflow line when the cap covers every skill", () => {
		using temp = TempDir.createSync("omp-skill-cap-");
		const catalog = new SkillDescriptionCatalog({ dbPath: temp.join("skills.db") });
		const exact = catalog.render(FIXTURES, FIXTURES.length);
		const generous = catalog.render(FIXTURES, FIXTURES.length + 10);
		expect(exact.map(entry => entry.name)).toEqual(FIXTURES.map(skill => skill.name));
		expect(generous.map(entry => entry.name)).toEqual(FIXTURES.map(skill => skill.name));
	});

	it("is deterministic: the same input renders identically twice", () => {
		using temp = TempDir.createSync("omp-skill-cap-");
		const catalog = new SkillDescriptionCatalog({ dbPath: temp.join("skills.db") });
		const first = catalog.render(FIXTURES, 2);
		const second = catalog.render(FIXTURES, 2);
		expect(second).toEqual(first);
	});

	it("caps the rendered <skills> block in the system prompt", async () => {
		using temp = TempDir.createSync("omp-skill-cap-");
		const catalog = new SkillDescriptionCatalog({ dbPath: temp.join("skills.db") });
		const prompt = await buildSystemPrompt({
			skills: FIXTURES,
			skillDescriptions: catalog,
			skillMaxEntries: 2,
			toolNames: ["read"],
		});
		const text = prompt.systemPrompt.join("\n");
		expect(text).toContain("- alpha: Routing hint for alpha.");
		expect(text).toContain("- beta: Routing hint for beta.");
		expect(text).toContain(`- more-skills: ${OVERFLOW_DESCRIPTION}`);
		expect(text).not.toContain("- gamma:");
		expect(text).not.toContain("- delta:");
		expect(text).not.toContain("- epsilon:");
	});
});
