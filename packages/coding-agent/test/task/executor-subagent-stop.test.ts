/**
 * `subagent_stop` contract: a child run's candidate terminal `yield` is offered
 * to handlers once, after its owner async work has quiesced and before any
 * acceptance/finalize path, and a refusal must re-run the SAME child session
 * instead of publishing the refused payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SubagentStopEvent, SubagentStopEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	runSubagentFollowUpTurn,
	runSubprocess,
	SUBAGENT_STOP_REFUSAL_UNRESOLVED,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const CHILD_SESSION_ID = "child-session-1";

/**
 * Advisory continuations `subagent_stop` documents per run (`docs/extensions.md`).
 * Pinned here as the published behavior: the executor's cap is module-private, so
 * an external change to it must be a deliberate change to this contract.
 */
const DOCUMENTED_ADVISORY_CONTINUATIONS = 8;

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function assistantMessage(text: string): AssistantMessage {
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

interface PromptCall {
	promptIndex: number;
	text: string;
	options?: PromptOptions;
	/** Append a child assistant turn carrying `text`, as the model's reply next turn would. */
	reply: (text: string) => void;
	/** Submit a terminal `yield` carrying `data`. */
	yieldTerminal: (data: unknown) => void;
	/** Submit a `complete: true` incremental section labelled `label` carrying `data`. */
	yieldCompleteSection: (label: string, data: unknown) => void;
}

interface StopHarness {
	session: AgentSession;
	prompts: PromptCall[];
	events: SubagentStopEvent[];
	/** Child transcript the fake session reports as `session.messages`. */
	messages: AssistantMessage[];
}

/** Text of a captured `last_assistant_message` (the fake transcript is text-only). */
function assistantText(message: SubagentStopEvent["last_assistant_message"]): string | undefined {
	if (!message || message.role !== "assistant") return undefined;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function createHarness(args: {
	onPrompt: (call: PromptCall) => void;
	/** Prompts whose turn ends without a `yield` (a continuation that did not finish). */
	idlePrompt?: (promptIndex: number) => boolean;
	/** Handler verdict per `subagent_stop` pass. */
	onStop?: (event: SubagentStopEvent, callIndex: number) => Promise<SubagentStopEventResult | undefined>;
	/** Whether the child session's runner has `subagent_stop` handlers at all. */
	hasStopHandlers: boolean;
	/** Child transcript path the session reports (`session.sessionFile`). */
	sessionFile?: string;
}): StopHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const prompts: PromptCall[] = [];
	const events: SubagentStopEvent[] = [];
	let yieldSeq = 0;
	let stopCalls = 0;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const session = {
		...createSessionDefaults(),
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		sessionId: CHILD_SESSION_ID,
		sessionFile: args.sessionFile,
		messages,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setWorkPoolYieldItems: async () => {},
		extensionRunner: {
			// The executor wires the runner it finds on the session during setup
			// (`initialize` + `onError` + a `session_start` emit) before it can
			// reach the stop pass, so the fake models that surface too — without
			// it the run fails in setup and never offers a candidate.
			initialize: () => {},
			onError: () => {},
			emit: async () => undefined,
			hasHandlers: (eventType: string) => args.hasStopHandlers && eventType === "subagent_stop",
			emitSubagentStop: async (event: Omit<SubagentStopEvent, "type">) => {
				// The runner stamps `type` onto the payload before dispatch, so record
				// the event handlers observe rather than the argument the caller passes.
				const delivered: SubagentStopEvent = { type: "subagent_stop", ...event };
				events.push(delivered);
				stopCalls += 1;
				return await args.onStop?.(delivered, stopCalls);
			},
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			const call: PromptCall = {
				promptIndex: prompts.length + 1,
				text,
				options,
				reply: (replyText: string) => {
					messages.push(assistantMessage(replyText));
				},
				yieldTerminal: (data: unknown) => {
					yieldSeq += 1;
					emit({
						type: "tool_execution_end",
						toolCallId: `yield-${yieldSeq}`,
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data },
						},
						isError: false,
					} as AgentSessionEvent);
				},
				yieldCompleteSection: (label: string, data: unknown) => {
					yieldSeq += 1;
					emit({
						type: "tool_execution_end",
						toolCallId: `yield-${yieldSeq}`,
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Section submitted." }],
							details: { status: "success", data, type: [label], complete: true },
						},
						isError: false,
					} as AgentSessionEvent);
				},
			};
			prompts.push(call);
			if (args.idlePrompt?.(call.promptIndex)) {
				messages.push(assistantMessage(`no yield for prompt ${call.promptIndex}`));
				return;
			}
			args.onPrompt(call);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		isAdvisorActive: () => false,
	};

	return { session: session as unknown as AgentSession, prompts, events, messages };
}

function mockCreateAgentSession(session: AgentSession): void {
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
}

