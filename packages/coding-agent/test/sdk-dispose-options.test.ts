import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("SDK session disposal options", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-sdk-dispose-options-");
		authStorage = createInMemoryAuthStorage();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		authStorage.close();
		AsyncJobManager.resetForTests();
		tempDir.removeSync();
	});

	async function createSession(): Promise<AgentSession> {
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			agentRegistry: new AgentRegistry(),
		});
		session = result.session;
		return result.session;
	}

	// Exercise the real platform deadlines alongside SDK teardown and SQLite I/O;
	// fake timers cannot drive Mnemopi's native Bun.sleep deadline.
	it("returns at the caller's drain deadline even while the agent is still settling", async () => {
		const current = await createSession();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(current.agent, "waitForIdle").mockImplementation(async () => {
			reached.resolve();
			await release.promise;
		});

		const disposing = current.dispose({ drainTimeoutMs: 20 });
		try {
			expect(current.isDisposed).toBe(true);
			await reached.promise;
			expect(await Promise.race([disposing.then(() => "disposed"), Bun.sleep(250).then(() => "pending")])).toBe(
				"disposed",
			);
		} finally {
			release.resolve();
			await disposing;
		}
	});

	it("persists the caller's shutdown reason once across repeated disposal", async () => {
		const current = await createSession();
		current.sessionManager.appendMessage(createAssistantMessage("finished response"));
		await current.sessionManager.ensureOnDisk();
		const sessionFile = current.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted session file");

		await current.dispose({ reason: postmortem.Reason.SIGTERM });
		await current.dispose({ reason: postmortem.Reason.MANUAL });

		const entries: unknown[] = (await Bun.file(sessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const exits = entries.filter(
			(entry): entry is { type: string; customType: string; data: unknown } =>
				typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "session_exit",
		);
		expect(exits).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ reason: postmortem.Reason.SIGTERM, kind: "signal" }),
			}),
		]);
	});

	it("returns at the caller's memory budget while consolidation is still running", async () => {
		const current = await createSession();
		await Promise.all([loadMnemopi(), loadMnemopiCore()]);
		const memorySettings = Settings.isolated({
			"mnemopi.dbPath": tempDir.join("memory.db"),
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRetain": false,
		});
		const state = new MnemopiSessionState({
			sessionId: current.sessionId,
			session: current,
			config: loadMnemopiConfig(memorySettings, tempDir.path()),
		});
		const closed = Promise.withResolvers<void>();
		const close = state.memory.close.bind(state.memory);
		vi.spyOn(state.memory, "close").mockImplementation(() => {
			close();
			closed.resolve();
		});
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(state, "consolidate").mockImplementation(async () => {
			reached.resolve();
			await release.promise;
		});
		setMnemopiSessionState(current, state);

		const disposing = current.dispose({ mnemopiConsolidateTimeoutMs: 20 });
		try {
			await reached.promise;
			expect(await Promise.race([disposing.then(() => "disposed"), Bun.sleep(250).then(() => "pending")])).toBe(
				"disposed",
			);
		} finally {
			release.resolve();
			await disposing;
			await closed.promise;
		}
	});
});
