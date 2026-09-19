import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableUserSource, enableUserSource } from "@oh-my-pi/pi-coding-agent/capability";
import { type Skill as CapabilitySkill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getWslWindowsHomeCandidate, runHostProbe } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import {
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	parseSkillInvocation,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";
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
			const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
			delete process.env.CLAUDE_CONFIG_DIR;
			delete Bun.env.CLAUDE_CONFIG_DIR;
			const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-home-"));
			const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-project-"));
			enableUserSource("claude");

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
				disableUserSource("claude");
				restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
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
	const first = path.join(collisionFixturesDir, "first");
	const second = path.join(collisionFixturesDir, "second");
	const mirror = path.join(collisionFixturesDir, "mirror");

	it("keeps a differing same-name skill under a namespaced name and warns", async () => {
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
		});
		const names = skills.map(skill => skill.name).sort();
		expect(names).toEqual(["first/calendar", "second/calendar"]);
		expect(skills.find(skill => skill.name === "first/calendar")?.filePath).toBe(
			path.join(first, "calendar", "SKILL.md"),
		);
		expect(skills.find(skill => skill.name === "second/calendar")?.filePath).toBe(
			path.join(second, "calendar", "SKILL.md"),
		);
		const collision = warnings.filter(warning => warning.message.includes("name collision"));
		expect(collision).toHaveLength(2);
		expect(collision.some(w => w.message.includes('available as "first/calendar"'))).toBe(true);
		expect(collision.some(w => w.message.includes('available as "second/calendar"'))).toBe(true);
	});

	it("silently collapses an identical same-name skill from another location", async () => {
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, mirror],
		});
		expect(skills.map(skill => skill.name)).toEqual(["calendar"]);
		expect(skills[0].filePath).toBe(path.join(first, "calendar", "SKILL.md"));
		expect(warnings.filter(warning => warning.message.includes("collision"))).toHaveLength(0);
	});

	it("silently collapses identical bodies across different namespaces", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-mirror-"));
		const thirdDir = path.join(tempDir, "third", "calendar");
		await fs.mkdir(thirdDir, { recursive: true });
		await fs.copyFile(path.join(second, "calendar", "SKILL.md"), path.join(thirdDir, "SKILL.md"));

		try {
			const { skills, warnings } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [first, second, path.join(tempDir, "third")],
			});
			const names = skills.map(skill => skill.name).sort();
			expect(names).toEqual(["first/calendar", "second/calendar"]);
			const collision = warnings.filter(warning => warning.message.includes("name collision"));
			expect(collision).toHaveLength(2);
			expect(collision.some(w => w.message.includes('available as "second/calendar"'))).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("resolves namespaced skills through skill:// URLs", async () => {
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
		});
		const handler = new SkillProtocolHandler();
		await expect(handler.resolve(parseInternalUrl("skill://calendar")!, { skills })).rejects.toThrow(
			"Unknown skill: calendar",
		);
		const firstSkill = await handler.resolve(parseInternalUrl("skill://first/calendar")!, { skills });
		expect(firstSkill.content).toContain("Calendar (First)");
		const namespaced = await handler.resolve(parseInternalUrl("skill://second/calendar")!, { skills });
		expect(namespaced.content).toContain("Calendar (Second)");
		const nested = await handler.resolve(parseInternalUrl("skill://second/calendar/SKILL.md")!, { skills });
		expect(nested.content).toContain("Calendar (Second)");
	});

	it("collapses a custom override whose body matches an existing alias", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "skills-override-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			// Provider copy of Second's calendar in ~/.agents/skills; the custom
			// directory then overrides the bare name with the identical body.
			const providerDir = path.join(home, ".agents", "skills", "calendar");
			await fs.mkdir(providerDir, { recursive: true });
			await fs.copyFile(path.join(second, "calendar", "SKILL.md"), path.join(providerDir, "SKILL.md"));
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				enableAgentsUser: true,
				customDirectories: [second],
			});
			expect(skills.map(skill => skill.name)).toEqual(["calendar"]);
			expect(skills[0].filePath).toBe(path.join(second, "calendar", "SKILL.md"));
		} finally {
			restoreEnvValue("HOME", previousHome);
			await removeWithRetries(home);
		}
	});

	it("normalizes derived namespaces to a token-safe form", async () => {
		const spaced = await fs.mkdtemp(path.join(os.tmpdir(), "My Skills-"));
		try {
			await fs.mkdir(path.join(spaced, "calendar"), { recursive: true });
			await fs.copyFile(path.join(second, "calendar", "SKILL.md"), path.join(spaced, "calendar", "SKILL.md"));
			const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [first, spaced] });
			const alias = skills.find(skill => skill.filePath.includes("My Skills"));
			// The temp root is "My Skills-<suffix>" → sanitized to "My-Skills-<suffix>".
			expect(alias?.name).toMatch(/^My-Skills-[^/]+\/calendar$/);
			expect(alias?.name).not.toContain(" ");
			const handler = new SkillProtocolHandler();
			const resolved = await handler.resolve(parseInternalUrl(`skill://${alias!.name}`)!, { skills });
			expect(resolved.content).toContain("Calendar (Second)");
			expect(parseSkillInvocation(`/skill:${alias!.name}`)?.name).toBe(alias!.name);
		} finally {
			await removeWithRetries(spaced);
		}
	});

	it("prefers an exact namespaced skill over a bare skill sharing the namespace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-selfnamed-"));
		try {
			// A skills root literally named "calendar" holding a differing "calendar"
			// skill produces the alias "calendar/calendar".
			const selfNamed = path.join(root, "calendar");
			await fs.mkdir(path.join(selfNamed, "calendar"), { recursive: true });
			await fs.copyFile(path.join(second, "calendar", "SKILL.md"), path.join(selfNamed, "calendar", "SKILL.md"));
			const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [first, selfNamed] });
			expect(skills.map(skill => skill.name).sort()).toEqual(["calendar/calendar", "first/calendar"]);
			const handler = new SkillProtocolHandler();
			const resolved = await handler.resolve(parseInternalUrl("skill://calendar/calendar")!, { skills });
			expect(resolved.content).toContain("Calendar (Second)");
		} finally {
			await removeWithRetries(root);
		}
	});

	it("keeps every differing skill when two of them share a namespace", async () => {
		const nested = path.join(collisionFixturesDir, "nested", "second");
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second, nested],
		});
		expect(skills.map(skill => skill.name).sort()).toEqual([
			"first/calendar",
			"second/calendar",
			"second/calendar~2",
		]);
		expect(skills.find(skill => skill.name === "second/calendar~2")?.filePath).toBe(
			path.join(nested, "calendar", "SKILL.md"),
		);
		expect(warnings.filter(warning => warning.message.includes("name collision"))).toHaveLength(3);
	});

	it("keeps a differing skill whose body matches a genuine ~N raw name", async () => {
		// A legal raw name ending in `~N` must not be read as a generated
		// collision suffix: `tilde-third/foo` shares a body with
		// `tilde-second/foo~2`, whose raw name is `foo~2`, not `foo` — so it is
		// a distinct skill and must be kept under its own namespace.
		const tildeMain = path.join(collisionFixturesDir, "tilde-main");
		const tildeSecond = path.join(collisionFixturesDir, "tilde-second");
		const tildeThird = path.join(collisionFixturesDir, "tilde-third");
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [tildeMain, tildeSecond, tildeThird],
		});
		expect(skills.map(skill => skill.name).sort()).toEqual([
			"tilde-main/foo",
			"tilde-main/foo~2",
			"tilde-second/foo",
			"tilde-second/foo~2",
			"tilde-third/foo",
		]);
		expect(skills.find(skill => skill.name === "tilde-second/foo~2")?.filePath).toBe(
			path.join(tildeSecond, "foo-raw", "SKILL.md"),
		);
		expect(skills.find(skill => skill.name === "tilde-third/foo")?.filePath).toBe(
			path.join(tildeThird, "foo", "SKILL.md"),
		);
		expect(warnings.filter(warning => warning.message.includes("name collision"))).toHaveLength(5);
	});

	it("refuses a raw skill name that claims a namespaced address", async () => {
		const squatter = path.join(collisionFixturesDir, "squatter");
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [squatter, first, second],
		});
		expect(skills.map(skill => skill.name).sort()).toEqual(["first/calendar", "second/calendar"]);
		expect(skills.find(skill => skill.name === "second/calendar")?.filePath).toBe(
			path.join(second, "calendar", "SKILL.md"),
		);
		expect(warnings.some(warning => warning.message.includes("path separator"))).toBe(true);
	});

	it("disables a namespaced skill by its own extension id without touching the bare one", async () => {
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
			disabledExtensions: ["skill:second/calendar"],
		});
		expect(skills.map(skill => skill.name)).toEqual(["calendar"]);
	});

	it("matches include patterns against the namespaced name", async () => {
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
			includeSkills: ["second/*"],
		});
		// The bare skill is still needed to derive the namespaced name; only the
		// final listing is filtered.
		expect(skills.map(skill => skill.name)).toEqual(["second/calendar"]);
		const excluded = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
			ignoredSkills: ["second/*"],
		});
		expect(excluded.skills.map(skill => skill.name)).toEqual(["calendar"]);
	});

	it("keeps a displaced provider skill when its namespaced slot is already taken", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "skills-displaced-"));
		try {
			// Project-level .claude/skills/calendar (provider "claude"; the dotted
			// home makes its namespace fall back to the provider id) versus a custom
			// root literally named "claude" that derives the same namespace.
			const providerDir = path.join(project, ".claude", "skills", "calendar");
			const claudeRoot = path.join(project, "x", "claude");
			await fs.mkdir(providerDir, { recursive: true });
			await fs.mkdir(path.join(claudeRoot, "calendar"), { recursive: true });
			await fs.copyFile(path.join(first, "calendar", "SKILL.md"), path.join(providerDir, "SKILL.md"));
			await fs.copyFile(
				path.join(collisionFixturesDir, "nested", "second", "calendar", "SKILL.md"),
				path.join(claudeRoot, "calendar", "SKILL.md"),
			);
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				enableClaudeProject: true,
				cwd: project,
				customDirectories: [second, claudeRoot],
			});
			const byName = new Map(skills.map(skill => [skill.name, skill]));
			// Both the provider skill and the custom skills collide on "calendar",
			// so all three variants receive a namespace prefix.
			expect(byName.get("second/calendar")?.filePath).toBe(path.join(second, "calendar", "SKILL.md"));
			expect(byName.get("claude/calendar")?.filePath).toBe(path.join(providerDir, "SKILL.md"));
			expect(byName.get("claude/calendar~2")?.filePath).toBe(path.join(claudeRoot, "calendar", "SKILL.md"));
			expect(skills).toHaveLength(3);
		} finally {
			await removeWithRetries(project);
		}
	});
});