function registerRunning(id: string, session: AgentSession): void {
	AgentRegistry.global().register({ id, displayName: id, kind: "sub", session, status: "running" });
}

describe("runSubprocess subagent_stop", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-subagent-stop-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id,
			sessionFile: path.join(tempDir.path(), "parent.jsonl"),
			parentSessionId: "parent-session-1",
			artifactsDir: tempDir.path(),
			enableLsp: false,
		};
	}

	it("runs to completion without a stop pass when no handler is registered", async () => {
		const id = "NoStopHandler";
		const harness = createHarness({
			hasStopHandlers: false,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		// A session_stop-only extension must not park or re-drive the child.
		expect(harness.prompts).toHaveLength(1);
		expect(harness.events).toEqual([]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "do the work" });
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
	});

	it("offers the candidate once with child and parent identity, and accepts it when allowed", async () => {
		const id = "AllowedCandidate";
		const childSessionFile = path.join(tempDir.path(), `${id}.jsonl`);
		const seen: Array<{ count: number; last: SubagentStopEvent["last_assistant_message"] }> = [];
		const harness = createHarness({
			hasStopHandlers: true,
			sessionFile: childSessionFile,
			onPrompt: call => {
				call.reply("child turn 1");
				call.yieldTerminal({ report: call.text });
			},
			onStop: async event => {
				seen.push({ count: event.messages.length, last: event.last_assistant_message });
				return undefined;
			},
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]).toMatchObject({
			type: "subagent_stop",
			agent_id: id,
			agent_type: "task",
			session_id: CHILD_SESSION_ID,
			session_file: childSessionFile,
			parent_session_id: "parent-session-1",
			parent_session_file: path.join(tempDir.path(), "parent.jsonl"),
			stop_hook_active: false,
		});
		// The pass carries the transcript the child had at that moment — the turn
		// that produced the candidate — not an empty or stale one.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.count).toBe(1);
		expect(assistantText(seen[0]?.last)).toBe("child turn 1");
		expect(seen[0]?.last).toBe(harness.messages[0]);
		expect(harness.prompts).toHaveLength(1);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "do the work" });
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
	});

	it("re-runs the same child session on a refusal and accepts only the replacement yield", async () => {
		const id = "RefusedCandidate";
		// Each pass is offered the transcript as it stands then: pass 1 sees only
		// the refused turn, pass 2 the replacement turn the continuation produced.
		const seen: Array<{ count: number; last: SubagentStopEvent["last_assistant_message"] }> = [];
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => {
				call.reply(`child turn ${call.promptIndex}`);
				call.yieldTerminal({ report: call.text });
			},
			onStop: async (event, callIndex) => {
				seen.push({ count: event.messages.length, last: event.last_assistant_message });
				return callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined;
			},
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		// The refused payload never reaches the result: the run completes on the
		// yield the same session produced after the continuation prompt.
		expect(harness.prompts.map(call => call.text)).toEqual(["do the work", "keep going"]);
		expect(harness.prompts[1]?.options).toMatchObject({ attribution: "agent", synthetic: true });
		expect(harness.events).toHaveLength(2);
		expect(harness.events.map(event => event.stop_hook_active)).toEqual([false, true]);
		expect(harness.events[1]?.session_id).toBe(harness.events[0]?.session_id);
		// Both passes observe the live child transcript, and the second pass sees
		// the replacement turn the refusal produced.
		expect(seen.map(entry => entry.count)).toEqual([1, 2]);
		expect(seen.map(entry => assistantText(entry.last))).toEqual(["child turn 1", "child turn 2"]);
		expect(seen[1]?.last).toBe(harness.messages.at(-1));
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "keep going" });
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
	});

	it("does not publish the refused yield when the replacement is only a complete section", async () => {
		const id = "RefusedThenSection";
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => {
				if (call.promptIndex === 1) call.yieldTerminal({ report: "REFUSED-PAYLOAD" });
				else call.yieldCompleteSection("summary", "replacement");
			},
			onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "redo" } : undefined),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.events).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		// A leftover refused item would still be the assembled terminal payload and
		// shadow the section the continuation produced.
		expect(JSON.parse(result.output)).toEqual({ summary: "replacement" });
		expect(result.output).not.toContain("REFUSED-PAYLOAD");
	});

	it("bounds advisory continuations at the cap and then accepts the pending yield", async () => {
		const id = "CappedCandidate";
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async () => ({ continue: true, additionalContext: "again" }),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.prompts).toHaveLength(DOCUMENTED_ADVISORY_CONTINUATIONS + 1);
		expect(harness.events).toHaveLength(DOCUMENTED_ADVISORY_CONTINUATIONS + 1);
		expect(harness.events.at(-1)?.stop_hook_active).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "again" });
	});

	it("fails the run instead of publishing a refused yield the continuation never replaced", async () => {
		const id = "UnresolvedRefusal";
		const refusedReport = "REFUSED-REPORT-MUST-NOT-BE-PUBLISHED";
		const harness = createHarness({
			hasStopHandlers: true,
			// The continuation turn and the reminder ladder produce no yield.
			idlePrompt: promptIndex => promptIndex > 1,
			onPrompt: call => call.yieldTerminal({ report: refusedReport }),
			onStop: async () => ({ decision: "block", reason: "not done" }),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.events).toHaveLength(1);
		expect(result.exitCode).not.toBe(0);
		expect(result.error).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
		expect(result.aborted).toBe(false);
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeUndefined();
		// The refused payload is not a result in any published form: not the
		// tool output, not the `<id>.md` artifact `agent://<id>` serves, not a
		// structured sidecar, and not the caller's extracted-data snapshot.
		expect(result.output).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
		expect(result.output).not.toContain(refusedReport);
		expect(result.structuredOutput).toBeUndefined();
		expect(result.extractedToolData?.yield).toBeUndefined();
		expect(result.outputPath).toBeUndefined();
		expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).exists()).toBe(false);
		expect(await Bun.file(path.join(tempDir.path(), `${id}.json`)).exists()).toBe(false);
	});

	it("leaves a resumed worker's accepted artifact intact when its next turn is refused", async () => {
		const id = "ResumedRefusal";
		const acceptedRun = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: "ACCEPTED-PAYLOAD" }),
		});
		mockCreateAgentSession(acceptedRun.session);
		registerRunning(id, acceptedRun.session);

		const first = await runSubprocess(baseOptions(id));
		expect(first.exitCode).toBe(0);
		const artifactPath = path.join(tempDir.path(), `${id}.md`);
		const acceptedArtifact = await Bun.file(artifactPath).text();
		expect(acceptedArtifact).toContain("ACCEPTED-PAYLOAD");

		// A later turn that a `subagent_stop` handler refuses and the model never
		// replaces must not republish over the artifact the earlier turn had
		// accepted — the resumed worker keeps its last authorized result.
		const refusedRun = createHarness({
			hasStopHandlers: true,
			idlePrompt: promptIndex => promptIndex > 1,
			onPrompt: call => call.yieldTerminal({ report: "REFUSED-PAYLOAD" }),
			onStop: async () => ({ decision: "block", reason: "not done" }),
		});
		registerRunning(id, refusedRun.session);

		const resumed = await runSubagentFollowUpTurn({
			id,
			agent: baseAgent,
			message: "continue",
			parentSessionId: "parent-session-1",
			parentSessionFile: "/parent/session.jsonl",
			artifactsDir: tempDir.path(),
		});

		expect(refusedRun.events).toHaveLength(1);
		expect(resumed.exitCode).not.toBe(0);
		expect(resumed.error).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
		expect(resumed.output).not.toContain("REFUSED-PAYLOAD");
		expect(resumed.extractedToolData?.yield).toBeUndefined();
		expect(resumed.outputPath).toBeUndefined();
		expect(await Bun.file(artifactPath).text()).toBe(acceptedArtifact);
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeUndefined();
	});

	it("drops the candidate when the run is cancelled while handlers are consulting", async () => {
		const id = "CancelledDuringStop";
		const stopEntered = Promise.withResolvers<void>();
		let handlerSawAbort = false;
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async event => {
				stopEntered.resolve();
				const aborted = Promise.withResolvers<void>();
				if (event.signal.aborted) aborted.resolve();
				else event.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				handlerSawAbort = true;
				return undefined;
			},
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);
		const controller = new AbortController();

		const run = runSubprocess({ ...baseOptions(id), signal: controller.signal });
		await stopEntered.promise;
		controller.abort();
		const result = await run;

		expect(handlerSawAbort).toBe(true);
		expect(harness.prompts).toHaveLength(1);
		expect(result.aborted).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.error).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeUndefined();
		// Handlers never confirmed this payload either, so the cancelled run
		// publishes no yield-derived output or artifact.
		expect(result.output).not.toContain("do the work");
		expect(result.extractedToolData?.yield).toBeUndefined();
		expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).exists()).toBe(false);
	});

	it("gates a resumed worker's turn through the same stop pass", async () => {
		const id = "ResumedWorker";
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async (_event, callIndex) =>
				callIndex === 1 ? { decision: "block", reason: "finish it" } : undefined,
		});
		registerRunning(id, harness.session);

		const result = await runSubagentFollowUpTurn({
			id,
			agent: baseAgent,
			message: "continue",
			parentSessionId: "parent-session-1",
			parentSessionFile: "/parent/session.jsonl",
		});

		expect(harness.prompts.map(call => call.text)).toEqual(["continue", "finish it"]);
		expect(harness.events).toHaveLength(2);
		expect(harness.events[0]).toMatchObject({
			agent_id: id,
			parent_session_id: "parent-session-1",
			parent_session_file: "/parent/session.jsonl",
			stop_hook_active: false,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "finish it" });
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
	});
});
