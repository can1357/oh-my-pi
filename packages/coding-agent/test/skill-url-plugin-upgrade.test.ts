import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discoveryHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { dispatchRpcSkillPrompt } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const SKILL = "upgrade-skill";

/**
 * `omp plugin upgrade` installs a marketplace plugin's new version in a new
 * cache directory (`<marketplace>___<plugin>___<version>`), points the
 * registry at it and deletes the old version's directory. A session that
 * discovered its skills before the upgrade must keep reading them.
 */
describe("a plugin upgrade that replaces the plugin's version directory under a running session", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const extraDirs: string[] = [];

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-upgrade-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		discoveryHelpers.clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-upgrade-project-"));
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-upgrade-home-"));
		process.env.HOME = tempHomeDir;
		// Discovery reads `os.homedir()` and the agent dir; left alone they scan the real user's plugins and skills.
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		installPluginVersion("1.0.0");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		discoveryHelpers.clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
		for (const dir of extraDirs.splice(0)) removeSyncWithRetries(dir);
		__resetDirsFromEnvForTests();
	});

	function pluginDir(version: string): string {
		return path.join(tempHomeDir, ".omp", "plugins", "cache", "plugins", `market___upgrade-plugin___${version}`);
	}

	function userRegistryPath(): string {
		return path.join(tempHomeDir, ".omp", "plugins", "installed_plugins.json");
	}

	/** The project-scope registry of a session whose cwd is `tempDir`. */
	function projectRegistryPath(): string {
		return path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
	}

	function writePluginVersion(version: string): void {
		const skillDir = path.join(pluginDir(version), "skills", SKILL);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${SKILL}\ndescription: Plugin skill.\n---\n\nBody of version ${version}.\n`,
		);
		fs.writeFileSync(path.join(skillDir, "notes.md"), `Notes of version ${version}.\n`);
	}

	function writeRegistry(registryPath: string, version: string, scope: "user" | "project"): void {
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(
			registryPath,
			JSON.stringify({
				version: 2,
				plugins: { "upgrade-plugin@market": [{ scope, installPath: pluginDir(version), version }] },
			}),
		);
	}

	/**
	 * What `omp plugin upgrade` leaves on disk: the new version installed and registered, and the old
	 * one deleted when `previous` is given. Without it the old directory stays, as when another scope
	 * still uses it or the installer keeps superseded versions for running sessions.
	 */
	function installPluginVersion(version: string, previous?: string): void {
		writePluginVersion(version);
		writeRegistry(userRegistryPath(), version, "user");
		if (previous) removeSyncWithRetries(pluginDir(previous));
	}

	/** A version of the plugin that renames its skill, so it no longer has {@link SKILL}. */
	function writePluginVersionWithoutSkill(version: string): void {
		const renamedDir = path.join(pluginDir(version), "skills", "renamed-skill");
		fs.mkdirSync(renamedDir, { recursive: true });
		fs.writeFileSync(
			path.join(renamedDir, "SKILL.md"),
			"---\nname: renamed-skill\ndescription: Plugin skill.\n---\n\nBody of the renamed skill.\n",
		);
	}

	function otherPluginDir(): string {
		return path.join(tempHomeDir, ".omp", "plugins", "cache", "plugins", "market___other-plugin___1.0.0");
	}

	/**
	 * Registers the plugin at `version` and another plugin with a different skill also named
	 * {@link SKILL}. The plugin registered first keeps the bare name and the other one's skill is
	 * namespaced. `upgradedLast` is the order `omp plugin upgrade` leaves: it rewrites the upgraded
	 * plugin's entry, which moves it after the other plugin.
	 */
	function writeRegistryWithCollidingPlugin(version: string, upgradedLast = false): void {
		const skillDir = path.join(otherPluginDir(), "skills", SKILL);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${SKILL}\ndescription: Another plugin's skill.\n---\n\nBody of the other plugin.\n`,
		);
		const upgraded: [string, unknown] = [
			"upgrade-plugin@market",
			[{ scope: "user", installPath: pluginDir(version), version }],
		];
		const other: [string, unknown] = [
			"other-plugin@market",
			[{ scope: "user", installPath: otherPluginDir(), version: "1.0.0" }],
		];
		const plugins = Object.fromEntries(upgradedLast ? [other, upgraded] : [upgraded, other]);
		fs.writeFileSync(userRegistryPath(), JSON.stringify({ version: 2, plugins }));
	}

	/** A project skill at `<cwd>/.omp/skills/<name>/SKILL.md`. */
	function writeProjectSkill(cwd: string, name: string, body: string): void {
		const skillDir = path.join(cwd, ".omp", "skills", name);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Project skill.\n---\n\n${body}\n`,
		);
	}

	/** Another directory to run a session in, removed after the test. */
	function makeExtraDir(prefix: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		extraDirs.push(dir);
		return dir;
	}

	/** What `omp plugin uninstall` leaves on disk: the plugin unregistered and its directory deleted. */
	function uninstallPlugin(version: string): void {
		fs.writeFileSync(userRegistryPath(), JSON.stringify({ version: 2, plugins: {} }));
		removeSyncWithRetries(pluginDir(version));
	}

	function skillsSettings(): Settings {
		return Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
		});
	}

	async function startSession(options: { skills?: AgentSession["skills"]; cwd?: string } = {}): Promise<AgentSession> {
		const cwd = options.cwd ?? tempDir;
		const { session } = await sdkModule.createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(cwd),
			modelRegistry: sharedModelRegistry,
			settings: skillsSettings(),
			...(options.skills ? { skills: [...options.skills] } : {}),
		});
		sessions.push(session);
		return session;
	}

	/** The `read` tool's text for `url`, or its error message when the read fails. */
	async function readText(session: AgentSession, url: string): Promise<string> {
		try {
			const result = await session.getToolByName("read")!.execute(`read-${url}`, { path: url });
			return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/** Counts process-wide cache clears, one per rediscovery pass. */
	function countRediscoveries() {
		return vi.spyOn(discoveryHelpers, "clearPluginRootsAndCaches");
	}

	it("a session that discovered the skill reads the new version and its skill list follows", async () => {
		const session = await startSession();
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");

		installPluginVersion("2.0.0", "1.0.0");

		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		expect(await readText(session, `skill://${SKILL}/notes.md`)).toContain("Notes of version 2.0.0.");
		// The session's own list is healed, so subagents it spawns from now on inherit the new path.
		const skill = session.skills.find(entry => entry.name === SKILL);
		expect(skill?.filePath.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("a session handed a fixed skill list (a subagent's inherited skills) reads the new version and keeps it", async () => {
		const parent = await startSession();
		const child = await startSession({ skills: parent.skills });

		installPluginVersion("2.0.0", "1.0.0");
		const rediscoveries = countRediscoveries();

		expect(await readText(child, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		// The re-pointed list is stored, so later reads (and subagents this child spawns) use the new path.
		expect(child.skills.find(entry => entry.name === SKILL)?.filePath.startsWith(pluginDir("2.0.0"))).toBe(true);
		expect(await readText(child, `skill://${SKILL}/notes.md`)).toContain("Notes of version 2.0.0.");
		expect(rediscoveries).toHaveBeenCalledTimes(1);
	});

	it("a fixed list whose plugin was uninstalled rediscovers once, then reports the skill as unknown", async () => {
		const parent = await startSession();
		const child = await startSession({ skills: parent.skills });

		uninstallPlugin("1.0.0");
		const rediscoveries = countRediscoveries();

		for (let attempt = 0; attempt < 3; attempt++) {
			expect(await readText(child, `skill://${SKILL}`)).toContain(`Unknown skill: ${SKILL}`);
		}
		expect(child.skills.some(entry => entry.name === SKILL)).toBe(false);
		expect(rediscoveries).toHaveBeenCalledTimes(1);
	});

	it("a fixed list re-points only the skill whose file is gone and keeps the inherited skills that still exist", async () => {
		writeProjectSkill(tempDir, "kept-skill", "Parent's copy.");
		// A worktree subagent runs in another cwd; its own discovery finds a same-named project skill.
		const worktreeDir = makeExtraDir("pi-skill-upgrade-worktree-");
		writeProjectSkill(worktreeDir, "kept-skill", "Worktree's copy.");
		const parent = await startSession();
		const inherited = parent.skills.find(entry => entry.name === "kept-skill")!;
		const child = await startSession({ skills: parent.skills, cwd: worktreeDir });

		installPluginVersion("2.0.0", "1.0.0");

		expect(await readText(child, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		expect(child.skills.find(entry => entry.name === "kept-skill")?.filePath).toBe(inherited.filePath);
		expect(await readText(child, "skill://kept-skill")).toContain("Parent's copy.");
	});

	it("a fixed list re-points a skill whose file is gone only to an install of the same plugin", async () => {
		// The plugin is installed for the parent's project only; the worktree subagent's own discovery
		// cannot see it, but finds a same-named project skill with other instructions.
		fs.writeFileSync(userRegistryPath(), JSON.stringify({ version: 2, plugins: {} }));
		writeRegistry(projectRegistryPath(), "1.0.0", "project");
		const worktreeDir = makeExtraDir("pi-skill-upgrade-worktree-");
		writeProjectSkill(worktreeDir, SKILL, "Worktree's copy.");
		const parent = await startSession();
		const child = await startSession({ skills: parent.skills, cwd: worktreeDir });

		writePluginVersion("2.0.0");
		writeRegistry(projectRegistryPath(), "2.0.0", "project");
		removeSyncWithRetries(pluginDir("1.0.0"));

		const text = await readText(child, `skill://${SKILL}`);
		expect(text).not.toContain("Worktree's copy.");
		expect(text).toContain(`Unknown skill: ${SKILL}`);
		expect(child.skills.some(entry => entry.name === SKILL)).toBe(false);
	});

	// Windows reports ENOENT for a path below a regular file, so there is no "cannot be checked" case there.
	it.skipIf(process.platform === "win32")(
		"a fixed list keeps a skill whose file cannot be checked: only a missing file counts as gone",
		async () => {
			// Every stat of a path below a regular file fails with ENOTDIR, not ENOENT.
			const notADirectory = path.join(tempDir, "not-a-directory");
			fs.writeFileSync(notADirectory, "");
			const unchecked = {
				name: "unchecked-skill",
				description: "A skill whose file cannot be checked.",
				filePath: path.join(notADirectory, "SKILL.md"),
				baseDir: notADirectory,
				source: "custom:user",
			};
			const parent = await startSession();
			const child = await startSession({ skills: [...parent.skills, unchecked] });

			installPluginVersion("2.0.0", "1.0.0");

			expect(await readText(child, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
			expect(child.skills.some(entry => entry.name === "unchecked-skill")).toBe(true);
		},
	);

	it("an upgrade that keeps the old version's directory moves a running session to the new version", async () => {
		const session = await startSession();
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");

		installPluginVersion("2.0.0");

		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		expect(session.skills.find(entry => entry.name === SKILL)?.filePath.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("an upgrade that keeps the old version's directory still moves a session after a session in another directory read the registry", async () => {
		const session = await startSession();
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");

		installPluginVersion("2.0.0");
		// Its discovery reads the upgraded registry before the first session's next lookup.
		await startSession({ cwd: makeExtraDir("pi-skill-upgrade-other-") });

		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
	});

	it("a registry path that cannot be checked counts as absent and leaves the other registries' plugins loaded", async () => {
		// Every stat below a regular file fails with ENOTDIR, so the Claude registry cannot be checked.
		fs.writeFileSync(path.join(tempHomeDir, ".claude"), "");
		const session = await startSession();

		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");
	});

	it("a /skill: invocation after an upgrade that keeps the old version's directory sends the new version", async () => {
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;

		installPluginVersion("2.0.0");

		const built = await session.buildUserSkillPrompt(skill, { args: "" });
		expect(built.message).toContain("Body of version 2.0.0.");
		expect(built.details.path.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("a /skill: invocation of a skill the upgrade dropped fails as unknown instead of reading the old version", async () => {
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;

		// 2.0.0 renames the skill; the 1.0.0 directory stays (another scope or a retained install).
		writePluginVersionWithoutSkill("2.0.0");
		writeRegistry(userRegistryPath(), "2.0.0", "user");

		await expect(session.buildUserSkillPrompt(skill, { args: "" })).rejects.toThrow(`Unknown skill: ${SKILL}`);
		expect(await readText(session, `skill://${SKILL}`)).toContain(`Unknown skill: ${SKILL}`);
	});

	it("a skill the upgrade dropped and kept on disk is unknown, not another plugin's same-named skill", async () => {
		writeRegistryWithCollidingPlugin("1.0.0");
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");
		// A tool session copied before the upgrade keeps the old list in `context.skills`.
		const toolSession = { skills: session.skills, skillRediscoveryHost: () => session.skillRediscoveryHost() };
		const context = { skills: session.skills, session: toolSession as unknown as ToolSession };

		writePluginVersionWithoutSkill("2.0.0");
		writeRegistryWithCollidingPlugin("2.0.0");

		await expect(session.buildUserSkillPrompt(skill, { args: "" })).rejects.toThrow(`Unknown skill: ${SKILL}`);
		// That rediscovery gave the other plugin's skill the bare name; the copy's lookup still refuses it.
		expect(session.skills.find(entry => entry.name === SKILL)?.filePath.startsWith(otherPluginDir())).toBe(true);
		await expect(new SkillProtocolHandler().resolve(parseInternalUrl(`skill://${SKILL}`), context)).rejects.toThrow(
			`Unknown skill: ${SKILL}`,
		);
	});

	it("a skill the upgrade dropped and deleted is unknown, not another plugin's same-named skill", async () => {
		writeRegistryWithCollidingPlugin("1.0.0");
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");

		writePluginVersionWithoutSkill("2.0.0");
		writeRegistryWithCollidingPlugin("2.0.0");
		removeSyncWithRetries(pluginDir("1.0.0"));

		const text = await readText(session, `skill://${SKILL}`);
		expect(text).not.toContain("Body of the other plugin.");
		expect(text).toContain(`Unknown skill: ${SKILL}`);
		// The rediscovery that refused the read gave the other plugin's skill the bare name.
		await expect(session.buildUserSkillPrompt(skill, { args: "" })).rejects.toThrow(`Unknown skill: ${SKILL}`);
	});

	it("an upgrade that leaves another plugin's same-named skill the bare name still serves the new version", async () => {
		writeRegistryWithCollidingPlugin("1.0.0");
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;
		const child = await startSession({ skills: session.skills });
		// A tool session copied before the upgrade keeps the old list in `context.skills`.
		const toolSession = { skills: session.skills, skillRediscoveryHost: () => session.skillRediscoveryHost() };
		const context = { skills: session.skills, session: toolSession as unknown as ToolSession };
		const handler = new SkillProtocolHandler();

		installPluginVersion("2.0.0", "1.0.0");
		writeRegistryWithCollidingPlugin("2.0.0", true);

		// The first lookup rediscovers; the second finds the session's list moved on.
		for (let attempt = 0; attempt < 2; attempt++) {
			const resource = await handler.resolve(parseInternalUrl(`skill://${SKILL}/notes.md`), context);
			expect(resource.content).toContain("Notes of version 2.0.0.");
		}
		// The rediscovery gave the other plugin's skill the bare name; the upgraded one is namespaced.
		expect(session.skills.find(entry => entry.name === SKILL)?.filePath.startsWith(otherPluginDir())).toBe(true);
		const built = await session.buildUserSkillPrompt(skill, { args: "" });
		expect(built.message).toContain("Body of version 2.0.0.");
		// A fixed list re-points the entry under the name it already lists, so later reads by that name keep working.
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(await readText(child, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		}
	});

	it("a new version that gives the skill's name to another folder serves that folder, not the renamed old one", async () => {
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;

		// 2.0.0 renames the skill in its old folder and gives its name to a skill in a new folder.
		for (const [folder, name, body] of [
			[SKILL, "renamed-skill", "Body of the renamed folder."],
			["moved-skill", SKILL, "Body of the moved skill."],
		]) {
			const skillDir = path.join(pluginDir("2.0.0"), "skills", folder);
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${name}\ndescription: Plugin skill.\n---\n\n${body}\n`,
			);
		}
		writeRegistry(userRegistryPath(), "2.0.0", "user");
		removeSyncWithRetries(pluginDir("1.0.0"));

		const built = await session.buildUserSkillPrompt(skill, { args: "" });
		expect(built.message).toContain("Body of the moved skill.");
	});

	it("a project-scope upgrade moves the project's session and leaves a session outside the project alone", async () => {
		// Both scopes share the 1.0.0 cache directory; the project upgrade keeps it for the user scope.
		writeRegistry(projectRegistryPath(), "1.0.0", "project");
		const projectSession = await startSession();
		const userSession = await startSession({ cwd: makeExtraDir("pi-skill-upgrade-outside-") });
		expect(await readText(projectSession, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");
		expect(await readText(userSession, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");

		writePluginVersion("2.0.0");
		writeRegistry(projectRegistryPath(), "2.0.0", "project");
		const rediscoveries = countRediscoveries();

		expect(await readText(projectSession, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(await readText(userSession, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");
		}
		expect(rediscoveries).toHaveBeenCalledTimes(1);
	});

	it("a skill:// resolve whose target is deleted by an upgrade after the stale check reads the new version", async () => {
		const session = await startSession();
		const toolSession = { skills: session.skills, skillRediscoveryHost: () => session.skillRediscoveryHost() };
		const context = { skills: session.skills, session: toolSession as unknown as ToolSession };
		const handler = new SkillProtocolHandler();
		expect((await handler.resolve(parseInternalUrl(`skill://${SKILL}`), context)).content).toContain(
			"Body of version 1.0.0.",
		);

		// The first superseded check answers from the registry as it was; the upgrade then publishes
		// 2.0.0 and deletes 1.0.0 before resolve reads the path that check accepted.
		const isSuperseded = discoveryHelpers.isSupersededPluginPath;
		let upgraded = false;
		vi.spyOn(discoveryHelpers, "isSupersededPluginPath").mockImplementation(async (...args) => {
			const superseded = await isSuperseded(...args);
			if (!upgraded) {
				upgraded = true;
				installPluginVersion("2.0.0", "1.0.0");
			}
			return superseded;
		});

		const resource = await handler.resolve(parseInternalUrl(`skill://${SKILL}`), context);
		expect(upgraded).toBe(true);
		expect(resource.content).toContain("Body of version 2.0.0.");
		expect(resource.sourcePath?.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("concurrent reads after the upgrade share one rediscovery", async () => {
		const session = await startSession();

		installPluginVersion("2.0.0", "1.0.0");
		const rediscoveries = countRediscoveries();

		const texts = await Promise.all(Array.from({ length: 5 }, () => readText(session, `skill://${SKILL}`)));
		for (const text of texts) expect(text).toContain("Body of version 2.0.0.");
		expect(rediscoveries).toHaveBeenCalledTimes(1);
	});

	it("a missing file inside a skill that still exists is not found without a rediscovery", async () => {
		const session = await startSession();
		const rediscoveries = countRediscoveries();

		expect(await readText(session, `skill://${SKILL}/missing.md`)).toContain("File not found");
		expect(rediscoveries).not.toHaveBeenCalled();
	});

	it("lookups through a copy of the skill list taken before the upgrade rediscover once", async () => {
		const session = await startSession();
		// A tool session copied before the upgrade (as a spread copy of the primary's) keeps the old
		// list in `context.skills` while its rediscovery host is the live session.
		const toolSession = { skills: session.skills, skillRediscoveryHost: () => session.skillRediscoveryHost() };
		const context = { skills: session.skills, session: toolSession as unknown as ToolSession };
		const handler = new SkillProtocolHandler();

		installPluginVersion("2.0.0", "1.0.0");
		const rediscoveries = countRediscoveries();

		for (let attempt = 0; attempt < 3; attempt++) {
			const resource = await handler.resolve(parseInternalUrl(`skill://${SKILL}`), context);
			expect(resource.content).toContain("Body of version 2.0.0.");
		}
		expect(rediscoveries).toHaveBeenCalledTimes(1);
	});

	it("a skill entry held from before two upgrades is rediscovered, not read from the first upgrade's deleted dir", async () => {
		const session = await startSession();
		const original = session.skills.find(entry => entry.name === SKILL)!;

		installPluginVersion("2.0.0", "1.0.0");
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		installPluginVersion("3.0.0", "2.0.0");

		const built = await session.buildUserSkillPrompt(original, { args: "" });
		expect(built.message).toContain("Body of version 3.0.0.");
		expect(built.details.path.startsWith(pluginDir("3.0.0"))).toBe(true);
	});

	it("a /skill: invocation from a running session (TUI, ACP, RPC) sends the new version", async () => {
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;

		installPluginVersion("2.0.0", "1.0.0");

		const built = await session.buildUserSkillPrompt(skill, { args: "" });
		expect(built.message).toContain("Body of version 2.0.0.");
		expect(built.details.path.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("an RPC prompt command with /skill: after the upgrade sends the new version", async () => {
		const session = await startSession();
		installPluginVersion("2.0.0", "1.0.0");

		// Only the turn is stubbed (there is no model to run): it records the message and admits it.
		const sent: Array<{ content: unknown; path: unknown }> = [];
		vi.spyOn(session, "promptCustomMessage").mockImplementation(async (message, options) => {
			const details = message.details;
			const readPath = details && typeof details === "object" && "path" in details ? details.path : undefined;
			sent.push({ content: message.content, path: readPath });
			options?.onPromptAdmitted?.();
			return true;
		});
		const results = new RpcPromptResults(
			{ isStreaming: false, hasAdmittedSubmission: false, queuedMessageCount: 0, hasPendingAsyncWork: () => false },
			() => {},
		);
		const result = await dispatchRpcSkillPrompt({
			ticket: results.begin("cmd-upgrade"),
			results,
			session,
			message: `/skill:${SKILL}`,
			streamingBehavior: undefined,
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		expect(result).toEqual({ agentInvoked: true });
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("Body of version 2.0.0.");
		expect(String(sent[0].path).startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("a subagent spawned with an autoload skill after the upgrade receives the new version", async () => {
		const parent = await startSession();
		const skill = parent.skills.find(entry => entry.name === SKILL)!;

		installPluginVersion("2.0.0", "1.0.0");

		// The child is a real session with the parent's list, fixed, as the executor creates it; only its
		// turn is stubbed (there is no model to run), ending at once with a successful yield.
		const child = await startSession({ skills: parent.skills });
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		vi.spyOn(child, "subscribe").mockImplementation(listener => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		});
		vi.spyOn(child, "prompt").mockImplementation(async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "yield",
					result: { content: [{ type: "text", text: "done" }], details: { status: "success", data: {} } },
					isError: false,
				});
			}
			return true;
		});
		const sendCustomMessage = vi.spyOn(child, "sendCustomMessage").mockResolvedValue(true);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: child,
			extensionsResult: {} as sdkModule.CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		});

		await runSubprocess({
			cwd: tempDir,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "do work",
			index: 0,
			id: "upgrade-subagent",
			settings: skillsSettings(),
			modelRegistry: sharedModelRegistry,
			enableLsp: false,
			skills: [...parent.skills],
			autoloadSkills: [skill],
		});

		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: expect.stringContaining("Body of version 2.0.0."),
				details: expect.objectContaining({ path: expect.stringContaining(pluginDir("2.0.0")) }),
			}),
			{ triggerTurn: false },
		);
	});
});
