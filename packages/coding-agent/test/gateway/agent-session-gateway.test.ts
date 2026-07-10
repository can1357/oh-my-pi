import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import {
	type AgentSessionGatewayHost,
	createAgentSessionGateway,
	type GatewayEvent,
	parseGatewayCommand,
} from "../../src/gateway/index";

type FakeCalls = {
	prompt: Array<{ text: string; options?: unknown }>;
	steer: Array<{ text: string; images?: unknown }>;
	followUp: Array<{ text: string; images?: unknown }>;
	abort: Array<{ reason?: string } | undefined>;
	newSession: Array<{ parentSession?: string } | undefined>;
	setModel: number;
	setThinkingLevel: number;
	setPermissions: number;
};

function createFakeSession(overrides?: { promptResult?: boolean; newSessionResult?: boolean; promptError?: Error }): {
	host: AgentSessionGatewayHost;
	calls: FakeCalls;
	emit: (event: AgentSessionEvent) => void;
	unsubscribeCount: () => number;
} {
	const listeners: AgentSessionEventListener[] = [];
	let unsubscribed = 0;
	const calls: FakeCalls = {
		prompt: [],
		steer: [],
		followUp: [],
		abort: [],
		newSession: [],
		setModel: 0,
		setThinkingLevel: 0,
		setPermissions: 0,
	};

	const host: AgentSessionGatewayHost = {
		isStreaming: false,
		sessionFile: "/tmp/session.jsonl",
		sessionId: "sess-1",
		model: {
			id: "test-model",
			name: "Test Model",
			provider: "openai",
		},
		thinkingLevel: ThinkingLevel.Medium,
		sessionManager: {
			getCwd: () => "/workspace",
		},
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.push(listener);
			return () => {
				unsubscribed += 1;
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text, options) => {
			calls.prompt.push({ text, options });
			if (overrides?.promptError) throw overrides.promptError;
			return overrides?.promptResult ?? true;
		},
		steer: async (text, images) => {
			calls.steer.push({ text, images });
		},
		followUp: async (text, images) => {
			calls.followUp.push({ text, images });
		},
		abort: async options => {
			calls.abort.push(options);
		},
		newSession: async options => {
			calls.newSession.push(options);
			return overrides?.newSessionResult ?? true;
		},
	};

	// Ensure privilege-widening methods are not part of the host contract used by tests.
	Object.defineProperty(host, "setModel", {
		value: async () => {
			calls.setModel += 1;
		},
	});
	Object.defineProperty(host, "setThinkingLevel", {
		value: () => {
			calls.setThinkingLevel += 1;
		},
	});
	Object.defineProperty(host, "setPermissions", {
		value: () => {
			calls.setPermissions += 1;
		},
	});

	return {
		host,
		calls,
		emit: event => {
			for (const listener of [...listeners]) listener(event);
		},
		unsubscribeCount: () => unsubscribed,
	};
}

const identity = { channelId: "slack:ops", sessionKey: "thread-1" };

