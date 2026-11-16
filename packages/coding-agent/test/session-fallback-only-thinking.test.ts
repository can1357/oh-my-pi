import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PRIMARY = "anthropic/claude-sonnet-4-5";

describe("fallback-only thinking entries", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStoragesToClose) authStorage.close();
		authStoragesToClose.length = 0;
		resetSettingsForTest();
		AgentStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function freshDir(): void {
		tempDir = path.join(os.tmpdir(), `pi-fallback-thinking-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	}

	function autoSettings(): Settings {
		return Settings.isolated({
			defaultThinkingLevel: AUTO_THINKING,
			modelRoles: { default: PRIMARY },
		});
	}

	function sessionOptions(sessionManager: SessionManager) {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			sessionManager,
			settings: autoSettings(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		};
	}

	/** Primary model, then one or two retry-fallback hops, with no earlier thinking entry. */
	function fallbackOnlyTranscript(options?: {
		secondHop?: boolean;
		/** Chosen after the first hop and, when set, before a second hop. */
		userPick?: Effort;
	}): SessionManager {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendModelChange("openai-codex/gpt-5.6-sol", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.XHigh, Effort.XHigh);
		if (options?.userPick) sessionManager.appendThinkingLevelChange(options.userPick, options.userPick);
		if (options?.secondHop) {
			sessionManager.appendModelChange("openai/gpt-4o-mini", EPHEMERAL_MODEL_CHANGE_ROLE, true);
			sessionManager.appendThinkingLevelChange(Effort.Max, Effort.Max);
		}
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		return sessionManager;
	}

	async function writeTranscript(sessionManager: SessionManager): Promise<string> {
		const file = path.join(tempDir, `saved-${Snowflake.next()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		const header = sessionManager.getHeader();
		if (!header) throw new Error("Expected a session header");
		const records = [
			{ ...header, timestamp, cwd: tempDir },
			...sessionManager.getEntries().map(entry => ({ ...entry, timestamp })),
		];
		await Bun.write(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		return file;
	}

	test("resumes the configured default when the only thinking entry is a fallback hop", async () => {
		freshDir();
		const sessionManager = fallbackOnlyTranscript();
		const context = sessionManager.buildSessionContext();
		expect(context.thinkingLevel).toBe("off");
		expect(context.configuredThinkingLevel).toBeUndefined();

		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		} finally {
			await session.dispose();
		}
	});

	test("a later fallback hop does not keep the first hop's level when nothing preceded them", async () => {
		freshDir();
		const sessionManager = fallbackOnlyTranscript({ secondHop: true });
		const context = sessionManager.buildSessionContext();
		expect(context.thinkingLevel).toBe("off");
		expect(context.configuredThinkingLevel).toBeUndefined();

		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		} finally {
			await session.dispose();
		}
	});

	test("keeps a level chosen after a fallback that had no earlier thinking entry", async () => {
		freshDir();
		const sessionManager = fallbackOnlyTranscript({ userPick: Effort.Low, secondHop: true });
		expect(sessionManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.Low);

		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("still restores a thinking level recorded before the fallback", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendThinkingLevelChange(Effort.High, Effort.High);
		sessionManager.appendModelChange("openai-codex/gpt-5.6-sol", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.XHigh, Effort.XHigh);
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		expect(sessionManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.High);

		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await session.dispose();
		}
	});

	test("switching sessions uses the configured default when only a fallback wrote a thinking level", async () => {
		freshDir();
		const target = await writeTranscript(fallbackOnlyTranscript({ secondHop: true }));
		const { session } = await createAgentSession(
			sessionOptions(SessionManager.create(tempDir, path.join(tempDir, "active"))),
		);
		try {
			session.setThinkingLevel(Effort.Medium);
			expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
			await expect(session.switchSession(target)).resolves.toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		} finally {
			await session.dispose();
		}
	});

	test("keeps the effort a model switch left in place when a later fallback follows", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendThinkingLevelChange(Effort.Low, Effort.Low);
		sessionManager.appendModelChange("openai-codex/gpt-5.6-sol", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.High, Effort.High);
		// The switch keeps high. The level did not change, so no thinking entry is written.
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendModelChange("openai/gpt-4o-mini", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.XHigh, Effort.XHigh);
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		const context = sessionManager.buildSessionContext();
		expect(context.thinkingLevel).toBe(Effort.High);
		expect(context.configuredThinkingLevel).toBe(Effort.High);

		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await session.dispose();
		}
	});

	test("switching to a fallback-only session with a different model uses the configured default", async () => {
		freshDir();
		const target = await writeTranscript(fallbackOnlyTranscript());
		const { session } = await createAgentSession(
			sessionOptions(SessionManager.create(tempDir, path.join(tempDir, "active"))),
		);
		try {
			const other = session.modelRegistry.find("anthropic", "claude-sonnet-4-6");
			if (!other) throw new Error("Expected bundled claude-sonnet-4-6");
			session.setThinkingLevel(Effort.Medium);
			await expect(session.switchSession(target, { model: other })).resolves.toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-6");
			expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
			expect(session.sessionManager.buildSessionContext().configuredThinkingLevel).toBe(AUTO_THINKING);
			await session.sessionManager.flush();
		} finally {
			await session.dispose();
		}

		const reopenedManager = await SessionManager.open(target, path.join(tempDir, "reopen"));
		const { session: reopened } = await createAgentSession(sessionOptions(reopenedManager));
		try {
			expect(reopened.model?.id).toBe("claude-sonnet-4-6");
			expect(reopened.configuredThinkingLevel()).toBe(AUTO_THINKING);
		} finally {
			await reopened.dispose();
		}
	});

	test("switching to a session with a different model keeps the effort from before the fallback", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendThinkingLevelChange(Effort.High, Effort.High);
		sessionManager.appendModelChange("openai-codex/gpt-5.6-sol", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.XHigh, Effort.XHigh);
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		const target = await writeTranscript(sessionManager);
		const { session } = await createAgentSession(
			sessionOptions(SessionManager.create(tempDir, path.join(tempDir, "active"))),
		);
		try {
			const other = session.modelRegistry.find("anthropic", "claude-sonnet-4-6");
			if (!other) throw new Error("Expected bundled claude-sonnet-4-6");
			session.setThinkingLevel(Effort.Medium);
			await expect(session.switchSession(target, { model: other })).resolves.toBe(true);
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.sessionManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.High);
		} finally {
			await session.dispose();
		}
	});
});
