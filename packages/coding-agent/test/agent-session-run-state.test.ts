import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-run-state-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({
			provider: "anthropic",
			responses: [
				// Abort lands during the first call's latency; the second keeps the
				// recovery run streaming while the aborted run's maintenance settles.
				{ content: ["editing"], delayMs: 1_000 },
				{ content: ["recovered"], delayMs: 100 },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "edit.streamingAbort": true }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	it("reports the streaming-edit recovery run as running, not idle", async () => {
		const reports: { state: string; streaming: boolean }[] = [];
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

			expect(reports.filter(report => report.state === "running")).toHaveLength(2);
			expect(reports.filter(report => report.state === "idle" && report.streaming)).toEqual([]);
			expect(reports.at(-1)).toEqual({ state: "idle", streaming: false });
		} finally {
			unsubscribeAgent();
			unsubscribe();
		}
	});
});