describe("parseGatewayCommand", () => {
	test("accepts a valid prompt command", () => {
		const parsed = parseGatewayCommand({
			id: "req-1",
			type: "prompt",
			identity,
			message: "hello",
			streamingBehavior: "steer",
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.command).toEqual({
			id: "req-1",
			type: "prompt",
			identity,
			message: "hello",
			streamingBehavior: "steer",
		});
	});

	test("rejects unknown command types without casting", () => {
		const parsed = parseGatewayCommand({
			id: "req-bad",
			type: "set_model",
			identity,
			provider: "openai",
			modelId: "gpt",
		});
		expect(parsed).toEqual({
			ok: false,
			error: "unknown command type: set_model",
		});
	});

	test("rejects missing identity metadata", () => {
		const parsed = parseGatewayCommand({
			id: "req-2",
			type: "abort",
		});
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("identity");
	});
});

describe("AgentSessionGateway", () => {
	test("emits ready, dispatches commands, and correlates responses", async () => {
		const fake = createFakeSession({ promptResult: true });
		const gateway = createAgentSessionGateway(fake.host);
		const events: GatewayEvent[] = [];
		gateway.subscribe(event => events.push(event));

		expect(events[0]).toEqual({ type: "ready" });

		await gateway.dispatch({
			id: "p1",
			type: "prompt",
			identity,
			message: "run tests",
		});
		await gateway.dispatch({
			id: "s1",
			type: "steer",
			identity,
			message: "focus on gateway",
		});
		await gateway.dispatch({
			id: "f1",
			type: "follow_up",
			identity,
			message: "then summarize",
		});
		await gateway.dispatch({ id: "a1", type: "abort", identity });
		await gateway.dispatch({
			id: "ap1",
			type: "abort_and_prompt",
			identity,
			message: "restart",
		});
		await gateway.dispatch({ id: "st1", type: "get_state", identity });
		await gateway.dispatch({
			id: "ns1",
			type: "new_session",
			identity,
			parentSession: "/tmp/parent.jsonl",
		});

		expect(fake.calls.prompt.map(call => call.text)).toEqual(["run tests", "restart"]);
		expect(fake.calls.steer).toEqual([{ text: "focus on gateway", images: undefined }]);
		expect(fake.calls.followUp).toEqual([{ text: "then summarize", images: undefined }]);
		expect(fake.calls.abort).toEqual([{ reason: USER_INTERRUPT_LABEL }, { reason: USER_INTERRUPT_LABEL }]);
		expect(fake.calls.newSession).toEqual([{ parentSession: "/tmp/parent.jsonl" }]);

		const responses = events.filter(event => event.type === "response");
		expect(responses).toEqual([
			{
				type: "response",
				id: "p1",
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			},
			{ type: "response", id: "s1", command: "steer", success: true },
			{ type: "response", id: "f1", command: "follow_up", success: true },
			{ type: "response", id: "a1", command: "abort", success: true },
			{
				type: "response",
				id: "ap1",
				command: "abort_and_prompt",
				success: true,
				data: { agentInvoked: true },
			},
			{
				type: "response",
				id: "st1",
				command: "get_state",
				success: true,
				data: {
					sessionFile: "/tmp/session.jsonl",
					sessionId: "sess-1",
					isStreaming: false,
					thinkingLevel: ThinkingLevel.Medium,
					cwd: "/workspace",
					model: { provider: "openai", id: "test-model", name: "Test Model" },
				},
			},
			{
				type: "response",
				id: "ns1",
				command: "new_session",
				success: true,
				data: { cancelled: false },
			},
		]);

		const stateEvent = responses.find(event => event.type === "response" && event.command === "get_state");
		expect(
			stateEvent?.type === "response" && stateEvent.success ? Object.keys(stateEvent.data as object).sort() : [],
		).toEqual(["cwd", "isStreaming", "model", "sessionFile", "sessionId", "thinkingLevel"]);
	});

	test("fans out session events to gateway listeners", async () => {
		const fake = createFakeSession();
		const gateway = createAgentSessionGateway(fake.host);
		const eventsA: GatewayEvent[] = [];
		const eventsB: GatewayEvent[] = [];
		gateway.subscribe(event => eventsA.push(event));
		gateway.subscribe(event => eventsB.push(event));

		fake.emit({ type: "notice", level: "info", message: "hello" });

		expect(eventsA.some(event => event.type === "session_event")).toBe(true);
		expect(eventsB.some(event => event.type === "session_event")).toBe(true);
		const sessionEvents = eventsA.filter(event => event.type === "session_event");
		expect(sessionEvents).toEqual([
			{ type: "session_event", event: { type: "notice", level: "info", message: "hello" } },
		]);
	});

	test("correlates command errors from the session", async () => {
		const fake = createFakeSession({ promptError: new Error("boom") });
		const gateway = createAgentSessionGateway(fake.host);
		const events: GatewayEvent[] = [];
		gateway.subscribe(event => events.push(event));

		await gateway.dispatch({
			id: "err-1",
			type: "prompt",
			identity,
			message: "fail",
		});

		expect(events.filter(event => event.type === "response" && !event.success)).toEqual([
			{ type: "response", id: "err-1", command: "prompt", success: false, error: "boom" },
		]);
	});

	test("rejects invalid runtime commands without mutating the session", async () => {
		const fake = createFakeSession();
		const gateway = createAgentSessionGateway(fake.host);
		const events: GatewayEvent[] = [];
		gateway.subscribe(event => events.push(event));

		await gateway.handle({
			id: "bad-1",
			type: "set_permissions",
			identity,
			mode: "full",
		});

		expect(fake.calls.prompt).toEqual([]);
		expect(fake.calls.abort).toEqual([]);
		expect(fake.calls.setModel).toBe(0);
		expect(fake.calls.setThinkingLevel).toBe(0);
		expect(fake.calls.setPermissions).toBe(0);
		expect(events.filter(event => event.type === "protocol_error")).toEqual([
			{ type: "protocol_error", id: "bad-1", error: "unknown command type: set_permissions" },
		]);
	});

	test("dispose unsubscribes from the session and ignores later commands", async () => {
		const fake = createFakeSession();
		const gateway = createAgentSessionGateway(fake.host);
		const events: GatewayEvent[] = [];
		const unsubscribe = gateway.subscribe(event => events.push(event));

		gateway.dispose();
		expect(fake.unsubscribeCount()).toBe(1);

		await gateway.dispatch({
			id: "after-dispose",
			type: "prompt",
			identity,
			message: "should fail",
		});
		fake.emit({ type: "notice", level: "warning", message: "late" });

		expect(fake.calls.prompt).toEqual([]);
		expect(events.filter(event => event.type === "session_event")).toEqual([]);
		expect(events.filter(event => event.type === "response" && !event.success)).toEqual([
			{
				type: "response",
				id: "after-dispose",
				command: "prompt",
				success: false,
				error: "gateway disposed",
			},
		]);

		unsubscribe();
	});

	test("does not call permission or config mutators for valid commands", async () => {
		const fake = createFakeSession();
		const gateway = createAgentSessionGateway(fake.host);
		gateway.subscribe(() => {});

		await gateway.handle({
			id: "safe-1",
			type: "get_state",
			identity,
		});
		await gateway.handle({
			id: "safe-2",
			type: "prompt",
			identity,
			message: "ok",
		});

		expect(fake.calls.setModel).toBe(0);
		expect(fake.calls.setThinkingLevel).toBe(0);
		expect(fake.calls.setPermissions).toBe(0);
	});
	test("rejects commands from a different bound identity", async () => {
		const fake = createFakeSession();
		const gateway = createAgentSessionGateway(fake.host, { identity });
		const events: GatewayEvent[] = [];
		gateway.subscribe(event => events.push(event));
		await gateway.handle({
			id: "wrong-thread",
			type: "prompt",
			identity: { channelId: "slack:other", sessionKey: "thread-2" },
			message: "intrude",
		});
		expect(fake.calls.prompt).toHaveLength(0);
		expect(events).toContainEqual({
			type: "response",
			id: "wrong-thread",
			command: "prompt",
			success: false,
			error: "gateway identity mismatch",
		});
	});

	test("projects transport-safe events and isolates throwing listeners", () => {
		const fake = createFakeSession();
		const listenerErrors: unknown[] = [];
		const gateway = createAgentSessionGateway(fake.host, {
			identity,
			onListenerError: error => listenerErrors.push(error),
		});
		gateway.subscribe(event => {
			if (event.type === "session_event") throw new Error("listener failed");
		});
		const received: GatewayEvent[] = [];
		gateway.subscribe(event => received.push(event));
		fake.emit({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "secret command" },
		});
		expect(listenerErrors).toHaveLength(1);
		expect(received).toContainEqual({
			type: "session_event",
			event: { type: "tool_start", toolCallId: "tool-1", toolName: "bash" },
		});
		expect(JSON.stringify(received)).not.toContain("secret command");
	});

	test("rejects oversized messages and image batches", () => {
		expect(
			parseGatewayCommand({
				id: "large",
				type: "prompt",
				identity,
				message: "x".repeat(200_001),
			}).ok,
		).toBe(false);
		expect(
			parseGatewayCommand({
				id: "images",
				type: "prompt",
				identity,
				message: "ok",
				images: Array.from({ length: 9 }, () => ({ type: "image", data: "a", mimeType: "image/png" })),
			}).ok,
		).toBe(false);
	});
});
