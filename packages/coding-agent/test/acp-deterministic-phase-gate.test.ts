import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import { ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import type { AgentContext, AgentEvent, AgentLoopConfig, ToolCallContext } from "@oh-my-pi/pi-agent-core/types";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendExecOptions } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import {
	type AcpRenderContext,
	type AcpToolFrame,
	checkedNotificationPayload,
	encodeToolFrames,
	INITIAL_ACP_TOOL_VIEW,
	negotiateTerminalMetaCap,
	reduceAcpToolView,
} from "@oh-my-pi/pi-coding-agent/modes/acp/view/index";
import { hydrateReplayableToolExecution } from "@oh-my-pi/pi-coding-agent/presentation/hydrate";
import { fenceBlock } from "@oh-my-pi/pi-coding-agent/presentation/projections";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	buildSessionContext,
	type InterruptedToolCallsMarker,
	type StrippedToolCallsMarker,
} from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { correlateReplayableToolExecution } from "@oh-my-pi/pi-coding-agent/session/tool-journal-correlation";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { AgentSideConnection, SessionNotification, SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import { captureKillMidToolJournal } from "./helpers/kill-mid-tool-capture";

const LINE_COUNT = 3000;
const LINE_WIDTH = 63;
const EXPECTED_OUTPUT = Array.from(
	{ length: LINE_COUNT },
	(_, index) => `${String(index).padStart(LINE_WIDTH, "0")}\n`,
).join("");

const DISPLAY_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "ACP deterministic transport",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function threadingHost(toolCall?: ToolCallContext): { toolCall: ToolCallContext } | undefined {
	return toolCall === undefined ? undefined : { toolCall };
}

function uniqueBashCommand(): string {
	return `awk 'BEGIN{for(i=0;i<${LINE_COUNT};i++) printf "%0${LINE_WIDTH}d\\n", i}'`;
}

function uniqueEvalCode(): string {
	return `for (let i = 0; i < ${LINE_COUNT}; i++) { print(String(i).padStart(${LINE_WIDTH}, '0')); }`;
}

function toolSession(
	cwd: string,
	asyncJobManager?: AsyncJobManager,
	autoBackground: boolean = false,
	autoBackgroundThresholdMs: number = 60_000,
): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": asyncJobManager !== undefined,
		"bash.autoBackground.enabled": autoBackground,
		"bash.autoBackground.thresholdMs": autoBackgroundThresholdMs,
		"bashInterceptor.enabled": false,
	});
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModel: () => undefined,
		getEvalSessionId: () => "acp-deterministic-phase-gate",
		getEvalKernelOwnerId: () => undefined,
		assertEvalExecutionAllowed: () => {},
		trackEvalExecution: async <T>(execution: Promise<T>, _abortController: AbortController): Promise<T> =>
			await execution,
		allocateOutputArtifact: async () => undefined,
		getClientBridge: () => undefined,
		asyncJobManager,
		getBashInterceptorRules: () => [],
	} as unknown as ToolSession;
}

class LoopBackedAcpSession {
	readonly sessionManager: SessionManager;
	readonly sessionId: string;
	readonly agent: { sessionId: string; waitForIdle: () => Promise<void> };
	readonly model = DISPLAY_MODEL;
	readonly customCommands: [] = [];
	readonly extensionRunner = undefined;
	readonly systemPrompt = "ACP deterministic phase gate";
	readonly skills = [];
	readonly skillsSettings = { enableSkillCommands: true };
	readonly modelRegistry = { getApiKey: async () => "test-key" };
	readonly events: AgentEvent[] = [];
	readonly #settings = Settings.isolated();
	isStreaming = false;
	queuedMessageCount = 0;
	thinkingLevel: string | undefined;
	fastMode = false;
	forcedToolChoice: string | undefined;
	#listeners = new Set<(event: AgentSessionEvent) => void>();
	#presentationSettlementDeliveryBarrier: ((toolCallId: string) => Promise<void> | void) | undefined;

