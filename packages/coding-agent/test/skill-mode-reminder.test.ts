import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_MODE_PIN_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/mode-skills";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const MODE_REMINDER_TEXT = "Always answer in the voice of a dry, laconic potato.";

function createIsolatedSkillsSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
		...overrides,
	});
}

describe("pinned skill mode reminders", () => {
	let tempDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-mode-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-mode-"));
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-mode-home-"));
		process.env.HOME = tempHomeDir;
		fs.mkdirSync(path.join(tempDir, ".omp", "skills", "potato-mode"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".omp", "skills", "potato-mode", "SKILL.md"),
			`---\nname: potato-mode\ndescription: A pinnable persona mode.\nmode: true\nreminder: "${MODE_REMINDER_TEXT}"\n---\n# Potato Mode\n`,
		);
		fs.mkdirSync(path.join(tempDir, ".omp", "skills", "plain-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".omp", "skills", "plain-skill", "SKILL.md"),
			`---\nname: plain-skill\ndescription: A regular skill without a mode.\n---\n# Plain Skill\n`,
		);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	async function createSession(sessionManager?: SessionManager): Promise<AgentSession> {
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: sessionManager ?? SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});
		session = created.session;
		return session;
	}

	it("injects the reminder into the system prompt while pinned and drops it when unpinned", async () => {
		const s = await createSession();
		const joined = () => s.agent.state.systemPrompt.join("\n");
		expect(joined()).not.toContain(MODE_REMINDER_TEXT);
		expect(s.getPinnedModeSkillNames()).toEqual([]);

		expect(await s.pinModeSkill("potato-mode")).toBe(true);
		expect(joined()).toContain(MODE_REMINDER_TEXT);
		expect(joined()).toContain("potato-mode");
		expect(s.getPinnedModeSkillNames()).toEqual(["potato-mode"]);
		expect(s.getPinnedModeSkills().map(skill => skill.name)).toEqual(["potato-mode"]);

		// The pin persists as a session entry (the resume-replay contract).
		const pinEntry = s.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SKILL_MODE_PIN_CUSTOM_TYPE) as
			| { type: "custom"; data: unknown }
			| undefined;
		expect(pinEntry?.type).toBe("custom");
		expect(pinEntry?.data).toEqual({ skill: "potato-mode", pinned: true });

		// No-ops are reported, not repeated entries.
		expect(await s.pinModeSkill("potato-mode")).toBe(false);
		expect(await s.pinModeSkill("plain-skill")).toBe(false);
		expect(await s.pinModeSkill("missing-skill")).toBe(false);
		expect(
			s.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === SKILL_MODE_PIN_CUSTOM_TYPE).length,
		).toBe(1);

		expect(await s.unpinModeSkill("potato-mode")).toBe(true);
		expect(joined()).not.toContain(MODE_REMINDER_TEXT);
		expect(s.getPinnedModeSkillNames()).toEqual([]);
		expect(await s.unpinModeSkill("potato-mode")).toBe(false);
	});

	it("keeps the reminder across a mid-session pin (transcript present)", async () => {
		const s = await createSession();
		s.agent.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });

		expect(await s.toggleModeSkill("potato-mode")).toBe("pinned");
		expect(s.agent.state.systemPrompt.join("\n")).toContain(MODE_REMINDER_TEXT);
		expect(await s.toggleModeSkill("potato-mode")).toBe("unpinned");
		expect(s.agent.state.systemPrompt.join("\n")).not.toContain(MODE_REMINDER_TEXT);
	});

	it("replays pins from session entries on resume", async () => {
		const sessionFile = path.join(tempDir, "session.jsonl");
		const first = await createSession(await SessionManager.open(sessionFile, tempDir));
		expect(await first.pinModeSkill("potato-mode")).toBe(true);
		expect(first.agent.state.systemPrompt.join("\n")).toContain(MODE_REMINDER_TEXT);
		await first.dispose();
		session = undefined;

		const resumed = await createSession(await SessionManager.open(sessionFile, tempDir));
		expect(resumed.getPinnedModeSkillNames()).toEqual(["potato-mode"]);
		expect(resumed.agent.state.systemPrompt.join("\n")).toContain(MODE_REMINDER_TEXT);
	});

	it("/mode slash command lists, pins, and unpins mode skills", async () => {
		const s = await createSession();
		const cmd = BUILTIN_MODE_SLASH_COMMANDS.find(c => c.name === "mode");
		expect(cmd).toBeDefined();

		const outputs: string[] = [];
		const runtime = {
			session: s,
			settings: s.settings,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await cmd!.handle!({ name: "mode", args: "list", text: "/mode list" }, runtime);
		const listing = outputs.pop()!;
		expect(listing).toContain("potato-mode");
		expect(listing).not.toContain("plain-skill");

		await cmd!.handle!({ name: "mode", args: "potato-mode", text: "/mode potato-mode" }, runtime);
		expect(outputs.pop()).toContain("pinned");
		expect(s.getPinnedModeSkillNames()).toEqual(["potato-mode"]);
		expect(s.agent.state.systemPrompt.join("\n")).toContain(MODE_REMINDER_TEXT);

		await cmd!.handle!({ name: "mode", args: "status", text: "/mode status" }, runtime);
		expect(outputs.pop()).toContain("potato-mode (pinned)");

		await cmd!.handle!({ name: "mode", args: "potato-mode", text: "/mode potato-mode" }, runtime);
		expect(outputs.pop()).toContain("unpinned");
		expect(s.getPinnedModeSkillNames()).toEqual([]);
		expect(s.agent.state.systemPrompt.join("\n")).not.toContain(MODE_REMINDER_TEXT);

		await cmd!.handle!({ name: "mode", args: "plain-skill", text: "/mode plain-skill" }, runtime);
		expect(outputs.pop()).toContain("not a mode skill");

		await cmd!.handle!({ name: "mode", args: "nope", text: "/mode nope" }, runtime);
		expect(outputs.pop()).toContain("Unknown skill");
	});
});
