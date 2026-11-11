import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Run state drives the agent registry (Agent Hub status, `wait`). A streaming
 * edit abort schedules its recovery run before the aborted run's `agent_end`
 * maintenance settles; that late settle must not report the recovery run idle.
 */
describe("AgentSession run state", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let reports: { state: string; streaming: boolean }[];
	/** Run state when the aborted run's settle reached extensions. */
	let atFirstSettle: { lastReport: string | undefined; streaming: boolean } | undefined;
	let providerCalls: number;
	let gate: PromiseWithResolvers<void>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-run-state-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		reports = [];
		atFirstSettle = undefined;
		providerCalls = 0;
		gate = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "anthropic",
			// The abort lands before the aborted run reaches the provider, so the
			// recovery run makes the only call. Holding it keeps the recovery run
			// streaming until the aborted run has settled.
			handler: async (_context, options) => {
				providerCalls++;
				const aborted = Promise.withResolvers<void>();
				options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				await Promise.race([gate.promise, aborted.promise]);
				return { content: ["recovered"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage);
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", () => {
					if (atFirstSettle) return;
					atFirstSettle = { lastReport: reports.at(-1)?.state, streaming: session.agent.state.isStreaming };
					gate.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"run-state-settle-probe",
		);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "edit.streamingAbort": true }),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
	});

	afterEach(async () => {
		try {
			gate.resolve();
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	it("reports the streaming-edit recovery run as running, not idle", async () => {
		const unsubscribe = session.subscribeRunState(state =>
			reports.push({ state, streaming: session.agent.state.isStreaming }),
		);
		let aborted = false;
		const unsubscribeAgent = session.agent.subscribe(event => {
			if (event.type !== "agent_start" || aborted) return;
			aborted = true;
			// A failed final edit preview aborts the run and schedules a recovery continue.
			session.agent.emitExternalEvent({
				type: "tool_stream_update",
				toolCallId: "call-edit",
				toolName: "edit",
				update: { streaming: false, files: [{ path: "a.ts", error: "anchor mismatch" }] },
			});
		});
		try {
			await session.prompt("Edit the file.");
			await session.waitForIdle();

			expect(providerCalls).toBe(1);
			// The aborted run settled while the recovery run was still streaming.
			expect(atFirstSettle).toEqual({ lastReport: "running", streaming: true });
			expect(reports.filter(report => report.state === "idle" && report.streaming)).toEqual([]);
			expect(reports.at(-1)).toEqual({ state: "idle", streaming: false });
		} finally {
			unsubscribeAgent();
			unsubscribe();
		}
	});
});
