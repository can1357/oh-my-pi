import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession idle custom message render", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-idle-custom-render-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(): { session: AgentSession; streamCalls: () => number } {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		let streamCallCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				streamCallCount++;
				return new AssistantMessageEventStream();
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});
		return { session: created, streamCalls: () => streamCallCount };
	}

	it("idle display:true no-trigger append paints exactly once without a turn", async () => {
		const created = createSession();
		session = created.session;

		const events: { type: string; customType?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "message_start" || event.type === "message_end") {
				events.push({
					type: event.type,
					customType: event.message.role === "custom" ? event.message.customType : undefined,
				});
			} else {
				events.push({ type: event.type });
			}
		});

		expect(session.isStreaming).toBe(false);
		const dispatched = await session.sendCustomMessage(
			{ customType: "idle-status", content: "IDLE_DISPLAY_BODY", display: true, attribution: "agent" },
			{ triggerTurn: false },
		);

		// No turn started.
		expect(dispatched).toBe(false);
		expect(session.isStreaming).toBe(false);
		expect(created.streamCalls()).toBe(0);
		expect(events.some(e => e.type === "agent_start" || e.type === "agent_end")).toBe(false);

		// Painted exactly once via a message_start/message_end pair (fails pre-fix: no events).
		const starts = events.filter(e => e.type === "message_start" && e.customType === "idle-status");
		const ends = events.filter(e => e.type === "message_end" && e.customType === "idle-status");
		expect(starts.length).toBe(1);
		expect(ends.length).toBe(1);

		// Present exactly once in agent state.
		const inState = session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "idle-status");
		expect(inState.length).toBe(1);

		// Persisted exactly once by the time the promise resolves.
		const persisted = session.sessionManager
			.getEntries()
			.filter(e => e.type === "custom_message" && e.customType === "idle-status");
		expect(persisted.length).toBe(1);

		// Rebuild-from-entries yields one copy — no duplicate after a reload/re-enter.
		const rebuilt = session
			.buildDisplaySessionContext()
			.messages.filter(m => m.role === "custom" && m.customType === "idle-status");
		expect(rebuilt.length).toBe(1);
	});

	it("idle display:false no-trigger append stays silent", async () => {
		const created = createSession();
		session = created.session;

		const events: { type: string; customType?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "message_start" || event.type === "message_end") {
				events.push({
					type: event.type,
					customType: event.message.role === "custom" ? event.message.customType : undefined,
				});
			}
		});

		const dispatched = await session.sendCustomMessage(
			{ customType: "idle-hidden", content: "IDLE_HIDDEN_BODY", display: false, attribution: "agent" },
			{ triggerTurn: false },
		);

		expect(dispatched).toBe(false);
		expect(created.streamCalls()).toBe(0);
		expect(events.filter(e => e.customType === "idle-hidden").length).toBe(0);

		const inState = session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "idle-hidden");
		expect(inState.length).toBe(1);

		const persisted = session.sessionManager
			.getEntries()
			.filter(e => e.type === "custom_message" && e.customType === "idle-hidden");
		expect(persisted.length).toBe(1);
	});
});