	constructor(
		cwd: string,
		private readonly tools: AgentTool[],
		private readonly mock: ReturnType<typeof createMockModel>,
	) {
		this.sessionManager = SessionManager.inMemory(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = { sessionId: this.sessionId, waitForIdle: async () => {} };
	}

	get settings(): Settings {
		return this.#settings;
	}

	get sessionName(): string {
		return "ACP deterministic phase gate";
	}

	getAvailableModels(): Model[] {
		return [this.model];
	}

	getAvailableThinkingLevels(): readonly string[] {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(level: string | undefined): void {
		this.thinkingLevel = level;
	}

	async setModel(_model: Model): Promise<void> {}

	setSlashCommands(_commands: unknown[]): void {}
	setClientBridge(_bridge: unknown): void {}
	setPresentationSettlementDeliveryBarrier(barrier: ((toolCallId: string) => Promise<void> | void) | undefined): void {
		this.#presentationSettlementDeliveryBarrier = barrier;
	}
	setUsageFallbackConfirmer(_confirmer: unknown): void {}
	async refreshMCPTools(_tools: unknown[]): Promise<void> {}
	getContextUsage(): undefined {
		return undefined;
	}
	getPlanModeState(): undefined {
		return undefined;
	}
	setPlanModeState(_state: unknown): void {}
	setPlanProposalHandler(_handler: unknown): void {}
	/**
	 * `#handlePromptEvent`'s legacy edit/bash/eval compatibility branches gate
	 * on this before their presentation-protocol short-circuit even runs, so it
	 * must exist once `tool_execution_start`/`tool_execution_end` are forwarded
	 * for any tool. `false` for every name: this harness's tools are either a
	 * real presentation-adapter tool (bash/eval, handled entirely before this
	 * check would matter) or a fixture tool with no built-in alias to report.
	 */
	hasBuiltInToolDispatch(_name: string): boolean {
		return false;
	}
	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(_text: string): Promise<boolean> {
		this.isStreaming = true;
		const context: AgentContext = { systemPrompt: [this.systemPrompt], messages: [], tools: this.tools };
		const config: AgentLoopConfig = {
			model: this.mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost as never,
			afterPresentationSettlement: toolCallId => this.#presentationSettlementDeliveryBarrier?.(toolCallId),
		};
		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "run the scripted tool call" }] }] as never,
			context,
			config,
			undefined,
			this.mock.stream,
		);
		for await (const event of stream) {
			this.events.push(event);
			if (event.type === "tool_presentation") {
				this.#emit({
					type: "tool_presentation",
					toolCallId: event.toolCallId,
					event: event.event,
				} as AgentSessionEvent);
			}
			// The generic legacy mapper path (`mapAgentSessionEventToAcpSessionUpdates`)
			// is what any tool with no presentation adapter rides live -- forwarded here
			// so the plain-channel truncation row exercises the real production route instead of
			// calling the mapper directly. Harmless for bash/eval: `AcpAgent`'s listener
			// returns immediately for a `presentation_events`-tagged start/end (see
			// `acp-agent.ts`), so this never perturbs the byte-gate assertions above.
			if (event.type === "tool_execution_start") {
				this.#emit({
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					progressProtocol: event.progressProtocol,
				} as AgentSessionEvent);
			}
			if (event.type === "tool_execution_end") {
				this.#emit({
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
					progressProtocol: event.progressProtocol,
				} as AgentSessionEvent);
			}
			if (event.type === "agent_end") {
				// AgentSession clears this before its end event reaches subscribers;
				// AcpAgent's real prompt barrier relies on that ordering.
				this.isStreaming = false;
				this.#emit({ type: "agent_end", messages: event.messages } as AgentSessionEvent);
			}
		}
		this.isStreaming = false;
		return true;
	}

	async waitForIdle(): Promise<void> {}
	async drainAsyncJobDeliveriesForAcp(): Promise<boolean> {
		return false;
	}
	async abort(): Promise<void> {
		this.isStreaming = false;
	}
	async dispose(): Promise<void> {}

	#emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

type ToolWireUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

function isToolWireUpdate(update: SessionUpdate): update is ToolWireUpdate {
	return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
}

function toolUpdates(notifications: readonly SessionNotification[]): ToolWireUpdate[] {
	return notifications.map(notification => notification.update).filter(isToolWireUpdate);
}

function terminalBytes(updates: readonly ToolWireUpdate[]): string {
	return updates
		.map(update => {
			const meta = update._meta as { terminal_output?: { data?: unknown } } | undefined;
			if (typeof meta !== "object" || meta === null || !("terminal_output" in meta)) return "";
			return typeof meta.terminal_output?.data === "string" ? meta.terminal_output.data : "";
		})
		.join("");
}