describe("parseSkillInvocation", () => {
	describe("leading `/skill:<name>` form", () => {
		it("parses a bare leading command", () => {
			expect(parseSkillInvocation("/skill:foo")).toEqual({ name: "foo", args: "", prompt: "/skill:foo" });
		});

		it("captures everything after the first space as args", () => {
			expect(parseSkillInvocation("/skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
				prompt: "/skill:foo focus on auth",
			});
		});

		it("terminates the name at a newline so a multi-line draft still invokes the skill", () => {
			expect(parseSkillInvocation("/skill:foo\nfocus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
				prompt: "/skill:foo\nfocus on auth",
			});
		});

		it("allows leading whitespace before the `/skill:<name>` command", () => {
			expect(parseSkillInvocation("  /skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
				prompt: "/skill:foo focus on auth",
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
				prompt: "fix the auth bug /skill:security-scan",
			});
		});

		it("collapses prose on both sides of the skill token into a single args string", () => {
			expect(parseSkillInvocation("leading /skill:foo trailing")).toEqual({
				name: "foo",
				args: "leading trailing",
				prompt: "leading /skill:foo trailing",
			});
		});

		it("preserves embedded newlines in args when the skill token spans a line break", () => {
			expect(parseSkillInvocation("explain this\nthen use /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "explain this\nthen use",
				prompt: "explain this\nthen use /skill:security-scan",
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
				prompt: "$echo /skill:reviewer",
			});
			// oxlint-disable-next-line no-template-curly-in-string -- testing literal string containing shell variable
			expect(parseSkillInvocation("${HOME}/bin /skill:foo")).toEqual({
				name: "foo",
				// oxlint-disable-next-line no-template-curly-in-string -- testing literal string containing shell variable
				args: "${HOME}/bin",
				// oxlint-disable-next-line no-template-curly-in-string -- testing literal string containing shell variable
				prompt: "${HOME}/bin /skill:foo",
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
