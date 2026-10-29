import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

describe("AgentSession settles what it promised", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-settle-promises-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("completes a session transition whose own hook sends an aside while an idle compaction is in flight", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["ack"] }] });
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const hookEntered = Promise.withResolvers<void>();
		const sendSettled = Promise.withResolvers<void>();
		let sendFinished = false;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_switch", async () => {
					hookEntered.resolve();
					await session?.sendCustomMessage(
						{ customType: "ext-aside", content: "HOOK_ASIDE_BODY", display: false, attribution: "agent" },
						{ deliverAs: "aside" },
					);
					sendFinished = true;
					sendSettled.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"aside-from-transition-hook",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});

		const compactionStarted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
			compactionStarted.resolve();
			await releaseCompaction.promise;
			return { continuationScheduled: false };
		});
		try {
			const idleCompaction = session.runIdleCompaction();
			await compactionStarted.promise;

			const transition = session.newSession();
			await hookEntered.promise;
			// The send must be parked on the idle compaction before it is released: otherwise this
			// test would never reach the transition wait it is here to exercise.
			await setImmediate();
			await setImmediate();
			expect(sendFinished).toBe(false);
			releaseCompaction.resolve();

			// A deadlocked transition is only observable as "still running": the watchdog is the
			// assertion, since the extension handler timeout would otherwise free it 30 seconds later.
			await withTimeout(transition, 5_000, "session transition never finished");
			await idleCompaction;
			await sendSettled.promise;
			await session.waitForIdle();
			expect(JSON.stringify(session.agent.state.messages)).toContain("HOOK_ASIDE_BODY");
		} finally {
			releaseCompaction.resolve();
			compactionSpy.mockRestore();
		}
	}, 45_000);

	/** A pooled yield contract parks a stranded aside instead of waking a turn for it
	 *  (#resumeStrandedIrcAsides), so the record is still queued — and still holding its
	 *  run's `agent_end` open — when the next prompt reaches IrcBridge.flushPending(). */
	async function startPooledRunWithStrandedAside(): Promise<{
		settles: Array<boolean | undefined>;
		modelRegistry: ModelRegistry;
		mock: MockModel;
	}> {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [{ content: ["First."] }, { content: ["Second."] }],
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let asideSent = false;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				// session_stop runs after the loop's last aside poll, so the record it sends
				// strands in IrcBridge instead of riding the turn that is settling.
				pi.on("session_stop", async () => {
					if (asideSent) return;
					asideSent = true;
					await session?.sendCustomMessage(
						{ customType: "ext-aside", content: "STRANDED_TRIGGER_ASIDE", display: false, attribution: "agent" },
						{ deliverAs: "aside", triggerTurn: true },
					);
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"stranded-aside-sender",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});
		const settles: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") settles.push(event.isTerminal);
		});
		await session.setWorkPoolYieldItems([{ id: "item-a", index: 0 }]);

		await session.prompt("go");
		await session.waitForIdle();

		// The run promised a continuation for the aside it could not deliver.
		expect(settles.at(-1)).toBe(false);
		expect(JSON.stringify(session.agent.state.messages)).not.toContain("STRANDED_TRIGGER_ASIDE");
		return { settles, modelRegistry, mock };
	}

	/** Clearing the contract releases whatever is still queued: the aside the bailing prompt
	 *  must not have consumed runs its turn, which settles the end its run left open. */
	async function expectStrandedAsideStillRuns(settles: Array<boolean | undefined>, mock: MockModel): Promise<void> {
		await session?.setWorkPoolYieldItems([]);
		await session?.waitForIdle();

		expect(JSON.stringify(session?.agent.state.messages)).toContain("STRANDED_TRIGGER_ASIDE");
		expect(mock.calls.length).toBe(2);
		expect(settles.at(-1)).toBe(true);
	}

	it("keeps a stranded aside for its turn when the next prompt bails with no model", async () => {
		const { settles, mock } = await startPooledRunWithStrandedAside();
		// A session may hold no model (initialState.model is optional); the prompt bails on it.
		session?.agent.setModel(undefined as unknown as Model);

		await session?.prompt("second").catch(() => {});
		await session?.waitForIdle();

		session?.agent.setModel(mock.model);
		await expectStrandedAsideStillRuns(settles, mock);
	}, 20_000);

	it("keeps a stranded aside for its turn when the next prompt bails with no API key", async () => {
		const { settles, modelRegistry, mock } = await startPooledRunWithStrandedAside();
		const keySpy = spyOn(modelRegistry, "getApiKey").mockResolvedValue(undefined);
		try {
			await session?.prompt("second").catch(() => {});
			await session?.waitForIdle();
		} finally {
			keySpy.mockRestore();
		}

		await expectStrandedAsideStillRuns(settles, mock);
	}, 20_000);

	it("keeps a stranded aside for its turn when the next prompt is superseded in setup", async () => {
		const { settles, modelRegistry, mock } = await startPooledRunWithStrandedAside();
		let aborted: Promise<void> | undefined;
		const keySpy = spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			// An abort lands mid-setup, between the prompt's bail points.
			aborted ??= session?.abort({ reason: "internal" });
			await setImmediate();
			return "test-key";
		});
		try {
			await session?.prompt("second").catch(() => {});
			await aborted;
			await session?.waitForIdle();
		} finally {
			keySpy.mockRestore();
		}

		await expectStrandedAsideStillRuns(settles, mock);
	}, 20_000);
});
