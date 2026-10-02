import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
import {
	getSkillStorePath,
	STORE_INTEGRITY_FILE,
	writeSkillsLock,
} from "@oh-my-pi/pi-coding-agent/skillshare/manifest";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
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
 * that need to isolate a custom directory or assert "no built-in leakage".
 * Plugin providers (`omp-plugins`, `claude-plugins`, `agent-plugins`) have no
 * toggle; the file-wide isolated home below keeps the developer's real plugin
 * installs out of every assertion.
 */
const DISABLE_ALL_BUILTIN_SKILLS = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
};

// Every provider resolves user-level roots from `os.homedir()` (HOME on POSIX,
// USERPROFILE on Windows) and the agent dir; point both at an empty temp home
// so real `~/.omp/plugins`, `~/.claude/plugins`, and `~/.agents/skills`
// installs never leak into these tests. On POSIX, Bun fixes `os.homedir()` at
// process start, so setting HOME alone is not enough; spy on it as well.
const isolatedEnvKeys = [
	"HOME",
	"USERPROFILE",
	"CLAUDE_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
	isolatedEnvKeys.map(key => [key, process.env[key]]),
);
let isolatedHome = "";
// Re-armed before every test: an inner test's `mockRestore()` on its own
// `os.homedir` spy restores the real function, not this one.
const isolateHomedir = () => spyOn(os, "homedir").mockReturnValue(isolatedHome);

beforeAll(async () => {
	isolatedHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-home-")));
	isolateHomedir();
	for (const key of ["HOME", "USERPROFILE"] as const) {
		process.env[key] = isolatedHome;
		Bun.env[key] = isolatedHome;
	}
	delete process.env.CLAUDE_CONFIG_DIR;
	delete Bun.env.CLAUDE_CONFIG_DIR;
	setAgentDir(path.join(isolatedHome, ".omp", "agent"));
});

beforeEach(() => {
	isolateHomedir();
});

