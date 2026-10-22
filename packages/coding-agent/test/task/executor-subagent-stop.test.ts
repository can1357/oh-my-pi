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
	/** Submit an incremental section labelled `label` that does not end the run (no terminal yield follows). */
	yieldSection: (label: string, data: unknown) => void;
	/** Submit one workpool item through the harness's real `YieldTool`; a rejected submission is recorded in `yieldErrors`. */
	submitWorkPoolItem: (key: number, data: string) => Promise<void>;
	/** Submit `params` through the harness's real `YieldTool`; a rejected submission is recorded in `yieldErrors`. */
	submitYield: (params: Record<string, unknown>) => Promise<void>;
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
	/** Runs whenever the executor waits for the fake session to go idle; a turn still running there ends inside it. */
	onWaitForIdle?: () => void | Promise<void>;
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
				yieldSection: (label: string, data: unknown) =>
					emitYield({ status: "success", data, type: [label] }, "Section submitted."),
				submitWorkPoolItem: (key: number, data: string) => call.submitYield({ key, data }),
				submitYield: async (params: Record<string, unknown>) => {
					try {
						const result = await args.yieldTool?.execute(`yield-call-${prompts.length}`, params);
						emitYield({ ...result?.details }, "Submitted.");
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
		waitForIdle: async () => {
			await args.onWaitForIdle?.();
		},
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
		// Each pass observes a snapshot of the child transcript as it stood then: the
		// first pass's array does not grow with the continuation's turn.
		expect(seen.map(entry => entry.count)).toEqual([1, 2]);
		expect(harness.events[0]?.messages).toHaveLength(1);
		expect(seen.map(entry => assistantText(entry.last))).toEqual(["child turn 1", "child turn 2"]);
		expect(seen[1]?.last).toBe(harness.messages.at(-1));
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "keep going" });
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeNumber();
	});

	it("asks a reason-less refusal's continuation to yield again", async () => {
		const id = "RefusedNoReason";
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block" } : undefined),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		await runSubprocess(baseOptions(id));

		expect(harness.prompts).toHaveLength(2);
		expect(harness.prompts[1]?.text).toContain("without a reason");
		expect(harness.prompts[1]?.text).toContain("yield again");
	});

	describe("when wake turns run while handlers consult", () => {
		/**
		 * The first `wakes` passes each leave a wake turn running on the idle child; it ends, recording a newer
		 * yield, while the run waits for the session to settle. Later passes are undisturbed.
		 */
		async function runWithWakes(id: string, wakes: number) {
			let pending = 0;
			let started = 0;
			let served = 0;
			const harness: StopHarness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.yieldTerminal({ report: "OLD-PAYLOAD" }),
				onStop: async () => {
					if (started < wakes) {
						started += 1;
						pending += 1;
					}
					return undefined;
				},
				onWaitForIdle: () => {
					if (pending === 0) return;
					pending -= 1;
					served += 1;
					harness.emitTerminalYield({ report: `WAKE-PAYLOAD-${served}` });
				},
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);
			const result = await runSubprocess(baseOptions(id));
			return { harness, result };
		}

		it("lets the wake turn settle and judges the candidate it recorded before publishing", async () => {
			const { harness, result } = await runWithWakes("WakeSettles", 1);

			// The first allow was about OLD-PAYLOAD, which the wake turn replaced.
			expect(harness.events).toHaveLength(2);
			expect(harness.events.map(event => event.stop_hook_active)).toEqual([false, false]);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ report: "WAKE-PAYLOAD-1" });
			expect(JSON.stringify(result.output)).not.toContain("OLD-PAYLOAD");
		});

		it("re-judges while turns keep replacing the candidate and stops once one is undisturbed", async () => {
			const { harness, result } = await runWithWakes("WakesKeepComing", 2);

			// Two disturbed passes, then one nothing overlapped: three consults, no more.
			expect(harness.events).toHaveLength(3);
			expect(JSON.parse(result.output)).toEqual({ report: "WAKE-PAYLOAD-2" });
		});

		it("consults exactly once when nothing overlaps the pass", async () => {
			const { harness, result } = await runWithWakes("NoWake", 0);

			expect(harness.events).toHaveLength(1);
			expect(JSON.parse(result.output)).toEqual({ report: "OLD-PAYLOAD" });
		});
	});

	describe("a structured run that never yields", () => {
		it("offers the fallback result to subagent_stop before publishing it", async () => {
			const id = "FallbackOffered";
			const harness = createHarness({
				hasStopHandlers: true,
				// The model answers in prose and ignores every yield reminder.
				onPrompt: call => call.report("prose result"),
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess(baseOptions(id));

			expect(harness.events).toHaveLength(1);
			expect(harness.events[0]?.stop_hook_active).toBe(false);
			expect(assistantText(harness.events[0]?.last_assistant_message)).toBe("prose result");
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).text()).toContain("prose result");
		});

		it("fails the run instead of publishing a refused fallback result nothing replaced", async () => {
			const id = "FallbackRefused";
			const refused = "REFUSED-PROSE-MUST-NOT-BE-PUBLISHED";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.report(refused),
				onStop: async (_event, callIndex) =>
					callIndex === 1 ? { decision: "block", reason: "not done" } : undefined,
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess(baseOptions(id));

			// Only a fresh yield can answer the refusal, so the spent ladder never re-offers the prose.
			expect(harness.events).toHaveLength(1);
			expect(harness.prompts.some(call => call.text === "not done")).toBe(true);
			expect(result.exitCode).not.toBe(0);
			expect(result.error).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
			expect(result.output).not.toContain(refused);
			expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).exists()).toBe(false);
		});

		it("publishes the yield that answers a refused fallback result", async () => {
			const id = "FallbackRefusedThenYield";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call =>
					call.text === "not done" ? call.yieldTerminal({ report: "real answer" }) : call.report("prose"),
				onStop: async (_event, callIndex) =>
					callIndex === 1 ? { decision: "block", reason: "not done" } : undefined,
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess(baseOptions(id));

			expect(harness.events.map(event => event.stop_hook_active)).toEqual([false, true]);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ report: "real answer" });
			expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).text()).not.toContain("prose");
		});

		it("offers a JSON completion that satisfies the schema, and nothing under a schema that prose cannot meet", async () => {
			const outputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
			const completion = createHarness({
				hasStopHandlers: true,
				// The reminders that follow add no text, so the run's output stays one JSON document.
				onPrompt: call => call.report(call.promptIndex === 1 ? '{"ok":true}' : ""),
			});
			mockCreateAgentSession(completion.session);
			registerRunning("FallbackCompletion", completion.session);
			const completed = await runSubprocess({ ...baseOptions("FallbackCompletion"), outputSchema });

			expect(completion.events).toHaveLength(1);
			expect(completed.exitCode).toBe(0);

			// Prose fails the schema, so the run fails on the missing yield: no result, nothing to offer.
			const prose = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.report("not json"),
			});
			mockCreateAgentSession(prose.session);
			registerRunning("FallbackProse", prose.session);
			const failed = await runSubprocess({ ...baseOptions("FallbackProse"), outputSchema });

			expect(prose.events).toHaveLength(0);
			expect(failed.exitCode).not.toBe(0);
		});

		describe("with only incremental sections recorded", () => {
			/** Two sections, then silence through every reminder: the model never submits a terminal yield. */
			const submitSectionsThenStall = (call: PromptCall) => {
				if (call.promptIndex === 1) {
					call.yieldSection("findings", "FINDING-A");
					call.yieldSection("findings", "FINDING-B");
				} else {
					call.reply("no terminal yield");
				}
			};

			it("offers the sections finalization would publish, and publishes them when allowed", async () => {
				const id = "SectionsOffered";
				const harness = createHarness({ hasStopHandlers: true, onPrompt: submitSectionsThenStall });
				mockCreateAgentSession(harness.session);
				registerRunning(id, harness.session);

				const result = await runSubprocess(baseOptions(id));

				// The run publishes these sections with exit 0 either way; what the hook decides is whether
				// any handler saw them first. Output stays empty, so only the sections can be the candidate.
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.output)).toEqual({ findings: ["FINDING-A", "FINDING-B"] });
				expect(harness.events).toHaveLength(1);
			});

			it("fails closed on a refusal, publishing none of the refused sections", async () => {
				const id = "SectionsRefused";
				const harness = createHarness({
					hasStopHandlers: true,
					onPrompt: submitSectionsThenStall,
					onStop: async (_event, callIndex) =>
						callIndex === 1 ? { decision: "block", reason: "not done" } : undefined,
				});
				mockCreateAgentSession(harness.session);
				registerRunning(id, harness.session);

				const result = await runSubprocess(baseOptions(id));

				// The continuation never produced a judged replacement, so the refused sections are not re-offered.
				expect(harness.events).toHaveLength(1);
				expect(result.exitCode).not.toBe(0);
				expect(result.error).toBe(SUBAGENT_STOP_REFUSAL_UNRESOLVED);
				expect(result.output).not.toContain("FINDING-");
				expect(result.extractedToolData?.yield).toBeUndefined();
				expect(await Bun.file(path.join(tempDir.path(), `${id}.md`)).exists()).toBe(false);
			});

			it("does not let refused sections ride into the replacement that finalizes the run", async () => {
				const id = "SectionsRefusedThenFinalized";
				const harness = createHarness({
					hasStopHandlers: true,
					onPrompt: call => {
						if (call.text === "not done") call.yieldCompleteSection("findings", "FINDING-C");
						else submitSectionsThenStall(call);
					},
					onStop: async (_event, callIndex) =>
						callIndex === 1 ? { decision: "block", reason: "not done" } : undefined,
				});
				mockCreateAgentSession(harness.session);
				registerRunning(id, harness.session);

				const result = await runSubprocess(baseOptions(id));

				expect(harness.events.map(event => event.stop_hook_active)).toEqual([false, true]);
				expect(result.exitCode).toBe(0);
				// Folding the refused sections into the replacement would publish payload no handler allowed.
				expect(JSON.parse(result.output)).toEqual({ findings: "FINDING-C" });
			});
		});
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

	it("does not let a refused yield's earlier sections ride into the replacement", async () => {
		const id = "RefusedSectionsThenSection";
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => {
				if (call.promptIndex === 1) {
					call.yieldSection("findings", "REFUSED-FINDING");
					call.yieldCompleteSection("summary", "REFUSED-SUMMARY");
				} else call.yieldCompleteSection("summary", "replacement");
			},
			onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "redo" } : undefined),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.events).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		// The refused candidate assembled every recorded section, not just its final item.
		expect(JSON.parse(result.output)).toEqual({ summary: "replacement" });
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

	it("lets every workpool item of a refused batch be submitted again", async () => {
		const id = "RefusedPoolBatch";
		const toolSession: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getWorkPoolYieldItems: () => [
				{ id: "review#1", index: 1 },
				{ id: "review#2", index: 2 },
			],
		};
		const harness = createHarness({
			hasStopHandlers: true,
			yieldTool: new YieldTool(toolSession),
			// The second item is the batch's final submission; the candidate is both items.
			onPrompt: async call => {
				const tag = call.promptIndex === 1 ? "REFUSED" : "replacement";
				await call.submitWorkPoolItem(1, `${tag} one`);
				await call.submitWorkPoolItem(2, `${tag} two`);
			},
			onStop: async (_event, callIndex) =>
				callIndex === 1 ? { decision: "block", reason: "redo both" } : undefined,
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess(baseOptions(id));

		expect(harness.yieldErrors).toEqual([]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("replacement one");
		expect(result.output).not.toContain("REFUSED");
	});

	it("rejects a data-less finalize that would close the sections a refusal discarded", async () => {
		const id = "RefusedSectionsThenBareFinalize";
		const outputSchema = {
			type: "object",
			properties: { findings: { type: "array", items: { type: "string" } } },
			required: ["findings"],
		};
		const toolSession: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			outputSchema,
			getLastAssistantText: () => "prose",
		};
		const harness = createHarness({
			hasStopHandlers: true,
			yieldTool: new YieldTool(toolSession),
			onPrompt: async call => {
				if (call.promptIndex === 1) {
					await call.submitYield({ type: ["findings"], data: "REFUSED-FINDING" });
					await call.submitYield({ type: "result" });
				} else if (call.promptIndex === 2) {
					// Without `data`, a finalize only closes sections, and the refusal discarded them all.
					await call.submitYield({ type: "result" });
				} else {
					await call.submitYield({ data: { findings: ["fresh"] } });
				}
			},
			onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "redo" } : undefined),
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess({ ...baseOptions(id), outputSchema });

		expect(harness.yieldErrors).toHaveLength(1);
		expect(harness.yieldErrors[0]).toContain("last-turn result cannot satisfy it");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ findings: ["fresh"] });
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

	it("drops an allowed candidate when the run is cancelled while the pass revalidates it", async () => {
		const id = "CancelledDuringRevalidation";
		const controller = new AbortController();
		let stopAnswered = false;
		let cancelled = false;
		const harness = createHarness({
			hasStopHandlers: true,
			onPrompt: call => call.yieldTerminal({ report: call.text }),
			onStop: async () => {
				stopAnswered = true;
				return undefined;
			},
			// After handlers allowed, the pass lets the child settle to see whether the candidate
			// changed; the run is cancelled right there, so the allow was never revalidated.
			onWaitForIdle: async () => {
				if (!stopAnswered || cancelled) return;
				cancelled = true;
				controller.abort();
				await Promise.withResolvers<void>().promise;
			},
		});
		mockCreateAgentSession(harness.session);
		registerRunning(id, harness.session);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(harness.events).toHaveLength(1);
		expect(result.aborted).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(AgentRegistry.global().get(id)?.lifecycle?.acceptedAt).toBeUndefined();
		expect(result.output).not.toContain("do the work");
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

		it("does not ask a reason-less refusal's continuation to call a yield tool it does not have", async () => {
			const id = "UnstructuredNoReason";
			const harness = createHarness({
				hasStopHandlers: true,
				onPrompt: call => call.report(call.promptIndex === 1 ? "first report" : "second report"),
				onStop: async (_event, callIndex) => (callIndex === 1 ? { decision: "block" } : undefined),
			});
			mockCreateAgentSession(harness.session);
			registerRunning(id, harness.session);

			const result = await runSubprocess({ ...baseOptions(id), structured: false });

			expect(harness.prompts).toHaveLength(2);
			expect(harness.prompts[1]?.text).toContain("without a reason");
			expect(harness.prompts[1]?.text).not.toMatch(/yield/i);
			expect(result.output).toBe("second report");
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
