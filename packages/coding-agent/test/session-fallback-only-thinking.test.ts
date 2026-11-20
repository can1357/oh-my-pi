import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
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

	function sessionOptions(sessionManager: SessionManager, settings: Settings = autoSettings()) {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			sessionManager,
			settings,
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

	test("keeps a user level chosen immediately after a bare fallback", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		// A bare fallback can retain the current effort and write no thinking entry.
		sessionManager.appendModelChange("openai-codex/gpt-5.6-sol", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			session.setThinkingLevel(Effort.Low);
			const context = sessionManager.buildSessionContext();
			expect(context.thinkingLevel).toBe(Effort.Low);
			expect(context.configuredThinkingLevel).toBe(Effort.Low);
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

	test("persists an unchanged effort explicitly retained after a live fallback", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			modelRoles: { default: PRIMARY },
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
		});
		const options = sessionOptions(sessionManager, settings);
		const primary = options.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const fallback = options.modelRegistry.find("openai-codex", "gpt-5.6-sol");
		const other = options.modelRegistry.find("anthropic", "claude-sonnet-4-6");
		if (!primary || !fallback || !other) throw new Error("Expected bundled fallback test models");
		options.authStorage.keys.setRuntime("openai-codex", "test-key");
		settings.setModelRole("default", PRIMARY);
		cfgRetryFallbackChains.set(settings, { default: [`${fallback.provider}/${fallback.id}:high`] });

		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			streamFn: (model, context, streamOptions) => {
				if (model.provider === primary.provider && model.id === primary.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=60000" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, streamOptions);
			},
		});
		const live = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: options.modelRegistry,
			thinkingLevel: Effort.Medium,
		});
		let target: string;
		try {
			await live.prompt("Trigger the high-effort fallback");
			await live.waitForIdle();
			expect(live.model?.id).toBe(fallback.id);
			expect(live.configuredThinkingLevel()).toBe(Effort.High);

			// High is already effective, but explicitly retaining it on this model switch
			// must still turn the ephemeral fallback effort into a saved session choice.
			await live.setModelTemporary(other, Effort.High);
			const context = sessionManager.buildSessionContext();
			expect(context.thinkingLevel).toBe(Effort.High);
			expect(context.configuredThinkingLevel).toBe(Effort.High);
			const retained = sessionManager
				.getBranch()
				.filter(entry => entry.type === "thinking_level_change")
				.at(-1);
			expect(retained?.retryFallback).toBe(false);
			target = await writeTranscript(sessionManager);
		} finally {
			await live.dispose();
		}

		const reopenedManager = await SessionManager.open(target, path.join(tempDir, "reopen-live-switch"));
		expect(reopenedManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.High);
		const reopenedSettings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			modelRoles: { default: PRIMARY },
		});
		const { session: reopened } = await createAgentSession(sessionOptions(reopenedManager, reopenedSettings));
		try {
			expect(reopened.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await reopened.dispose();
		}
	});

	test("persists an unchanged effort explicitly picked after a live fallback", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		const settings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			modelRoles: { default: PRIMARY },
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		const options = sessionOptions(sessionManager, settings);
		const primary = options.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const fallback = options.modelRegistry.find("openai-codex", "gpt-5.6-sol");
		if (!primary || !fallback) throw new Error("Expected bundled fallback test models");
		options.authStorage.keys.setRuntime("openai-codex", "test-key");
		settings.setModelRole("default", PRIMARY);
		cfgRetryFallbackChains.set(settings, { default: [`${fallback.provider}/${fallback.id}:high`] });

		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			streamFn: (model, context, streamOptions) => {
				if (model.provider === primary.provider && model.id === primary.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, streamOptions);
			},
		});
		const live = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: options.modelRegistry,
			thinkingLevel: Effort.Medium,
		});
		let target: string;
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await live.prompt("Trigger the high-effort fallback");
			await live.waitForIdle();
			expect(live.model?.id).toBe(fallback.id);
			expect(live.configuredThinkingLevel()).toBe(Effort.High);

			// High is already in effect from the hop, but picking it explicitly must
			// adopt it as a saved session choice rather than leave the hop's entry as
			// the only thinking record.
			live.setThinkingLevel(Effort.High);
			const retained = sessionManager
				.getBranch()
				.filter(entry => entry.type === "thinking_level_change")
				.at(-1);
			expect(retained?.retryFallback).toBe(false);
			expect(sessionManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.High);

			// The cooldown restore to the primary must keep the adopted level instead
			// of treating it as the untouched fallback level and reverting to medium.
			now += 240;
			await live.prompt("Cooldown expired: restore the primary");
			await live.waitForIdle();
			expect(live.model?.id).toBe(primary.id);
			expect(live.configuredThinkingLevel()).toBe(Effort.High);
			vi.restoreAllMocks();
			target = await writeTranscript(sessionManager);
		} finally {
			vi.restoreAllMocks();
			await live.dispose();
		}

		const reopenedManager = await SessionManager.open(target, path.join(tempDir, "reopen-live-pick"));
		expect(reopenedManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.High);
		const reopenedSettings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			modelRoles: { default: PRIMARY },
		});
		const { session: reopened } = await createAgentSession(sessionOptions(reopenedManager, reopenedSettings));
		try {
			expect(reopened.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await reopened.dispose();
		}
	});

	test("does not promote a fallback effort retained by a later model switch", async () => {
		freshDir();
		const settings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			modelRoles: { default: PRIMARY },
		});
		const sessionManager = fallbackOnlyTranscript();
		const { session } = await createAgentSession(sessionOptions(sessionManager, settings));
		try {
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
			const other = session.modelRegistry.find("anthropic", "claude-sonnet-4-6");
			if (!other) throw new Error("Expected bundled claude-sonnet-4-6");
			await session.setModelTemporary(other, Effort.Low);
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
			const context = sessionManager.buildSessionContext();
			// The explicit low choice is saved; the fallback's xhigh effort is not promoted.
			expect(context.thinkingLevel).toBe(Effort.Low);
			expect(context.configuredThinkingLevel).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}

		const target = await writeTranscript(sessionManager);
		const reopenedManager = await SessionManager.open(target, path.join(tempDir, "reopen-switch"));
		const reopenedSettings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			modelRoles: { default: PRIMARY },
		});
		const { session: reopened } = await createAgentSession(sessionOptions(reopenedManager, reopenedSettings));
		try {
			expect(reopened.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await reopened.dispose();
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
			const restoredContext = session.sessionManager.buildSessionContext();
			expect(restoredContext.thinkingLevel).toBe("off");
			expect(restoredContext.configuredThinkingLevel).toBeUndefined();
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

	test("persists a concrete effort when an explicit model switch preserves auto", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendThinkingLevelChange(Effort.Medium, AUTO_THINKING);
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
			await expect(session.switchSession(target, { model: other })).resolves.toBe(true);
			expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
			const entries = session.sessionManager.getBranch().filter(entry => entry.type === "thinking_level_change");
			const restored = entries.at(-1);
			expect(restored?.thinkingLevel).toBe(session.thinkingLevel);
			expect(restored?.configured).toBe(AUTO_THINKING);
			expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(session.thinkingLevel);
		} finally {
			await session.dispose();
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

	test("switching sessions uses the default role's effort when only a fallback wrote a thinking level", async () => {
		freshDir();
		const roleSettings = () =>
			Settings.isolated({
				defaultThinkingLevel: Effort.Low,
				modelRoles: { default: `${PRIMARY}:high` },
			});
		const target = await writeTranscript(fallbackOnlyTranscript());
		const openedManager = await SessionManager.open(target, path.join(tempDir, "open-role"));
		const { session: opened } = await createAgentSession(sessionOptions(openedManager, roleSettings()));
		try {
			expect(opened.model?.id).toBe("claude-sonnet-4-5");
			expect(opened.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await opened.dispose();
		}

		const { session } = await createAgentSession(
			sessionOptions(SessionManager.create(tempDir, path.join(tempDir, "active-role")), roleSettings()),
		);
		try {
			session.setThinkingLevel(Effort.Medium);
			await expect(session.switchSession(target)).resolves.toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.sessionManager.buildSessionContext().configuredThinkingLevel).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("switching sessions keeps a saved model thinking suffix ahead of the role and the global default", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(`${PRIMARY}:low`);
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		const target = await writeTranscript(sessionManager);
		const suffixSettings = () =>
			Settings.isolated({
				defaultThinkingLevel: Effort.Medium,
				modelRoles: { default: `${PRIMARY}:high` },
			});
		const openedManager = await SessionManager.open(target, path.join(tempDir, "open-suffix"));
		const { session: opened } = await createAgentSession(sessionOptions(openedManager, suffixSettings()));
		try {
			expect(opened.model?.id).toBe("claude-sonnet-4-5");
			expect(opened.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await opened.dispose();
		}

		const { session } = await createAgentSession(
			sessionOptions(SessionManager.create(tempDir, path.join(tempDir, "active-suffix")), suffixSettings()),
		);
		try {
			await expect(session.switchSession(target)).resolves.toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("keeps an explicit pick on a fallback when a later hop follows a saved level", async () => {
		freshDir();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(PRIMARY);
		sessionManager.appendThinkingLevelChange(Effort.Low, Effort.Low);
		sessionManager.appendModelChange("openai-codex/gpt-5.6-sol", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.High, Effort.High, { retryFallback: true });
		// High is already in effect, but the receipt marks it as a saved choice.
		sessionManager.appendThinkingLevelChange(Effort.High, Effort.High, { retryFallback: false });
		sessionManager.appendModelChange("openai/gpt-4o-mini", EPHEMERAL_MODEL_CHANGE_ROLE, true);
		sessionManager.appendThinkingLevelChange(Effort.XHigh, Effort.XHigh, { retryFallback: true });
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		const context = sessionManager.buildSessionContext();
		expect(context.thinkingLevel).toBe(Effort.High);
		expect(context.configuredThinkingLevel).toBe(Effort.High);

		const { session } = await createAgentSession(sessionOptions(sessionManager));
		try {
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
		} finally {
			await session.dispose();
		}
	});

	test("switching sessions uses the allowed default model's effort when an earlier role model is turned off", async () => {
		freshDir();
		const allowedModel = "anthropic/claude-sonnet-4-6";
		const roleSettings = () =>
			Settings.isolated({
				defaultThinkingLevel: Effort.Medium,
				modelRoles: { default: `${PRIMARY}:high,${allowedModel}:low` },
				enabledModels: [allowedModel],
			});
		const target = await writeTranscript(fallbackOnlyTranscript());
		const openedManager = await SessionManager.open(target, path.join(tempDir, "open-allowed-role"));
		const { session: opened } = await createAgentSession(sessionOptions(openedManager, roleSettings()));
		try {
			expect(opened.model?.id).toBe("claude-sonnet-4-5");
			expect(opened.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await opened.dispose();
		}

		const { session } = await createAgentSession(
			sessionOptions(SessionManager.create(tempDir, path.join(tempDir, "active-allowed-role")), roleSettings()),
		);
		try {
			session.setThinkingLevel(Effort.Medium);
			await expect(session.switchSession(target)).resolves.toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});
});
