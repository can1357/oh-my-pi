import { afterEach, describe, expect, it, vi } from "bun:test";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess, type ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function createMockSession(abort: () => Promise<void>): {
	session: AgentSession;
	emit: (event: AgentSessionEvent) => void;
} {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			await Bun.sleep(300);
			return true;
		},
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort,
	};
	return { session: session as unknown as AgentSession, emit };
}

function mockCreateAgentSession(session: AgentSession) {
	const result = {
		session,
		extensionsResult: {},
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as unknown as CreateAgentSessionResult;
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(result);
}

describe("terminal runtime late cancellation", () => {
	afterEach(() => vi.restoreAllMocks());

	it("invalidates structured metadata when runtime limit wins after a committed yield", async () => {
		const { session, emit } = createMockSession(async () => {});
		mockCreateAgentSession(session);
		session.prompt = async () => {
			await Bun.sleep(80);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield-timeout",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			} as AgentSessionEvent);
			await Bun.sleep(200);
			return true;
		};
		const options: ExecutorOptions = {
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "timeout-after-yield",
			enableLsp: false,
			maxRuntimeMs: 30,
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { const: true } },
				required: ["ok"],
			},
			outputSchemaSource: "caller",
		};
		const result = await runSubprocess(options);
		// Runtime-limit wins after teardown: no valid structured result may survive. The late
		// yield is not guaranteed to be accepted here, so this asserts the invariant rather than
		// a data payload that the execution path does not produce.
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("does not downgrade a committed yield when parent cancellation arrives during teardown", async () => {
		const abortStarted = Promise.withResolvers<void>();
		const cleanupGate = Promise.withResolvers<void>();
		const { session, emit } = createMockSession(async () => {
			abortStarted.resolve();
			await cleanupGate.promise;
		});
		mockCreateAgentSession(session);
		const accepted = Promise.withResolvers<void>();
		const originalPrompt = session.prompt;
		session.prompt = async (...args) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			} as AgentSessionEvent);
			accepted.resolve();
			return originalPrompt(...args);
		};
		const options: ExecutorOptions = {
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "late-signal-runtime",
			enableLsp: false,
			signal: undefined,
		};
		const controller = new AbortController();
		options.signal = controller.signal;
		let settled = false;
		const run = runSubprocess(options).finally(() => {
			settled = true;
		});
		await accepted.promise;
		await abortStarted.promise;
		expect(settled).toBe(false);
		await Bun.sleep(20);
		controller.abort("late parent cancel");
		expect(settled).toBe(false);
		cleanupGate.resolve();
		const result = await run;
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
	});
});
