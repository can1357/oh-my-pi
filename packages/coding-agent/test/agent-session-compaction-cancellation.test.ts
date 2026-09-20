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
import {
	ContextNotesTool,
	GrepTool,
	NewContextTool,
	ReadTool,
	type Tool,
	type ToolSession,
} from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type HookMode = "extension-veto" | "park";

describe.each([false, true])("AgentSession compaction cancellation source (experimental=%s)", experimental => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-cancellation-");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Network access is forbidden in compaction cancellation tests"),
		);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
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
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.experimentalContextManagement": experimental,
		});
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			sessionManager,
			getSessionId: () => sessionManager.getSessionId(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const tools: Tool[] = experimental
			? [
					new ReadTool(toolSession),
					new GrepTool(toolSession),
					new ContextNotesTool(toolSession),
					new NewContextTool(toolSession),
				]
			: [];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
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
			settings,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: tools.map(tool => tool.name),
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

	it("resumes the interrupted turn when compaction rejects after the entry is appended", async () => {
		// The entry lands, then post-append bookkeeping in #commitCompactionEntry
		// throws. The compaction is committed from the transcript's point of view,
		// so the turn the abort cut must still resume; otherwise a manual /compact
		// mid-turn leaves the agent idle exactly as before the fix.
		session = await createSession("park");
		session.settings.override("compaction.autoContinue", true);
		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		vi.spyOn(session.agent, "replaceMessages").mockImplementationOnce(() => {
			throw new Error("post-append bookkeeping failed");
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		await expect(session.compact()).rejects.toThrow("post-append bookkeeping failed");
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		await session.waitForIdle();

		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});

	it("aborts the live turn with preserveCompaction when manual compaction interrupts it", async () => {
		// Manual /compact during a live turn must abort that turn before
		// rewriting history (only this call site passes preserveCompaction), and
		// the interrupted turn must still resume afterwards. Abort itself is
		// mocked per this file's idiom — a faked streaming flag with no live
		// loop would hang the real abort's idle wait.
		session = await createSession("park");
		session.settings.override("compaction.autoContinue", true);
		session.agent.state.isStreaming = true;
		const abortSpy = vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		await session.compact();
		expect(abortSpy).toHaveBeenCalledWith({ goalReason: "internal", preserveCompaction: true });
		// The abort drops the live turn; without it the faked streaming flag
		// would hang the idle wait below, so clear it once the abort is proven.
		session.agent.state.isStreaming = false;
		await session.waitForIdle();

		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});
	if (experimental) {
		for (const mutation of ["branch", "disable"] as const) {
			it(`rejects a rollover when ${mutation} changes during an awaited hook`, async () => {
				const started = Promise.withResolvers<void>();
				const gate = Promise.withResolvers<void>();
				session = await createSession("park", started.resolve, gate.promise);
				const cancellation = cancellationFrom(session.compact());
				await started.promise;
				if (mutation === "branch") {
					const first = session.sessionManager.getBranch()[0];
					if (!first) throw new Error("Expected seeded history");
					session.sessionManager.branch(first.id);
				} else {
					session.settings.override("compaction.experimentalContextManagement", false);
				}
				gate.resolve();
				await cancellation;
				expect(session.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
			});
		}

		it("retains saved notes when disabling the experiment before legacy compaction", async () => {
			session = await createSession("park");
			session.sessionManager.appendCustomEntry("experimental_context_notes", {
				version: 1,
				text: "Preserve the rollback decision.",
			});
			session.settings.override("compaction.experimentalContextManagement", false);
			const result = await session.compact();
			expect(result.summary).toBe("compacted");
			expect(JSON.stringify(session.agent.state.messages)).toContain("Preserve the rollback decision.");
		});
	}
});
