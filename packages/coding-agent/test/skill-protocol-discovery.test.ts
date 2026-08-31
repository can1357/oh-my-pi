import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";

function skill(name: string, description = `${name} description`, hide = false): Skill {
	const baseDir = path.join("/skills", name);
	return {
		name,
		description,
		filePath: path.join(baseDir, "SKILL.md"),
		baseDir,
		source: "test",
		...(hide ? { hide: true } : {}),
	};
}

describe("skill:// discovery", () => {
	const handler = new SkillProtocolHandler();

	it("returns a deterministic bounded root catalog with sanitized descriptions", async () => {
		const skills = Array.from({ length: 55 }, (_, index) =>
			skill(
				`skill-${index.toString().padStart(3, "0")}`,
				index === 0 ? `first\n\tline \u200b\x1b[31m${"x".repeat(220)}` : `description ${index}`,
			),
		).reverse();

		const root = parseInternalUrl("skill://");
		const first = await handler.resolve(root, { skills });
		const search = await handler.resolve(parseInternalUrl("skill://?q=SKILL"), { skills });
		const second = await handler.resolve(root, { skills: [...skills].reverse() });
		const catalogEntries = first.content.split("\n").filter(line => /^skill:\/\/skill-\d{3} /.test(line));
		const searchEntries = search.content.split("\n").filter(line => /^skill:\/\/skill-\d{3} /.test(line));

		expect(first.content).toBe(second.content);
		expect(catalogEntries).toHaveLength(50);
		expect(searchEntries).toHaveLength(50);
		expect(catalogEntries[0]).toStartWith("skill://skill-000 — first line x");
		expect(catalogEntries[0]).not.toContain("\x1b");
		expect(catalogEntries[0]).not.toContain("\u200b");
		expect(catalogEntries[0]?.length).toBeLessThanOrEqual("skill://skill-000 — ".length + 200);
		expect(first.content).toContain("skill://skill-049");
		expect(first.content).not.toContain("skill://skill-050");
		expect(first.content).toContain("Results truncated at 50");
		expect(first.content).toContain("skill://?q=<term>");
		expect(search.content).toContain("Results truncated at 50");
	});

	it("searches visible names and descriptions case-insensitively without exposing hidden skills", async () => {
		const hidden = skill("quiet-helper", `${"prefix ".repeat(40)}DeepNeedle capability`, true);
		const skills = [skill("needle-name", "ordinary capability"), hidden, skill("other", "unrelated")];

		const result = await handler.resolve(parseInternalUrl("skill://?q=NEEDLE"), { skills });
		const catalog = await handler.resolve(parseInternalUrl("skill://"), { skills });

		expect(result.content).toContain("skill://needle-name — ordinary capability");
		expect(result.content).not.toContain("skill://quiet-helper");
		expect(catalog.content).not.toContain("skill://quiet-helper");
		expect(result.content).not.toContain("skill://other — unrelated");
		expect(result.content).toContain("(1 of 1)");
	});

	it("emits bounded exact aliases for overlong and non-URI-safe names", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-alias-"));
		try {
			const names = ["x".repeat(65), `invalid-${String.fromCharCode(0xd800)}`];
			const skills = await Promise.all(
				names.map(async (name, index): Promise<Skill> => {
					const baseDir = path.join(tempDir, String(index));
					const filePath = path.join(baseDir, "SKILL.md");
					await fs.mkdir(baseDir);
					await Bun.write(filePath, `skill body ${index}\n`);
					return { name, description: `capability ${index}`, filePath, baseDir, source: "test" };
				}),
			);

			const catalog = await handler.resolve(parseInternalUrl("skill://"), { skills });
			const routes = catalog.content
				.split("\n")
				.filter(line => line.startsWith("skill://?id="))
				.map(line => line.split(" — ", 1)[0] ?? "");

			expect(routes).toHaveLength(2);
			expect(catalog.content).toContain("&path=<encoded-relative>");
			expect(routes.every(route => route.length === 76)).toBe(true);
			const resolved = await Promise.all(routes.map(route => handler.resolve(parseInternalUrl(route), { skills })));
			const relative = await handler.resolve(parseInternalUrl(`${routes[0]}&path=SKILL.md`), { skills });
			expect(relative.content).toBe(resolved[0]?.content);
			expect(resolved.map(resource => resource.content).sort()).toEqual(["skill body 0\n", "skill body 1\n"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("emits a one-line percent-encoded route that resolves delimiter and control characters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-route-"));
		try {
			const specialName = "foo?bar/baz\ninjected";
			const filePath = path.join(tempDir, "SKILL.md");
			await Bun.write(filePath, "special skill body\n");
			const specialSkill: Skill = {
				name: specialName,
				description: "special capability",
				filePath,
				baseDir: tempDir,
				source: "test",
			};
			const result = await handler.resolve(parseInternalUrl("skill://"), { skills: [specialSkill] });
			const route = result.content
				.split("\n")
				.find(line => line.startsWith("skill://"))
				?.split(" — ", 1)[0];

			expect(route).toBe("skill://foo%3Fbar%2Fbaz%0Ainjected");
			expect(result.content.split("\n").filter(line => line === "injected")).toHaveLength(0);
			if (!route) throw new Error("expected catalog route");
			const resolved = await handler.resolve(parseInternalUrl(route), { skills: [specialSkill] });
			expect(resolved.content).toBe("special skill body\n");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous and non-root search queries", async () => {
		const skills = [skill("exact-skill")];

		await expect(handler.resolve(parseInternalUrl("skill://?q=one&q=two"), { skills })).rejects.toThrow(
			"Invalid skill:// query",
		);
		await expect(handler.resolve(parseInternalUrl("skill://?other=value"), { skills })).rejects.toThrow(
			"Invalid skill:// query",
		);
		await expect(handler.resolve(parseInternalUrl("skill://exact-skill?q=other"), { skills })).rejects.toThrow(
			"only valid on the catalog root",
		);
	});

	it("keeps exact skill and nested resource reads unchanged", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-discovery-"));
		try {
			const baseDir = path.join(tempDir, "exact-skill");
			const filePath = path.join(baseDir, "SKILL.md");
			const nestedPath = path.join(baseDir, "references", "guide.md");
			await fs.mkdir(path.dirname(nestedPath), { recursive: true });
			await Bun.write(filePath, "exact skill body\n");
			await Bun.write(nestedPath, "nested guide body\n");
			const exactSkill: Skill = {
				name: "exact-skill",
				description: "Exact skill",
				filePath,
				baseDir,
				source: "test",
			};

			const exact = await handler.resolve(parseInternalUrl("skill://exact-skill"), { skills: [exactSkill] });
			const nested = await handler.resolve(parseInternalUrl("skill://exact-skill/references/guide.md"), {
				skills: [exactSkill],
			});

			expect(exact.content).toBe("exact skill body\n");
			expect(exact.sourcePath).toBe(filePath);
			expect(nested.content).toBe("nested guide body\n");
			expect(nested.sourcePath).toBe(nestedPath);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps unknown-skill errors bounded and points to search", async () => {
		const skills = Array.from({ length: 200 }, (_, index) => skill(`available-${index.toString().padStart(3, "0")}`));
		const unknownName = `missing-${"x".repeat(1_000)}`;

		try {
			await handler.resolve(parseInternalUrl(`skill://${unknownName}`), { skills });
			expect.unreachable("unknown skill should fail");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw error;
			expect(error.message.length).toBeLessThan(200);
			expect(error.message).toContain("Unknown skill: missing-");
			expect(error.message).toContain("skill://?q=<term>");
			expect(error.message).not.toContain("available-000");
		}
	});
});
