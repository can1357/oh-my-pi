import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { type ResolveContext, resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { expandInternalUrls, expandSkillUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

const imageAttachment = {
	label: "Image #1",
	uri: "attachment://1",
	sourcePath: "/tmp/session blobs/image 1.png",
	image: { type: "image", data: "image-bytes", mimeType: "image/png" },
} as const;

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
		context?: ResolveContext,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string; immutable: boolean }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
				immutable: true,
			};
		},
	};
}

describe("expandSkillUrls", () => {
	it("expands a basic skill:// URI to an absolute path", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python skill://valid-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands multiple skill:// URIs in one command", () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];
		const command = "cp skill://first-skill/a.txt skill://second-skill/b.txt";
		const firstPath = path.join(skills[0].baseDir, "a.txt");
		const secondPath = path.join(skills[1].baseDir, "b.txt");

		expect(expandSkillUrls(command, skills)).toBe(`cp ${shellEscape(firstPath)} ${shellEscape(secondPath)}`);
	});

	it("throws ToolError for unknown skills with available names", () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];

		expect(() => expandSkillUrls("python skill://missing/run.py", skills)).toThrow(
			"Unknown skill: missing. Available: first-skill, second-skill",
		);
	});

	it("throws ToolError for path traversal attempts", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

		expect(() => expandSkillUrls("cat skill://valid-skill/../../../etc/passwd", skills)).toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});

	it("returns command unchanged when there are no skill:// tokens", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "git status";

		expect(expandSkillUrls(command, skills)).toBe(command);
	});

	it("does not expand non-skill internal URIs", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "echo agent://1 artifact://abc rule://security";

		expect(expandSkillUrls(command, skills)).toBe(command);
	});

	it("expands URI in double quotes", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'python "skill://valid-skill/scripts/init.py"';
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands URI in single quotes", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python 'skill://valid-skill/scripts/init.py'";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths with spaces", () => {
		const skills = [createSkill("space-skill", "/tmp/skills/with space")];
		const command = "python skill://space-skill/scripts/my%20file.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/my file.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths containing single quotes", () => {
		const skills = [createSkill("quote-skill", "/tmp/skills/with'quote")];
		const command = "python skill://quote-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("resolves skill://name with no relative path to the skill directory", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "printf '%s\n' skill://valid-skill";

		expect(expandSkillUrls(command, skills)).toBe(`printf '%s\n' ${shellEscape(skills[0].baseDir)}`);
	});

	it("returns command unchanged when no skills are loaded", () => {
		const command = "python skill://valid-skill/scripts/init.py";
		expect(expandSkillUrls(command, [])).toBe(command);
	});

	it("throws ToolError when traversal is attempted with encoded segments", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		expect(() => expandSkillUrls("cat skill://valid-skill/%2E%2E/%2E%2E/etc/passwd", skills)).toThrow(ToolError);
	});
});

