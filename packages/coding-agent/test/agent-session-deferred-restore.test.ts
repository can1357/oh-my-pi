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
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
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

	// Review R6-4: the deferred slot is cleared speculatively before the
	// fallible setSessionFile()/cwd steps — a switch that FAILS restores the
	// source session, and its owed retry must survive the rollback (the persona
	// restore it carries is the only path back off the persona model).
	it("keeps the owed deferred restore when the switch rolls back", async () => {
		// A target recorded in ANOTHER cwd with no onCwdChange callback makes
		// setSessionFile throw SESSION_CWD_CHANGE_REJECTED after the clear.
		const otherDir = TempDir.createSync("@pi-deferred-restore-other-");
		try {
			const otherManager = SessionManager.create(otherDir.path(), otherDir.path());
			otherManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
			await otherManager.ensureOnDisk();
			await otherManager.flush();
			const otherFile = otherManager.getSessionFile();
			if (!otherFile) throw new Error("Expected session file");
			await otherManager.close();

			session.queueDeferredModelRestore(activeModel);
			const switched = await session.switchSession(otherFile);
			expect(switched).toBe(false);
			expect(session.getDeferredModelRestore()?.model).toBe(activeModel);
		} finally {
			otherDir.removeSync();
		}
	});

	// A same-session reload is NOT a session boundary: the owed restore belongs
	// to the continuing session and must survive the reload (the clear scopes
	// to switchingToDifferentSession).
	it("keeps the owed deferred restore across a same-session reload", async () => {
		await session.sessionManager.ensureOnDisk();
		await session.sessionManager.flush();
		const ownFile = session.sessionManager.getSessionFile();
		if (!ownFile) throw new Error("Expected session file");
		session.queueDeferredModelRestore(activeModel);
		await session.reload();
		expect(session.getDeferredModelRestore()?.model).toBe(activeModel);
	});

	// Review R6-3: /new past its commit point is a fresh-session boundary — a
	// journal-reinstalled tool ceiling must not survive into the new transcript
	// (the exit's presentation restore is also filtered through granted(), so a
	// stale ceiling would keep narrowing the fresh session's tools). The slot
	// discard (R6-5) is covered by the rollback test's counterpart above.
	it("drops a journal-installed ceiling when a new session commits", async () => {
		const policy = new SessionToolPolicy({
			registry: () => new Set(["read", "write"]),
			isDefaultActive: () => true,
		});
		policy.installJournalCeiling(["read"]);
		expect(policy.journalCeiling).not.toBeNull();
		// Drive the real discard through a session that owns this policy.
		const withPolicy = new AgentSession({
			agent: new Agent({
				initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			toolPolicy: policy,
		});
		try {
			expect(await withPolicy.newSession()).toBe(true);
			expect(policy.journalCeiling).toBeNull();
			// A CLI-typed grant stays authoritative across /new (process-scoped).
			const cliPolicy = new SessionToolPolicy({
				toolNames: ["read"],
				registry: () => new Set(["read", "write"]),
				isDefaultActive: () => true,
			});
			cliPolicy.installJournalCeiling(["write"]);
			expect([...cliPolicy.cliGrant!]).toEqual(["read"]);
		} finally {
			await withPolicy.dispose();
		}
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
