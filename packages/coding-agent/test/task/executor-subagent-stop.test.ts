/**
 * `subagent_stop` contract: a child run's candidate terminal `yield` is offered
 * to handlers once, after its owner async work has quiesced and before any
 * acceptance/finalize path, and a refusal must re-run the SAME child session
 * instead of publishing the refused payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SubagentStopEvent, SubagentStopEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	BUDGET_STOP_GRACE_REQUESTS,
	runSubagentFollowUpTurn,
	runSubprocess,
	SUBAGENT_STOP_REFUSAL_UNRESOLVED,
	SUBAGENT_WARNING_EMPTY_MESSAGE,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
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

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
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
		stopReason,
		timestamp: Date.now(),
	};
}

interface PromptCall {
	promptIndex: number;
	text: string;
	options?: PromptOptions;
	/** Append a child assistant turn carrying `text`, as the model's reply next turn would. */
	reply: (text: string) => void;
	/** End the turn on a final report (`structured: false` runs): a counted `stop` assistant message carrying `text`. */
	report: (text: string, stopReason?: AssistantMessage["stopReason"]) => void;
	/** Submit a terminal `yield` carrying `data`. */
	yieldTerminal: (data: unknown) => void;
	/** Submit a `complete: true` incremental section labelled `label` carrying `data`. */
	yieldCompleteSection: (label: string, data: unknown) => void;
	/** Submit one workpool item through the harness's real `YieldTool`; a rejected submission is recorded in `yieldErrors`. */
	submitWorkPoolItem: (key: number, data: string) => Promise<void>;
}

