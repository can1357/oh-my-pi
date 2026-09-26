import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SkillDescriptionCatalog } from "../src/extensibility/skill-descriptions";
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

describe("system prompt skill descriptions", () => {
	it("renders an immediate bounded preview, deduplicates in-flight work, and holds a session snapshot", async () => {
		using temp = TempDir.createSync("omp-skill-description-");
		const dbPath = temp.join("skills.db");
		const { promise, resolve } = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		const compress = (_name: string, _description: string, request: string) => {
			calls++;
			started.resolve();
			expect(request).toContain(original.description);
			return promise;
		};
		const session = new SkillDescriptionCatalog({ dbPath, compress });
		const preview = session.render([original, original])[0]?.description;
		expect(preview).toBeDefined();
		expect(preview!.length).toBeLessThanOrEqual(100);
		expect(preview).toEndWith("…");
		expect(preview).not.toBe(original.description);
		expect(calls).toBe(0);
		await started.promise;
		expect(calls).toBe(1);
		const concurrent = new SkillDescriptionCatalog({ dbPath, compress });
		expect(concurrent.render([original])[0]?.description).toBe(preview);
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(session.render([original])[0]?.description).toBe(preview);
		const before = await buildSystemPrompt({
			skills: [original],
			skillDescriptions: session,
			toolNames: ["read"],
			systemPromptTemplate: "{{#each skills}}- {{name}}: {{description}}{{/each}}",
		});
		expect(before.systemPrompt.join("\n")).toContain(`- ${original.name}: ${preview}`);

		const compressed = "Use for interactive or authenticated browser tasks; not static public pages.";
		resolve(compressed);
		await session.waitForPending();
		expect(session.render([original])[0]?.description).toBe(preview);
		const nextSession = new SkillDescriptionCatalog({ dbPath });
		expect(nextSession.render([original])[0]?.description).toBe(compressed);
		const after = await buildSystemPrompt({
			skills: [original],
			skillDescriptions: nextSession,
			toolNames: ["read"],
			systemPromptTemplate: "{{#each skills}}- {{name}}: {{description}}{{/each}}",
		});
		expect(after.systemPrompt.join("\n")).toContain(`- ${original.name}: ${compressed}`);
	});

	it("misses on a changed full description rather than serving stale cached text", async () => {
		using temp = TempDir.createSync("omp-skill-description-change-");
		const dbPath = temp.join("skills.db");
		let calls = 0;
		const first = new SkillDescriptionCatalog({
			dbPath,
			compress: async () => {
				calls++;
				return "Use for interactive browser tasks.";
			},
		});
		first.render([original]);
		await first.waitForPending();
		const changed = { ...original, description: `${original.description} Also inspect accessibility trees.` };
		const next = new SkillDescriptionCatalog({
			dbPath,
			compress: async () => {
				calls++;
				return "Use for interactive browser and accessibility tasks.";
			},
		});
		expect(next.render([changed])[0]?.description).not.toBe("Use for interactive browser tasks.");
		await next.waitForPending();
		expect(calls).toBe(2);
	});

	it("does not cache malformed output and retries in a later session", async () => {
		using temp = TempDir.createSync("omp-skill-description-invalid-");
		const dbPath = temp.join("skills.db");
		const failed = new SkillDescriptionCatalog({ dbPath, compress: async () => "line one\nline two" });
		const preview = failed.render([original])[0]?.description;
		await failed.waitForPending();

		const retry = new SkillDescriptionCatalog({
			dbPath,
			compress: async () => "Use for interactive sites; not static pages.",
		});
		expect(retry.render([original])[0]?.description).toBe(preview);
		await retry.waitForPending();
		expect(new SkillDescriptionCatalog({ dbPath }).render([original])[0]?.description).toBe(
			"Use for interactive sites; not static pages.",
		);
	});

	it("verbatim mode renders authored descriptions and never compresses, even over a warm cache", async () => {
		using temp = TempDir.createSync("omp-skill-description-verbatim-");
		const dbPath = temp.join("skills.db");
		const warm = new SkillDescriptionCatalog({ dbPath, compress: async () => "Use for interactive browser tasks." });
		warm.render([original]);
		await warm.waitForPending();
		expect(new SkillDescriptionCatalog({ dbPath }).render([original])[0]?.description).toBe(
			"Use for interactive browser tasks.",
		);

		let calls = 0;
		const verbatim = new SkillDescriptionCatalog({
			dbPath,
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