afterAll(async () => {
	for (const key of isolatedEnvKeys) restoreEnvValue(key, originalEnv[key]);
	isolateHomedir().mockRestore();
	__resetDirsFromEnvForTests();
	await removeWithRetries(isolatedHome);
});

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

		// The WSL candidate maps USERPROFILE to `/mnt/<drive>/...`, which a Windows
		// host cannot resolve; the pure mapping is covered by the tests below.
		it.skipIf(process.platform === "win32")(
			"should load Windows host ~/.agents/skills when running under WSL (#3779)",
			async () => {
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
			},
		);

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

	it("keeps the first-admitted skill on its bare name and namespaces the later collision", async () => {
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
		});
		const names = skills.map(skill => skill.name).sort();
		expect(names).toEqual(["calendar", "second/calendar"]);
		expect(skills.find(skill => skill.name === "calendar")?.filePath).toBe(path.join(first, "calendar", "SKILL.md"));
		expect(skills.find(skill => skill.name === "second/calendar")?.filePath).toBe(
			path.join(second, "calendar", "SKILL.md"),
		);
		const collision = warnings.filter(warning => warning.message.includes("name collision"));
		expect(collision).toHaveLength(1);
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
			expect(names).toEqual(["calendar", "second/calendar"]);
			const collision = warnings.filter(warning => warning.message.includes("name collision"));
			expect(collision).toHaveLength(1);
			expect(collision.some(w => w.message.includes('available as "second/calendar"'))).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("resolves the bare name to the winner and the collision to its namespaced form", async () => {
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
		});
		const handler = new SkillProtocolHandler();
		const bareSkill = await handler.resolve(parseInternalUrl("skill://calendar")!, { skills });
		expect(bareSkill.content).toContain("Calendar (First)");
		const namespaced = await handler.resolve(parseInternalUrl("skill://second/calendar")!, { skills });
		expect(namespaced.content).toContain("Calendar (Second)");
		const nested = await handler.resolve(parseInternalUrl("skill://second/calendar/SKILL.md")!, { skills });
		expect(nested.content).toContain("Calendar (Second)");
	});

	/** Project with `.claude/skills/calendar` (priority 80) and `.agents/skills/calendar` (priority 70) copied from fixtures. */
	async function projectWithProviderCopies(claudeFrom: string, agentsFrom: string | undefined) {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "skills-provider-copies-"));
		const claudeFile = path.join(project, ".claude", "skills", "calendar", "SKILL.md");
		await fs.mkdir(path.dirname(claudeFile), { recursive: true });
		await fs.copyFile(claudeFrom, claudeFile);
		let agentsFile: string | undefined;
		if (agentsFrom) {
			agentsFile = path.join(project, ".agents", "skills", "calendar", "SKILL.md");
			await fs.mkdir(path.dirname(agentsFile), { recursive: true });
			await fs.copyFile(agentsFrom, agentsFile);
		}
		return { project, claudeFile, agentsFile };
	}
	const providerOptions = { ...DISABLE_ALL_BUILTIN_SKILLS, enableClaudeProject: true, enableAgentsProject: true };

	it("lets a custom override that matches a namespaced provider alias take the bare name", async () => {
		// .claude (A) holds the bare name, .agents (B) is namespaced, and the custom
		// override is byte-identical to B: it must still override A (#7190), and B's
		// alias is redundant once the override carries the same content.
		const { project, claudeFile } = await projectWithProviderCopies(
			path.join(first, "calendar", "SKILL.md"),
			path.join(second, "calendar", "SKILL.md"),
		);
		try {
			const { skills, warnings } = await loadSkills({
				...providerOptions,
				cwd: project,
				customDirectories: [second],
			});
			expect(skills.map(skill => skill.name).sort()).toEqual(["calendar", "claude/calendar"]);
			expect(skills.find(skill => skill.name === "calendar")?.filePath).toBe(
				path.join(second, "calendar", "SKILL.md"),
			);
			expect(skills.find(skill => skill.name === "claude/calendar")?.filePath).toBe(claudeFile);
			// Only the displacement is reported; the dropped alias's own warning is retracted.
			const collision = warnings.filter(warning => warning.message.includes("name collision"));
			expect(collision).toHaveLength(1);
			expect(collision[0].message).toContain('available as "claude/calendar"');
		} finally {
			await removeWithRetries(project);
		}
	});

	it("drops a provider skill identical to a custom override instead of re-admitting it", async () => {
		const { project } = await projectWithProviderCopies(path.join(first, "calendar", "SKILL.md"), undefined);
		try {
			const { skills, warnings } = await loadSkills({
				...providerOptions,
				cwd: project,
				customDirectories: [mirror],
			});
			expect(skills.map(skill => skill.name)).toEqual(["calendar"]);
			expect(skills[0].filePath).toBe(path.join(mirror, "calendar", "SKILL.md"));
			expect(warnings.filter(warning => warning.message.includes("collision"))).toHaveLength(0);
		} finally {
			await removeWithRetries(project);
		}
	});

	it("does not silently collapse identical bodies with differing frontmatter", async () => {
		// Same markdown body, different `description` frontmatter: the two
		// skills read differently to the model (and any other frontmatter
		// field, e.g. allowed-tools, could differ too), so a body-only equality
		// check must not treat them as the same skill.
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "skills-fm-a-"));
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "skills-fm-b-"));
		try {
			const body = "# Calendar\n\nSame body text for both skills.\n";
			await fs.mkdir(path.join(dirA, "calendar"), { recursive: true });
			await Bun.write(
				path.join(dirA, "calendar", "SKILL.md"),
				`---\nname: calendar\ndescription: Description A.\n---\n\n${body}`,
			);
			await fs.mkdir(path.join(dirB, "calendar"), { recursive: true });
			await Bun.write(
				path.join(dirB, "calendar", "SKILL.md"),
				`---\nname: calendar\ndescription: Description B.\n---\n\n${body}`,
			);

			const { skills, warnings } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [dirA, dirB],
			});
			const nsB = path.basename(dirB);
			const bareEntry = skills.find(skill => skill.name === "calendar");
			const namespacedEntry = skills.find(skill => skill.name === `${nsB}/calendar`);
			expect(bareEntry).toBeDefined();
			expect(namespacedEntry).toBeDefined();
			expect(bareEntry!.filePath).toBe(path.join(dirA, "calendar", "SKILL.md"));
			expect(namespacedEntry!.filePath).toBe(path.join(dirB, "calendar", "SKILL.md"));
			expect(bareEntry!.description).toBe("Description A.");
			expect(namespacedEntry!.description).toBe("Description B.");
			expect(warnings.some(warning => warning.message.includes("name collision"))).toBe(true);
		} finally {
			await removeWithRetries(dirA);
			await removeWithRetries(dirB);
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
			// skill produces the alias "calendar/calendar", distinct from the bare
			// "calendar" winner (`first`, admitted first).
			const selfNamed = path.join(root, "calendar");
			await fs.mkdir(path.join(selfNamed, "calendar"), { recursive: true });
			await fs.copyFile(path.join(second, "calendar", "SKILL.md"), path.join(selfNamed, "calendar", "SKILL.md"));
			const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [first, selfNamed] });
			expect(skills.map(skill => skill.name).sort()).toEqual(["calendar", "calendar/calendar"]);
			const handler = new SkillProtocolHandler();
			const bareSkill = await handler.resolve(parseInternalUrl("skill://calendar")!, { skills });
			expect(bareSkill.content).toContain("Calendar (First)");
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
		expect(skills.map(skill => skill.name).sort()).toEqual(["calendar", "second/calendar", "second/calendar~2"]);
		expect(skills.find(skill => skill.name === "calendar")?.filePath).toBe(path.join(first, "calendar", "SKILL.md"));
		expect(skills.find(skill => skill.name === "second/calendar~2")?.filePath).toBe(
			path.join(nested, "calendar", "SKILL.md"),
		);
		expect(warnings.filter(warning => warning.message.includes("name collision"))).toHaveLength(2);
	});

	it("keeps a differing skill whose body matches a genuine ~N raw name", async () => {
		// A legal raw name ending in `~N` must not be read as a generated
		// collision suffix: `tilde-third/foo` differs from both `foo` (bare,
		// tilde-main) and `tilde-second/foo`, so it keeps its own namespace
		// rather than being folded into `tilde-second/foo~2`, whose raw name is
		// `foo~2`, not `foo`.
		const tildeMain = path.join(collisionFixturesDir, "tilde-main");
		const tildeSecond = path.join(collisionFixturesDir, "tilde-second");
		const tildeThird = path.join(collisionFixturesDir, "tilde-third");
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [tildeMain, tildeSecond, tildeThird],
		});
		expect(skills.map(skill => skill.name).sort()).toEqual([
			"foo",
			"foo~2",
			"tilde-second/foo",
			"tilde-second/foo~2",
			"tilde-third/foo",
		]);
		expect(skills.find(skill => skill.name === "foo")?.filePath).toBe(path.join(tildeMain, "foo", "SKILL.md"));
		expect(skills.find(skill => skill.name === "foo~2")?.filePath).toBe(path.join(tildeMain, "foo-raw", "SKILL.md"));
		expect(skills.find(skill => skill.name === "tilde-second/foo~2")?.filePath).toBe(
			path.join(tildeSecond, "foo-raw", "SKILL.md"),
		);
		expect(skills.find(skill => skill.name === "tilde-third/foo")?.filePath).toBe(
			path.join(tildeThird, "foo", "SKILL.md"),
		);
		expect(warnings.filter(warning => warning.message.includes("name collision"))).toHaveLength(3);
	});

	it("refuses a raw skill name that claims a namespaced address", async () => {
		const squatter = path.join(collisionFixturesDir, "squatter");
		const { skills, warnings } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [squatter, first, second],
		});
		expect(skills.map(skill => skill.name).sort()).toEqual(["calendar", "second/calendar"]);
		expect(skills.find(skill => skill.name === "second/calendar")?.filePath).toBe(
			path.join(second, "calendar", "SKILL.md"),
		);
		expect(warnings.some(warning => warning.message.includes("path separator"))).toBe(true);
	});

	it("rejects reserved names through the direct directory loader", async () => {
		const { skills } = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "squatter"),
			source: "custom:project",
		});
		expect(skills).toEqual([]);
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
		// The bare winner ("calendar") does not match a namespace-only pattern,
		// so only the namespaced loser is included.
		expect(skills.map(skill => skill.name)).toEqual(["second/calendar"]);
		const excluded = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
			ignoredSkills: ["second/*"],
		});
		expect(excluded.skills.map(skill => skill.name)).toEqual(["calendar"]);
	});

	it("keeps the bare winner when includeSkills names it directly", async () => {
		// Regression: on a differing collision, an include pattern matching the
		// bare name must keep the winner instead of dropping it (both sides used
		// to be namespaced, so a bare `include: ["calendar"]` matched neither).
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [first, second],
			includeSkills: ["calendar"],
		});
		expect(skills.map(skill => skill.name)).toEqual(["calendar"]);
		expect(skills[0].filePath).toBe(path.join(first, "calendar", "SKILL.md"));
	});

	it("lets a custom-directory skill override a provider skill and keeps a taken namespaced slot suffixed", async () => {
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
			// `second` (custom) is admitted first and overrides the provider skill
			// onto "claude/calendar" (#7190). `claudeRoot` (also custom, its own
			// namespace happens to be "claude" too) then collides with that taken
			// slot and falls back to the `~2` suffix.
			expect(byName.get("calendar")?.filePath).toBe(path.join(second, "calendar", "SKILL.md"));
			expect(byName.get("claude/calendar")?.filePath).toBe(path.join(providerDir, "SKILL.md"));
			expect(byName.get("claude/calendar~2")?.filePath).toBe(path.join(claudeRoot, "calendar", "SKILL.md"));
			expect(skills).toHaveLength(3);
		} finally {
			await removeWithRetries(project);
		}
	});

	describe("diagnostics", () => {
		const firstFile = path.join(first, "calendar", "SKILL.md");
		const secondFile = path.join(second, "calendar", "SKILL.md");
		const mirrorFile = path.join(mirror, "calendar", "SKILL.md");
		const customOptions = { ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [first, second] };

		it("reports the winner and every active variant of a differing collision", async () => {
			const { diagnostics } = await loadSkills(customOptions);
			expect(diagnostics).toHaveLength(1);
			const [diagnostic] = diagnostics;
			expect(diagnostic.name).toBe("calendar");
			expect(diagnostic.reason).toBe("source-order");
			expect(diagnostic.duplicates).toEqual([]);
			expect(diagnostic.skills.map(skill => [skill.name, skill.filePath])).toEqual([
				["calendar", firstFile],
				["second/calendar", secondFile],
			]);
		});

		it("reports nothing when no raw name has competing variants", async () => {
			const unique = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [fixturesDir] });
			expect(unique.skills.map(skill => skill.name)).toContain("valid-skill");
			expect(unique.diagnostics).toEqual([]);
		});

		it("reports a byte-identical copy as redundant with the skill that is kept", async () => {
			const { skills, diagnostics } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [first, mirror],
			});
			expect(skills.map(skill => skill.filePath)).toEqual([firstFile]);
			expect(diagnostics).toHaveLength(1);
			const [diagnostic] = diagnostics;
			expect(diagnostic.reason).toBe("source-order");
			expect(diagnostic.skills.map(skill => skill.filePath)).toEqual([firstFile]);
			expect(diagnostic.duplicates).toHaveLength(1);
			expect(diagnostic.duplicates[0].skill.filePath).toBe(mirrorFile);
			expect(diagnostic.duplicates[0].retained.filePath).toBe(firstFile);
		});

		it.each([
			["ignored", { ignoredSkills: ["mirror/*"] }],
			["disabled", { disabledExtensions: ["skill:mirror/calendar"] }],
		])("does not notify about an identical copy whose namespace is %s", async (_label, filter) => {
			const { skills, diagnostics, warnings } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [first, mirror],
				...filter,
			});
			expect(skills.map(skill => skill.filePath)).toEqual([firstFile]);
			expect(diagnostics).toEqual([]);
			expect(warnings).toEqual([]);
		});

		it("honors an excluded suffixed alias without hiding the preceding active variant", async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-duplicate-slot-"));
			try {
				const variantRoot = path.join(root, "one", "mirror");
				const duplicateRoot = path.join(root, "two", "mirror");
				await Bun.write(path.join(variantRoot, "calendar", "SKILL.md"), await Bun.file(secondFile).text());
				await Bun.write(path.join(duplicateRoot, "calendar", "SKILL.md"), await Bun.file(firstFile).text());
				const { skills, diagnostics } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					customDirectories: [first, variantRoot, duplicateRoot],
					disabledExtensions: ["skill:mirror/calendar~2"],
				});
				expect(skills.map(skill => skill.name)).toEqual(["calendar", "mirror/calendar"]);
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics[0].duplicates).toEqual([]);
			} finally {
				await removeWithRetries(root);
			}
		});

		it.each([
			["ignored", { ignoredSkills: ["claude/*"] }],
			["disabled", { disabledExtensions: ["skill:claude/calendar"] }],
		])("does not notify about a provider copy whose displaced namespace is %s", async (_label, filter) => {
			const { project } = await projectWithProviderCopies(firstFile, undefined);
			try {
				const { skills, diagnostics } = await loadSkills({
					...providerOptions,
					cwd: project,
					customDirectories: [mirror],
					...filter,
				});
				expect(skills.map(skill => skill.filePath)).toEqual([mirrorFile]);
				expect(diagnostics).toEqual([]);
			} finally {
				await removeWithRetries(project);
			}
		});

		it("never counts a symlink to a loaded file and lists a redundant file once", async () => {
			if (process.platform === "win32") return;
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-aliases-"));
			try {
				const firstAlias = path.join(root, "first-alias");
				const mirrorAlias = path.join(root, "mirror-alias");
				await fs.symlink(first, firstAlias);
				await fs.symlink(mirror, mirrorAlias);

				const aliased = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					customDirectories: [first, firstAlias],
				});
				expect(aliased.skills.map(skill => skill.filePath)).toEqual([firstFile]);
				expect(aliased.diagnostics).toEqual([]);

				// The distinct copy is redundant; reaching it again through a symlink adds no second entry.
				const { diagnostics } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					customDirectories: [first, mirror, mirrorAlias],
				});
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics[0].duplicates.map(duplicate => duplicate.skill.filePath)).toEqual([mirrorFile]);
			} finally {
				await removeWithRetries(root);
			}
		});

		it.each([
			["includes only the bare name", { includeSkills: ["calendar"] }],
			["includes only the namespaced name", { includeSkills: ["second/*"] }],
			["ignores the namespaced name", { ignoredSkills: ["second/*"] }],
			["disables the namespaced name", { disabledExtensions: ["skill:second/calendar"] }],
		])("omits a collision that leaves one active variant when it %s", async (_label, filter) => {
			const { skills, diagnostics } = await loadSkills({ ...customOptions, ...filter });
			expect(skills).toHaveLength(1);
			expect(diagnostics).toEqual([]);
		});

		it("omits a provider variant that an override displaced into an ignored alias", async () => {
			const { project } = await projectWithProviderCopies(firstFile, undefined);
			try {
				const { skills, diagnostics } = await loadSkills({
					...providerOptions,
					cwd: project,
					customDirectories: [second],
					ignoredSkills: ["claude/*"],
				});
				expect(skills.map(skill => skill.filePath)).toEqual([secondFile]);
				expect(diagnostics).toEqual([]);
			} finally {
				await removeWithRetries(project);
			}
		});

		it("drops a redundancy whose retained skill is filtered out", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-third-"));
			try {
				const third = path.join(tempDir, "third");
				const thirdFile = path.join(third, "calendar", "SKILL.md");
				await fs.mkdir(path.dirname(thirdFile), { recursive: true });
				await fs.copyFile(secondFile, thirdFile);
				const options = { ...customOptions, customDirectories: [first, second, third] };

				const all = await loadSkills(options);
				expect(all.diagnostics).toHaveLength(1);
				const [diagnostic] = all.diagnostics;
				expect(diagnostic.skills.map(skill => skill.name)).toEqual(["calendar", "second/calendar"]);
				expect(diagnostic.duplicates).toHaveLength(1);
				expect(diagnostic.duplicates[0].skill.filePath).toBe(thirdFile);
				expect(diagnostic.duplicates[0].retained.filePath).toBe(secondFile);

				const filtered = await loadSkills({ ...options, includeSkills: ["calendar"] });
				expect(filtered.skills.map(skill => skill.name)).toEqual(["calendar"]);
				expect(filtered.diagnostics).toEqual([]);
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("re-points redundant copies at the override that replaces their retained skill", async () => {
			// .claude and .agents hold identical copies; the identical custom skill takes the bare name
			// from .claude, which also makes the .agents copy redundant with the override.
			const { project, claudeFile, agentsFile } = await projectWithProviderCopies(firstFile, firstFile);
			try {
				const { skills, diagnostics } = await loadSkills({
					...providerOptions,
					cwd: project,
					customDirectories: [mirror],
				});
				expect(skills.map(skill => skill.filePath)).toEqual([mirrorFile]);
				expect(diagnostics).toHaveLength(1);
				const [diagnostic] = diagnostics;
				expect(diagnostic.reason).toBe("custom-directory");
				expect(diagnostic.skills.map(skill => skill.filePath)).toEqual([mirrorFile]);
				expect(diagnostic.duplicates.map(duplicate => duplicate.skill.filePath).sort()).toEqual(
					[agentsFile!, claudeFile].sort(),
				);
				expect(diagnostic.duplicates.map(duplicate => duplicate.retained.filePath)).toEqual([
					mirrorFile,
					mirrorFile,
				]);
			} finally {
				await removeWithRetries(project);
			}
		});

		it("reports an override, the variant it displaced, and a dropped duplicate of the override", async () => {
			const { project, claudeFile, agentsFile } = await projectWithProviderCopies(firstFile, secondFile);
			try {
				const { diagnostics } = await loadSkills({
					...providerOptions,
					cwd: project,
					customDirectories: [second],
				});
				expect(diagnostics).toHaveLength(1);
				const [diagnostic] = diagnostics;
				expect(diagnostic.reason).toBe("custom-directory");
				expect(diagnostic.skills.map(skill => [skill.name, skill.filePath])).toEqual([
					["calendar", secondFile],
					["claude/calendar", claudeFile],
				]);
				expect(diagnostic.duplicates).toHaveLength(1);
				expect(diagnostic.duplicates[0].skill.filePath).toBe(agentsFile!);
				expect(diagnostic.duplicates[0].retained.filePath).toBe(secondFile);
				expect(diagnostic.duplicates[0].skill.name).toBe("calendar");
			} finally {
				await removeWithRetries(project);
			}
		});

		it("does not count a redundant provider file again when its symlink becomes the custom override", async () => {
			const { project, claudeFile, agentsFile } = await projectWithProviderCopies(firstFile, firstFile);
			try {
				const customRoot = path.join(project, "override");
				const aliasDir = path.join(customRoot, "calendar");
				await fs.mkdir(customRoot, { recursive: true });
				await fs.symlink(path.dirname(agentsFile!), aliasDir, process.platform === "win32" ? "junction" : "dir");
				const { diagnostics } = await loadSkills({
					...providerOptions,
					cwd: project,
					customDirectories: [customRoot],
				});
				expect(diagnostics).toHaveLength(1);
				const diagnostic = diagnostics[0];
				expect(diagnostic.skills.map(skill => skill.filePath)).toEqual([path.join(aliasDir, "SKILL.md")]);
				expect(diagnostic.duplicates.map(duplicate => duplicate.skill.filePath)).toEqual([claudeFile]);
				expect(diagnostic.duplicates[0].retained.filePath).toBe(path.join(aliasDir, "SKILL.md"));
			} finally {
				await removeWithRetries(project);
			}
		});

		const installedText = "---\nname: pdf-tools\ndescription: PDF helpers\n---\n# pdf-tools\n";
		/**
		 * Project holding a registry-installed `pdf-tools` (skillshare lock + unpacked store) and an authored
		 * copy under `<project>/<authoredRoot>/skills/pdf-tools`. The store sits next to the agent dir, so this
		 * points the agent dir at the temp root for the duration of `run`.
		 */
		async function withInstalledPdfTools(
			authoredRoot: ".omp" | ".claude",
			authoredText: string,
			run: (paths: { project: string; installedFile: string; authoredFile: string }) => Promise<void>,
		) {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-installed-")));
			const project = path.join(root, "proj");
			const authoredFile = path.join(project, authoredRoot, "skills", "pdf-tools", "SKILL.md");
			setAgentDir(path.join(root, ".omp", "agent"));
			try {
				await fs.mkdir(path.join(project, ".git"), { recursive: true });
				await fs.mkdir(path.dirname(authoredFile), { recursive: true });
				await Bun.write(authoredFile, authoredText);
				const integrity = "sha512-alice-pdf-tools-1.0.0";
				await writeSkillsLock(path.join(project, ".omp", "skills.lock.json"), {
					version: 1,
					skills: {
						"@alice/pdf-tools": {
							version: "1.0.0",
							integrity,
							resolved: "/api/v1/skills/@alice/pdf-tools/versions/1.0.0/tarball",
						},
					},
				});
				const storeDir = getSkillStorePath("alice", "pdf-tools", "1.0.0");
				await fs.mkdir(storeDir, { recursive: true });
				await Bun.write(path.join(storeDir, "SKILL.md"), installedText);
				await Bun.write(path.join(storeDir, STORE_INTEGRITY_FILE), `${integrity}\n`);
				await run({ project, installedFile: path.join(storeDir, "SKILL.md"), authoredFile });
			} finally {
				setAgentDir(path.join(isolatedHome, ".omp", "agent"));
				await removeWithRetries(root);
			}
		}

		it("reports an installed skill that a differing authored skill outranks", async () => {
			const authoredText = "---\nname: pdf-tools\ndescription: Local PDF helpers\n---\n# local\n";
			await withInstalledPdfTools(".omp", authoredText, async ({ project, installedFile, authoredFile }) => {
				const { skills, diagnostics } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					enablePiProject: true,
					cwd: project,
				});
				expect(skills.map(skill => skill.filePath)).toEqual([authoredFile, installedFile]);
				expect(diagnostics).toHaveLength(1);
				const [diagnostic] = diagnostics;
				expect(diagnostic.name).toBe("pdf-tools");
				expect(diagnostic.reason).toBe("authored-over-installed");
				expect(diagnostic.skills.map(skill => skill.filePath)).toEqual([authoredFile, installedFile]);
				expect(diagnostic.skills[0].name).toBe("pdf-tools");
				expect(diagnostic.duplicates).toEqual([]);
			});
		});

		it("reports an installed skill as redundant with an identical authored skill admitted after it", async () => {
			// skillshare (95) is admitted before .claude (80), so the authored copy takes the bare name back.
			await withInstalledPdfTools(".claude", installedText, async ({ project, installedFile, authoredFile }) => {
				const { skills, diagnostics } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					enableClaudeProject: true,
					cwd: project,
				});
				expect(skills.map(skill => skill.filePath)).toEqual([authoredFile]);
				expect(diagnostics).toHaveLength(1);
				const [diagnostic] = diagnostics;
				expect(diagnostic.reason).toBe("authored-over-installed");
				expect(diagnostic.skills.map(skill => skill.filePath)).toEqual([authoredFile]);
				expect(diagnostic.duplicates).toHaveLength(1);
				expect(diagnostic.duplicates[0].skill.filePath).toBe(installedFile);
				expect(diagnostic.duplicates[0].retained.filePath).toBe(authoredFile);
			});
		});

		it("does not let an identical installed copy change the reason for an authored conflict", async () => {
			await withInstalledPdfTools(".omp", installedText, async ({ project, installedFile, authoredFile }) => {
				const variantFile = path.join(project, ".claude", "skills", "pdf-tools", "SKILL.md");
				await Bun.write(variantFile, "---\nname: pdf-tools\ndescription: Different instructions\n---\n# variant\n");
				const { diagnostics } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					enablePiProject: true,
					enableClaudeProject: true,
					cwd: project,
				});
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics[0].reason).toBe("source-order");
				expect(diagnostics[0].skills.find(skill => skill.name === "pdf-tools")?.filePath).toBe(authoredFile);
				expect(diagnostics[0].duplicates.map(duplicate => duplicate.skill.filePath)).toEqual([installedFile]);
			});
		});
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

		it("parses a collision-namespaced skill mid-prompt", () => {
			// `<namespace>/<name>` is the address a differing same-name skill gets,
			// and mid-prompt completion inserts it, so the token must invoke it.
			expect(parseSkillInvocation("fix the bug /skill:superpowers/tdd focus on auth")).toEqual({
				name: "superpowers/tdd",
				args: "fix the bug focus on auth",
				prompt: "fix the bug /skill:superpowers/tdd focus on auth",
			});
		});

		it("invokes every skill that mid-prompt completion suggests, namespaced ones included", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:tdd", description: "Local test-driven development" },
					{ name: "skill:superpowers/tdd", description: "Plugin test-driven development" },
				],
				os.tmpdir(),
			);
			const before = "fix the bug /skill:";
			const lines = [`${before} focus on auth`];
			const suggestions = await provider.getSuggestions(lines, 0, before.length);
			const values = suggestions?.items.map(item => item.value) ?? [];
			expect(values).toEqual(expect.arrayContaining(["skill:tdd", "skill:superpowers/tdd"]));

			for (const item of suggestions?.items ?? []) {
				const accepted = provider.applyCompletion(lines, 0, before.length, item, suggestions?.prefix ?? "");
				expect(parseSkillInvocation(accepted.lines[0])?.name).toBe(item.value.slice("skill:".length));
			}
		});

		it("rejects mid-prompt skill tokens with more than one namespace segment", () => {
			// Only one `/` is a namespaced name; deeper tokens read as paths.
			expect(parseSkillInvocation("see /skill:foo/bar/baz")).toBeUndefined();
			expect(parseSkillInvocation("see /skill:foo/")).toBeUndefined();
		});
	});
});