/** Observer a kept-alive session's IRC wake turns are bracketed with (`AgentSession.setIrcWakeTurnObserver`). */
type WakeObserver = (records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface StopHarness {
	session: AgentSession;
	prompts: PromptCall[];
	events: SubagentStopEvent[];
	/** Child transcript the fake session reports as `session.messages`. */
	messages: AssistantMessage[];
	/** Messages of yield submissions the real `YieldTool` rejected. */
	yieldErrors: string[];
	/** The IRC wake-turn observer the executor installed on the kept-alive session, if any. */
	wakeObserver: () => WakeObserver | undefined;
	/** Record a terminal `yield` outside any prompt, as a wake turn the executor does not drive would. */
	emitTerminalYield: (data: unknown) => void;
}

/** Text of a captured `last_assistant_message` (the fake transcript is text-only). */
function assistantText(message: SubagentStopEvent["last_assistant_message"]): string | undefined {
	if (!message || message.role !== "assistant") return undefined;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function createHarness(args: {
	onPrompt: (call: PromptCall) => void | Promise<void>;
	/** Prompts whose turn ends without a `yield` (a continuation that did not finish). */
	idlePrompt?: (promptIndex: number) => boolean;
	/** Handler verdict per `subagent_stop` pass. */
	onStop?: (event: SubagentStopEvent, callIndex: number) => Promise<SubagentStopEventResult | undefined>;
	/** Whether the child session's runner has `subagent_stop` handlers at all. */
	hasStopHandlers: boolean;
	/** Child transcript path the session reports (`session.sessionFile`). */
	sessionFile?: string;
	/** Real yield tool the session hands out as `getToolByName("yield")`. */
	yieldTool?: YieldTool;
}): StopHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const prompts: PromptCall[] = [];
	const events: SubagentStopEvent[] = [];
	let yieldSeq = 0;
	let stopCalls = 0;
	const yieldErrors: string[] = [];
	let wakeObserver: WakeObserver | undefined;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	/** A real yield turn ends its assistant message (one counted request) before the tool result lands. */
	const emitYield = (details: Record<string, unknown>, resultText: string) => {
		yieldSeq += 1;
		const toolCallId = `yield-${yieldSeq}`;
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "yield", arguments: {} }],
				stopReason: "toolUse",
			},
		} as unknown as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "yield",
			result: { content: [{ type: "text", text: resultText }], details },
			isError: false,
		} as AgentSessionEvent);
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
		getToolByName: (name: string) => (name === "yield" ? args.yieldTool : undefined),
		setWorkPoolYieldItems: async () => {},
		setIrcWakeTurnObserver: (observer: WakeObserver | undefined) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
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
				report: (reportText: string, stopReason?: AssistantMessage["stopReason"]) => {
					const message = assistantMessage(reportText, stopReason);
					messages.push(message);
					emit({ type: "message_end", message } as AgentSessionEvent);
				},
				yieldTerminal: (data: unknown) => emitYield({ status: "success", data }, "Result submitted."),
				yieldCompleteSection: (label: string, data: unknown) =>
					emitYield({ status: "success", data, type: [label], complete: true }, "Section submitted."),
				submitWorkPoolItem: async (key: number, data: string) => {
					try {
						const result = await args.yieldTool?.execute(`pool-${prompts.length}`, { key, data });
						emitYield({ ...result?.details }, "Item submitted.");
					} catch (error) {
						yieldErrors.push(error instanceof Error ? error.message : String(error));
					}
				},
			};
			prompts.push(call);
			if (args.idlePrompt?.(call.promptIndex)) {
				messages.push(assistantMessage(`no yield for prompt ${call.promptIndex}`));
				return;
			}
			await args.onPrompt(call);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		isAdvisorActive: () => false,
	};

	return {
		session: session as unknown as AgentSession,
		prompts,
		events,
		messages,
		yieldErrors,
		wakeObserver: () => wakeObserver,
		emitTerminalYield: data => emitYield({ status: "success", data }, "Result submitted."),
	};
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

	it("lets a workpool item's refused final submission be submitted again", async () => {
		const id = "RefusedPoolItem";
		const toolSession: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getWorkPoolYieldItems: () => [{ id: "review#1", index: 1 }],
		};
		const harness = createHarness({
			hasStopHandlers: true,
			yieldTool: new YieldTool(toolSession),
			// The single item is the batch's final submission: the candidate.
			onPrompt: call => call.submitWorkPoolItem(1, call.promptIndex === 1 ? "REFUSED-ITEM" : "replacement item"),
			onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "redo it" } : undefined),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		// The yield tool remembers a submitted item and rejects it a second time, so
		// a refusal would be unanswerable unless the refused item is released.
		expect(harness.yieldErrors).toEqual([]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("replacement item");
		expect(result.output).not.toContain("REFUSED-ITEM");
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

	it("keeps re-prompting on an explicit refusal past the advisory cap", async () => {
		const id = "UncappedRefusals";
		const refusals = 3 * DOCUMENTED_ADVISORY_CONTINUATIONS;
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async (_event, callIndex) =>
				callIndex <= refusals ? { decision: "block", reason: `refusal ${callIndex}` } : undefined,
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		// Every refusal got a continuation; the run finished on the first pass that allowed it.
		expect(harness.events).toHaveLength(refusals + 1);
		expect(harness.prompts).toHaveLength(refusals + 1);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: `refusal ${refusals}` });
	});

	it("spends the advisory allowance only on advisory continuations when refusals interleave", async () => {
		const id = "MixedContinuations";
		const verdicts: SubagentStopEventResult[] = [
			// Refusals first: they must not consume the allowance...
			...Array.from({ length: 3 }, (): SubagentStopEventResult => ({ decision: "block", reason: "refused" })),
			// ...so the full advisory allowance is still available...
			...Array.from({ length: DOCUMENTED_ADVISORY_CONTINUATIONS }, (): SubagentStopEventResult => ({
				continue: true,
				additionalContext: "again",
			})),
			// ...and refusals after the allowance is spent are still not capped.
			...Array.from({ length: 3 }, (): SubagentStopEventResult => ({ decision: "block", reason: "refused" })),
			// The next advisory request finds the allowance spent and the run is let go.
			{ continue: true, additionalContext: "again" },
		];
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async (_event, callIndex) => verdicts[callIndex - 1],
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.events).toHaveLength(verdicts.length);
		expect(harness.prompts).toHaveLength(verdicts.length);
		expect(result.exitCode).toBe(0);
	});

	it("charges each refused yield against the soft request budget and ends the run with the budget reason", async () => {
		const id = "RefusedBudget";
		const refusedReport = "REFUSED-REPORT-MUST-NOT-BE-PUBLISHED";
		const harness = createHarness({
			hasStopHandlers: true,
			// Safety valve: without budget accounting the loop never ends, so past
			// this prompt the child stops yielding and the run fails on the
			// unresolved refusal instead of hanging the suite.
			idlePrompt: promptIndex => promptIndex > 40,
			onPrompt: call => call.yieldTerminal({ report: refusedReport }),
			onStop: async () => ({ decision: "block", reason: "not done" }),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess({
			...baseOptions(id),
			settings: Settings.isolated({ "task.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		});

		expect(result.aborted).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.abortReason).toContain("Soft request budget exceeded");
		// One request per prompt: the run hard-aborts once the budget stop's grace
		// window is spent, and no continuation prompt starts after that abort.
		const hardAbortRequests = 2 * 1.5 + BUDGET_STOP_GRACE_REQUESTS;
		expect(harness.events).toHaveLength(hardAbortRequests);
		expect(harness.prompts).toHaveLength(hardAbortRequests);
		expect(result.output).not.toContain(refusedReport);
		expect(result.extractedToolData?.yield).toBeUndefined();
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeUndefined();
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

	it("drops the 99% completion estimate while a refused worker keeps working", async () => {
		const id = "RefusedProgress";
		let latest: AgentProgress | undefined;
		const percentSeen: Array<number | undefined> = [];
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => {
				// The continuation starts after the refusal: the latched 99% must be gone.
				if (call.promptIndex === 2) percentSeen.push(latest?.completionPercent);
				call.yieldTerminal({ report: call.text });
			},
			onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "redo" } : undefined),
		});
		registerRunning(id, harness.session);

		await runSubagentFollowUpTurn({
			id,
			agent: baseAgent,
			message: "continue",
			completionProbe: true,
			onProgress: progress => {
				latest = progress;
			},
		});

		expect(percentSeen).toEqual([undefined]);
	});

	it("reports the spawning session on a kept-alive worker's IRC wake turn", async () => {
		const id = "WakeIdentity";
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);
		await runSubprocess(baseOptions(id));

		const finish = harness.wakeObserver()?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "wake",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		harness.emitTerminalYield({ report: "answered while woken" });
		await finish?.(undefined);

		// Pass 1 belongs to the first run; pass 2 is the wake turn's, built from the
		// wake options the executor installed with the observer.
		expect(harness.events).toHaveLength(2);
		expect(harness.events[1]).toMatchObject({
			agent_id: id,
			parent_session_id: "parent-session-1",
			parent_session_file: path.join(tempDir.path(), "parent.jsonl"),
		});
	});

	describe("without a yield tool (structured: false)", () => {
		it("offers the settled final report turn once and publishes it when allowed", async () => {
			const id = "UnstructuredAllowed";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.report("final answer"),
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({ ...baseOptions(id), structured: false });

			expect(harness.events).toHaveLength(1);
			expect(harness.events[0]).toMatchObject({ agent_id: id, stop_hook_active: false });
			expect(assistantText(harness.events[0]?.last_assistant_message)).toBe("final answer");
			expect(harness.prompts).toHaveLength(1);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("final answer");
			expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
		});

		it("re-prompts the same session on a refusal and publishes only the replacement report", async () => {
			const id = "UnstructuredRefused";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.report(call.promptIndex === 1 ? "REFUSED-REPORT" : "replacement report"),
				onStop: async (_event, callIndex) =>
					callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined,
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({ ...baseOptions(id), structured: false });

			expect(harness.prompts.map(call => call.text)).toEqual(["do the work", "keep going"]);
			expect(harness.prompts[1]?.options).toMatchObject({ attribution: "agent", synthetic: true });
			expect(harness.events.map(event => event.stop_hook_active)).toEqual([false, true]);
			expect(harness.events.map(event => assistantText(event.last_assistant_message))).toEqual([
				"REFUSED-REPORT",
				"replacement report",
			]);
			// A fresh report turn clears the refusal: the run succeeds on it.
			expect(result.exitCode).toBe(0);
			expect(result.error).toBeUndefined();
			expect(result.output).toBe("replacement report");
			expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).text()).toBe("replacement report");
			expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
		});

		it("fails the run instead of publishing a refused report the continuation never replaced", async () => {
			const id = "UnstructuredUnresolved";
			const refusedReport = "REFUSED-REPORT-MUST-NOT-BE-PUBLISHED";
			const harness = createHarness({
				hasStopHandlers: true,
				// The continuation turn ends without any report text.
				idlePrompt: promptIndex => promptIndex > 1,
				onPrompt: call => call.report(refusedReport),
				// Only the first pass refuses: a regression that offers the cleared
				// candidate again would be allowed and published rather than loop.
				onStop: async (_event, callIndex) =>
					callIndex === 1 ? { decision: "block", reason: "not done" } : undefined,
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({ ...baseOptions(id), structured: false });

			expect(harness.events).toHaveLength(1);
			expect(result.exitCode).not.toBe(0);
			expect(result.error).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
			expect(result.output).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
			expect(result.output).not.toContain(refusedReport);
			expect(result.outputPath).toBeUndefined();
			expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).exists()).toBe(false);
			expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeUndefined();
		});

		it("does not offer a final turn that is not a settled report", async () => {
			const id = "UnstructuredNoCandidate";
			const harness = createHarness({
				hasStopHandlers: true,
				// A turn that produced no report text leaves nothing to judge.
				idlePrompt: () => true,
				onPrompt: () => {},
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({ ...baseOptions(id), structured: false });

			expect(harness.events).toEqual([]);
			expect(result.error).toBe(SUBAGENT_WARNING_EMPTY_MESSAGE);
		});

		it("offers a final report that ended short of a clean stop, like a length cutoff", async () => {
			const id = "UnstructuredLength";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call =>
					call.report(
						call.promptIndex === 1 ? "partial" : "replacement",
						call.promptIndex === 1 ? "length" : "stop",
					),
				onStop: async (_event, callIndex) =>
					callIndex === 1 ? { decision: "block", reason: "finish it" } : undefined,
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({ ...baseOptions(id), structured: false });

			// The cut-off report would otherwise be published unjudged.
			expect(harness.events).toHaveLength(2);
			const offered = harness.events[0]?.last_assistant_message;
			expect(offered?.role === "assistant" ? offered.stopReason : undefined).toBe("length");
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("replacement");
		});

		it("does not offer the budget wrap-up report that ends a stopped run", async () => {
			const id = "UnstructuredBudgetStop";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => {
					if (call.promptIndex === 1) {
						// Budget 2 stops the free-running turn at the third request.
						call.report("working 1");
						call.report("working 2");
						call.report("working 3");
					} else {
						call.report("budget wrap-up");
					}
				},
				onStop: async () => ({ decision: "block", reason: "not done" }),
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({
				...baseOptions(id),
				structured: false,
				settings: Settings.isolated({ "task.softRequestBudget": 2 }),
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			});

			// The wrap-up is the stopped run's forced answer: handlers are never asked to
			// refuse it, or an always-blocking handler would burn the grace window.
			expect(harness.events).toEqual([]);
			expect(harness.prompts).toHaveLength(2);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("budget wrap-up");
		});

		it("re-prompts a resumed worker's final report on a refusal and publishes the replacement", async () => {
			const id = "UnstructuredResumed";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.report(call.promptIndex === 1 ? "REFUSED-REPORT" : "replacement report"),
				onStop: async (_event, callIndex) =>
					callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined,
			});
			registerRunning(id, harness.session);

			const result = await runSubagentFollowUpTurn({
				id,
				agent: baseAgent,
				message: "continue",
				structured: false,
				artifactsDir: tempDir.path(),
			});

			expect(harness.prompts.map(call => call.text)).toEqual(["continue", "keep going"]);
			expect(harness.events.map(event => event.stop_hook_active)).toEqual([false, true]);
			expect(result.exitCode).toBe(0);
			expect(result.error).toBeUndefined();
			expect(result.output).toBe("replacement report");
			expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
		});
	});
});
