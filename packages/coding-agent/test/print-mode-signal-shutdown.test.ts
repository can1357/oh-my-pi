/**
 * Regression (#18450): two shutdown-ordering gaps in `--mode json` signal teardown.
 *
 * 1. `AgentSession.dispose()` dropped its agent subscription and cleared its
 *    session listeners BEFORE the bounded disposal drain, so a tool that settles
 *    while the drain waits for the run (its execute rejects the abort and
 *    completes anyway) had its `tool_execution_end` emitted by the core loop but
 *    never forwarded to session subscribers — and therefore never to the JSON
 *    stream.
 * 2. The signal cleanup callback returned `session.dispose()` alone, while the
 *    serialized stdout tail lived inside the print-mode run. postmortem exits as
 *    soon as the cleanup pass ends, so a record still blocked on a slow reader's
 *    backpressure was truncated mid-line.
 *
 * Contract: a tool that settles inside the disposal window still reaches JSON
 * consumers with its terminal event; the signal path joins the stdout tail
 * before exiting even when disposal rejects, and a disposal failure stays the
 * error the pass sees.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

type SignalCleanup = (reason: postmortem.Reason) => void | Promise<void>;

const captured: SignalCleanup[] = [];

/** Captures the print-mode signal cleanup instead of letting it reach the real exit pass. */
function captureSignalCleanup(): void {
	const register = postmortem.register.bind(postmortem);
	vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
		if (id !== "print-mode-session") return register(id, callback, options);
		captured.push(callback);
		return () => {};
	});
}

function collectStdout(options: { hold?: (text: string) => boolean } = {}): {
	lines: string[];
	release?: () => void;
	writeIssued?: Promise<void>;
} {
	const lines: string[] = [];
	let release: (() => void) | undefined;
	const { promise: writeIssued, resolve: markWriteIssued } = Promise.withResolvers<void>();
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const text = typeof args[0] === "string" ? args[0] : Buffer.from(args[0] as Uint8Array).toString();
		lines.push(text);
		const callback = args.at(-1);
		const complete = typeof callback === "function" ? (callback as (err?: Error | null) => void) : undefined;
		if (options.hold?.(text)) {
			release = () => complete?.(null);
			markWriteIssued();
		} else {
			complete?.(null);
		}
		return true;
	});
	return {
		lines,
		get release() {
			return release;
		},
		writeIssued,
	};
}

/** Every emitted line must be one complete JSON record. */
function parseRecords(stream: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of stream.split("\n")) {
		if (line.length === 0) continue;
		records.push(JSON.parse(line) as Record<string, unknown>);
	}
	return records;
}

