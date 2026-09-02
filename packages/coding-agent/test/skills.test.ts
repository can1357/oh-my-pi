import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { disableUserSource, enableUserSource } from "@oh-my-pi/pi-coding-agent/capability";
import { type Skill as CapabilitySkill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getWslWindowsHomeCandidate, runHostProbe } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import { ExtensionRunner, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtensionError } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	parseSkillInvocation,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { restoreEnvValue } from "./helpers/settings-test-state";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures/skills");
const collisionFixturesDir = path.resolve(import.meta.dirname, "fixtures/skills-collision");

const longSkillName = "this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard";
const expectedFixtureSkillOrder: string[] = [
	"bad--name",
	"child-skill",
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

		it("should load skills one namespace level deep but not deeper", async () => {
			const { skills } = await loadFixtureRoot();

			// nested/child-skill: one namespace level below the root — discovered.
			expect(skills.some(skill => skill.name === "child-skill")).toBe(true);
			// nested/deeper/grandchild-skill: two levels down — stays invisible.
			expect(skills.some(skill => skill.name === "grandchild-skill")).toBe(false);
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
					"child-skill",
				]),
			);
			expect(skills).toHaveLength(7);
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

	describe("extensionDirectories (resources_discover)", () => {
		async function writeSkill(root: string, relDir: string, name: string, description: string): Promise<string> {
			const skillDir = path.join(root, relDir);
			await fs.mkdir(skillDir, { recursive: true });
			const skillPath = path.join(skillDir, "SKILL.md");
			await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
			return skillPath;
		}

		it("should load skills from extension directories with extension source labeling", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-skills-"));
			try {
				await writeSkill(tempDir, "flat-ext-skill", "flat-ext-skill", "Flat extension-provided skill.");
				await writeSkill(tempDir, "second-ext-skill", "second-ext-skill", "Second extension-provided skill.");

				const { skills } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					extensionDirectories: [tempDir],
				});

				const flat = skills.find(s => s.name === "flat-ext-skill");
				expect(flat).toBeDefined();
				expect(skills.some(s => s.name === "second-ext-skill")).toBe(true);
				expect(flat!.source).toBe("extension:user");
				expect(flat!._source?.providerName).toBe("Extension");
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("should prefer customDirectories over extensionDirectories on name collision", async () => {
			const customDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-custom-"));
			const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-ext-"));
			try {
				const customPath = await writeSkill(customDir, "shared-name", "shared-name", "From custom directory.");
				await writeSkill(extensionDir, "shared-name", "shared-name", "From extension directory.");

				const { skills, warnings } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					customDirectories: [customDir],
					extensionDirectories: [extensionDir],
				});

				const shared = skills.filter(s => s.name === "shared-name");
				expect(shared).toHaveLength(1);
				expect(shared[0].filePath).toBe(customPath);
				expect(shared[0].source).toBe("custom:user");
				expect(warnings.some(w => w.message.includes(`name collision: "shared-name"`))).toBe(true);
			} finally {
				await removeWithRetries(customDir);
				await removeWithRetries(extensionDir);
			}
		});

		it("should apply ignoredSkills to extension directories", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-ignored-"));
			try {
				await writeSkill(tempDir, "ignored-ext-skill", "ignored-ext-skill", "Should be filtered out.");
				await writeSkill(tempDir, "kept-ext-skill", "kept-ext-skill", "Should survive the filter.");

				const { skills } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					extensionDirectories: [tempDir],
					ignoredSkills: ["ignored-ext-skill"],
				});

				expect(skills.some(s => s.name === "ignored-ext-skill")).toBe(false);
				expect(skills.some(s => s.name === "kept-ext-skill")).toBe(true);
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("should dedupe by real path when custom and extension directories overlap", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-overlap-"));
			try {
				await writeSkill(tempDir, "overlap-skill", "overlap-skill", "Reached via two configured routes.");

				const { skills, warnings } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					customDirectories: [tempDir],
					extensionDirectories: [tempDir],
				});

				expect(skills.filter(s => s.name === "overlap-skill")).toHaveLength(1);
				expect(warnings.some(w => w.message.includes(`name collision: "overlap-skill"`))).toBe(false);
			} finally {
				await removeWithRetries(tempDir);
			}
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

