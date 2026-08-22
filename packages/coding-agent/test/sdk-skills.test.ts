import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reset as resetCapabilities } from "@pk-nerdsaver-ai/pi-coding-agent/capability";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { getActiveSkills } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/skills";
import type { Skill } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function createIsolatedSkillsSettings(): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
	});
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests: skill
	// discovery never touches models, and building them per test would make createAgentSession call
	// modelRegistry.refreshInBackground(), whose online model discovery saturates the event loop and
	// serializes the otherwise-parallel capability scans (~340ms/call). Supplying a prebuilt registry
	// skips that refresh entirely (~24ms/call).
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-skills-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Create skill in .ompk/skills/ for native project-level discovery
		skillsDir = path.join(tempDir, ".ompk", "skills", "test-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-home-"));
		process.env.HOME = tempHomeDir;
		const nativeUserSkillsDir = path.join(tempHomeDir, ".ompk", "agent", "skills");
		fs.mkdirSync(nativeUserSkillsDir, { recursive: true });

		// Create a test skill in the pi skills directory
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(externalSkillDir, path.join(path.dirname(skillsDir), "symlinked-skill-link"), "dir");
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
	});

	it("should still discover project skills when user skills directory is missing", async () => {
		const userAgentDir = path.join(tempHomeDir, ".ompk", "agent");
		removeSyncWithRetries(path.join(userAgentDir, "skills"));
		fs.writeFileSync(path.join(userAgentDir, "placeholder.txt"), "placeholder");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});
	it("should have empty skills when options.skills is empty array (--no-skills)", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [], // Explicitly empty - like --no-skills
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should be empty
		expect(session.skills).toEqual([]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});

	it("should use provided skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should contain only the provided skill
		expect(session.skills).toEqual([customSkill]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});
});

describe("createAgentSession reloadSkills", () => {
	let tempDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-skills-reload-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(path.join(tempDir, ".ompk", "skills", "initial-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".ompk", "skills", "initial-skill", "SKILL.md"),
			`---
name: initial-skill
description: Present at session start.
---

# Initial Skill
`,
		);
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-reload-home-"));
		process.env.HOME = tempHomeDir;
	});

	afterEach(
		cleanupTempHome(() => ({
			tempDir,
			tempHomeDir,
			originalHome,
		})),
	);

	function writeSkill(name: string, description: string): void {
		const dir = path.join(tempDir, ".ompk", "skills", name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---
name: ${name}
description: ${description}
---

# ${name}
`,
		);
	}

	it("picks up added and removed skills across reloadSkills()", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "initial-skill")).toBe(true);

		writeSkill("reloaded-skill", "Added after session creation.");
		fs.rmSync(path.join(tempDir, ".ompk", "skills", "initial-skill"), { recursive: true, force: true });

		// Mirror the /reload-plugins pipelines: capability cache must be dropped
		// or the re-discovery below would read the stale cached skill set.
		resetCapabilities();
		const changed = await session.reloadSkills();

		expect(changed).toBe(true);
		expect(session.skills.some((s: Skill) => s.name === "reloaded-skill")).toBe(true);
		expect(session.skills.some((s: Skill) => s.name === "initial-skill")).toBe(false);

		// The stale-closure regression: the SDK prompt builder closed over the
		// construction-time skills array, so the rebuilt prompt kept advertising
		// removed skills and never mentioned new ones.
		const promptText = session.systemPrompt.join("\n");
		expect(promptText).toContain("reloaded-skill");
		expect(promptText).not.toContain("initial-skill");

		// Tool-facing resolution: the read tool resolves `skill://` through the
		// ToolSession's live skills getter, not a construction-time snapshot.
		const readTool = session.getToolByName("read");
		if (!readTool) throw new Error("Expected read tool");
		const readResult = await readTool.execute("reload-skill-read", {
			path: "skill://reloaded-skill",
		});
		const readText = JSON.stringify(readResult);
		expect(readText).toContain("reloaded-skill");
	});
	it("updates the process-global active-skills registry used by skill:// reads", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		writeSkill("late-skill", "Only visible after reload.");
		resetCapabilities();
		await session.reloadSkills();

		const active = getActiveSkills();
		expect(active.some((s: Skill) => s.name === "late-skill")).toBe(true);
	});

	it("refuses to rediscover when options.skills was explicit", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "Caller-owned list",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		writeSkill("ignored-skill", "Must NOT be discovered.");
		const changed = await session.reloadSkills();

		expect(changed).toBe(false);
		expect(session.skills).toEqual([customSkill]);
	});
});