describe("print-mode signal shutdown (#18450)", () => {
	afterEach(() => {
		captured.length = 0;
		vi.restoreAllMocks();
	});

	it("forwards a tool end that settles during the disposal drain", async () => {
		const stdout = collectStdout();
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		captureSignalCleanup();

		const dir = TempDir.createSync("@pi-print-signal-end-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "tool-signal", name: "slow-settle", arguments: {} }] }],
		});
		const { promise: toolStarted, resolve: markToolStarted } = Promise.withResolvers<void>();
		const { promise: toolSettled, resolve: settleTool } = Promise.withResolvers<void>();
		const schema = type({});
		const slowSettle: AgentTool<typeof schema> = {
			name: "slow-settle",
			label: "Slow settle",
			description: "Settles only when the test releases it, ignoring the abort signal",
			parameters: schema,
			async execute() {
				markToolStarted();
				await toolSettled;
				return { content: [{ type: "text", text: "settled" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowSettle] },
			streamFn: mock.stream,
		});
		// The disposal drain is the only waiter that keeps a run alive after the
		// signal, so entering it pins the moment the pre-fix code has already
		// disconnected the agent and cleared the session listeners.
		const waitForIdle = agent.waitForIdle.bind(agent);
		const { promise: drainEntered, resolve: markDrainEntered } = Promise.withResolvers<void>();
		let teardownStarted = false;
		vi.spyOn(agent, "waitForIdle").mockImplementation(() => {
			if (teardownStarted) markDrainEntered();
			return waitForIdle();
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml"), { settings }),
		});
		try {
			const run = runPrintMode(session, { mode: "json", initialMessage: "run the slow tool" });
			await toolStarted;
			expect(captured).toHaveLength(1);

			teardownStarted = true;
			const teardown = captured[0](postmortem.Reason.SIGTERM);
			await drainEntered;
			// The tool settles while the drain is still waiting for the run.
			settleTool();
			await teardown;
			await run;

			const records = parseRecords(stdout.lines.join(""));
			const ends = records.filter(record => record.type === "tool_execution_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({
				type: "tool_execution_end",
				toolCallId: "tool-signal",
				toolName: "slow-settle",
			});
			// The settled tool's result is in the stream too, so the consumer holds a
			// complete lifecycle rather than an orphaned start.
			expect(records.some(record => record.type === "tool_execution_start")).toBe(true);
			// The final record is a complete JSON line, not a truncated tail.
			const lastLine = stdout.lines.join("").trimEnd().split("\n").at(-1);
			expect(() => JSON.parse(lastLine as string)).not.toThrow();
		} finally {
			await session.dispose();
			auth.close();
			await dir.remove();
		}
	});

	it("joins the stdout tail on signal shutdown even when disposal rejects", async () => {
		const stdout = collectStdout({ hold: text => text.includes('"type":"agent_end"') });
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		captureSignalCleanup();

		const disposeError = new Error("dispose failed during signal teardown");
		const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
		const { promise: promptReleased, resolve: releasePrompt } = Promise.withResolvers<void>();
		let subscriber: ((event: unknown) => void) | undefined;
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
			subscribe: (listener: (event: unknown) => void) => {
				subscriber = listener;
				return () => {};
			},
			prompt: async () => {
				markPromptStarted();
				await promptReleased;
				return true;
			},
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {
				throw disposeError;
			},
		} as unknown as AgentSession;

		const run = runPrintMode(session, { mode: "json", initialMessage: "hello" });
		// The core path rethrows the same failure; observe it so the rejection is
		// never unhandled while the assertions below run.
		const runSettled = run.then(
			() => undefined,
			(error: unknown) => error,
		);
		await promptStarted;
		subscriber?.({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "y".repeat(1_500_000) }],
					stopReason: "aborted",
					errorMessage: "Deadline exceeded",
					timestamp: Date.now(),
				},
			],
		});
		releasePrompt();
		await stdout.writeIssued;
		expect(captured).toHaveLength(1);

		const settled: { state: "pending" | "fulfilled" | "rejected" } = { state: "pending" };
		const teardown = Promise.resolve(captured[0](postmortem.Reason.SIGTERM));
		const teardownSettled = teardown.then(
			() => {
				settled.state = "fulfilled";
			},
			() => {
				settled.state = "rejected";
			},
		);
		// Disposal already rejected; the cleanup must still be parked on the
		// undrained record rather than letting the exit truncate it.
		const { promise: nextTask, resolve: resolveNextTask } = Promise.withResolvers<void>();
		setImmediate(resolveNextTask);
		await nextTask;
		expect(settled.state).toBe("pending");

		stdout.release?.();
		await teardownSettled;
		expect(settled.state).toBe("rejected");
		await expect(teardown).rejects.toBe(disposeError);

		const agentEndLine = stdout.lines.find(line => line.includes('"type":"agent_end"'));
		expect(agentEndLine?.endsWith("\n")).toBe(true);
		expect(JSON.parse(agentEndLine as string)).toMatchObject({ type: "agent_end" });
		expect(await runSettled).toBe(disposeError);
	});

	it("joins a record that disposal itself queues", async () => {
		// The reviewer's probe: the record exists only because dispose forwards
		// the terminal event of a tool that settled inside its drain, so it is
		// queued on a tail newer than the one a pre-dispose `flushed()` snapshot
		// resolves. Holding that write must hold the cleanup.
		const stdout = collectStdout({ hold: text => text.includes('"type":"tool_execution_end"') });
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		captureSignalCleanup();

		const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
		const { promise: promptReleased, resolve: releasePrompt } = Promise.withResolvers<void>();
		let subscriber: ((event: unknown) => void) | undefined;
		let disposed = false;
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
			subscribe: (listener: (event: unknown) => void) => {
				subscriber = listener;
				return () => {};
			},
			prompt: async () => {
				markPromptStarted();
				await promptReleased;
				return true;
			},
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {
				// Idempotent like the real session: the run's own dispose must not
				// replay the event the signal cleanup already forwarded.
				if (disposed) return;
				disposed = true;
				// The real dispose awaits its drain before forwarding, so the event
				// lands after any tail a caller captured before dispose ran.
				await Promise.resolve();
				subscriber?.({
					type: "tool_execution_end",
					toolCallId: "late-tool",
					toolName: "late-settle",
					result: { content: [{ type: "text", text: "settled" }] },
				});
			},
		} as unknown as AgentSession;

		const run = runPrintMode(session, { mode: "json", initialMessage: "hello" });
		// Track the run's own settlement so a rejection is never unhandled while
		// the assertions below drive the cleanup by hand.
		const runSettled = run.then(
			(value: number) => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await promptStarted;
		expect(captured).toHaveLength(1);

		const settled: { state: "pending" | "fulfilled" | "rejected" } = { state: "pending" };
		const teardown = Promise.resolve(captured[0](postmortem.Reason.SIGTERM));
		const teardownSettled = teardown.then(
			() => {
				settled.state = "fulfilled";
			},
			() => {
				settled.state = "rejected";
			},
		);
		await stdout.writeIssued;
		releasePrompt();

		// Disposal has resolved and the record it queued is still held, so a
		// cleanup parked on the pre-dispose tail would already have settled here
		// and let postmortem exit with that line unflushed.
		const { promise: nextTask, resolve: resolveNextTask } = Promise.withResolvers<void>();
		setImmediate(resolveNextTask);
		await nextTask;
		expect(settled.state).toBe("pending");

		stdout.release?.();
		await teardownSettled;
		expect(settled.state).toBe("fulfilled");

		const lateLine = stdout.lines.find(line => line.includes('"type":"tool_execution_end"'));
		expect(lateLine?.endsWith("\n")).toBe(true);
		expect(JSON.parse(lateLine as string)).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "late-tool",
			toolName: "late-settle",
		});
		expect(await runSettled).toEqual({ status: "fulfilled", value: 0 });
	});
});
