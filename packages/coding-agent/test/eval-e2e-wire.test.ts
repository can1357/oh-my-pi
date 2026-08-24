import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import type { AgentContext, AgentEvent, AgentLoopConfig, ToolCallContext } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendExecOptions } from "@oh-my-pi/pi-coding-agent/eval/backend";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext, DeliveryReceipt } from "../src/modes/acp/view/reducer";
import { driveAcpToolView } from "./helpers/acp-tool-view-driver";

/**
 * End-to-end wire coverage: real EvalTool.execute() through agentLoop →
 * presentation events → reducer → ACP encoder → literal SessionUpdate frames.
 *
 * This test exercises the full lifecycle the manual test bypassed: protocol
 * selection by the loop, loop-owned `started`/`settled`, freeze, and actual
 * timeout propagation. The backend is stubbed for determinism; the tool, the
 * producer, the reducer, and the encoder are all real.
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function mockSession(): ToolSession {
	return {
		cwd: "/tmp",
		settings: new Map() as unknown as ToolSession["settings"],
		getActiveModel: () => undefined,
		allocateOutputArtifact: async () => undefined,
		getSessionFile: () => undefined,
		getEvalKernelOwnerId: () => undefined,
		getEvalSessionId: () => "test-session",
		getSessionSpawns: () => "*",
		assertEvalExecutionAllowed: () => {},
		trackEvalExecution: async (exec: Promise<unknown>) => exec,
	} as unknown as ToolSession;
}

function threadingHost(toolCall?: ToolCallContext): { toolCall: ToolCallContext } | undefined {
	return toolCall ? { toolCall } : undefined;
}

function metaContext(): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase: "live", terminal: { kind: "meta_only", cap }, cwd: "/tmp", fence: true };
}

function plainContext(): AcpRenderContext {
	return { phase: "live", terminal: { kind: "none" }, cwd: "/tmp", fence: true };
}

function terminalData(updates: readonly unknown[]): string {
	return updates
		.map(u => {
			if (typeof u !== "object" || u === null) return "";
			const meta = ("_meta" in u && u._meta) as { terminal_output?: { data?: unknown } } | undefined;
			const data = meta?.terminal_output?.data;
			return typeof data === "string" ? data : "";
		})
		.join("");
}

function runEventsThroughReducer(
	events: readonly ToolPresentationEvent[],
	context: AcpRenderContext = metaContext(),
): { updates: SessionUpdate[]; receipts: DeliveryReceipt[] } {
	const run = driveAcpToolView(events, context);
	// Additional assertion layer: the fact-audience delivery ledger
	// must agree with every receipt the reducer itself issued.
	expect(run.deliveryViolations).toEqual([]);
	return { updates: run.updates, receipts: run.receipts };
}

function presentationEvents(events: readonly AgentEvent[]): ToolPresentationEvent[] {
	return events
		.filter((e): e is Extract<AgentEvent, { type: "tool_presentation" }> => e.type === "tool_presentation")
		.map(e => e.event);
}

async function runEvalLoop(
	backendResult: Record<string, unknown>,
	args: Record<string, unknown>,
	chunks: readonly string[] = [],
): Promise<{ events: AgentEvent[]; presEvents: ToolPresentationEvent[] }> {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: ExecutorBackendExecOptions,
	) => {
		for (const chunk of chunks) options.onChunk?.(chunk);
		return {
			output: "",
			exitCode: 0,
			termination: undefined,
			truncated: false,
			artifactId: undefined,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
			displayOutputs: [],
			...backendResult,
		};
	}) as never);
	const tool = new EvalTool(mockSession());
	const context: AgentContext = {
		systemPrompt: [""],
		messages: [],
		tools: [tool as never],
	};
	const mock = createMockModel({
		responses: [
			{
				content: [
					{
						type: "toolCall",
						id: "call-eval-e2e",
						name: "eval",
						arguments: args,
					},
				],
			},
			{ content: ["done"] },
		],
	});
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		getToolContext: threadingHost as never,
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: "user", content: [{ type: "text", text: "run eval" }] }] as never,
		context,
		config,
		undefined,
		mock.stream,
	);
	try {
		for await (const event of stream) events.push(event);
	} catch {
		// lifecycle errors may propagate; the wire assertions are the point
	}
	return { events, presEvents: presentationEvents(events) };
}

function toolResultText(events: readonly AgentEvent[]): string {
	const end = events.find(
		(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
	);
	const content = end?.result.content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block =>
			typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
				? block.text
				: "",
		)
		.join("\n");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("eval end-to-end through agentLoop: literal wire frames", () => {
	it("keeps raw whitespace on ACP stdout-only terminal bytes while preserving the trimmed model body", async () => {
		const raw = " \n\tstdout\n  ";
		const code = "print('stdout')";
		const { events, presEvents } = await runEvalLoop({ output: raw }, { language: "js", code }, [raw]);
		expect(toolResultText(events)).toBe("stdout");

		const { updates } = runEventsThroughReducer(presEvents, metaContext());
		expect(terminalData(updates)).toBe(`${code}\n${"─".repeat(48)}\n${raw}`);
	});

	it("uses trimmed model layout but raw stdout before display on the ACP terminal", async () => {
		const raw = " \nstdout\n";
		const code = "print('stdout'); display({value: 1})";
		const { events, presEvents } = await runEvalLoop(
			{ output: raw, displayOutputs: [{ type: "json", data: { value: 1 } }] },
			{ language: "js", code },
			[raw],
		);
		expect(toolResultText(events)).toBe('stdout\n\ndisplay[1]:\n{\n  "value": 1\n}');

		const { updates } = runEventsThroughReducer(presEvents, metaContext());
		expect(terminalData(updates)).toBe(`${code}\n${"─".repeat(48)}\n${raw}\ndisplay[1]:\n{\n  "value": 1\n}`);
	});

	it("delivers JSON display() output exactly once on the meta terminal", async () => {
		const { presEvents } = await runEvalLoop(
			{ displayOutputs: [{ type: "json", data: { x: 1 } }] },
			{ language: "js", code: "display({x: 1})" },
		);
		const { updates } = runEventsThroughReducer(presEvents, metaContext());
		const data = terminalData(updates);
		expect(data).toContain('"x": 1');
		// Source echo precedes display (ordering).
		const echoIdx = data.indexOf("display({x: 1})");
		const displayIdx = data.indexOf('"x": 1');
		expect(echoIdx).toBeGreaterThanOrEqual(0);
		expect(displayIdx).toBeGreaterThan(echoIdx);
		// Exactly one delivery.
		expect((data.match(/"x": 1/g) ?? []).length).toBe(1);
	});

	it("delivers display output exactly once on the plain path", async () => {
		const { presEvents } = await runEvalLoop(
			{ displayOutputs: [{ type: "json", data: { x: 1 } }] },
			{ language: "js", code: "display({x: 1})" },
		);
		const { updates } = runEventsThroughReducer(presEvents, plainContext());
		// Plain path: source echo + display in settlement content.
		const texts = updates
			.map(u => {
				const content = (u as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const item of content) {
						if (item !== null && typeof item === "object" && "content" in item) {
							const inner = (item as { content?: unknown }).content;
							if (inner !== null && typeof inner === "object" && "text" in inner) {
								const text = (inner as { text?: unknown }).text;
								if (typeof text === "string") return text;
							}
						}
					}
				}
				return "";
			})
			.join("\n");
		expect(texts).toContain('"x": 1');
		expect((texts.match(/"x": 1/g) ?? []).length).toBe(1);
	});

	it("emits only the typed fallback for an invalid display value", async () => {
		const reflected = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error("unexpected reflection");
				},
			},
		);
		const { presEvents } = await runEvalLoop(
			{ displayOutputs: [{ type: "json", data: reflected }] },
			{ language: "js", code: "display(untrusted)" },
		);
		const display = presEvents.find(event => event.type === "display_output");
		if (display?.type !== "display_output") throw new Error("expected display output");
		expect(display.display).toEqual({ kind: "sequence", items: [{ kind: "invalid_json" }] });
		const { updates } = runEventsThroughReducer(presEvents, metaContext());
		expect(terminalData(updates)).toContain("[unavailable: non-JSON display value]");
	});

	it("settles exactly once with started before settled", async () => {
		const { presEvents } = await runEvalLoop({ output: "ok" }, { language: "js", code: "print('ok')" });
		const types = presEvents.map(e => e.type);
		const startedIdx = types.indexOf("started");
		const settledIdx = types.indexOf("settled");
		expect(startedIdx).toBeGreaterThanOrEqual(0);
		expect(settledIdx).toBeGreaterThan(startedIdx);
		// Exactly one settled.
		expect(types.filter(t => t === "settled").length).toBe(1);
	});

	it("forwards the backend timeout through the loop and correlated terminal settlement frame", async () => {
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.("partial\n");
			return {
				output: "partial\n",
				exitCode: undefined,
				termination: { kind: "timed_out", timeoutMs: 123456 },
				truncated: false,
				artifactId: undefined,
				totalLines: 1,
				totalBytes: 7,
				outputLines: 1,
				outputBytes: 7,
				displayOutputs: [],
			};
		}) as never);

		const tool = new EvalTool(mockSession());
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [tool as never],
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-timeout",
							name: "eval",
							arguments: { language: "js", code: "while(true)", timeout: 5 },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost as never,
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "run" }] }] as never,
			context,
			config,
			undefined,
			mock.stream,
		);
		try {
			for await (const event of stream) events.push(event);
		} catch {
			// may throw on timeout
		}

		const presEvents = presentationEvents(events);
		const settled = presEvents.find(e => e.type === "settled");
		if (settled?.type !== "settled") throw new Error("expected settled");
		// The backend termination is authoritative even when it differs from the
		// request's five-second cell setting.
		expect(settled.outcome.kind).toBe("failed");
		if (settled.outcome.kind === "failed" && settled.outcome.process?.kind === "timed_out") {
			expect(settled.outcome.process.timeoutMs).toBe(123456);
		}
		const { updates } = runEventsThroughReducer(presEvents, metaContext());
		expect(updates.at(-1)).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-timeout",
			status: "failed",
			_meta: { terminal_exit: { terminal_id: "call-timeout", exit_code: null, signal: null } },
		});
	});

	it("derives interrupted for cancellation with zero output", async () => {
		const { presEvents } = await runEvalLoop(
			{ output: "", exitCode: undefined, termination: { kind: "interrupted" } },
			{ language: "js", code: "abort" },
		);
		const settled = presEvents.find(e => e.type === "settled");
		if (settled?.type !== "settled") throw new Error("expected settled");
		expect(settled.outcome.kind).toBe("interrupted");
	});

	it("classifies cancellation from termination rather than output text", async () => {
		const interrupted = await runEvalLoop(
			{ output: "partial\nnot a cancellation marker", exitCode: undefined, termination: { kind: "interrupted" } },
			{ language: "js", code: "abort after output" },
		);
		const interruptedSettlement = interrupted.presEvents.find(event => event.type === "settled");
		if (interruptedSettlement?.type !== "settled") throw new Error("expected interrupted settlement");
		expect(interruptedSettlement.outcome.kind).toBe("interrupted");

		const failed = await runEvalLoop(
			{ output: "[Command cancelled]", exitCode: 1, termination: undefined },
			{ language: "js", code: "ordinary nonzero" },
		);
		const failedSettlement = failed.presEvents.find(event => event.type === "settled");
		if (failedSettlement?.type !== "settled") throw new Error("expected failed settlement");
		expect(failedSettlement.outcome).toMatchObject({ kind: "failed", process: { kind: "exited", code: 1 } });
	});

	it("replaces the terminal with one complete display-and-image snapshot", async () => {
		const { presEvents } = await runEvalLoop(
			{
				displayOutputs: [
					{ type: "json", data: { result: 42 } },
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
						mimeType: "image/png",
					},
				],
			},
			{ language: "js", code: "display({result: 42}); display(plot)" },
		);
		const { updates } = runEventsThroughReducer(presEvents, metaContext());
		const data = terminalData(updates);
		// The live terminal receives the display while the call is running.
		expect((data.match(/"result": 42/g) ?? []).length).toBe(1);
		const contentTexts = updates
			.map(u => {
				const content = (u as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const item of content) {
						if (item !== null && typeof item === "object" && "content" in item) {
							const inner = (item as { content?: unknown }).content;
							if (inner !== null && typeof inner === "object" && "text" in inner) {
								return (inner as { text?: string }).text ?? "";
							}
						}
					}
				}
				return "";
			})
			.join("\n");
		// ACP content is a complete replacement snapshot, so it preserves every
		// terminal-delivered byte exactly once alongside the typed image content.
		expect((contentTexts.match(/"result": 42/g) ?? []).length).toBe(1);
		expect(contentTexts).toContain("display({result: 42}); display(plot)");
	});
});