describe("session resources_discover lifecycle (issue: PR #9379 review)", () => {
	/**
	 * Writes an on-disk extension whose `resources_discover` handler only
	 * returns a skill path once its `session_start` handler has already run
	 * (recorded via a marker file — the extension runs in its own dynamic
	 * import, so it can't share a closure variable with the test) — mirroring
	 * a real extension that derives discovery state during `session_start`.
	 * Pre-fix, `sdk.ts` emitted `resources_discover` before any mode called
	 * `initialize()`/`session_start`, so this handler always saw no marker and
	 * returned nothing — the skill never reached `session.skills`.
	 */
	async function writeStartupOrderingExtension(
		extensionsDir: string,
		markerPath: string,
		skillDir: string,
	): Promise<string> {
		await fs.mkdir(extensionsDir, { recursive: true });
		const extPath = path.join(extensionsDir, "startup-ordering.ts");
		await fs.writeFile(
			extPath,
			`import * as fs from "node:fs";
export default function (pi) {
	pi.on("session_start", () => {
		fs.writeFileSync(${JSON.stringify(markerPath)}, "started");
	});
	pi.on("resources_discover", () => {
		if (!fs.existsSync(${JSON.stringify(markerPath)})) return undefined;
		return { skillPaths: [${JSON.stringify(skillDir)}] };
	});
}
`,
		);
		return extPath;
	}

	async function writeStartupSkill(root: string): Promise<void> {
		const skillDir = path.join(root, "startup-discovered-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: startup-discovered-skill\ndescription: Contributed via resources_discover at startup.\n---\n\nbody\n",
		);
	}

	it("folds resources_discover skillPaths into session.skills only after session_start has fired", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-startup-skill-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			await writeStartupSkill(tempDir);
			const markerPath = path.join(tempDir, "session-started.marker");
			const extPath = await writeStartupOrderingExtension(path.join(tempDir, "ext"), markerPath, tempDir);

			// Direct extension loading + `new AgentSession(...)`, not
			// `createAgentSession()`: the SDK entrypoint also runs
			// `initializeWithSettings` and wires process-global registries
			// (model lifecycle, settings) that other suites assert against —
			// unrelated global state this test must not touch.
			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
			});

			const runtimeErrors: ExtensionError[] = [];

			// The bug this regresses: emitting resources_discover before
			// session_start means the marker file doesn't exist yet, and the
			// handler above returns nothing.
			const markerExistsBeforeStart = await fs.access(markerPath).then(
				() => true,
				() => false,
			);
			expect(markerExistsBeforeStart).toBe(false);

			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});

			expect(runtimeErrors).toEqual([]);
			expect(session.skills.some(skill => skill.name === "startup-discovered-skill")).toBe(true);

			// `/reload-plugins` re-emits resources_discover with reason "reload";
			// the marker persists across reloads, so the skill must still be found.
			await session.refreshSkills();
			expect(session.skills.some(skill => skill.name === "startup-discovered-skill")).toBe(true);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("still emits resources_discover at startup for a session with a fixed skill snapshot (options.skills)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-fixed-skills-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			const markerPath = path.join(tempDir, "resources-discover.marker");
			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "fixed-skills-observer.ts");
			await fs.writeFile(
				extPath,
				`import * as fs from "node:fs";
export default function (pi) {
	pi.on("resources_discover", () => {
		fs.writeFileSync(${JSON.stringify(markerPath)}, "discovered");
		return { skillPaths: [${JSON.stringify(tempDir)}] };
	});
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			// A fixed skill snapshot (the SDK caller supplied `options.skills`,
			// which maps to `skillsReloadable: false`) must not suppress the
			// `resources_discover` event itself — only the skill rescan it
			// would otherwise trigger.
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
				skills: [],
				skillsReloadable: false,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});

			expect(runtimeErrors).toEqual([]);
			const markerFired = await fs.access(markerPath).then(
				() => true,
				() => false,
			);
			expect(markerFired).toBe(true);
			// The skill rescan is skipped for a fixed snapshot: the returned
			// skillPaths never reach session.skills.
			expect(session.skills.some(skill => skill.name === "startup-discovered-skill")).toBe(false);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("merges resources_discover skillPaths into a subagent's inherited fixed skill snapshot (mergeDiscoveredSkillPaths)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-merge-skills-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			// A skill the subagent's own resources_discover handler contributes.
			const discoveredDir = path.join(tempDir, "task-discovered-skill");
			await fs.mkdir(discoveredDir, { recursive: true });
			await fs.writeFile(
				path.join(discoveredDir, "SKILL.md"),
				"---\nname: task-discovered-skill\ndescription: Contributed by a task subagent's own extension instance.\n---\n\nbody\n",
			);
			// A skill that must sort *before* the inherited "shared-skill" entry
			// (regression: PR #9379 round-6 review) — appending discovered skills
			// after the inherited snapshot without re-sorting would leave this
			// after "shared-skill" in `session.skills` instead of before it.
			const earlySortingDir = path.join(tempDir, "aaa-discovered-skill");
			await fs.mkdir(earlySortingDir, { recursive: true });
			await fs.writeFile(
				path.join(earlySortingDir, "SKILL.md"),
				"---\nname: aaa-discovered-skill\ndescription: Sorts before the inherited snapshot entry alphabetically.\n---\n\nbody\n",
			);
			// A colliding name held by a *configured* source (custom:user): the
			// inherited entry wins — first configured source keeps priority.
			const collidingDir = path.join(tempDir, "shared-skill");
			await fs.mkdir(collidingDir, { recursive: true });
			await fs.writeFile(
				path.join(collidingDir, "SKILL.md"),
				"---\nname: shared-skill\ndescription: Discovered version — must lose to the inherited configured one.\n---\n\nbody\n",
			);
			// A colliding name held by a *default provider* source (claude:user):
			// the discovered configured source must replace it, mirroring
			// `loadSkills`'s custom-directory precedence (PR #9379 review).
			const providerDir = path.join(tempDir, "provider-skill");
			await fs.mkdir(providerDir, { recursive: true });
			await fs.writeFile(
				path.join(providerDir, "SKILL.md"),
				"---\nname: provider-skill\ndescription: Discovered version — must replace the provider-sourced one.\n---\n\nbody\n",
			);
			// A skill explicitly disabled by the user (`disabledExtensions:
			// ["skill:disabled-skill"]` below): the merge must honor that gate
			// the same way the full-rescan `loadSkills` path does, not just
			// ignoredSkills/includeSkills.
			const extDir = path.join(tempDir, "ext-skill");
			await fs.mkdir(extDir, { recursive: true });
			await fs.writeFile(
				path.join(extDir, "SKILL.md"),
				"---\nname: ext-skill\ndescription: Child extension version — replaces the parent-discovered one.\n---\n\nbody\n",
			);
			const disabledDir = path.join(tempDir, "disabled-skill");
			await fs.mkdir(disabledDir, { recursive: true });
			await fs.writeFile(
				path.join(disabledDir, "SKILL.md"),
				"---\nname: disabled-skill\ndescription: Disabled by the user — must never enter the child snapshot.\n---\n\nbody\n",
			);

			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "task-merge-observer.ts");
			await fs.writeFile(
				extPath,
				`export default function (pi) {
	pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(tempDir)}] }));
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			// Simulates `buildSubagentSessionOptions` in task/executor.ts: the
			// parent forwards its own already-discovered `skills` (perf only)
			// and sets `mergeDiscoveredSkillPaths`, unlike a direct SDK caller
			// who supplies `options.skills` to freeze the set outright.
			const inheritedSkill: Skill = {
				name: "shared-skill",
				description: "Inherited from the parent session — must win on collision.",
				filePath: path.join(tempDir, "inherited", "SKILL.md"),
				baseDir: path.join(tempDir, "inherited"),
				source: "custom:user",
			};
			const inheritedProviderSkill: Skill = {
				name: "provider-skill",
				description: "Inherited from a default provider — must be replaced.",
				filePath: path.join(tempDir, "inherited-provider", "SKILL.md"),
				baseDir: path.join(tempDir, "inherited-provider"),
				source: "claude:user",
			};
			// An extension-sourced entry inherited from the PARENT's discovery
			// pass: the child's own rescan would only see the child's extension
			// directories, so the child's contribution replaces it
			// (PR #9379 round-6 review).
			const inheritedExtensionSkill: Skill = {
				name: "ext-skill",
				description: "Inherited from the parent's extension discovery — must be replaced.",
				filePath: path.join(tempDir, "inherited-ext", "SKILL.md"),
				baseDir: path.join(tempDir, "inherited-ext"),
				source: "extension:user",
			};
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					disabledExtensions: ["skill:disabled-skill"],
				}),
				modelRegistry,
				extensionRunner,
				skills: [inheritedSkill, inheritedProviderSkill, inheritedExtensionSkill],
				skillsReloadable: false,
				mergeDiscoveredSkillPaths: true,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});

			expect(runtimeErrors).toEqual([]);
			// The newly discovered skill is added onto the inherited snapshot...
			expect(session.skills.some(skill => skill.name === "task-discovered-skill")).toBe(true);
			// ...but a name collision with a *configured* inherited source keeps
			// the inherited snapshot's version (first configured source wins).
			const shared = session.skills.find(skill => skill.name === "shared-skill");
			expect(shared?.description).toBe("Inherited from the parent session — must win on collision.");
			expect(session.skills.filter(skill => skill.name === "shared-skill")).toHaveLength(1);
			// A default-provider inherited skill is replaced by the discovered
			// configured source, matching `loadSkills` precedence.
			const provider = session.skills.find(skill => skill.name === "provider-skill");
			expect(provider?.description).toBe("Discovered version — must replace the provider-sourced one.");
			expect(provider?.source).toBe("extension:user");
			expect(session.skills.filter(skill => skill.name === "provider-skill")).toHaveLength(1);
			// A parent-discovered extension entry is replaced by the child's own
			// extension contribution (the child's rescan would never see the
			// parent's directory).
			const ext = session.skills.find(skill => skill.name === "ext-skill");
			expect(ext?.description).toBe("Child extension version — replaces the parent-discovered one.");
			expect(session.skills.filter(skill => skill.name === "ext-skill")).toHaveLength(1);
			// A skill the user disabled cannot re-enter through this merge path.
			expect(session.skills.some(skill => skill.name === "disabled-skill")).toBe(false);
			// The merged array must be re-sorted by the same `compareSkillOrder`
			// comparator the full-rescan path uses (extensibility/skills.ts),
			// not left as the inherited snapshot followed by append order
			// (regression: PR #9379 round-6 review).
			expect(session.skills.map(skill => skill.name)).toEqual([
				"aaa-discovered-skill",
				"ext-skill",
				"provider-skill",
				"shared-skill",
				"task-discovered-skill",
			]);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("still emits resources_discover on /reload-plugins for a session with a fixed skill snapshot", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-fixed-skills-reload-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			const reasonsPath = path.join(tempDir, "resources-discover-reasons.log");
			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "fixed-skills-reload-observer.ts");
			await fs.writeFile(
				extPath,
				`import * as fs from "node:fs";
export default function (pi) {
	pi.on("resources_discover", event => {
		fs.appendFileSync(${JSON.stringify(reasonsPath)}, event.reason + "\\n");
		return { skillPaths: [${JSON.stringify(tempDir)}] };
	});
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			// Same fixed-snapshot contract as startup, but exercised through
			// `/reload-plugins` (`session.refreshSkills()`): the event must
			// still fire with reason "reload" even though the skill rescan
			// it would otherwise trigger stays skipped.
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
				skills: [],
				skillsReloadable: false,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});
			expect(runtimeErrors).toEqual([]);

			await session.refreshSkills();

			const reasons = await fs.readFile(reasonsPath, "utf8");
			expect(reasons.trim().split("\n")).toEqual(["startup", "reload"]);
			// The skill rescan is skipped for a fixed snapshot: the returned
			// skillPaths never reach session.skills, even after reload.
			expect(session.skills.some(skill => skill.name === "startup-discovered-skill")).toBe(false);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("first contributing directory wins a same-name replacement across discovered dirs (regression: PR #9379 round-7 review)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-merge-first-wins-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			const dirA = path.join(tempDir, "dir-a");
			const dirB = path.join(tempDir, "dir-b");
			for (const [dir, label] of [
				[dirA, "first"],
				[dirB, "second"],
			] as const) {
				const skillDir = path.join(dir, "dup-skill");
				await fs.mkdir(skillDir, { recursive: true });
				await fs.writeFile(
					path.join(skillDir, "SKILL.md"),
					`---\nname: dup-skill\ndescription: ${label} directory version\n---\n\nbody\n`,
				);
			}

			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "first-wins-observer.ts");
			await fs.writeFile(
				extPath,
				`export default function (pi) {
	pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(dirA)}, ${JSON.stringify(dirB)}] }));
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			// The inherited snapshot holds a replaceable (provider-sourced) entry
			// under the same name — both directories try to replace it; the
			// FIRST must win, mirroring loadSkills's configured-source policy.
			const inheritedProviderSkill: Skill = {
				name: "dup-skill",
				description: "Inherited provider version — replaced by the FIRST discovered dir.",
				filePath: path.join(tempDir, "inherited", "SKILL.md"),
				baseDir: path.join(tempDir, "inherited"),
				source: "claude:user",
			};
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
				skills: [inheritedProviderSkill],
				skillsReloadable: false,
				mergeDiscoveredSkillPaths: true,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});
			expect(runtimeErrors).toEqual([]);

			const dup = session.skills.filter(skill => skill.name === "dup-skill");
			expect(dup).toHaveLength(1);
			expect(dup[0].description).toBe("first directory version");
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("drops a previously discovered skill on reload when its directory stops contributing (regression: PR #9379 round-7 review)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-merge-reload-drop-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			const skillDir = path.join(tempDir, "transient-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				"---\nname: transient-skill\ndescription: Contributed at startup, withdrawn on reload.\n---\n\nbody\n",
			);

			const togglePath = path.join(tempDir, "contribute.flag");
			await fs.writeFile(togglePath, "yes");
			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "withdrawing-observer.ts");
			await fs.writeFile(
				extPath,
				`import * as fs from "node:fs";
export default function (pi) {
	pi.on("resources_discover", () => {
		if (!fs.existsSync(${JSON.stringify(togglePath)})) return { skillPaths: [] };
		return { skillPaths: [${JSON.stringify(tempDir)}] };
	});
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
				skills: [],
				skillsReloadable: false,
				mergeDiscoveredSkillPaths: true,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});
			expect(runtimeErrors).toEqual([]);
			expect(session.skills.some(skill => skill.name === "transient-skill")).toBe(true);

			// The handler withdraws its contribution; `/reload-plugins` must
			// reconcile the snapshot back to the inherited base, not leave the
			// stale skill in the prompt until the child is recreated.
			await fs.rm(togglePath);
			await session.refreshSkills();

			expect(session.skills.some(skill => skill.name === "transient-skill")).toBe(false);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("folds reload-time resources_discover contributions into a merge-marked subagent snapshot (regression: PR #9379 round-5 review)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-merge-skills-reload-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "reload-merge-observer.ts");
			await fs.writeFile(
				extPath,
				`export default function (pi) {
	pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(tempDir)}] }));
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
				skills: [],
				skillsReloadable: false,
				mergeDiscoveredSkillPaths: true,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});
			expect(runtimeErrors).toEqual([]);
			expect(session.skills.some(skill => skill.name === "late-skill")).toBe(false);

			// A skill that appears only after startup — `/reload-plugins`
			// (`refreshSkills`) must fold it into the inherited snapshot the
			// same way `discoverStartupSkillPaths` would have at startup, not
			// freeze the snapshot permanently after init.
			const lateDir = path.join(tempDir, "late-skill");
			await fs.mkdir(lateDir, { recursive: true });
			await fs.writeFile(
				path.join(lateDir, "SKILL.md"),
				"---\nname: late-skill\ndescription: Appears after startup; reload must merge it.\n---\n\nbody\n",
			);

			await session.refreshSkills();

			expect(session.skills.some(skill => skill.name === "late-skill")).toBe(true);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
	});

	it("drains a resources_discover-triggered sendUserMessage before returning (regression: PR #9379 round-5 review)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-discover-drain-"));
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			// A `resources_discover` handler that announces itself via
			// `pi.sendUserMessage()` — the same shared action context every other
			// handler uses (mirrors an extension posting a note about a directory
			// it just discovered). The handler itself returns synchronously, but
			// `sendUserMessage` starts an async turn the action never exposes a
			// promise for.
			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const extPath = path.join(extensionsDir, "discover-announce.ts");
			await fs.writeFile(
				extPath,
				`export default function (pi) {
	pi.on("resources_discover", () => {
		pi.sendUserMessage("announcing a discovered directory");
		return undefined;
	});
}
`,
			);

			const loaded = await loadExtensions([extPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			// `delayMs` makes the extension-triggered turn's completion
			// observably later than the handler's own synchronous return, so a
			// caller that fails to drain pending sends would see this resolve
			// with the turn still in flight.
			const mock = createMockModel({ handler: () => ({ content: ["ack"], delayMs: 20 }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);

			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				extensionRunner,
			});

			const runtimeErrors: ExtensionError[] = [];
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					runtimeErrors.push(error);
				},
			});

			expect(runtimeErrors).toEqual([]);
			// The extension-triggered turn must be fully settled by the time
			// `initializeExtensions` resolves — not merely started — or a caller
			// like print mode's immediate `session.prompt()` can observe the
			// session as still streaming and throw `AgentBusyError`.
			expect(session.isStreaming).toBe(false);
			expect(
				session.messages.some(
					m => m.role === "assistant" && m.content.some(c => c.type === "text" && c.text === "ack"),
				),
			).toBe(true);
			// Prove it wasn't a lucky race: a caller can prompt immediately
			// afterward without hitting AgentBusyError.
			await expect(session.prompt("next")).resolves.toBe(true);
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(tempDir);
		}
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
			// oxlint-disable-next-line no-template-curly-in-string -- testing literal string containing shell variable
			expect(parseSkillInvocation("${HOME}/bin /skill:foo")).toEqual({
				name: "foo",
				// oxlint-disable-next-line no-template-curly-in-string -- testing literal string containing shell variable
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
