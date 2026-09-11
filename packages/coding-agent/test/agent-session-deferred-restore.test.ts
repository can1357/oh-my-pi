/**
 * Regression (Codex P2): `flushDeferredModelRestore` (the ACP `agent_end`
 * channel for a mid-turn persona exit) must keep the restore QUEUED when the
 * model application fails. Pre-fix it cleared the slot before awaiting
 * `setModelTemporary`, and the ACP caller only logs the rejection — a persona
 * already cleared then stayed stranded on its persona model with no later turn
 * ever retrying the restore.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession deferred model restore", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let activeModel: Model<Api>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-deferred-restore-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");
		activeModel = defaultModel;
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: defaultModel, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		HistoryStorage.close();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the restore queued when the model application fails, and retries at the next flush", async () => {
		// A model the registry has no credentials for: setModelTemporary rejects
		// (the real "extension/hook/provider failed" path, not a mock).
		const unauthenticated = buildModel({
			id: "ghost",
			name: "Ghost",
			api: "anthropic-messages",
			provider: "no-such-provider",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		}) as Model<Api>;

		session.queueDeferredModelRestore(activeModel);
		// First flush: the queued model applies fine and the slot empties.
		expect(await session.flushDeferredModelRestore()).toBe(true);
		expect(session.getDeferredModelRestore()).toBeUndefined();

		// Second flush with an unapplicable model: the flush reports failure but
		// the restore stays owed for the next turn boundary.
		session.queueDeferredModelRestore(unauthenticated);
		await expect(session.flushDeferredModelRestore()).rejects.toThrow(/No API key/);
		expect(session.getDeferredModelRestore()?.model).toBe(unauthenticated);

		// The ACP caller catches+logs at agent_end; a later flush still owes it.
		session.queueDeferredModelRestore(activeModel);
		expect(await session.flushDeferredModelRestore()).toBe(true);
		expect(session.getDeferredModelRestore()).toBeUndefined();
		expect(session.model?.id).toBe(activeModel.id);
	});

	it("discards a owed deferred restore when the session switch commits", async () => {
		// Review P2-1 (headless parity with the TUI discard): a retained failed
		// restore is SOURCE-session state. switchSession to another journal must
		// drop it — otherwise the target's first agent_end flushes the source's
		// owed model over the target's restored state, and a later first persona
		// enter ADOPTS it as its exit baseline.
		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await otherManager.ensureOnDisk();
		await otherManager.flush();
		const otherFile = otherManager.getSessionFile();
		if (!otherFile) throw new Error("Expected session file");
		await otherManager.close();

		session.queueDeferredModelRestore(activeModel);
		const switched = await session.switchSession(otherFile);
		expect(switched).toBe(true);
		expect(session.getDeferredModelRestore()).toBeUndefined();
	});
});
