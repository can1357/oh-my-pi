import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSkillList, runSkillsCommand } from "../../src/cli/skill-list";
import { boundSettings } from "../../src/capability";
import type { Skill } from "../../src/capability/skill";
import {
	getEnabledProviders,
	initializeWithSettings,
	isUserSourceEnabled,
	loadCapability,
	resetCapabilityForTests,
} from "../../src/discovery";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { AgentStorage } from "../../src/session/agent-storage";
import { restoreEnvValue } from "../helpers/settings-test-state";
import * as skillsModule from "../../src/extensibility/skills";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	removeSyncWithRetries,
	removeWithRetries,
	setAgentDir,
	Snowflake,
} from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";

const POISON_RUN = Snowflake.next();
const CLAUDE_POISON = `omp-foundation-w6-claude-poison-${POISON_RUN}`;
const AGENTS_POISON = `omp-foundation-w6-agents-poison-${POISON_RUN}`;
const OUTER_CODEX = "omp-foundation-w6-outer-codex";

/** Ambient Claude config the current fixture does not clear. Owned only when the variable was absent. */
let ambientClaudeDir = "";
let ownedClaudeDir = false;
let originalClaudeConfigDir: string | undefined;
/** Real home captured before `os.homedir` is mocked; project ancestor walks can still see it. */
let ambientHome = "";
let agentsPoisonDir = "";

/** Best-effort sync cleanup so an interrupted run does not leave poison skills in real directories. */
function removeAmbientPoisonOnExit(): void {
	const targets = [
		ambientClaudeDir ? path.join(ambientClaudeDir, "skills", CLAUDE_POISON) : "",
		ownedClaudeDir ? ambientClaudeDir : "",
		agentsPoisonDir,
	];
	for (const target of targets) {
		if (!target) continue;
		try {
			removeSyncWithRetries(target);
		} catch {
			// The process is already leaving; a locked file must not fail the exit.
		}
	}
}

process.on("exit", removeAmbientPoisonOnExit);

