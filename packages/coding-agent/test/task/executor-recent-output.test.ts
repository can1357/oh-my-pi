/**
 * Event-sequence equivalence tests for `progress.recentOutput`.
 *
 * The executor defers recent-output line reconstruction from every text_delta
 * to the progress emission boundary (`emitProgressNow`). These tests drive
 * `runSubprocess` with scripted event sequences and assert that EVERY observed
 * progress snapshot's `recentOutput` is byte-identical to the reference
 * algorithm applied to the raw tail at that observation point:
 *
 *   tail.slice(-8192).split("\n").filter(l => l.trim()).slice(-8).reverse()
 *
 * covering arbitrary chunk boundaries, blank/whitespace-only lines, tail
 * truncation (partial first line), Unicode code-unit slicing, message_start
 * resets, message_update content replacement, cancellation, and the final
 * flush. Snapshot arrays must also stay immutable after later refreshes.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { AssistantMessage, AssistantMessageEvent, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import type { AgentProgress, AgentStreaming } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "../helpers/session-defaults";

const TAIL_BYTES = 8 * 1024;

/**
 * Reference model: the pre-optimization algorithm, recomputed eagerly from the
 * same raw-tail state machine (append + cap, content replace, reset). Any
 * observed snapshot must equal `expected()` of the events delivered so far.
 */
class RecentOutputReference {
	tail = "";

	append(text: string): void {
		if (!text) return;
		this.tail += text;
		if (this.tail.length > TAIL_BYTES) {
			this.tail = this.tail.slice(-TAIL_BYTES);
		}
	}

	replace(texts: ReadonlyArray<string | null>): void {
		this.tail = "";
		for (const text of texts) {
			if (!text) continue;
			this.tail += text;
			if (this.tail.length > TAIL_BYTES) {
				this.tail = this.tail.slice(-TAIL_BYTES);
			}
		}
	}

	reset(): void {
		this.tail = "";
	}

	expected(): string[] {
		return this.tail
			.split("\n")
			.filter(line => line.trim())
			.slice(-8)
			.reverse();
	}
}

type Op =
	/** message_update text_delta chunk (arbitrary boundary). */
	| { kind: "delta"; text: string }
	/** message_update carrying full content blocks (replace path); null = non-text block. */
	| { kind: "replace"; texts: Array<string | null> }
	/** assistant message_start (resets the tail). */
	| { kind: "reset" }
	/** tool start+end pair — tool_execution_end flushes progress synchronously. */
	| { kind: "observe" };

interface Observation {
	got: string[];
	want: string[];
}

interface ScenarioResult {
	observations: Observation[];
	tools: Array<string | undefined>;
	toolSnapshots: Array<
		Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolIntent" | "lastIntent" | "recentTools">
	>;
	/** Snapshot arrays captured by reference + a deep copy taken at observation time. */
	immutability: Array<{ live: string[]; copy: string[] }>;
	exitCode: number;
	finalWant: string[];
}

// AssistantMessage requires api/provider/usage/stopReason the executor never
// reads on this path; cast documents the deliberate structural test double.
function assistantMessage(content: TextContent[]): AssistantMessage {
	return { role: "assistant", content } as AssistantMessage;
}

function deltaEvent(delta: string): AgentSessionEvent {
	// `partial` is unread by the executor's message_update handling; single
	// cast keeps the test double minimal (same rationale as assistantMessage).
	return {
		type: "message_update",
		message: assistantMessage([]),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistantMessage([]) },
	} as AgentSessionEvent;
}

function replaceEvent(texts: Array<string | null>): AgentSessionEvent {
	const content = texts.map(text =>
		text === null ? ({ type: "image", data: "", mimeType: "image/png" } as unknown) : { type: "text", text },
	);
	// No assistantMessageEvent → executor takes the content-replacement path.
	return {
		type: "message_update",
		message: { role: "assistant", content },
	} as AgentSessionEvent;
}

function resetEvent(): AgentSessionEvent {
	return { type: "message_start", message: assistantMessage([]) } as AgentSessionEvent;
}

function toolPair(idx: number): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: `obs-${idx}`, toolName: "read", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: `obs-${idx}`,
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		},
	] as AgentSessionEvent[];
}

function yieldEvents(): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: "final-yield", toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: "final-yield",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		},
	] as AgentSessionEvent[];
}

