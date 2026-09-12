import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function createUserMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

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

describe("skillful setting and /skillful session toggle", () => {
	let tempDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skillful-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skillful-"));
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skillful-home-"));
		process.env.HOME = tempHomeDir;
		fs.mkdirSync(path.join(tempDir, ".omp", "skills", "test-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".omp", "skills", "test-skill", "SKILL.md"),
			`---\nname: test-skill\ndescription: A test skill for the skillful toggle.\n---\n# Test Skill\n`,
		);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	async function createSession(overrides: Record<string, unknown> = {}): Promise<AgentSession> {
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(overrides),
		});
		session = created.session;
		return session;
	}

	it("lists skills in the system prompt by default and omits them when skillful is false", async () => {
		const listed = await createSession();
		expect(listed.skills.some(skill => skill.name === "test-skill")).toBe(true);
		expect(listed.agent.state.systemPrompt.join("\n")).toContain("- test-skill:");
		await listed.dispose();
		session = undefined;

		const unlisted = await createSession({ skillful: false });
		expect(unlisted.skills.some(skill => skill.name === "test-skill")).toBe(true);
		expect(unlisted.agent.state.systemPrompt.join("\n")).not.toContain("- test-skill:");
	});

	it("rebuilds the system prompt when toggled on an empty transcript without persisting", async () => {
		const s = await createSession({ skillful: false });
		expect(s.agent.state.systemPrompt.join("\n")).not.toContain("- test-skill:");

		expect(await s.toggleSkillful()).toBe(true);
		expect(s.settings.get("skillful")).toBe(true);
		expect(s.agent.state.systemPrompt.join("\n")).toContain("- test-skill:");

		expect(await s.toggleSkillful()).toBe(false);
		expect(s.agent.state.systemPrompt.join("\n")).not.toContain("- test-skill:");
	});

	it("appends one hidden notice instead of rewriting the prompt when enabled mid-session", async () => {
		const s = await createSession({ skillful: false });
		s.agent.appendMessage(createUserMessage("earlier work"));
		const promptBefore = s.agent.state.systemPrompt;

		expect(await s.toggleSkillful()).toBe(true);
		expect(s.agent.state.systemPrompt).toBe(promptBefore);

		const notices = s.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "skillful-notice",
		);
		expect(notices.length).toBe(1);
		const notice = notices[0];
		expect(notice.role === "custom" && notice.display).toBe(false);
		const content = notice.role === "custom" ? notice.content : "";
		expect(content).toContain("- test-skill:");
		expect(content).toContain("skill://<name>");

		// First enable only: a later disable/enable cycle adds no second notice.
		await s.toggleSkillful();
		expect(await s.toggleSkillful()).toBe(true);
		expect(
			s.agent.state.messages.filter(message => message.role === "custom" && message.customType === "skillful-notice")
				.length,
		).toBe(1);
	});

	it("adds no notice when disabling mid-session", async () => {
		const s = await createSession();
		s.agent.appendMessage(createUserMessage("earlier work"));

		expect(await s.toggleSkillful()).toBe(false);
		expect(
			s.agent.state.messages.some(message => message.role === "custom" && message.customType === "skillful-notice"),
		).toBe(false);
	});

	it("/skillful slash command toggles skillful and formats status", async () => {
		const s = await createSession({ skillful: true });
		const cmd = BUILTIN_MODE_SLASH_COMMANDS.find(c => c.name === "skillful");
		expect(cmd).toBeDefined();

		const outputs: string[] = [];
		const runtime = {
			session: s,
			settings: s.settings,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await cmd!.handle!({ name: "skillful", args: "off", text: "/skillful off" }, runtime);
		expect(s.settings.get("skillful")).toBe(false);
		expect(outputs.pop()).toContain("disabled");

		await cmd!.handle!({ name: "skillful", args: "status", text: "/skillful status" }, runtime);
		expect(outputs.pop()).toContain("off");

		await cmd!.handle!({ name: "skillful", args: "toggle", text: "/skillful toggle" }, runtime);
		expect(s.settings.get("skillful")).toBe(true);
		expect(outputs.pop()).toContain("enabled");
	});
});