function isLiteralSettlementFrame(notification: SessionNotification): boolean {
	if (!isToolWireUpdate(notification.update)) return false;
	const meta = notification.update._meta as { terminal_exit?: unknown } | undefined;
	return meta?.terminal_exit !== undefined;
}

async function runRoute(route: "bash" | "bash_async" | "bash_auto" | "eval"): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-deterministic-phase-gate-"));
	const asyncJobManager =
		route === "bash_async" || route === "bash_auto" ? new AsyncJobManager({ retentionMs: 0 }) : undefined;
	try {
		const input =
			route === "bash"
				? { command: uniqueBashCommand() }
				: route === "bash_async"
					? { command: uniqueBashCommand(), async: true }
					: route === "bash_auto"
						? { command: uniqueBashCommand() }
						: { language: "js", code: uniqueEvalCode() };
		const tool =
			route === "bash" || route === "bash_async" || route === "bash_auto"
				? new BashTool(toolSession(cwd, asyncJobManager, route === "bash_auto"))
				: new EvalTool(toolSession(cwd));
		if (route === "eval") {
			vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
				_code: string,
				options: ExecutorBackendExecOptions,
			) => {
				for (let start = 0; start < EXPECTED_OUTPUT.length; start += LINE_WIDTH * 31) {
					options.onChunk?.(EXPECTED_OUTPUT.slice(start, start + LINE_WIDTH * 31));
				}
				return {
					output: EXPECTED_OUTPUT,
					exitCode: 0,
					termination: undefined,
					truncated: false,
					artifactId: undefined,
					totalLines: LINE_COUNT,
					totalBytes: Buffer.byteLength(EXPECTED_OUTPUT),
					outputLines: LINE_COUNT,
					outputBytes: Buffer.byteLength(EXPECTED_OUTPUT),
					displayOutputs: [],
				};
			}) as never);
		}
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: `phase-${route}`,
							name: route === "eval" ? route : "bash",
							arguments: input,
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const session = new LoopBackedAcpSession(cwd, [tool as unknown as AgentTool], mock);
		const notifications: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				notifications.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => session as unknown as AgentSession);
		await acp.initialize({
			protocolVersion: 1,
			clientCapabilities: { _meta: { terminal_output: true } },
		} as Parameters<typeof acp.initialize>[0]);
		const created = await acp.newSession({ cwd, mcpServers: [] } as Parameters<typeof acp.newSession>[0]);
		await acp.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "run exact scripted tool" }],
		} as Parameters<typeof acp.prompt>[0]);

		const start = session.events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
				event.type === "tool_execution_start",
		);
		expect(start?.progressProtocol).toBe("presentation_events");
		const updates = toolUpdates(notifications);
		expect(updates[0]?.rawInput).toEqual(route === "eval" ? input : { command: uniqueBashCommand() });
		const sourcePrefix =
			route === "eval"
				? `${uniqueEvalCode()}\n${"─".repeat(48)}\n`
				: route === "bash_async"
					? "\nBackgrounded as job bg_1; result will be delivered automatically.\n"
					: "";
		const delivered = terminalBytes(updates);
		const rawStart = sourcePrefix.length;
		// Facts follow the process stream structurally (wall time/truncation), but
		// the pre-retention process prefix must be byte-for-byte complete and unique.
		expect(delivered.slice(0, rawStart)).toBe(sourcePrefix);
		expect(delivered.slice(rawStart, rawStart + EXPECTED_OUTPUT.length)).toBe(EXPECTED_OUTPUT);
		expect(delivered.indexOf(EXPECTED_OUTPUT.slice(0, LINE_WIDTH), rawStart + LINE_WIDTH)).toBe(-1);
		expect(delivered.indexOf(EXPECTED_OUTPUT.slice(-LINE_WIDTH), rawStart + EXPECTED_OUTPUT.length)).toBe(-1);
	} finally {
		await asyncJobManager?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

const PLAIN_LINE_COUNT = 100;
const PLAIN_LINE_WIDTH = 63;
const PLAIN_EXPECTED_OUTPUT = Array.from(
	{ length: PLAIN_LINE_COUNT },
	(_, index) => `${String(index).padStart(PLAIN_LINE_WIDTH, "0")}\n`,
).join("");

const plainTruncationToolSchema = z.object({});

/**
 * A minimal tool named `grep` (one of `shouldCodeFenceToolOutput`'s
 * whitelisted legacy names in acp-event-mapper.ts) with no `presentation`
 * adapter, so the agent loop tags its `tool_execution_start`/
 * `tool_execution_end` events `progressProtocol: "legacy_snapshot"` -- the
 * real production signal that routes a live event through `AcpAgent`'s
 * generic mapper branch (`mapAgentSessionEventToAcpSessionUpdates`), the
 * only place `ACP_TEXT_LIMIT` actually applies. `bash`/`eval` are
 * unsuitable for this row post-migration: both carry a `presentation`
 * adapter now, so their plain-channel content goes through
 * `reduceAcpToolView`'s unbounded `plain` state instead (see
 * `buildReplacementSnapshotContent`), never through `ACP_TEXT_LIMIT` at all.
 */
const plainTruncationTool: AgentTool<typeof plainTruncationToolSchema, undefined> = {
	name: "grep",
	label: "Plain Truncation Probe",
	description: "Fixture tool returning fixed-width unique output larger than ACP_TEXT_LIMIT",
	parameters: plainTruncationToolSchema,
	async execute() {
		return { content: [{ type: "text", text: PLAIN_EXPECTED_OUTPUT }] };
	},
};

/**
 * The plain/no-capability channel's
 * `ACP_TEXT_LIMIT` (4,000-char) head-truncation class lost its end-to-end
 * coverage when the old shell grid's ten `fenced` rows (2 tools x 5 sizes)
 * went to zero alongside the byte-floor rows that made them redundant on
 * the terminal paths. Only unit-level coverage of the mapper's `limitText`
 * boundary remained (`acp-event-mapper.test.ts:1878,2132,2461`). This row
 * drives a real legacy (non-presentation) tool call with NO negotiated
 * terminal capability (no `clientCapabilities.terminal`, no
 * `_meta.terminal_output`) through the production live-event route in
 * `acp-agent.ts`, so the mapper's `ACP_TEXT_LIMIT` head-truncation actually
 * fires -- not a re-derivation of it.
 *
 * 6,400 bytes of unique fixed-width output is well past the 4,000-char
 * limit, so the truncation boundary is deterministic.
 */
async function runPlainTruncationRoute(): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-deterministic-phase-gate-plain-"));
	try {
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "phase-plain-truncation", name: "grep", arguments: {} }],
				},
				{ content: ["done"] },
			],
		});
		const session = new LoopBackedAcpSession(cwd, [plainTruncationTool as unknown as AgentTool], mock);
		const notifications: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				notifications.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => session as unknown as AgentSession);
		// Plain/no-capability channel: neither a real client terminal nor the
		// `_meta.terminal_output` display convention is negotiated.
		await acp.initialize({ protocolVersion: 1, clientCapabilities: {} } as Parameters<typeof acp.initialize>[0]);
		const created = await acp.newSession({ cwd, mcpServers: [] } as Parameters<typeof acp.newSession>[0]);
		await acp.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "run the plain-channel truncation probe" }],
		} as Parameters<typeof acp.prompt>[0]);

		const updates = toolUpdates(notifications);
		const settlement = updates.at(-1);
		const textBlocks = (settlement?.content ?? []).filter(
			(item): item is { type: "content"; content: { type: "text"; text: string } } =>
				item.type === "content" && item.content.type === "text",
		);
		const bodyBlock = textBlocks[0];
		if (!bodyBlock) throw new Error("expected a truncated text content block");
		// ACP_TEXT_LIMIT is 4,000 chars: head-truncated to 3,999 chars plus an
		// ellipsis, then fenced -- the exact production shape (`fenceBlock` is the
		// real presentation-boundary helper, not a re-derived copy of its rule).
		const expectedTruncatedBody = `${PLAIN_EXPECTED_OUTPUT.slice(0, 3_999)}…`;
		expect(bodyBlock.content.text).toBe(fenceBlock(expectedTruncatedBody));
		// The full body -- in particular its tail line -- must never have reached
		// the client: proves the cut lands inside the real 6,400-byte output
		// rather than some unrelated short string satisfying the equality above.
		expect(bodyBlock.content.text).not.toContain(PLAIN_EXPECTED_OUTPUT.slice(-PLAIN_LINE_WIDTH));
		expect(textBlocks).toHaveLength(1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

/**
 * `kill-mid-tool` has no equivalent coverage elsewhere: the old shell grid's
 * four-capability-combo probe for it was removed because that combo axis
 * (none/terminal/meta/both) was a *live-transport* concern for a real
 * hard-kill/respawn subprocess pair; it does not carry
 * over meaningfully to an in-process capture of the durable on-disk journal
 * signature, so this row exercises one representative render context
 * (terminal-meta-capable replay, the richest of the four) rather than
 * force-fitting all four onto a harness that never spawns a second process.
 *
 * `captureKillMidToolJournal` (test/helpers/kill-mid-tool-capture.ts) proves
 * the durable signature is real -- not merely a hand-built fixture standing
 * in for one, as every other dangling-execution test in this suite uses. This
 * row then drives the *same* production replay chain `session/load` uses
 * over that real capture:
 * `correlateReplayableToolExecution` -> `hydrateReplayableToolExecution` ->
 * `reduceAcpToolView(phase:'replay')`, asserting the reducer's real
 * `interrupted` `ToolOutcome` arm and its `terminal_exit` meta (null exit
 * code, `status: "failed"`) -- no new reducer state. It also drives the
 * TUI-side `session-context.ts` dangling detection over the same capture,
 * confirming the call survives collapse as an `InterruptedToolCallsMarker`
 * entry rather than the plain elision count `StrippedToolCallsMarker` uses
 * for a call with no journal coverage at all. Rendering that marker into an
 * interrupted tool-execution card (`ui-helpers.ts`) is covered from the same
 * real capture in `interactive-mode-journaled-dangling-rebuild.test.ts`,
 * which already owns that TUI harness and its bucket
 * (`coding-agent-ui`, distinct from this file's `coding-agent-runtime`).
 */
async function runKillMidToolReplay(): Promise<void> {
	const { capturedEntries, callId, dispose } = await captureKillMidToolJournal();
	try {
		const startedEntries = capturedEntries.filter(entry => entry.type === "tool_execution_started");
		const settledEntries = capturedEntries.filter(entry => entry.type === "tool_execution_settled");
		expect(startedEntries).toHaveLength(1);
		expect(settledEntries).toHaveLength(0);

		const execution = correlateReplayableToolExecution(capturedEntries, callId);
		if (execution === undefined)
			throw new Error("expected a correlated execution from the captured mid-kill entries");
		expect(execution.state).toBe("interrupted");
		if (execution.state !== "interrupted") throw new Error("unreachable");
		expect(execution.reason).toContain("Interrupted");

		const events = hydrateReplayableToolExecution(execution);
		const metaCap = negotiateTerminalMetaCap(true);
		if (metaCap === undefined) throw new Error("expected a negotiated terminal meta cap");
		const renderContext: AcpRenderContext = {
			phase: "replay",
			terminal: { kind: "meta_only", cap: metaCap },
			fence: true,
		};
		let state = INITIAL_ACP_TOOL_VIEW;
		const frames: AcpToolFrame[] = [];
		for (const event of events) {
			const step = reduceAcpToolView(state, event, renderContext);
			state = step.state;
			frames.push(...step.frames);
		}
		expect(state).toEqual({
			state: "settled",
			call: execution.call,
			outcome: { kind: "interrupted", reason: execution.reason },
		});
		const updates = encodeToolFrames("acp-kill-mid-tool-session", frames).map(
			checked => checkedNotificationPayload(checked).update,
		);
		const settlementUpdate = updates.at(-1) as
			| {
					status?: string;
					_meta?: { terminal_exit?: { terminal_id: string; exit_code: number | null; signal: number | null } };
			  }
			| undefined;
		expect(settlementUpdate?.status).toBe("failed");
		expect(settlementUpdate?._meta?.terminal_exit).toEqual({ terminal_id: callId, exit_code: null, signal: null });

		const context = buildSessionContext(capturedEntries, undefined, undefined, { transcript: true });
		const assistant = context.messages.find(message => message.role === "assistant");
		if (!assistant) throw new Error("expected the dangling call's assistant turn to survive collapse");
		const interruptedToolCalls = (assistant as AgentMessage & InterruptedToolCallsMarker).interruptedToolCalls;
		expect(interruptedToolCalls?.[0]?.call.toolCallId).toBe(callId);
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBeUndefined();
	} finally {
		await dispose();
	}
}

describe("deterministic ACP Phase 1 end-to-end byte gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes exact local, explicit-async, and auto-background bash plus eval through presentation events and preserves every pre-retention byte", async () => {
		await runRoute("bash");
		await runRoute("bash_async");
		await runRoute("bash_auto");
		await runRoute("eval");
	}, 30_000);

	it("truncates a real bash call's plain-channel content at ACP_TEXT_LIMIT and recovers the clipped notice", async () => {
		await runPlainTruncationRoute();
	}, 15_000);

	it("replays a genuinely captured kill-mid-tool journal as interrupted through the production replay chain", async () => {
		await runKillMidToolReplay();
	}, 15_000);

	it("releases a completed suppressed auto-background delivery only after the real loop emits its literal settlement frame", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-auto-background-settlement-race-"));
		const freezeStarted = Promise.withResolvers<void>();
		const releaseFreeze = Promise.withResolvers<void>();
		const managerDelivery = Promise.withResolvers<void>();
		const chronology: string[] = [];
		const deliveryPrerequisites: Array<{ readonly settledEvent: boolean; readonly settlementFrame: boolean }> = [];
		const notifications: SessionNotification[] = [];
		let session: LoopBackedAcpSession | undefined;
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async jobId => {
				chronology.push(`manager_delivery:${jobId}`);
				deliveryPrerequisites.push({
					settledEvent: Boolean(
						session?.events.some(
							(event): event is Extract<AgentEvent, { type: "tool_presentation" }> =>
								event.type === "tool_presentation" && event.event.type === "settled",
						),
					),
					settlementFrame: notifications.some(isLiteralSettlementFrame),
				});
				managerDelivery.resolve();
			},
		});
		let resumeCalls = 0;
		const resumeDeliveries = manager.resumeDeliveries.bind(manager);
		vi.spyOn(manager, "resumeDeliveries").mockImplementation(jobIds => {
			resumeCalls++;
			resumeDeliveries(jobIds);
		});
		const originalFreeze = ToolPresentationStream.prototype.freeze;
		vi.spyOn(ToolPresentationStream.prototype, "freeze").mockImplementation(function (this: ToolPresentationStream) {
			freezeStarted.resolve();
			return releaseFreeze.promise.then(() => originalFreeze.call(this));
		});
		try {
			const tool = new BashTool(toolSession(cwd, manager, true, 0));
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "phase-auto-background-settlement-race",
								name: "bash",
								arguments: { command: "printf 'RACE-COMPLETED-SUPPRESSED\\n'" },
							},
						],
					},
					{ content: ["done"] },
				],
			});
			session = new LoopBackedAcpSession(cwd, [tool as unknown as AgentTool], mock);
			const connection = {
				sessionUpdate: async (notification: SessionNotification) => {
					notifications.push(notification);
				},
				signal: new AbortController().signal,
				closed: Promise.withResolvers<void>().promise,
			} as unknown as AgentSideConnection;
			const acp = new AcpAgent(connection, async () => session as unknown as AgentSession);
			await acp.initialize({
				protocolVersion: 1,
				clientCapabilities: { _meta: { terminal_output: true } },
			} as Parameters<typeof acp.initialize>[0]);
			const created = await acp.newSession({ cwd, mcpServers: [] } as Parameters<typeof acp.newSession>[0]);
			const prompt = acp.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "run completed suppressed background job" }],
			} as Parameters<typeof acp.prompt>[0]);

			await freezeStarted.promise;
			await manager.waitForAll();
			expect(manager.getJob("bg_1")?.status).toBe("completed");
			expect(chronology).toEqual([]);
			expect(notifications.some(isLiteralSettlementFrame)).toBe(false);

			releaseFreeze.resolve();
			await prompt;
			await Promise.race([
				managerDelivery.promise,
				Bun.sleep(2_000).then(() => {
					throw new Error("suppressed manager completion was not released after settlement");
				}),
			]);
			await Bun.sleep(50);
			expect(resumeCalls).toBe(1);
			expect(chronology).toEqual(["manager_delivery:bg_1"]);
			expect(deliveryPrerequisites).toEqual([{ settledEvent: true, settlementFrame: true }]);
		} finally {
			releaseFreeze.resolve();
			await manager.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 20_000);
});