interface MockSessionControls {
	session: AgentSession;
	/** Resolves once prompt() has emitted every scripted event. */
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
		getToolByName: () => undefined,
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
			return true;
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

async function runScenario(
	ops: Op[],
	options?: { abortAfterOps?: boolean; events?: AgentSessionEvent[] },
): Promise<ScenarioResult> {
	const ref = new RecentOutputReference();
	const observations: Observation[] = [];
	const tools: Array<string | undefined> = [];
	const toolSnapshots: ScenarioResult["toolSnapshots"] = [];
	const immutability: Array<{ live: string[]; copy: string[] }> = [];
	const abortController = new AbortController();

	const { session } = createScriptedSession(async emit => {
		for (const op of ops) {
			// Reference state advances BEFORE delivery: processEvent is synchronous,
			// so any onProgress fired during emit() observes exactly this state.
			switch (op.kind) {
				case "delta":
					ref.append(op.text);
					emit(deltaEvent(op.text));
					break;
				case "replace":
					ref.replace(op.texts);
					emit(replaceEvent(op.texts));
					break;
				case "reset":
					ref.reset();
					emit(resetEvent());
					break;
				case "observe":
					for (const event of toolPair(observations.length)) emit(event);
					break;
			}
		}
		for (const event of options?.events ?? []) emit(event);
		if (options?.abortAfterOps) {
			abortController.abort();
			return;
		}
		for (const event of yieldEvents()) emit(event);
	});

	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

	const result = await runSubprocess({
		cwd: "/tmp",
		agent,
		task: "equivalence scenario",
		description: "recent-output equivalence",
		index: 0,
		id: `recent-output-${Math.random().toString(36).slice(2)}`,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as ModelRegistry,
		enableLsp: false,
		signal: abortController.signal,
		eventBus: new EventBus(),
		onProgress: (progress: AgentProgress) => {
			tools.push(progress.currentTool);
			toolSnapshots.push({
				currentTool: progress.currentTool,
				currentToolArgs: progress.currentToolArgs,
				currentToolIntent: progress.currentToolIntent,
				lastIntent: progress.lastIntent,
				recentTools: progress.recentTools.slice(),
			});
			observations.push({ got: [...progress.recentOutput], want: ref.expected() });
			immutability.push({ live: progress.recentOutput, copy: [...progress.recentOutput] });
		},
	});

	return { observations, tools, toolSnapshots, immutability, exitCode: result.exitCode, finalWant: ref.expected() };
}

function expectAllMatch(result: ScenarioResult, minObservations: number): void {
	expect(result.observations.length).toBeGreaterThanOrEqual(minObservations);
	for (const [index, obs] of result.observations.entries()) {
		// Index in message aids debugging without a custom matcher.
		expect({ index, lines: obs.got }).toEqual({ index, lines: obs.want });
	}
	// Final flush (finalizeRunResult → scheduleProgress(true)) sees full-stream state.
	const last = result.observations[result.observations.length - 1];
	expect(last.got).toEqual(result.finalWant);
	// Older snapshots must never be mutated by later refreshes.
	for (const snap of result.immutability) {
		expect(snap.live).toEqual(snap.copy);
	}
}

/** Deterministic PRNG (mulberry32) for the property-style scenario. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
describe("tool argument preview semantics", () => {
	afterEach(() => vi.restoreAllMocks());

	it("does not reinterpret another tool's input as an edit path", async () => {
		const result = await runScenario([], {
			events: [
				{
					type: "tool_execution_start",
					toolCallId: "custom-1",
					toolName: "custom-search",
					args: { input: "[draft]", query: "real query" },
				},
			],
		});
		expect(result.toolSnapshots.find(p => p.currentTool === "custom-search")?.currentToolArgs).toBe("real query");
	});

	it("extracts apply_patch wire-alias paths in executor progress", async () => {
		const input = ["*** Begin Patch", "*** Update File: src/aliased.ts", "@@", "-old", "+new", "*** End Patch"].join(
			"\n",
		);
		const result = await runScenario([], {
			events: [
				{
					type: "tool_execution_start",
					toolCallId: "apply-patch-1",
					toolName: "apply_patch",
					args: { input },
				},
			],
		});

		const active = result.toolSnapshots.find(snapshot => snapshot.currentTool === "apply_patch");
		expect(active?.currentToolArgs).toBe("src/aliased.ts");
	});

	it("shortens home paths before bounding the argument preview", async () => {
		const home = os.homedir();
		// Fits the preview bound only once the home directory is shortened; bounding the raw command first
		// would cut the path inside the home directory or its descendant.
		const filler = "x".repeat(TRUNCATE_LENGTHS.CONTENT - "echo  ~/private/file".length);
		const result = await runScenario([], {
			events: [
				{
					type: "tool_execution_start",
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command: `echo ${filler} ${home}/private/file` },
				},
			],
		});
		const active = result.toolSnapshots.find(p => p.currentTool === "bash");
		expect(active?.currentToolArgs).toBe(`echo ${filler} ~/private/file`);
	});

	it("bounds large arguments in both active and completed progress snapshots", async () => {
		const result = await runScenario([], {
			events: [
				{
					type: "tool_execution_start",
					toolCallId: "large",
					toolName: "bash",
					args: { command: `echo ${"payload ".repeat(20_000)}` },
				},
				{
					type: "tool_execution_end",
					toolCallId: "large",
					toolName: "bash",
					result: { content: [] },
					isError: false,
				},
			],
		});
		const active = result.toolSnapshots.find(p => p.currentTool === "bash")!;
		const completed = result.toolSnapshots.find(p => p.recentTools[0]?.tool === "bash")!;
		expect(active.currentToolArgs).toContain("echo payload");
		expect(active.currentToolArgs!.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.CONTENT);
		expect(completed.recentTools[0].args.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.CONTENT);
	});
});

describe("streaming progress", () => {
	afterEach(() => vi.restoreAllMocks());

	it("publishes what the model writes before a call runs: reasoning, prose, then the call until it runs", async () => {
		// Each event lands past the coalescing window, so each publishes its own snapshot.
		let clock = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => (clock += 200));
		const partial = (...content: AssistantMessage["content"]) => ({ role: "assistant", content }) as AssistantMessage;
		const update = (assistantMessageEvent: AssistantMessageEvent): AgentSessionEvent =>
			({ type: "message_update", message: partial(), assistantMessageEvent }) as AgentSessionEvent;
		const write = (args: Record<string, unknown>): ToolCall => ({
			type: "toolCall",
			id: "write-1",
			name: "write",
			arguments: args,
		});
		const prose: TextContent = { type: "text", text: "Next, the norm test" };
		const written = write({ i: "Write the norm test.", path: "tests/test_norm.py", content: "import os" });
		const steps: AgentSessionEvent[] = [
			resetEvent(),
			update({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial: partial() }),
			deltaEvent(prose.text),
			update({ type: "toolcall_start", contentIndex: 1, partial: partial(prose, write({})) }),
			update({ type: "toolcall_delta", contentIndex: 1, delta: "import os", partial: partial(prose, written) }),
			{ type: "message_end", message: partial(prose, written) } as AgentSessionEvent,
			{
				type: "tool_execution_start",
				toolCallId: "write-1",
				toolName: "write",
				args: { path: "tests/test_norm.py", content: "import os" },
				intent: "Write the norm test",
			} as AgentSessionEvent,
		];
		let latest: AgentProgress | undefined;
		const seen: Array<Pick<AgentProgress, "streaming" | "currentTool">> = [];
		const { session } = createScriptedSession(async emit => {
			for (const event of steps) {
				emit(event);
				seen.push({ streaming: latest?.streaming, currentTool: latest?.currentTool });
			}
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "streaming scenario",
			description: "streaming progress",
			index: 0,
			id: `streaming-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
			onProgress: progress => {
				latest = progress;
			},
		});

		const call: AgentStreaming = {
			kind: "call",
			tool: "write",
			args: "tests/test_norm.py",
			argsKey: "path",
			intent: "Write the norm test",
		};
		expect(seen).toEqual([
			{ streaming: undefined, currentTool: undefined },
			{ streaming: { kind: "thinking" }, currentTool: undefined },
			{ streaming: { kind: "text" }, currentTool: undefined },
			{ streaming: { kind: "call", tool: "write" }, currentTool: undefined },
			{ streaming: call, currentTool: undefined },
			// The response ended; the call it wrote shows until it runs, not the call before it.
			{ streaming: call, currentTool: undefined },
			{ streaming: undefined, currentTool: "write" },
		]);
	});
});

describe("clock-only progress", () => {
	afterEach(() => vi.restoreAllMocks());

	it("skips snapshots that change only durationMs, keeps real changes, flushes and a heartbeat", async () => {
		// Every step lands past the coalescing window, so only the clock-only rule can hold a snapshot back.
		let clock = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const partial = () => ({ role: "assistant", content: [] }) as unknown as AssistantMessage;
		const thinking: AgentSessionEvent = {
			type: "message_update",
			message: partial(),
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: partial() },
		} as AgentSessionEvent;
		const pause = { type: "agent_pause", messages: [] } as unknown as AgentSessionEvent;
		const steps: Array<{ label: string; advance: number; event: AgentSessionEvent }> = [
			{ label: "first thinking", advance: 200, event: thinking },
			{ label: "thinking again", advance: 200, event: thinking },
			{ label: "thinking again", advance: 200, event: thinking },
			{ label: "thinking again", advance: 200, event: thinking },
			{ label: "prose", advance: 200, event: deltaEvent("hello") },
			{ label: "empty delta", advance: 200, event: deltaEvent("") },
			{ label: "heartbeat", advance: 5_000, event: deltaEvent("") },
			{ label: "pause", advance: 200, event: pause },
			{ label: "unchanged flush", advance: 200, event: pause },
		];
		const durations: number[] = [];
		let busFrames = 0;
		const emitted: Array<{ label: string; count: number }> = [];
		const { session } = createScriptedSession(async emit => {
			for (const step of steps) {
				clock += step.advance;
				const before = durations.length;
				emit(step.event);
				emitted.push({ label: step.label, count: durations.length - before });
			}
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, () => {
			busFrames++;
		});

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "clock-only scenario",
			description: "clock-only progress",
			index: 0,
			id: `clock-only-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus,
			onProgress: progress => {
				durations.push(progress.durationMs);
			},
		});

		expect(emitted).toEqual([
			{ label: "first thinking", count: 1 },
			{ label: "thinking again", count: 0 },
			{ label: "thinking again", count: 0 },
			{ label: "thinking again", count: 0 },
			{ label: "prose", count: 1 },
			{ label: "empty delta", count: 0 },
			{ label: "heartbeat", count: 1 },
			{ label: "pause", count: 1 },
			{ label: "unchanged flush", count: 1 },
		]);
		// The progress channel carries exactly the snapshots onProgress sees.
		expect(busFrames).toBe(durations.length);
		// The clock still advances across emitted snapshots, the final one included.
		for (let i = 1; i < durations.length; i++) expect(durations[i]).toBeGreaterThanOrEqual(durations[i - 1]);
	});

	it("leaves an emitted snapshot's recent tools unchanged when a later tool ends", async () => {
		const { session } = createScriptedSession(async emit => {
			for (const event of [...toolPair(0), ...toolPair(1)]) emit(event);
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);
		const snapshots: AgentProgress[] = [];

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "recent tools scenario",
			description: "recent tools snapshots",
			index: 0,
			id: `recent-tools-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
			onProgress: progress => {
				snapshots.push(progress);
			},
		});

		const first = snapshots.find(progress => progress.recentTools.length > 0);
		expect(first?.recentTools).toHaveLength(1);
	});

	it("re-reads a streamed call's arguments at most once per coalescing window while its snapshots are dropped", async () => {
		let clock = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		// The streamed call's arguments count their reads: each preview refresh parses them.
		let argumentReads = 0;
		const input = { path: "src/a.ts", content: "x" };
		const call = {
			type: "toolCall",
			id: "write-1",
			name: "write",
			get arguments() {
				argumentReads++;
				return input;
			},
		} as unknown as ToolCall;
		const partial = { role: "assistant", content: [call] } as unknown as AssistantMessage;
		const update = (type: "toolcall_start" | "toolcall_delta"): AgentSessionEvent =>
			({
				type: "message_update",
				message: partial,
				assistantMessageEvent:
					type === "toolcall_start"
						? { type, contentIndex: 0, partial }
						: { type, contentIndex: 0, delta: "x", partial },
			}) as AgentSessionEvent;
		// The preview never changes, so every snapshot after the first is clock-only and dropped.
		const steps: Array<{ label: string; advance: number; event: AgentSessionEvent }> = [
			{ label: "call starts", advance: 200, event: update("toolcall_start") },
			{ label: "next window", advance: 200, event: update("toolcall_delta") },
			{ label: "same window", advance: 10, event: update("toolcall_delta") },
			{ label: "same window", advance: 10, event: update("toolcall_delta") },
			{ label: "same window", advance: 10, event: update("toolcall_delta") },
			{ label: "next window", advance: 200, event: update("toolcall_delta") },
		];
		let emits = 0;
		const seen: Array<{ label: string; refreshed: boolean; emitted: boolean }> = [];
		const { session } = createScriptedSession(async emit => {
			for (const step of steps) {
				clock += step.advance;
				const reads = argumentReads;
				const before = emits;
				emit(step.event);
				seen.push({ label: step.label, refreshed: argumentReads > reads, emitted: emits > before });
			}
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "streamed call scenario",
			description: "streamed call coalescing",
			index: 0,
			id: `streamed-call-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
			onProgress: () => {
				emits++;
			},
		});

		expect(seen).toEqual([
			{ label: "call starts", refreshed: true, emitted: true },
			{ label: "next window", refreshed: true, emitted: false },
			{ label: "same window", refreshed: false, emitted: false },
			{ label: "same window", refreshed: false, emitted: false },
			{ label: "same window", refreshed: false, emitted: false },
			{ label: "next window", refreshed: true, emitted: false },
		]);
	});
});

describe("recentOutput event-sequence equivalence (deferred reconstruction)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("publishes fast tool starts even within the progress coalescing window", async () => {
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		const result = await runScenario([{ kind: "delta", text: "Reading" }, { kind: "observe" }, { kind: "observe" }]);
		expect(result.exitCode).toBe(0);
		expect(result.tools.filter(tool => tool === "read")).toHaveLength(2);
		for (let index = 0; index < result.tools.length; index++) {
			if (result.tools[index] === "read") expect(result.tools[index + 1]).toBeUndefined();
		}
	});

	it("keeps another concurrent tool running and attributes each completion to its call", async () => {
		for (const finishReadFirst of [true, false]) {
			const readEvents = toolPair(1);
			readEvents[0] = {
				type: "tool_execution_start",
				toolCallId: "obs-1",
				toolName: "read",
				args: { path: "src/one.ts" },
				intent: "Reading the first file",
			};
			const searchEvents: AgentSessionEvent[] = [
				{
					type: "tool_execution_start",
					toolCallId: "search-2",
					toolName: "grep",
					args: { pattern: "needle" },
					intent: "Searching for the symbol",
				},
				{
					type: "tool_execution_end",
					toolCallId: "search-2",
					toolName: "grep",
					result: { content: [] },
					isError: true,
				},
			];
			const events = [
				readEvents[0],
				searchEvents[0],
				...(finishReadFirst ? [readEvents[1], searchEvents[1]] : [searchEvents[1], readEvents[1]]),
			];
			const result = await runScenario([], { events });
			expect(result.exitCode).toBe(0);
			const finishedName = finishReadFirst ? "read" : "grep";
			const afterFirst = result.toolSnapshots.find(snapshot => snapshot.recentTools[0]?.tool === finishedName);
			expect(afterFirst?.currentTool).toBe(finishReadFirst ? "grep" : "read");
			expect(afterFirst?.currentToolArgs).toBe(finishReadFirst ? "needle" : "src/one.ts");
			// The row shows the surviving call's own intent, not the other call's.
			expect(afterFirst?.currentToolIntent).toBe(
				finishReadFirst ? "Searching for the symbol" : "Reading the first file",
			);
			expect(afterFirst?.recentTools[0]).toMatchObject({
				tool: finishedName,
				args: finishReadFirst ? "src/one.ts" : "needle",
				intent: finishReadFirst ? "Reading the first file" : "Searching for the symbol",
				isError: !finishReadFirst,
			});
		}
	});

	it("extracts source and destination paths across supported edit modes", async () => {
		for (const args of [
			{
				input: "*** Begin Patch\n[src/one.ts#A1B2]\nPUT 1.=1:\n+private body\n[src/two.ts#C3D4]\nCUT 2.=2\n*** End Patch",
			},
			{ input: "*** Begin Patch\n[src/one.ts#A1B2]\nMV src/two.ts\n*** End Patch" },
			{
				input: "*** Begin Patch\n*** Update File: src/one.ts\n@@\n [draft]\n-old body\n+private body\n*** Delete File: src/two.ts\n*** End Patch",
			},
			{
				input: "*** Begin Patch\n*** Update File: src/one.ts\n*** Move to: src/two.ts\n@@\n-old\n+new\n*** End Patch",
			},
			{
				input: "*** Begin Patch\n*** Edit File: src/one.ts\n*** Find\n[draft]\n*** Replace\nprivate body\n*** Edit File: src/two.ts\n*** Find\nold\n*** Replace\nnew\n*** End Patch",
			},
			{ path: "src/one.ts", edits: [{ op: "update", rename: "src/two.ts", diff: "@@\n-old\n+new" }] },
		]) {
			const result = await runScenario([], {
				events: [
					{ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args },
					{
						type: "tool_execution_end",
						toolCallId: "edit-1",
						toolName: "edit",
						result: { content: [] },
						isError: false,
					},
				],
			});
			expect(result.exitCode).toBe(0);
			expect(result.toolSnapshots.find(snapshot => snapshot.currentTool === "edit")?.currentToolArgs).toBe(
				"src/one.ts, src/two.ts",
			);
			expect(
				result.toolSnapshots.find(snapshot => snapshot.recentTools[0]?.tool === "edit")?.recentTools[0],
			).toMatchObject({
				tool: "edit",
				args: "src/one.ts, src/two.ts",
				argsKey: "path",
			});
		}
	});

	it("counts the lines a finished edit changed, by its result's diff, and nothing for failures or other tools", async () => {
		const diff = "+1|added\n+2|added too\n-3|gone\n 4|kept";
		const call = (id: string, toolName: string, isError: boolean): AgentSessionEvent[] => [
			{ type: "tool_execution_start", toolCallId: id, toolName, args: { path: "src/one.ts" } },
			{ type: "tool_execution_end", toolCallId: id, toolName, result: { content: [], details: { diff } }, isError },
		];
		const result = await runScenario([], {
			events: [...call("ok", "edit", false), ...call("bad", "edit", true), ...call("other", "read", false)],
		});
		const finished =
			result.toolSnapshots.find(snapshot => snapshot.recentTools[0]?.tool === "read")?.recentTools ?? [];
		expect(finished.map(({ tool, isError, added, removed }) => ({ tool, isError, added, removed }))).toEqual([
			{ tool: "read", isError: false, added: undefined, removed: undefined },
			{ tool: "edit", isError: true, added: undefined, removed: undefined },
			{ tool: "edit", isError: false, added: 2, removed: 1 },
		]);
	});

	it("matches the reference across arbitrary chunk boundaries and blank lines", async () => {
		const corpus = "first line\n\n  \nsecond line\nthird\t line \n\n\nfourth\npartial trailing";
		const sizes = [1, 3, 7, 2, 11, 5, 1, 13, 4];
		const ops: Op[] = [];
		let offset = 0;
		let sizeIdx = 0;
		while (offset < corpus.length) {
			const size = sizes[sizeIdx % sizes.length];
			sizeIdx++;
			ops.push({ kind: "delta", text: corpus.slice(offset, offset + size) });
			offset += size;
			ops.push({ kind: "observe" });
		}
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, corpus.length / 13);
		// Sanity: the scenario actually produced visible lines.
		const last = result.observations[result.observations.length - 1];
		expect(last.got[0]).toBe("partial trailing");
		expect(last.got).toContain("third\t line ");
	});

	it("preserves partial-first-line semantics across tail truncation", async () => {
		const ops: Op[] = [];
		// One line far longer than the cap: recentOutput[0] must be the code-unit
		// suffix of the tail, not the whole line.
		ops.push({ kind: "delta", text: `HEAD-${"x".repeat(9000)}` });
		ops.push({ kind: "observe" });
		// Then structured lines pushing the cut point through line boundaries.
		for (let i = 0; i < 40; i++) {
			ops.push({ kind: "delta", text: `line-${i}-${"y".repeat(97)}\n` });
			if (i % 7 === 0) ops.push({ kind: "observe" });
		}
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 6);
	});

	it("slices by UTF-16 code units across astral characters at the cap", async () => {
		const ops: Op[] = [];
		// Surrogate pairs (𝄞 = 2 code units) so the -8192 cut can land mid-pair.
		ops.push({ kind: "delta", text: "𝄞".repeat(4000) });
		ops.push({ kind: "observe" });
		ops.push({ kind: "delta", text: `\né-ü-𝄞 mixed ${"𝄞".repeat(150)}\n` });
		ops.push({ kind: "delta", text: "z".repeat(300) });
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 2);
	});

	it("handles exact 8192-code-unit cap boundaries and lone surrogates", async () => {
		const ops: Op[] = [];
		// Fill the tail to exactly the cap: 16 x (511 chars + "\n") = 8192 units.
		const line = "L".repeat(511);
		for (let i = 0; i < 16; i++) ops.push({ kind: "delta", text: `${line}\n` });
		ops.push({ kind: "observe" }); // tail.length === 8192 — no truncation yet
		ops.push({ kind: "delta", text: "x" }); // 8193 — cut exactly one leading unit
		ops.push({ kind: "observe" });
		// A high surrogate split from its low half across chunk boundaries, then
		// an unpaired high surrogate that stays lone in the tail.
		ops.push({ kind: "delta", text: "\uD83D" });
		ops.push({ kind: "observe" });
		ops.push({ kind: "delta", text: "\uDE00 paired-now\n" });
		ops.push({ kind: "delta", text: "lone-tail \uD800" });
		ops.push({ kind: "observe" });
		// Land the cap cut mid-pair: 64 astral pairs then 8191 filler units leave
		// exactly one unit (a lone low surrogate) of the emoji run in the tail.
		ops.push({ kind: "delta", text: "😀".repeat(64) });
		ops.push({ kind: "delta", text: "z".repeat(TAIL_BYTES - 1) });
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 5);
	});

	it("resets on assistant message_start and replaces on content updates", async () => {
		const ops: Op[] = [
			{ kind: "delta", text: "old stream line\nmore old\n" },
			{ kind: "observe" },
			{ kind: "reset" },
			{ kind: "observe" },
			{ kind: "delta", text: "fresh after reset\n" },
			{ kind: "observe" },
			{ kind: "replace", texts: ["replaced A\n", null, "", "replaced B\npartial C"] },
			{ kind: "observe" },
			{ kind: "delta", text: " extended" },
			{ kind: "observe" },
			{ kind: "replace", texts: [null, ""] },
			{ kind: "observe" },
			{ kind: "delta", text: "after empty replace" },
			{ kind: "observe" },
		];
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 7);
		// The reset actually cleared: post-reset observation saw [].
		const emptyObserved = result.observations.some(obs => obs.want.length === 0 && obs.got.length === 0);
		expect(emptyObserved).toBe(true);
	});

	it("handles whitespace-only trailing segments (unrepresentable last line)", async () => {
		const ops: Op[] = [
			{ kind: "delta", text: "line1\n   " },
			{ kind: "observe" },
			{ kind: "delta", text: "\t " },
			{ kind: "observe" },
			{ kind: "delta", text: "x" },
			{ kind: "observe" },
			{ kind: "delta", text: "\n\n \n" },
			{ kind: "observe" },
		];
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 4);
		const last = result.observations[result.observations.length - 1];
		expect(last.got).toEqual(["   \t x", "line1"]);
	});

	it("final flush on cancellation reflects the full delivered stream", async () => {
		const ops: Op[] = [
			{ kind: "delta", text: "work in progress\nsecond line" },
			{ kind: "observe" },
			{ kind: "delta", text: " grows without another observe boundary\ntail line" },
		];
		const result = await runScenario(ops, { abortAfterOps: true });
		expect(result.exitCode).not.toBe(0);
		expectAllMatch(result, 2);
		const last = result.observations[result.observations.length - 1];
		expect(last.got[0]).toBe("tail line");
	});

	it("property: seeded random chunk/reset/replace sequences match at every emission", async () => {
		const rand = mulberry32(0x5eed);
		const alphabet = ["a", "b", " ", "\t", "\n", "é", "𝄞", "0", "\n\n", "word ", "line\n"];
		const ops: Op[] = [];
		for (let i = 0; i < 400; i++) {
			const roll = rand();
			if (roll < 0.02) {
				ops.push({ kind: "reset" });
			} else if (roll < 0.05) {
				const texts: Array<string | null> = [];
				const blocks = 1 + Math.floor(rand() * 3);
				for (let b = 0; b < blocks; b++) {
					texts.push(
						rand() < 0.2
							? null
							: alphabet[Math.floor(rand() * alphabet.length)].repeat(1 + Math.floor(rand() * 40)),
					);
				}
				ops.push({ kind: "replace", texts });
			} else {
				let chunk = "";
				const pieces = 1 + Math.floor(rand() * 24);
				for (let p = 0; p < pieces; p++) {
					chunk += alphabet[Math.floor(rand() * alphabet.length)];
				}
				ops.push({ kind: "delta", text: chunk });
			}
			if (i % 17 === 0) ops.push({ kind: "observe" });
		}
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 20);
	});
});