function skillMarkdown(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function writeSkill(directory: string, name: string, description: string): Promise<string> {
	const skillDir = path.join(directory, name);
	await fs.mkdir(skillDir, { recursive: true });
	const filePath = path.join(skillDir, "SKILL.md");
	await Bun.write(filePath, skillMarkdown(name, description));
	return filePath;
}

/** Ambient-poison fixture state: what setup created and how to undo it. */
interface PoisonFixture {
	/** Directories setup created because they did not exist, parents before children. */
	createdDirectories: string[];
	/** Poison leaf directories (always removed by cleanup, created or not). */
	claudePoisonDir: string;
	agentsPoisonDir: string;
	/** Directory existence snapshot keyed by absolute path, taken before setup ran. */
	preExisting: Map<string, boolean>;
}

/** File writer seam so a test can fail the setup midway through its second write. */
type PoisonWriter = (filePath: string, contents: string) => Promise<void>;

const bunPoisonWriter: PoisonWriter = async (filePath, contents) => {
	await Bun.write(filePath, contents);
};

/**
 * Install the ambient poison pair the isolation assertions prove are excluded.
 *
 * Every directory the installation creates — only those that did not exist
 * before — is recorded in {@link PoisonFixture.createdDirectories}, and the
 * cleanup is registered before each creation: `trackAncestry` records the
 * missing directories before `mkdir` runs, and a throw from `mkdir` or the
 * writer (e.g. an injected failing writer) unwinds everything recorded so
 * far, deepest first, while pre-existing parents stay untouched. A
 * successful install returns the cleanup for the caller to run on teardown;
 * re-running it is a no-op because every removal targets an already-gone
 * path (`force: true`).
 */
async function installAmbientPoison(options: { writer?: PoisonWriter } = {}): Promise<
	PoisonFixture & {
		cleanup: () => Promise<void>;
	}
> {
	const writer = options.writer ?? bunPoisonWriter;
	const createdDirectories: string[] = [];
	const preExisting = new Map<string, boolean>();
	const exists = (directory: string): boolean => preExisting.get(directory) ?? fsSync.existsSync(directory);
	const track = (directory: string): boolean => {
		const present = exists(directory);
		preExisting.set(directory, present);
		return present;
	};
	/** Record every missing directory from `skillDir` up to its nearest existing ancestor. */
	const trackAncestry = (skillDir: string): void => {
		const missing: string[] = [];
		let current = skillDir;
		while (!track(current)) {
			missing.push(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		createdDirectories.push(...missing);
	};
	const cleanup = async (): Promise<void> => {
		// Deepest first: a created parent cannot be removed while a created
		// child still lives inside it. Removals of already-gone paths are
		// no-ops (force: true), so re-running cleanup is safe.
		for (const directory of [...createdDirectories].reverse()) {
			if (!fsSync.existsSync(directory)) continue;
			await removeWithRetries(directory);
		}
	};
	const writePoison = async (skillDir: string, description: string): Promise<void> => {
		// Registration happens BEFORE the creation (trackAncestry records the
		// missing directories first), so a throw from mkdir or the writer is
		// already covered by the recorded set when it unwinds here.
		trackAncestry(skillDir);
		try {
			await fs.mkdir(skillDir, { recursive: true });
			await writer(path.join(skillDir, "SKILL.md"), skillMarkdown(path.basename(skillDir), description));
		} catch (error) {
			// A mid-setup throw must still clean everything recorded so far.
			await cleanup();
			throw error;
		}
	};
	const claudePoisonDir = path.join(ambientClaudeDir, "skills", CLAUDE_POISON);
	const localAgentsPoisonDir = path.join(ambientHome, ".agents", "skills", AGENTS_POISON);
	await writePoison(claudePoisonDir, "Ambient Claude poison.");
	await writePoison(localAgentsPoisonDir, "Ambient agents poison.");
	agentsPoisonDir = localAgentsPoisonDir;
	return { createdDirectories, claudePoisonDir, agentsPoisonDir: localAgentsPoisonDir, preExisting, cleanup };
}

function listingEvidence(skills: { name: string; source: string; filePath: string }[]): string {
	const rows = skills.map(skill => `${skill.name}\t${skill.source}\t${skill.filePath}`);
	return [
		`mocked os.homedir (ctx.home seam): ${os.homedir()}`,
		`ambient home: ${ambientHome}`,
		`HOME=${process.env.HOME ?? "<absent>"}`,
		`USERPROFILE=${process.env.USERPROFILE ?? "<absent>"}`,
		`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "<absent>"}`,
		`claude poison: ${path.join(ambientClaudeDir, "skills", CLAUDE_POISON, "SKILL.md")}`,
		`agents poison: ${path.join(agentsPoisonDir, "SKILL.md")}`,
		"discovered:",
		...rows,
	].join("\n");
}

let poisonFixtureCleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
	ambientHome = os.homedir();
	originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	const configured = originalClaudeConfigDir?.trim();
	if (configured) {
		ambientClaudeDir = path.resolve(configured);
	} else {
		ambientClaudeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-w6-claude-poison-"));
		ownedClaudeDir = true;
		process.env.CLAUDE_CONFIG_DIR = ambientClaudeDir;
		Bun.env.CLAUDE_CONFIG_DIR = ambientClaudeDir;
	}
	const fixture = await installAmbientPoison();
	poisonFixtureCleanup = fixture.cleanup;
});

afterAll(async () => {
	await removeWithRetries(path.join(ambientClaudeDir, "skills", CLAUDE_POISON));
	if (ownedClaudeDir) await removeWithRetries(ambientClaudeDir);
	await removeWithRetries(agentsPoisonDir);
	await poisonFixtureCleanup?.();
	restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
});

// Every test below discovers skills through the real capability loader, which
// walks `os.homedir()` and `getAgentDir()` for user-level providers (native
// `<agentDir>/skills`, `~/.claude/skills`, managed auto-learn skills, and
// `Settings.init()`'s own config.yml/settings.json lookup in the
// `handleSkillList` tests below). The fixture isolates that walk: cwd lives
// under a mocked home that is its own repo root, and Claude/profile/agent-dir
// variables are snapshotted and restored. Poison files stay in their ambient
// locations so a leak still fails the listing assertion.
const ISOLATED_ENV = [
	"CLAUDE_CONFIG_DIR",
	"PI_CONFIG_FILES",
	"HOME",
	"USERPROFILE",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;
let tempHome: string;
let isolatedEnv: Record<(typeof ISOLATED_ENV)[number], string | undefined>;

function deleteEnv(key: string): void {
	delete process.env[key];
	delete Bun.env[key];
}

/** Working directory inside the isolated home, so ancestor discovery stops there. */
function isolatedDirectory(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(tempHome, prefix));
}

beforeEach(async () => {
	isolatedEnv = {
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
		PI_CONFIG_FILES: process.env.PI_CONFIG_FILES,
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		OMP_PROFILE: process.env.OMP_PROFILE,
		PI_PROFILE: process.env.PI_PROFILE,
	};
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-list-home-"));
	// Nearest `.git` stops project ancestor walks before the real home.
	await Bun.write(path.join(tempHome, ".git"), "");
	process.env.HOME = tempHome;
	Bun.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	Bun.env.USERPROFILE = tempHome;
	deleteEnv("CLAUDE_CONFIG_DIR");
	deleteEnv("PI_CONFIG_FILES");
	deleteEnv("OMP_PROFILE");
	deleteEnv("PI_PROFILE");
	spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(path.join(tempHome, ".omp", "agent"));
});

afterEach(async () => {
	// Close storage before removing the isolated home. Windows refuses to
	// delete a directory that still has agent.db open. Do not release a
	// capability hold here: the two-file command must still see one if
	// `runSkillsCommand` leaks it.
	resetSettingsForTest();
	AgentStorage.close();
	spyOn(os, "homedir").mockRestore();
	for (const key of ISOLATED_ENV) restoreEnvValue(key, isolatedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(tempHome);
});

describe("runSkillsCommand", () => {
	test("lists skills for a directory with public metadata", async () => {
		const directory = await isolatedDirectory("omp-skills-cmd-");
		const skillsRoot = path.join(directory, "skills-fixture");
		await fs.mkdir(path.join(skillsRoot, "first", "calendar"), { recursive: true });
		await fs.mkdir(path.join(skillsRoot, "second", "reviewer"), { recursive: true });
		await Bun.write(
			path.join(skillsRoot, "first", "calendar", "SKILL.md"),
			"---\nname: calendar\ndescription: First calendar.\n---\n\n# Calendar (First)\n",
		);
		await Bun.write(
			path.join(skillsRoot, "second", "reviewer", "SKILL.md"),
			"---\nname: reviewer\ndescription: Review code.\n---\n\n# Reviewer\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: [path.join(skillsRoot, "first"), path.join(skillsRoot, "second")] },
			});

			// Home/agent-dir isolation (see the file-level beforeEach) means only the
			// two fixture skills below are discoverable — pin the whole listing.
			expect(result.skills.map(skill => skill.name)).toEqual(["calendar", "reviewer"]);
			const reviewer = result.skills.find(skill => skill.name === "reviewer");
			expect(reviewer?.description).toBe("Review code.");
			expect(reviewer?.filePath).toBe(path.join(skillsRoot, "second", "reviewer", "SKILL.md"));
			expect(reviewer?.baseDir).toBe(path.join(skillsRoot, "second", "reviewer"));
			expect(reviewer?.source).toBe("custom:user");
			expect(reviewer?.hide).toBe(false);
			// The public shape is fixed: internal `_source`/`containRoot` stay out.
			expect(Object.keys(reviewer ?? {}).sort()).toEqual([
				"baseDir",
				"description",
				"filePath",
				"hide",
				"name",
				"source",
			]);
		} finally {
			await removeWithRetries(directory);
		}
	});

	test("resolves relative custom directories against the requested directory", async () => {
		const directory = await isolatedDirectory(`omp-skills-rel-${Snowflake.next()}-`);
		await fs.mkdir(path.join(directory, "rel-root", "calendar"), { recursive: true });
		await Bun.write(
			path.join(directory, "rel-root", "calendar", "SKILL.md"),
			"---\nname: calendar\ndescription: Relative calendar.\n---\n\n# Calendar\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: ["rel-root"] },
			});
			const calendar = result.skills.find(
				skill => skill.filePath === path.join(directory, "rel-root", "calendar", "SKILL.md"),
			);
			expect(calendar?.name).toBe("calendar");
		} finally {
			await removeWithRetries(directory);
		}
	});

	test("expands a tilde custom directory against the home directory", async () => {
		const directory = await isolatedDirectory(`omp-skills-tilde-${Snowflake.next()}-`);
		// `os.homedir()` is stubbed to `tempHome` above, so `~/example-skills`
		// names this fixture directory.
		const skillsRoot = path.join(tempHome, "example-skills");
		await fs.mkdir(path.join(skillsRoot, "demo"), { recursive: true });
		await Bun.write(
			path.join(skillsRoot, "demo", "SKILL.md"),
			"---\nname: demo\ndescription: Home-relative demo.\n---\n\n# Demo\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: ["~/example-skills"] },
			});
			// The listing must agree with the loader: a tilde entry resolves
			// against the home directory, not against the inspected directory.
			expect(result.skills.map(skill => skill.name)).toEqual(["demo"]);
			expect(result.skills[0]?.filePath).toBe(path.join(skillsRoot, "demo", "SKILL.md"));
		} finally {
			await removeWithRetries(directory);
		}
	});
});