describe("expandInternalUrls", () => {
	it("expands skill/agent/artifact/memory/rule URLs in one command", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const router = createInternalRouter({
			"artifact://12": { sourcePath: "/tmp/artifacts/12.bash.log" },
			"agent://reviewer_0": { sourcePath: "/tmp/session/reviewer_0.md" },
			"memory://root/memory_summary.md": { sourcePath: "/tmp/memories/memory_summary.md" },
			"rule://rs-no-unwrap": { sourcePath: "/tmp/rules/rs-no-unwrap.md" },
		});
		const command =
			"cat agent://reviewer_0 artifact://12 memory://root/memory_summary.md rule://rs-no-unwrap skill://valid-skill/scripts/init.py";
		const expectedSkillPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills, internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/session/reviewer_0.md")} ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape("/tmp/memories/memory_summary.md")} ${shellEscape("/tmp/rules/rs-no-unwrap.md")} ${shellEscape(expectedSkillPath)}`,
		);
	});

	it("passes caller cwd to the router when expanding memory URLs", async () => {
		const cwd = "/tmp/session-b";
		const sourcePath = "/tmp/session-b-memory/memory_summary.md";
		let observedCwd: string | undefined;
		let observedPathOnly: boolean | undefined;
		const router = {
			canHandle: (input: string) => input === "memory://root/memory_summary.md",
			resolve: async (input: string, context?: ResolveContext) => {
				observedCwd = context?.cwd;
				observedPathOnly = context?.pathOnly;
				return {
					url: input,
					content: "",
					contentType: "text/plain" as const,
					sourcePath,
					immutable: true,
				};
			},
		};

		await expect(
			expandInternalUrls("cat memory://root/memory_summary.md", { skills: [], internalRouter: router, cwd }),
		).resolves.toBe(`cat ${shellEscape(sourcePath)}`);
		expect(observedCwd).toBe(cwd);
		expect(observedPathOnly).toBe(true);
	});

	it("forwards the session's scoped rules to the router when expanding rule:// URLs", async () => {
		const sourcePath = "/tmp/rules/scout-only.md";
		const scopedRules = [
			{
				name: "scout-only",
				path: sourcePath,
				content: "stay on plan",
				_source: { provider: "test", providerName: "test", path: sourcePath, level: "user" as const },
			},
		];
		let observedRules: unknown;
		const router = {
			canHandle: (input: string) => input === "rule://scout-only",
			resolve: async (input: string, context?: ResolveContext) => {
				observedRules = context?.rules;
				return {
					url: input,
					content: "",
					contentType: "text/plain" as const,
					sourcePath,
					immutable: true,
				};
			},
		};

		await expect(
			expandInternalUrls("cat rule://scout-only", { skills: [], internalRouter: router, rules: scopedRules }),
		).resolves.toBe(`cat ${shellEscape(sourcePath)}`);
		expect(observedRules).toBe(scopedRules);
	});

	it("expands quoted non-skill URLs and shell-escapes quotes in paths", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
	});

	it("expands attachment URLs and shell-escapes source paths with spaces", async () => {
		await expect(
			expandInternalUrls("cp attachment://1 saved.png", { skills: [], attachments: [imageAttachment] }),
		).resolves.toBe(`cp ${shellEscape(imageAttachment.sourcePath)} saved.png`);
	});

	it("expands attachment URLs used as quoted command arguments", async () => {
		const command = `cmp "attachment://1" 'attachment://1'`;
		await expect(expandInternalUrls(command, { skills: [], attachments: [imageAttachment] })).resolves.toBe(
			`cmp ${shellEscape(imageAttachment.sourcePath)} ${shellEscape(imageAttachment.sourcePath)}`,
		);
	});

	it("leaves unknown attachment references unchanged", async () => {
		const command = "cp attachment://2 saved.png";
		await expect(expandInternalUrls(command, { skills: [], attachments: [imageAttachment] })).resolves.toBe(command);
	});

	it("preserves attachment mentions embedded in quoted text", async () => {
		const command = `printf '%s\\n' 'copy attachment://1 to save the original'`;
		await expect(expandInternalUrls(command, { skills: [], attachments: [imageAttachment] })).resolves.toBe(command);
	});

	it("expands an unquoted URL inside a double-quoted command substitution", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'echo "$(realpath skill://valid-skill/SKILL.md 2>&1)"';
		const expectedPath = path.join(skills[0].baseDir, "SKILL.md");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`echo "$(realpath ${shellEscape(expectedPath)} 2>&1)"`,
		);
	});

	it("expands an unquoted URL inside a backtick substitution nested in double quotes", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'echo "`cat skill://valid-skill/SKILL.md`"';
		const expectedPath = path.join(skills[0].baseDir, "SKILL.md");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`echo "\`cat ${shellEscape(expectedPath)}\`"`,
		);
	});

	it("expands a top-level unquoted URL inside a backtick substitution", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "echo `cat skill://valid-skill/SKILL.md`";
		const expectedPath = path.join(skills[0].baseDir, "SKILL.md");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`echo \`cat ${shellEscape(expectedPath)}\``);
	});

	it("expands nested $() inside a double-quoted backtick substitution", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'echo "`echo $(cat skill://valid-skill/SKILL.md)`"';
		const expectedPath = path.join(skills[0].baseDir, "SKILL.md");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`echo "\`echo $(cat ${shellEscape(expectedPath)})\`"`,
		);
	});

	it("expands nested backticks inside a double-quoted $() substitution", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'echo "$(echo `cat skill://valid-skill/SKILL.md`)"';
		const expectedPath = path.join(skills[0].baseDir, "SKILL.md");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`echo "$(echo \`cat ${shellEscape(expectedPath)}\`)"`,
		);
	});

	it("leaves a URL inside a single-quoted backtick string literal", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "echo '`cat skill://valid-skill/SKILL.md`'";

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("leaves a URL behind an escaped backtick in double quotes literal", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'echo "\\`skill://valid-skill/SKILL.md\\`"';

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("leaves a URL inside escaped quotes within a double-quoted backtick substitution", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'echo "`printf %s \\"literal skill://valid-skill/SKILL.md\\"`"';

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("leaves literal internal URLs embedded in quoted text unchanged", async () => {
		const router = createInternalRouter({
			"memory://root/summary.md": { sourcePath: "/tmp/memories/summary.md" },
		});
		const command = `printf '%s\\n' 'the literal memory://root/summary.md string'`;

		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("leaves unresolved quoted literal URLs unchanged", async () => {
		const router = createInternalRouter({});
		const command = "grep 'memory://xyz-quoted' file.txt";

		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("expands agent:// URLs when router is available", async () => {
		const router = createInternalRouter({
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).resolves.toBe(
			`echo ${shellEscape("/tmp/session/abc.md")}`,
		);
	});

	it("keeps query parameters in an unquoted internal URL", async () => {
		const router = createInternalRouter({
			"agent://reviewer?q=needle": { sourcePath: "/tmp/session/reviewer.md" },
		});

		await expect(
			expandInternalUrls("cat agent://reviewer?q=needle", { skills: [], internalRouter: router }),
		).resolves.toBe(`cat ${shellEscape("/tmp/session/reviewer.md")}`);
	});

	it("expands local:// URLs to filesystem paths without requiring preexisting files", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
	});

	it("preserves an adjacent command separator after an unquoted local URL", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = 'bb review-packet gates --body-file local://body.txt; echo "exit=$?"';
		const expectedPath = resolveLocalUrlToPath("local://body.txt", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`bb review-packet gates --body-file ${shellEscape(expectedPath)}; echo "exit=$?"`,
		);
	});

	it("expands local:/ (single-slash) URL in double quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = 'cat "local:/PLAN.md"';
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in single quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat 'local:/PLAN.md'";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL without quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("leaves local:// URLs unchanged without local protocol options", async () => {
		const command = "mv foo local://bar";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("leaves non-skill URLs unchanged without an internal router", async () => {
		const command = "cat artifact://1";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("leaves internal URLs unchanged when they resolve without sourcePath", async () => {
		const router = createInternalRouter({
			"rule://my-rule": {},
		});
		const command = "cat rule://my-rule";
		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("leaves internal URLs unchanged when the resolver fails", async () => {
		const router = createInternalRouter({
			"memory://root/missing.md": { error: "Memory file not found" },
		});
		const command = "cat memory://root/missing.md";
		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("does not match local:/ inside filesystem paths (e.g. /repo/local:/PLAN.md)", async () => {
		const command = "cat /repo/local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("does not match local:/ after ./ or ../ prefixes", async () => {
		const command = "cat ./local:/PLAN.md ../local:/other.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("still matches standalone local:/ at a real token boundary", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("does not match local:/ when embedded in words (e.g., notlocal:/, mylocal:/)", async () => {
		const command1 = "cat notlocal:/PLAN.md";
		await expect(expandInternalUrls(command1, { skills: [] })).resolves.toBe(command1);

		const command2 = "cat mylocal:/data.json";
		await expect(expandInternalUrls(command2, { skills: [] })).resolves.toBe(command2);

		const command3 = "cat getlocal:/file.txt";
		await expect(expandInternalUrls(command3, { skills: [] })).resolves.toBe(command3);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command1, { skills: [], localOptions })).resolves.toBe(command1);
	});

	it("does not match local:/ after a hyphen (e.g. not-local:/PLAN.md)", async () => {
		const command = "cat not-local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(command);
	});
});
