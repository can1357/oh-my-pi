/**
 * Regression (#7635): `--mode json` must not exit until the final record's
 * stdout write has fully drained.
 *
 * The JSON path emitted each event with a fire-and-forget `process.stdout.write`
 * and relied on an empty-write "flush barrier" before dispose/exit. The barrier
 * awaited its own callback, not the preceding large write, so a big final
 * `agent_end` (multi-MB) could be truncated when the process exited before the
 * pipe drained — while still exiting 0. The fix serializes every print-mode
 * stdout write on its own completion callback and blocks shutdown on the tail.
 *
 * Contract: `runPrintMode` stays pending until the final record's write callback
 * fires (so `process.exit` can't discard it), and the full record is delivered.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FlushHarness {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
	emit: (event: AgentSessionEvent) => void;
	disposed: () => boolean;
}

function createFlushHarness(): FlushHarness {
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	let disposed = false;
	let advisorDrainPrepared = false;

	const session = {
		sessionManager: {
			getHeader: () => undefined,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
		},
		settings: { get: () => false },
		extensionRunner: undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async () => {
			markPromptStarted();
			await promptReleased;
			return true;
		},
		prepareForHeadlessAdvisorDrain: () => {
			advisorDrainPrepared = true;
		},
		waitForAdvisorCatchup: async () => {
			if (!advisorDrainPrepared) throw new Error("advisor catch-up started before headless delivery was armed");
		},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as AgentSession;

	return {
		session,
		promptStarted,
		resolvePrompt,
		emit: event => subscriber?.(event),
		disposed: () => disposed,
	};
}

function makeLargeAgentEnd(payload: string): AgentSessionEvent {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: payload }],
				stopReason: "aborted",
				errorMessage: "Deadline exceeded",
				timestamp: Date.now(),
			},
		],
	} as unknown as AgentSessionEvent;
}

describe("print-mode JSON flush (#7635)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks exit until the final agent_end write drains, then delivers it in full", async () => {
		const writes: string[] = [];
		let releaseAgentEnd: (() => void) | undefined;
		const { promise: agentEndWriteIssued, resolve: markAgentEndWriteIssued } = Promise.withResolvers<void>();
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
			writes.push(text);
			const cb = args[args.length - 1];
			const invoke = typeof cb === "function" ? (cb as (err?: Error | null) => void) : undefined;
			// Defer the large agent_end record's completion callback to emulate a
			// backpressured pipe; every other write completes synchronously.
			if (text.includes('"type":"agent_end"')) {
				releaseAgentEnd = () => invoke?.(null);
				markAgentEndWriteIssued();
			} else {
				invoke?.(null);
			}
			return true;
		});

		const payload = "x".repeat(1_500_000);
		const harness = createFlushHarness();

		const run = runPrintMode(harness.session, { mode: "json", initialMessage: "hello" });
		let settled = false;
		void run.then(() => {
			settled = true;
		});

		await harness.promptStarted;
		harness.emit(makeLargeAgentEnd(payload));
		harness.resolvePrompt();

		// Drain to quiescence: every step runPrintMode can complete without the
		// deferred write is microtask-driven, so one macrotask boundary flushes
		// them all. The pre-fix fire-and-forget path settles and disposes here;
		// the fix must still be blocked on the undrained agent_end write.
		await agentEndWriteIssued;
		const { promise: nextTask, resolve: resolveNextTask } = Promise.withResolvers<void>();
		setImmediate(resolveNextTask);
		await nextTask;
		expect(releaseAgentEnd).toBeDefined();
		expect(settled).toBe(false);
		expect(harness.disposed()).toBe(false);

		releaseAgentEnd?.();
		await run;

		expect(settled).toBe(true);
		expect(harness.disposed()).toBe(true);

		const agentEndLine = writes.find(line => line.includes('"type":"agent_end"'));
		expect(agentEndLine).toBeDefined();
		expect(agentEndLine?.endsWith("\n")).toBe(true);
		// The complete payload survives — not a pipe-buffer-sized prefix.
		expect(agentEndLine).toContain(payload);
		expect(JSON.parse(agentEndLine as string)).toMatchObject({ type: "agent_end" });
	});
});
