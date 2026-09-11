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
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { shortenToolArgumentPaths, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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
	toolSnapshots: Array<Pick<AgentProgress, "currentTool" | "currentToolArgs" | "lastIntent" | "recentTools">>;
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

	it("keeps complete home path boundaries until the display sanitizer runs", async () => {
		const home = process.env.HOME!;
		const command = `echo ${"x".repeat(Math.max(0, 53 - home.length))} ${home}/private/file`;
		const result = await runScenario([], {
			events: [
				{
					type: "tool_execution_start",
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command },
				},
			],
		});
		const args = result.toolSnapshots.find(p => p.currentTool === "bash")?.currentToolArgs ?? "";
		const preview = shortenToolArgumentPaths(args, "command");
		expect(preview).toContain("~/private/file");
		expect(preview).not.toContain(home);
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
			expect(afterFirst?.lastIntent).toBe(finishReadFirst ? "Searching for the symbol" : "Reading the first file");
			expect(afterFirst?.recentTools[0]).toMatchObject({
				tool: finishedName,
				args: finishReadFirst ? "src/one.ts" : "needle",
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
				input: '*** Begin Patch\n<sm:edit path="src/one.ts">\n<SM:FIND>\n[draft]\n</SM:FIND>\n<SM:PUT>\nprivate body\n</SM:PUT>\n<Sm:Edit path="src/two.ts">\n<SM:FIND>\nold\n</SM:FIND>\n<SM:PUT>\nnew\n</SM:PUT>\n*** End Patch',
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
