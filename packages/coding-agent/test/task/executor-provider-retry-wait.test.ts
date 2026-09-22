/**
 * `provider_retry_wait_*` events surface on subagent progress.
 *
 * The executor maps `auto_retry_start`/`auto_retry_end` to
 * `progress.retryState` so a stalled subagent card explains itself; the
 * provider-internal waits fell through to the `isAgentEvent` branch and were
 * dropped, leaving a subagent parked in a `retry-after` backoff on a plain
 * spinner. These tests drive `runSubprocess` with a scripted session and
 * assert the wait's state appears on progress snapshots (keyed by its
 * correlation id) and clears only on the matching `_end`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

function waitStart(waitId: number): AgentSessionEvent {
	return {
		type: "provider_retry_wait_start",
		waitId,
		role: "main",
		delayMs: 8000,
		model: "claude-sonnet-4-5",
		provider: "anthropic",
		api: "anthropic-messages",
		attempt: 1,
		maxAttempts: 5,
	} as AgentSessionEvent;
}

function waitEnd(waitId: number): AgentSessionEvent {
	return { type: "provider_retry_wait_end", aborted: false, waitId } as AgentSessionEvent;
}

interface MockSessionControls {
	session: AgentSession;
	emitted: Promise<void>;
}

function createScriptedSession(
	script: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
): MockSessionControls {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emittedGate = Promise.withResolvers<void>();
	let aborted = false;
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			await script(emit);
			emittedGate.resolve();
		},
		abort: async () => {
			aborted = true;
		},
		isAborted: () => aborted,
	};
	// AgentSession is a concrete class; the executor consumes only this
	// structural subset. Deliberate documented test-double escape hatch,
	// mirroring test/task/executor-pass-through.test.ts.
	return { session: session as unknown as AgentSession, emitted: emittedGate.promise };
}

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

async function runScripted(
	script: (emit: (event: AgentSessionEvent) => void, states: Array<AgentProgress["providerRetryState"]>) => void,
): Promise<{
	states: Array<AgentProgress["providerRetryState"]>;
	exitCode: number;
}> {
	const states: Array<AgentProgress["providerRetryState"]> = [];
	const { session } = createScriptedSession(async emit => {
		script(emit, states);
		emit({
			type: "tool_execution_start",
			toolCallId: "final-yield",
			toolName: "yield",
			args: {},
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "final-yield",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		} as AgentSessionEvent);
	});

	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

	const result = await runSubprocess({
		cwd: "/tmp",
		agent,
		task: "provider retry wait scenario",
		description: "provider-retry-wait",
		index: 0,
		id: `provider-retry-wait-${Math.random().toString(36).slice(2)}`,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as ModelRegistry,
		enableLsp: false,
		signal: new AbortController().signal,
		eventBus: new EventBus(),
		onProgress: (progress: AgentProgress) => {
			states.push(progress.providerRetryState);
		},
	});

	return { states, exitCode: result.exitCode };
}

/** Consecutive-duplicate-free wait ids of the defined states, in order. */
function definedWaitIds(states: Array<AgentProgress["providerRetryState"]>): number[] {
	const ids: number[] = [];
	for (const state of states) {
		if (state === undefined) continue;
		if (ids.at(-1) !== state.waitId) ids.push(state.waitId);
	}
	return ids;
}

describe("executor provider retry wait progress", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sets providerRetryState on start and clears it on the matching end", async () => {
		const { states, exitCode } = await runScripted(emit => {
			emit(waitStart(1));
			emit(waitEnd(1));
		});
		expect(exitCode).toBe(0);

		const defined = states.filter(state => state !== undefined);
		expect(defined.length).toBeGreaterThan(0);
		for (const state of defined) {
			expect(state).toMatchObject({
				waitId: 1,
				delayMs: 8000,
				model: "claude-sonnet-4-5",
				attempt: 1,
				maxAttempts: 5,
			});
			expect(typeof state?.startedAtMs).toBe("number");
		}
		// The matching end cleared the state; later snapshots carry none.
		expect(states.at(-1)).toBeUndefined();
	});

	it("ignores a stale end for a superseded wait", async () => {
		let midState: AgentProgress["providerRetryState"];
		const { states, exitCode } = await runScripted((emit, seen) => {
			emit(waitStart(1));
			emit(waitStart(2));
			emit(waitEnd(1));
			// A tool end flushes progress synchronously, so this snapshot shows
			// exactly what the stale end left behind.
			emit({ type: "tool_execution_start", toolCallId: "probe", toolName: "read", args: {} } as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "probe",
				toolName: "read",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			} as AgentSessionEvent);
			midState = seen.at(-1);
			emit(waitEnd(2));
		});
		expect(exitCode).toBe(0);

		// Both waits surfaced in order, and the stale end(1) left wait 2 mounted.
		expect(definedWaitIds(states)).toEqual([1, 2]);
		expect(midState).toMatchObject({ waitId: 2, model: "claude-sonnet-4-5" });
		expect(states.at(-1)).toBeUndefined();
	});
});
