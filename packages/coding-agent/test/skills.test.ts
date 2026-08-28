import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Skill as CapabilitySkill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getWslWindowsHomeCandidate, runHostProbe } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import {
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	parseSkillInvocation,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures/skills");
const collisionFixturesDir = path.resolve(import.meta.dirname, "fixtures/skills-collision");

const longSkillName = "this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard";
const expectedFixtureSkillOrder: string[] = [
	"bad--name",
	"different-name",
	"Invalid_Name",
	longSkillName,
	"unknown-field",
	"valid-skill",
];

/**
 * Disable every named built-in skill source. Used by `loadSkills` option tests
 * that need to isolate a custom directory or assert "no built-in leakage". Tests
 * MUST spread this in: the discovery surface only ignores `~/.<dir>/skills/*` if
 * every provider toggle resolves to false, otherwise stray skills from the
 * developer's real `$HOME` (e.g. `~/.agents/skills/<name>/SKILL.md`) leak into
 * the assertion.
 */
const DISABLE_ALL_BUILTIN_SKILLS = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		let fixtureRoot: LoadSkillsResult;

		beforeAll(async () => {
			fixtureRoot = await loadSkillsFromDir({ dir: fixturesDir, source: "test" });
		});

		const loadFixtureRoot = async () => fixtureRoot;
		it("should load a valid skill from a skills root", async () => {
			const { skills, warnings } = await loadFixtureRoot();
			const validSkill = skills.find(skill => skill.name === "valid-skill");

			expect(validSkill).toBeDefined();
			expect(validSkill?.description).toBe("A valid skill for testing purposes.");
			expect(validSkill?.source).toBe("test");
			expect(warnings).toHaveLength(0);
		});

		it("should load skill when name doesn't match parent directory", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "different-name")).toBe(true);
		});

		it("should load skill with invalid name characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "Invalid_Name")).toBe(true);
		});

		it("should load skill when name exceeds 64 characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(
				skills.some(
					skill =>
						skill.name ===
						"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
				),
			).toBe(true);
		});

		it("should skip skill when description is missing", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "missing-description")).toBe(false);
		});

		it("should load skill with unknown frontmatter fields", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "unknown-field")).toBe(true);
		});

		it("should not load nested skills recursively", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "child-skill")).toBe(false);
		});

		it("should skip files without frontmatter description", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "no-frontmatter")).toBe(false);
		});

		it("should load skill with consecutive hyphens in name", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "bad--name")).toBe(true);
		});

		it("should load all directly nested skills from fixture directory", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(
				expect.arrayContaining([
					"valid-skill",
					"different-name",
					"Invalid_Name",
					"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
					"unknown-field",
					"bad--name",
				]),
			);
			expect(names).not.toContain("child-skill");
			expect(skills).toHaveLength(6);
		});

		it("should return skills sorted by name (case-insensitive)", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(expectedFixtureSkillOrder);
		});

		it("should return empty for non-existent directory", async () => {
			const { skills, warnings } = await loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});
			expect(skills).toHaveLength(0);
			expect(warnings).toHaveLength(0);
		});

		it("should return empty when scanning a single skill directory directly", async () => {
			const { skills } = await loadSkillsFromDir({
				dir: path.join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
		});
	});

	describe("loadSkills with options", () => {
		let customDirectorySkills: LoadSkillsResult;

		beforeAll(async () => {
			customDirectorySkills = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
			});
		});
		it("should load from customDirectories only when built-ins disabled", async () => {
			const { skills } = customDirectorySkills;
			expect(skills.length).toBeGreaterThan(0);
			// Custom directory skills have source "custom:user"
			expect(skills.every(s => s.source.startsWith("custom"))).toBe(true);
		});

		it("should return customDirectory skills sorted by name (case-insensitive)", async () => {
			const { skills } = customDirectorySkills;

			expect(skills.map(s => s.name)).toEqual(expectedFixtureSkillOrder);
		});

		it("should keep user Claude skills when project .claude/skills is missing", async () => {
			const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-home-"));
			const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-project-"));

			try {
				const userSkillDir = path.join(tempHomeDir, ".claude", "skills", "user-only-skill");
				await fs.mkdir(userSkillDir, { recursive: true });
				await fs.writeFile(
					path.join(userSkillDir, "SKILL.md"),
					[
						"---",
						"name: user-only-skill",
						"description: User-only Claude skill",
						"---",
						"",
						"# User-only skill",
					].join("\n"),
				);

				const capability = getCapability<CapabilitySkill>(skillCapability.id);
				expect(capability).toBeDefined();
				const claudeProvider = capability?.providers.find(provider => provider.id === "claude");
				expect(claudeProvider).toBeDefined();

				const result = await claudeProvider!.load({ cwd: tempProjectDir, home: tempHomeDir, repoRoot: null });
				expect(result.items.some(skill => skill.name === "user-only-skill" && skill.level === "user")).toBe(true);
			} finally {
				await removeWithRetries(tempProjectDir);
				await removeWithRetries(tempHomeDir);
			}
		});

		// Regression for issue #2401: a user who disables the named third-party
		// CLI toggles (codex/claude/native) MUST still see skills from the
		// canonical OMP-native `~/.agent[s]/skills` (the `agents` provider).
		// Pre-fix `loadSkills` gated `agents` on `anyBuiltInSkillSourceEnabled`,
		// so flipping the five third-party toggles off silently disabled it.
		it("should still load ~/.agents/skills when codex/claude/native toggles are off (#2401)", async () => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-home-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-cwd-"));
			const skillDir = path.join(tempHome, ".agents", "skills", "user-agents-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				["---", "description: Loaded from ~/.agents/skills", "---", "", "# user-agents-skill"].join("\n"),
			);
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					// enableAgentsUser/enableAgentsProject left at their default-true value
					cwd: tempCwd,
				});
				expect(skills.some(s => s.name === "user-agents-skill" && s.source === "agents:user")).toBe(true);
			} finally {
				homedirSpy.mockRestore();
				await removeWithRetries(tempHome);
				await removeWithRetries(tempCwd);
			}
		});

		it("should load Windows host ~/.agents/skills when running under WSL (#3779)", async () => {
			const tempHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-wsl-host-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-wsl-cwd-"));
			const skillDir = path.join(tempHostHome, ".agents", "skills", "wsl-host-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				["---", "description: Loaded from WSL host USERPROFILE", "---", "", "# wsl-host-skill"].join("\n"),
			);
			const previousWslDistroName = process.env.WSL_DISTRO_NAME;
			const previousWslInterop = process.env.WSL_INTEROP;
			const previousUserProfile = process.env.USERPROFILE;
			const previousPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.WSL_DISTRO_NAME = "Ubuntu";
			delete process.env.WSL_INTEROP;
			process.env.USERPROFILE = tempHostHome;
			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					cwd: tempCwd,
				});
				const skill = skills.find(s => s.name === "wsl-host-skill");
				expect(skill?.source).toBe("agents:user");
				expect(skill?.filePath).toBe(path.join(skillDir, "SKILL.md"));
			} finally {
				if (previousWslDistroName === undefined) delete process.env.WSL_DISTRO_NAME;
				else process.env.WSL_DISTRO_NAME = previousWslDistroName;
				if (previousWslInterop === undefined) delete process.env.WSL_INTEROP;
				else process.env.WSL_INTEROP = previousWslInterop;
				if (previousUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = previousUserProfile;
				Object.defineProperty(process, "platform", { value: previousPlatform });
				await removeWithRetries(tempHostHome);
				await removeWithRetries(tempCwd);
			}
		});

		it("converts Windows USERPROFILE paths to the default WSL mount (#3779)", () => {
			const resolved = getWslWindowsHomeCandidate({
				platform: "linux",
				env: { WSL_DISTRO_NAME: "Ubuntu", USERPROFILE: "C:\\Users\\alice" },
				wslPath: () => undefined,
			});

			expect(resolved).toBe("/mnt/c/Users/alice");
		});

		it("resolves the Windows profile through interop when USERPROFILE is not exported (#3779)", () => {
			const resolved = getWslWindowsHomeCandidate({
				platform: "linux",
				env: { WSL_DISTRO_NAME: "Ubuntu" },
				windowsUserProfile: () => "C:\\Users\\alice",
				wslPath: () => "/mnt/c/Users/alice",
			});

			expect(resolved).toBe("/mnt/c/Users/alice");
		});

		it("kills a host probe that never exits instead of blocking startup (#8402)", () => {
			// Integration test against real OS timer behavior: the contract is that
			// runHostProbe's spawnSync `timeout` actually kills a genuinely blocked
			// child. Injecting a short deadline preserves that native lifecycle
			// coverage without paying the production discovery budget.
			const start = performance.now();
			const result = runHostProbe([process.execPath, "-e", "await Bun.sleep(60_000)"], 25);
			const elapsed = performance.now() - start;
			expect(result).toBeUndefined();
			// Loose bound proves the probe returned via its timeout, not the child.
			expect(elapsed).toBeLessThan(1_000);
		});

		it("returns trimmed stdout for a host probe that succeeds (#8402)", () => {
			const result = runHostProbe([process.execPath, "-e", "process.stdout.write('  host-home  ')"]);
			expect(result).toBe("host-home");
		});

		it("respects an explicit enableAgentsUser: false (#2401)", async () => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-home-off-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-cwd-off-"));
			const skillDir = path.join(tempHome, ".agents", "skills", "opted-out");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				["---", "description: Should be filtered out", "---", "", "# opted-out"].join("\n"),
			);
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const { skills } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					enableAgentsUser: false,
					cwd: tempCwd,
				});
				expect(skills.some(s => s.name === "opted-out")).toBe(false);
			} finally {
				homedirSpy.mockRestore();
				await removeWithRetries(tempHome);
				await removeWithRetries(tempCwd);
			}
		});

		// Regression for PR #2405 review: the fall-through gate used by
		// unknown third-party providers (opencode/github/claude-plugins/...)
		// MUST NOT consider the OMP-native `enableAgentsUser`/`...Project`
		// toggles. Otherwise a user who disables Codex/Claude/Pi to silence
		// third-party CLI noise but keeps the default agents toggles on still
		// sees opencode skills resurface via the fallback branch.
		it("does not re-enable third-party providers via the agents toggles (PR #2405)", async () => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-opencode-home-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-opencode-cwd-"));
			const opencodeSkillDir = path.join(tempHome, ".config", "opencode", "skills", "leaked-opencode");
			await fs.mkdir(opencodeSkillDir, { recursive: true });
			await fs.writeFile(
				path.join(opencodeSkillDir, "SKILL.md"),
				["---", "description: Should be filtered by third-party gate", "---", "", "# leaked-opencode"].join("\n"),
			);
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					// enableAgentsUser / enableAgentsProject default true
					cwd: tempCwd,
				});
				expect(skills.some(s => s.name === "leaked-opencode")).toBe(false);
			} finally {
				homedirSpy.mockRestore();
				await removeWithRetries(tempHome);
				await removeWithRetries(tempCwd);
			}
		});

		it("should filter out ignoredSkills", async () => {
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
				ignoredSkills: ["valid-skill"],
			});
			expect(skills.some(s => s.name === "valid-skill")).toBe(false);
		});

		it("should support glob patterns in ignoredSkills", async () => {
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
				ignoredSkills: ["valid-*"],
			});
			expect(skills.every(s => !s.name.startsWith("valid-"))).toBe(true);
		});

		it("should skip skills disabled via frontmatter", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-skill-"));
			const skillDir = path.join(tempDir, "disabled-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---
name: disabled-skill
description: Should not be discovered.
enabled: false
---

# Disabled Skill
`,
			);

			try {
				const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [tempDir] });
				expect(skills.some(s => s.name === "disabled-skill")).toBe(false);
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("should hide skills with disable-model-invocation frontmatter (Agent Skills spec)", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dmi-skill-"));
			const skillDir = path.join(tempDir, "hidden-by-spec");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: hidden-by-spec\ndescription: Should be hidden via Agent Skills standard field.\ndisable-model-invocation: true\n---\n\n# Hidden Skill\n`,
			);

			try {
				const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [tempDir] });
				const skill = skills.find(s => s.name === "hidden-by-spec");
				expect(skill).toBeDefined();
				expect(skill!.hide).toBe(true);
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("should let ignoredSkills override includeSkills", async () => {
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
				includeSkills: ["valid-*"],
				ignoredSkills: ["valid-skill"],
			});
			expect(skills.every(s => s.name !== "valid-skill")).toBe(true);
		});
	});

	it("should expand ~ in customDirectories", async () => {
		const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-home-"));
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
		const tempHomeSkillsDir = await fs.mkdtemp(path.join(fakeHome, ".pi-skills-test-"));
		const relativeToHome = path.relative(fakeHome, tempHomeSkillsDir);
		const tildeDir = `~/${relativeToHome.split(path.sep).join("/")}`;
		const skillDir = path.join(tempHomeSkillsDir, "tilde-skill");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			skillPath,
			`---
name: tilde-skill
description: Skill loaded from a tilde-expanded custom directory.
---

# Tilde Skill
`,
		);

		try {
			const { skills: withTilde } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [tildeDir],
			});
			const { skills: withoutTilde } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [tempHomeSkillsDir],
			});
			expect(withTilde.length).toBe(withoutTilde.length);
			expect(withTilde.some(skill => skill.name === "tilde-skill")).toBe(true);
		} finally {
			homedirSpy.mockRestore();
			await removeWithRetries(fakeHome);
		}
	});

	it("should return empty when all sources disabled and no custom dirs", async () => {
		const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS });
		expect(skills).toHaveLength(0);
	});

	it("should filter skills with includeSkills glob patterns", async () => {
		// Load all skills from fixtures
		const { skills: allSkills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
		});
		expect(allSkills.length).toBeGreaterThan(0);

		// Filter to only include "valid-skill"
		const { skills: filtered } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
			includeSkills: ["valid-skill"],
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0].name).toBe("valid-skill");
	});

	it("should support glob patterns in includeSkills", async () => {
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
			includeSkills: ["valid-*"],
		});
		expect(skills.length).toBeGreaterThan(0);
		expect(skills.every(s => s.name.startsWith("valid-"))).toBe(true);
	});

	it("should return all skills when includeSkills is empty", async () => {
		const { skills: withEmpty } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
			includeSkills: [],
		});
		const { skills: withoutOption } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
		});
		expect(withEmpty.length).toBe(withoutOption.length);
	});
});

