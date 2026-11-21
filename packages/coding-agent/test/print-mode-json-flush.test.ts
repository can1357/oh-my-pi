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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { postmortem } from "@oh-my-pi/pi-utils";

interface FlushHarness {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
	emit: (event: AgentSessionEvent) => void;
	disposed: () => boolean;
}

function createFlushHarness(dispose: () => Promise<void> = async () => {}): FlushHarness {
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
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		settings: Settings.isolated(),
		getLastAssistantMessage: () => undefined,
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
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {
			advisorDrainPrepared = true;
		},
		waitForIdle: async () => {},
		waitForAdvisorCatchup: async () => {
			if (!advisorDrainPrepared) throw new Error("advisor catch-up started before headless delivery was armed");
		},
		dispose: () => {
			disposed = true;
			return dispose();
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

interface HeldAgentEndWrite {
	writes: string[];
	/** Resolves once the agent_end record's write has been issued (callback still held). */
	issued: Promise<void>;
	/** Fires the held write's completion callback. */
	release: () => void;
}

/** Mock stdout so the agent_end record's completion callback is held, emulating a backpressured pipe. */
function holdAgentEndWrite(): HeldAgentEndWrite {
	const writes: string[] = [];
	let releaseHeld: (() => void) | undefined;
	const issued = Promise.withResolvers<void>();
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
		writes.push(text);
		const cb = args[args.length - 1];
		const invoke = typeof cb === "function" ? (cb as (err?: Error | null) => void) : undefined;
		if (text.includes('"type":"agent_end"')) {
			releaseHeld = () => invoke?.(null);
			issued.resolve();
		} else {
			invoke?.(null);
		}
		return true;
	});
	return {
		writes,
		issued: issued.promise,
		release: () => {
			if (!releaseHeld) throw new Error("agent_end write was never issued");
			releaseHeld();
		},
	};
}

/** One macrotask boundary: every microtask-driven step that does not need the held write completes first. */
async function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("print-mode JSON flush (#7635)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks exit until the final agent_end write drains, then delivers it in full", async () => {
		const held = holdAgentEndWrite();
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

		// The pre-fix fire-and-forget path settles and disposes here; the fix
		// must still be blocked on the undrained agent_end write.
		await held.issued;
		await nextMacrotask();
		expect(settled).toBe(false);
		expect(harness.disposed()).toBe(false);

		held.release();
		expect(await run).toBe(0);

		expect(settled).toBe(true);
		expect(harness.disposed()).toBe(true);

		const agentEndLine = held.writes.find(line => line.includes('"type":"agent_end"'));
		expect(agentEndLine).toBeDefined();
		expect(agentEndLine?.endsWith("\n")).toBe(true);
		// The complete payload survives — not a pipe-buffer-sized prefix.
		expect(agentEndLine).toContain(payload);
		expect(JSON.parse(agentEndLine as string)).toMatchObject({ type: "agent_end" });
	});
});

// Regression (#18450): postmortem exits as soon as the `print-mode-session`
// signal callback settles, so that callback must join the serialized stdout
// tail — not just session disposal — or SIGTERM truncates the last record.
describe("print-mode JSON signal teardown (#18450)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function signalWithHeldAgentEnd(dispose?: () => Promise<void>) {
		const held = holdAgentEndWrite();
		let signalCallback: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
		vi.spyOn(postmortem, "register").mockImplementation((id, callback) => {
			if (id === "print-mode-session") signalCallback = callback;
			return () => {};
		});
		const harness = createFlushHarness(dispose);
		const run = runPrintMode(harness.session, { mode: "json", initialMessage: "hello" });
		await harness.promptStarted;
		harness.emit(makeLargeAgentEnd("y".repeat(200_000)));
		await held.issued;
		if (!signalCallback) throw new Error("print-mode-session cleanup was not registered");

		const teardown = Promise.resolve(signalCallback(postmortem.Reason.SIGTERM));
		let teardownSettled = false;
		void teardown.then(
			() => {
				teardownSettled = true;
			},
			() => {
				teardownSettled = true;
			},
		);
		await nextMacrotask();
		return { held, harness, run, teardown, teardownSettled: () => teardownSettled };
	}

	it("stays pending until the held agent_end write drains", async () => {
		const { held, harness, run, teardown, teardownSettled } = await signalWithHeldAgentEnd();

		expect(harness.disposed()).toBe(true);
		expect(teardownSettled()).toBe(false);

		held.release();
		await teardown;

		harness.resolvePrompt();
		await run;
		const agentEndLine = held.writes.find(line => line.includes('"type":"agent_end"'));
		expect(JSON.parse(agentEndLine as string)).toMatchObject({ type: "agent_end" });
	});

	it("joins stdout when disposal rejects and keeps the disposal error primary", async () => {
		const disposeError = new Error("dispose failed");
		const { held, harness, run, teardown, teardownSettled } = await signalWithHeldAgentEnd(async () => {
			throw disposeError;
		});

		expect(harness.disposed()).toBe(true);
		expect(teardownSettled()).toBe(false);

		held.release();
		await expect(teardown).rejects.toBe(disposeError);

		harness.resolvePrompt();
		await run.catch(() => {});
	});
});
