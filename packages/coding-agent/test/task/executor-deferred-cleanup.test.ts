/**
 * Deferred-cleanup outcome contract (issue #9670).
 *
 * When a subagent's teardown (advisor catch-up, session disposal, owner-job
 * reaping) drains past the shared cleanup deadline, `runSubprocess` hands the
 * remaining work off asynchronously. That hand-off MUST NOT rewrite the run's
 * terminal outcome: a successful `yield` stays a success, and a genuinely
 * aborted run stays aborted. Previously the deferral unconditionally forced
 * `aborted`/exitCode 1, so a valid `agent()` result was discarded as
 * `RuntimeError: cleanup exceeded N ms`.
 *
 * The deferred-cleanup path is exercised deterministically with a blocking
 * teardown and a zero grace, so no wall-clock timers are needed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function assistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Minimal mock session whose teardown (`abort`/`dispose`) can be blocked to
 * force the deferred-cleanup path, and whose first prompt runs `onPrompt` to
 * either yield or trigger a caller-signal abort.
 */
function mockSession(opts: {
	onPrompt: (emit: (event: AgentSessionEvent) => void) => void;
	abort?: () => Promise<void>;
	dispose?: () => Promise<void>;
}): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const l of [...listeners]) l(event);
	};
	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (l: (event: AgentSessionEvent) => void) => {
			listeners.push(l);
			return () => {
				const i = listeners.indexOf(l);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		prompt: async () => {
			const msg = assistantStop("done");
			state.messages.push(msg);
			emit({ type: "message_end", message: msg } as AgentSessionEvent);
			opts.onPrompt(emit);
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: opts.abort ?? (async () => {}),
		dispose: opts.dispose ?? (async () => {}),
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
}

function emitYield(emit: (event: AgentSessionEvent) => void, data: unknown): void {
	emit({
		type: "tool_execution_end",
		toolCallId: "yield-1",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data },
		},
	} as AgentSessionEvent);
}

describe("runSubprocess deferred cleanup outcome (issue #9670)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves a successful yield when disposal is deferred past the cleanup deadline", async () => {
		const disposeGate = Promise.withResolvers<void>();
		const session = mockSession({
			onPrompt: emit => emitYield(emit, { ok: true }),
			// Disposal never settles within the (zero) grace window.
			dispose: () => disposeGate.promise,
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		let deferredCleanup: Promise<void> | undefined;
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "issue-9670-success",
			keepAlive: false,
			cleanupGraceMs: 0,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
			},
		});

		// The deferred teardown must not overwrite the successful yield.
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
		expect(result.error).toBeUndefined();
		expect(result.output).toContain('"ok": true');
		// The teardown was still handed off, not dropped.
		expect(deferredCleanup).toBeDefined();
		disposeGate.resolve();
		await deferredCleanup;
	});

	it("keeps a genuinely aborted run aborted when its cleanup is deferred", async () => {
		const controller = new AbortController();
		const abortGate = Promise.withResolvers<void>();
		const session = mockSession({
			// The caller cancels mid-run before any yield: a genuine abort.
			onPrompt: () => controller.abort(),
			// The session's abort cleanup never settles within the grace window.
			abort: () => abortGate.promise,
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		let deferredCleanup: Promise<void> | undefined;
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "issue-9670-aborted",
			keepAlive: false,
			signal: controller.signal,
			cleanupGraceMs: 0,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
			},
		});

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toBe("cleanup exceeded 0 ms");
		expect(deferredCleanup).toBeDefined();
		abortGate.resolve();
		await deferredCleanup;
	});
});