describe("collision handling", () => {
	it("should detect name collisions and keep first skill", async () => {
		// Load from first directory
		const first = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "first"),
			source: "first",
		});

		const second = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "second"),
			source: "second",
		});

		// Both directories should have loaded one skill each
		expect(first.skills).toHaveLength(1);
		expect(second.skills).toHaveLength(1);

		// Both have the same name "calendar"
		expect(first.skills[0].name).toBe("calendar");
		expect(second.skills[0].name).toBe("calendar");

		// Simulate the collision behavior from loadSkills()
		const skillMap = new Map<string, Skill>();
		const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

		for (const skill of first.skills) {
			skillMap.set(skill.name, skill);
		}

		for (const skill of second.skills) {
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionWarnings.push({
					skillPath: skill.filePath,
					message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
				});
			} else {
				skillMap.set(skill.name, skill);
			}
		}

		expect(skillMap.size).toBe(1);
		expect(skillMap.get("calendar")?.source).toBe("first");
		expect(collisionWarnings).toHaveLength(1);
		expect(collisionWarnings[0].message).toContain("name collision");
	});
});

describe("parseSkillInvocation", () => {
	describe("leading `/skill:<name>` form", () => {
		it("parses a bare leading command", () => {
			expect(parseSkillInvocation("/skill:foo")).toEqual({ name: "foo", args: "" });
		});

		it("captures everything after the first space as args", () => {
			expect(parseSkillInvocation("/skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
			});
		});

		it("allows leading whitespace before the `/skill:<name>` command", () => {
			expect(parseSkillInvocation("  /skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
			});
		});

		it("returns undefined for the bare `/skill:` prefix", () => {
			expect(parseSkillInvocation("/skill:")).toBeUndefined();
		});
	});

	describe("mid-prompt `/skill:<name>` form (issue #3913)", () => {
		it("threads surrounding prose through as args when the skill token appears after typed text", () => {
			expect(parseSkillInvocation("fix the auth bug /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "fix the auth bug",
			});
		});

		it("collapses prose on both sides of the skill token into a single args string", () => {
			expect(parseSkillInvocation("leading /skill:foo trailing")).toEqual({
				name: "foo",
				args: "leading trailing",
			});
		});

		it("preserves embedded newlines in args when the skill token spans a line break", () => {
			expect(parseSkillInvocation("explain this\nthen use /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "explain this\nthen use",
			});
		});

		it("does not hijack another slash command whose args mention a skill", () => {
			expect(parseSkillInvocation("/compact /skill:security-scan")).toBeUndefined();
			expect(parseSkillInvocation("/goal set /skill:foo focus on auth")).toBeUndefined();
		});

		it("does not hijack the bash tool (`!cmd`) when the body mentions a skill", () => {
			expect(parseSkillInvocation("!echo /skill:reviewer")).toBeUndefined();
			expect(parseSkillInvocation("!!echo /skill:reviewer")).toBeUndefined();
			expect(parseSkillInvocation("   !echo /skill:reviewer")).toBeUndefined();
		});

		it("does not hijack the python tool (`$ code`) when the body mentions a skill", () => {
			expect(parseSkillInvocation("$ run.py /skill:foo")).toBeUndefined();
			expect(parseSkillInvocation("$$ run.py /skill:foo")).toBeUndefined();
			expect(parseSkillInvocation("$\trun /skill:foo")).toBeUndefined();
		});

		it("still matches when `$` is followed by prose, not a python whitespace sigil", () => {
			// `$echo`, `${HOME}`, and `$200` are not python commands — `pythonCommandPrefixLength`
			// returns 0 for them — so the mid-prompt parser must still see the embedded skill.
			expect(parseSkillInvocation("$echo /skill:reviewer")).toEqual({
				name: "reviewer",
				args: "$echo",
			});
			// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal string containing shell variable
			expect(parseSkillInvocation("${HOME}/bin /skill:foo")).toEqual({
				name: "foo",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal string containing shell variable
				args: "${HOME}/bin",
			});
		});

		it("returns undefined when no `/skill:<name>` token is present", () => {
			expect(parseSkillInvocation("no skill token here")).toBeUndefined();
		});

		it("does not match when the slash is glued to a preceding non-whitespace character", () => {
			expect(parseSkillInvocation("https://example.com/skill:foo")).toBeUndefined();
		});

		it("excludes embedded slashes from the mid-prompt skill name", () => {
			// `/skill:foo/bar` mid-prompt is ambiguous with a path — the mid-prompt
			// regex requires `[^\s/]+`, so this falls through with no match.
			expect(parseSkillInvocation("see /skill:foo/bar")).toBeUndefined();
		});
	});
});
