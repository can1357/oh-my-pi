import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, CompactionCancelledError } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type HookMode = "extension-veto" | "park";

describe("AgentSession compaction cancellation source", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-cancellation-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	async function createSession(mode: HookMode, entered?: () => void, gate?: Promise<void>): Promise<AgentSession> {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => {
					if (mode === "extension-veto") return { cancel: true };
					entered?.();
					await gate;
					return {
						compaction: {
							summary: "compacted",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"compaction-cancellation-source",
		);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		sessionManager.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner,
		});
	}

	async function cancellationFrom(promise: Promise<unknown>): Promise<CompactionCancelledError> {
		try {
			await promise;
		} catch (error) {
			if (error instanceof CompactionCancelledError) return error;
			throw error;
		}
		throw new Error("Expected compaction cancellation");
	}

	it("leaves extension vetoes unmarked as user interrupts", async () => {
		session = await createSession("extension-veto");

		const error = await cancellationFrom(session.compact());
		expect(error.cause).toBeUndefined();
	});

	it("waits for manual compaction cleanup before starting a replacement prompt", async () => {
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		session = await createSession("park", started.resolve, gate.promise);

		const cancellation = cancellationFrom(session.compact());
		await started.promise;
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		const abortAndPrompt = session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => session.prompt("replacement prompt"));

		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();
		expect(session.isCompacting).toBe(true);

		gate.resolve();
		await abortAndPrompt;
		expect(session.isCompacting).toBe(false);
		expect(prompt).toHaveBeenCalledWith("replacement prompt");

		const error = await cancellation;
		expect(error.cause).toBe(USER_INTERRUPT_LABEL);
	});

	it("blocks an ordinary prompt until manual compaction cleanup resolves", async () => {
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		session = await createSession("park", started.resolve, gate.promise);

		// The turn dispatch seam: prompt() must not reach it while compaction holds
		// the agent subscription disconnected.
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

		const compaction = session.compact();
		await started.promise;

		let promptSettled = false;
		const promptPromise = session.prompt("normal prompt").then(result => {
			promptSettled = true;
			return result;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(session.isCompacting).toBe(true);
		expect(agentPrompt).not.toHaveBeenCalled();
		expect(promptSettled).toBe(false);

		gate.resolve();
		await compaction;
		await promptPromise;
		expect(agentPrompt).toHaveBeenCalledTimes(1);
	});
});