describe("handleSkillList", () => {
	// `handleSkillList` reads the inspected directory's config through
	// `Settings.init({ cwd })`, which returns an already-initialized singleton
	// unchanged; start from none so the fixture's `.omp/config.yml` is read.
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
		// `Settings.init()` opens `<agentDir>/agent.db`; release it so the temp
		// home can be removed (Windows refuses to delete open files).
		AgentStorage.close();
	});

	test("keeps stdout to TSV rows and sends warnings to stderr", async () => {
		const directory = await isolatedDirectory(`omp-skills-list-${Snowflake.next()}-`);
		for (const root of ["first", "second"]) {
			await fs.mkdir(path.join(directory, root, "calendar"), { recursive: true });
			await Bun.write(
				path.join(directory, root, "calendar", "SKILL.md"),
				`---\nname: calendar\ndescription: ${root} calendar.\n---\n\n# Calendar\n`,
			);
		}
		await Bun.write(
			path.join(directory, ".omp", "config.yml"),
			"skills:\n  customDirectories:\n    - first\n    - second\n",
		);

		let stdout = "";
		let stderr = "";
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout += chunk.toString();
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += chunk.toString();
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(await handleSkillList([], directory, false)).toBe(0);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			await removeWithRetries(directory);
		}

		// `omp skill list | cut -f1` must see skill rows only.
		const rows = stdout.split("\n").filter(Boolean);
		expect(rows).toContain("calendar\tfirst calendar.");
		for (const row of rows) expect(row).toMatch(/^[^\t]+\t/);
		expect(stderr).toContain('warning: name collision: "calendar"');
	});

	test("applies global manualSkills from config and lets a project list clear it", async () => {
		const directory = await isolatedDirectory(`omp-skills-layer-${Snowflake.next()}-`);
		const projectDir = path.join(directory, "project");
		const skillsRoot = path.join(directory, "skills");
		const agentDir = getAgentDir();
		await fs.mkdir(projectDir, { recursive: true });
		for (const name of ["alpha", "beta"]) {
			await fs.mkdir(path.join(skillsRoot, name), { recursive: true });
			await Bun.write(
				path.join(skillsRoot, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n`,
			);
		}
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`skills:\n  customDirectories:\n    - ${JSON.stringify(skillsRoot)}\n  manualSkills:\n    - alpha\n`,
		);

		const readJson = async (projectConfig?: string) => {
			resetSettingsForTest();
			const configPath = path.join(projectDir, ".omp", "config.yml");
			if (projectConfig === undefined) {
				await fs.rm(path.dirname(configPath), { recursive: true, force: true });
			} else {
				await fs.mkdir(path.dirname(configPath), { recursive: true });
				await Bun.write(configPath, projectConfig);
			}

			let stdout = "";
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
				stdout += chunk.toString();
				return true;
			}) as typeof process.stdout.write);
			try {
				expect(await handleSkillList([], projectDir, true)).toBe(0);
				return JSON.parse(stdout) as { skills: { name: string; hide: boolean }[] };
			} finally {
				stdoutSpy.mockRestore();
			}
		};

		try {
			const inherited = await readJson();
			expect(inherited.skills.map(skill => [skill.name, skill.hide])).toEqual([
				["alpha", true],
				["beta", false],
			]);
			const cleared = await readJson("skills:\n  manualSkills: []\n");
			expect(cleared.skills.map(skill => [skill.name, skill.hide])).toEqual([
				["alpha", false],
				["beta", false],
			]);
		} finally {
			await removeWithRetries(directory);
		}
	});

	test("rejects a target that is not a directory", async () => {
		const directory = await isolatedDirectory(`omp-skills-list-${Snowflake.next()}-`);
		const file = path.join(directory, "file.txt");
		await Bun.write(file, "not a directory");
		try {
			const missing = path.join(directory, "missing");
			await expect(handleSkillList(["missing"], directory, false)).rejects.toThrow(
				new CliUsageError(`Not a directory: ${missing}`),
			);
			await expect(handleSkillList(["file.txt"], directory, false)).rejects.toThrow(
				new CliUsageError(`Not a directory: ${file}`),
			);
			await expect(handleSkillList(["file.txt/sub"], directory, false)).rejects.toThrow(
				new CliUsageError(`Not a directory: ${path.join(file, "sub")}`),
			);
		} finally {
			await removeWithRetries(directory);
		}
	});
});

describe("ambient skill isolation", () => {
	test("gives ambient poison skills a per-run name and an exit cleanup", () => {
		expect(CLAUDE_POISON).toMatch(/^omp-foundation-w6-claude-poison-[0-9a-f]{16}$/);
		expect(AGENTS_POISON).toMatch(/^omp-foundation-w6-agents-poison-[0-9a-f]{16}$/);
		expect(process.listeners("exit").some(listener => listener.name === "removeAmbientPoisonOnExit")).toBe(true);
	});

	test("removes every directory setup created when the writer fails mid-setup", async () => {
		// Point the fixture at a throwaway tree so the created parents stand in
		// for `.agents/skills` and `.claude/skills` without touching the real
		// home. The writer succeeds for the first (Claude) poison and throws
		// on the second (`.agents`) write, simulating a partial setup.
		const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-poison-partial-"));
		const preExistingParent = path.join(fixtureRoot, "pre-existing", "parent");
		await fs.mkdir(preExistingParent, { recursive: true });
		const throwingWriter: PoisonWriter = async (filePath, _contents) => {
			if (filePath.endsWith(path.join(CLAUDE_POISON, "SKILL.md"))) {
				await Bun.write(filePath, "partial");
				return;
			}
			throw new Error("injected: writer failed mid-setup");
		};
		const savedAmbientHome = ambientHome;
		const savedAmbientClaudeDir = ambientClaudeDir;
		const savedOwnedClaudeDir = ownedClaudeDir;
		const savedAgentsPoisonDir = agentsPoisonDir;
		ambientHome = fixtureRoot;
		ambientClaudeDir = path.join(fixtureRoot, "claude-config");
		ownedClaudeDir = false;
		try {
			let caught: unknown;
			try {
				await installAmbientPoison({ writer: throwingWriter });
			} catch (error) {
				caught = error;
			}
			expect((caught as Error).message).toBe("injected: writer failed mid-setup");
			const claudeParent = path.join(fixtureRoot, "claude-config", "skills");
			const claudePoison = path.join(claudeParent, CLAUDE_POISON);
			const agentsSkills = path.join(fixtureRoot, ".agents", "skills");
			// RED: today's cleanup removes only the poison leaves, so the
			// parents setup created (claude-config/skills, .agents/skills)
			// survive a partial setup.
			expect(fsSync.existsSync(claudePoison)).toBe(false);
			expect(fsSync.existsSync(claudeParent)).toBe(false);
			expect(fsSync.existsSync(agentsSkills)).toBe(false);
			expect(fsSync.existsSync(path.join(fixtureRoot, ".agents"))).toBe(false);
			// Pre-existing parents must be untouched by the cleanup.
			expect(fsSync.existsSync(preExistingParent)).toBe(true);
			expect(fsSync.existsSync(fixtureRoot)).toBe(true);
		} finally {
			ambientHome = savedAmbientHome;
			ambientClaudeDir = savedAmbientClaudeDir;
			ownedClaudeDir = savedOwnedClaudeDir;
			agentsPoisonDir = savedAgentsPoisonDir;
			await removeWithRetries(fixtureRoot);
		}
	});

	// Reachability precondition: the poison assertions above only mean
	// something if the poison would be discovered without isolation. The test
	// cwd (os.tmpdir()) is under the real home on some Linux setups, letting
	// the project ancestor walk reach <home>/.agents; on macOS CI tmp is
	// outside the home and that walk cannot reach it.
	//
	// `skipIf` reads its condition when the test is registered — before any
	// beforeAll runs — so this computes the real home directly from the
	// environment (HOME, falling back to os.homedir()) instead of the
	// `ambientHome` variable the beforeAll assigns later.
	const REAL_HOME = process.env.HOME?.trim() || os.homedir();
	const ANCESTOR_REACHABLE = (() => {
		let current = path.resolve(os.tmpdir());
		while (true) {
			if (current === path.resolve(REAL_HOME)) return true;
			const parent = path.dirname(current);
			if (parent === current) return false;
			current = parent;
		}
	})();
	const UNREACHABLE_REASON = `test tmpdir (${os.tmpdir()}) is not under the real home (${REAL_HOME}), so the project ancestor walk cannot reach <home>/.agents`;

	// `skipIf` at runtime accepts (condition, reason); bun-types declares only
	// the single-argument form, so widen a bound reference for this one call.
	const skipIfWithReason = test.skipIf.bind(test) as (
		condition: boolean,
		reason?: string,
	) => ReturnType<typeof test.skipIf>;
	skipIfWithReason(!ANCESTOR_REACHABLE, UNREACHABLE_REASON)(
		"discovers the ambient .agents poison when discovery can reach the real home",
		async () => {
			// Control: with the real home visible to discovery, the .agents
			// poison must appear, proving the isolated run's empty poisonHits
			// is a real isolation result and not an unreachable fixture.
			const directory = await isolatedDirectory("omp-skills-reach-");
			const realHomeSpy = spyOn(os, "homedir").mockReturnValue(ambientHome);
			try {
				const result = await runSkillsCommand({
					cwd: directory,
					skillsSettings: { customDirectories: [] },
				});
				const poisonHits = result.skills.filter(skill => skill.name === AGENTS_POISON);
				expect(
					poisonHits.map(skill => `${skill.name}\t${skill.source}\t${skill.filePath}`),
					listingEvidence(result.skills),
				).not.toEqual([]);
			} finally {
				realHomeSpy.mockReturnValue(tempHome);
				await removeWithRetries(directory);
			}
		},
	);

	test("lists only the requested fixture skill, not ambient Claude or .agents poison", async () => {
		const directory = await isolatedDirectory("omp-skills-poison-");
		const fixtureRoot = path.join(directory, "fixture-skills");
		await writeSkill(fixtureRoot, "fixture-only", "Requested fixture skill.");
		try {
			// Poison files stay in the ambient Claude dir and real home. The fixture
			// home mock must not be treated as proof that those inputs are unreachable.
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: [fixtureRoot] },
			});
			const evidence = listingEvidence(result.skills);
			const poisonHits = result.skills.filter(skill => skill.name === CLAUDE_POISON || skill.name === AGENTS_POISON);
			// Claude poison is claude:user via CLAUDE_CONFIG_DIR. The .agents poison is
			// agents:project from the real-home ancestor walk, not the mocked ctx.home.
			expect(
				poisonHits.map(skill => `${skill.name}\t${skill.source}\t${skill.filePath}`),
				evidence,
			).toEqual([]);
			expect(
				result.skills.map(skill => skill.name),
				evidence,
			).toEqual(["fixture-only"]);
		} finally {
			await removeWithRetries(directory);
		}
	});
});

describe("runSkillsCommand settings hold", () => {
	beforeEach(() => {
		resetSettingsForTest();
		resetCapabilityForTests();
	});

	afterEach(() => {
		// Release is asserted inside each test. Do not clear a leaked hold here,
		// or the two-file integrations run would no longer see it.
		resetSettingsForTest();
		AgentStorage.close();
	});

	async function projectConfig(directory: string, yaml: string): Promise<void> {
		await fs.mkdir(path.join(directory, ".omp"), { recursive: true });
		await Bun.write(path.join(directory, ".omp", "config.yml"), yaml);
	}

	async function assertOuterCodexScope(directory: string, outer: Settings): Promise<void> {
		expect(boundSettings() === outer, "skill-list must release its own hold and leave the outer scope bound").toBe(
			true,
		);
		expect(getEnabledProviders()).toContain("codex");
		expect(getEnabledProviders()).not.toContain("cursor");
		expect(isUserSourceEnabled("codex")).toBe(true);
		expect(isUserSourceEnabled("cursor")).toBe(false);
		const discovered = await loadCapability<Skill>("skills", { cwd: directory });
		expect(discovered.items.map(item => item.name)).toContain(OUTER_CODEX);
	}

	test("keeps an outer provider scope after the normal skill-list path", async () => {
		const directory = await isolatedDirectory("omp-skills-hold-");
		await writeSkill(path.join(tempHome, ".codex", "skills"), OUTER_CODEX, "Outer codex skill.");
		await projectConfig(directory, "enabledProviders:\n  - cursor\ndisabledProviders:\n  - codex\n");
		const outer = Settings.isolated({ enabledProviders: ["codex"] });
		const release = initializeWithSettings(outer);
		try {
			await runSkillsCommand({ cwd: directory });
			await assertOuterCodexScope(directory, outer);
		} finally {
			release();
			await removeWithRetries(directory);
		}
	});

	test("keeps an outer provider scope when skill discovery throws", async () => {
		const directory = await isolatedDirectory("omp-skills-hold-throw-");
		await writeSkill(path.join(tempHome, ".codex", "skills"), OUTER_CODEX, "Outer codex skill.");
		await projectConfig(directory, "enabledProviders:\n  - cursor\ndisabledProviders:\n  - codex\n");
		const outer = Settings.isolated({ enabledProviders: ["codex"] });
		const release = initializeWithSettings(outer);
		const discovery = spyOn(skillsModule, "loadSkills").mockRejectedValue(
			new Error("downstream skill discovery failed"),
		);
		try {
			await expect(runSkillsCommand({ cwd: directory })).rejects.toThrow("downstream skill discovery failed");
			discovery.mockRestore();
			await assertOuterCodexScope(directory, outer);
		} finally {
			discovery.mockRestore();
			release();
			await removeWithRetries(directory);
		}
	});

	test("does not leave a capability hold when skill-list had no enclosing binding", async () => {
		const directory = await isolatedDirectory("omp-skills-hold-none-");
		await writeSkill(path.join(tempHome, ".codex", "skills"), OUTER_CODEX, "Inner-only codex skill.");
		await projectConfig(directory, "enabledProviders:\n  - codex\n");
		try {
			expect(boundSettings() === undefined, "nothing is bound before skill-list").toBe(true);
			await runSkillsCommand({ cwd: directory });
			expect(boundSettings() === undefined, "skill-list leaked the Settings.init hold").toBe(true);
			expect(isUserSourceEnabled("codex")).toBe(false);
			expect(getEnabledProviders()).not.toContain("codex");
			const discovered = await loadCapability<Skill>("skills", { cwd: directory });
			expect(discovered.items.map(item => item.name)).not.toContain(OUTER_CODEX);
		} finally {
			await removeWithRetries(directory);
		}
	});
});
