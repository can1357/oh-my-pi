import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CompactTool } from "@oh-my-pi/pi-coding-agent/tools/compact";
import { TempDir } from "@oh-my-pi/pi-utils";

// A trivial tool the scripted model can pair with `compact` so a single turn
// can carry a SECOND runnable tool call — the agent loop then reports
// `willContinue === true` (mid-loop) at that boundary, which is exactly the
// case the wiring must NOT compact on.
const noopTool: AgentTool = {
	name: "noop",
	label: "Noop",
	description: "Does nothing; keeps the tool loop going for another turn.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text" as const, text: "noop done" }] };
	},
};

// A terminal `yield` tool: its non-array `result` makes the tool result
// terminal, so agent-core aborts the run with the graceful terminal-yield
// reason and the settle `onTurnEnd` fires in the SAME turn that carried the
// `compact` result — the ordering that raced the old async-set marker.
const yieldTool: AgentTool = {
	name: "yield",
	label: "Yield",
	description: "Finish the task.",
	parameters: type({ result: type("unknown") }),
	async execute() {
		return { content: [{ type: "text" as const, text: "yielded" }] };
	},
};

// A `write` stub: prewalk treats a non-error `write`/`edit` result as the first
// workspace-mutating action, so a turn carrying one drives the prewalk hand-off
// — the awaited `setModelTemporary` inside `onTurnEnd`, which is the only
// test-reachable await between the hook's entry abort check and the point it
// schedules a requested compaction.
const writeTool: AgentTool = {
	name: "write",
	label: "Write",
	description: "Writes a file.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text" as const, text: "wrote" }] };
	},
};

/** A stub compaction result so `session.compact` can be spied without a real LLM summary. */
function fakeCompaction(): CompactionResult {
	return { summary: "stub summary", firstKeptEntryId: "kept-1", tokensBefore: 0 };
}

/** Top-level ToolSession stub for constructing the real CompactTool. */
function topLevelToolSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		taskDepth: 0,
	};
}

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

async function createHarness(
	responses: MockHandler[],
	options: {
		includeCompactTool?: boolean;
		extensionRunner?: ExtensionRunner;
		/** Replace the built-in `compact` tool with a wrapper of the same name. */
		compactToolOverride?: AgentTool;
	} = {},
): Promise<Harness & { mock: MockModel }> {
	const includeCompactTool = options.includeCompactTool ?? true;
	const tempDir = TempDir.createSync("@pi-compact-tool-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		// Auto-compaction OFF: any compaction we observe must be the one the
		// `compact` tool requested, never a threshold/idle fire.
		"compaction.enabled": false,
		// Real lifecycle tests drive the actual `compact()`; pin the summary
		// method so method selection resolves without a remote/vision path. A
		// too-small session still short-circuits to "Nothing to compact" before
		// any LLM summary call, so no API key is needed.
		"compaction.methodOrder": ["soft"],
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	// The real CompactTool: its result carries `toolName === "compact"` +
	// `details.requested`, which is exactly what the onTurnEnd wiring scans for.
	// A top-level ToolSession stub is enough — the tool only reads taskDepth.
	// `compactToolOverride` swaps in a same-named wrapper to model an extension
	// that re-registered the built-in `compact` name.
	const compactTool = options.compactToolOverride ?? (new CompactTool(topLevelToolSession()) as AgentTool);
	const tools: AgentTool[] = includeCompactTool
		? [noopTool, yieldTool, writeTool, compactTool]
		: [noopTool, yieldTool, writeTool];

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		extensionRunner: options.extensionRunner,
	});
	const harness = { session, authStorage, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

describe("AgentSession compact tool onTurnEnd wiring", () => {
	it("runs a compaction when a settling turn carries a non-error compact result (e)", async () => {
		const { session } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		// Observable seam (brief-endorsed): spy the public compaction entrypoint so
		// no real LLM summary runs. A call proves #applyRequestedCompaction fired
		// the requested compaction at settle. Removing the onTurnEnd call → 0 calls.
		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("do the thing then compact");

		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("forwards trimmed instructions from the compact result into the compaction (e)", async () => {
		const { session } = await createHarness([
			{
				content: [
					{
						type: "toolCall",
						id: "call_compact",
						name: "compact",
						arguments: { instructions: "  keep the failing test  " },
					},
				],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact with focus");

		// End-to-end trim-carry: execute() trims into details.instructions, and the
		// settle path passes that verbatim to compact(). "\u00a0" defends the trim.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).toHaveBeenCalledWith("keep the failing test");
	});

	it("does NOT compact at mid-loop boundaries; only once at the genuine settle (f)", async () => {
		// Turn 1 emits compact + noop → both run → willContinue true (mid-loop).
		// Turn 2 emits another noop → runs → willContinue true (mid-loop).
		// Turn 3 settles (stop) → willContinue false.
		// The compact result is live in `messages` at ALL THREE boundaries, but the
		// gate must apply it only at the final settle. If the `willContinue === false`
		// guard were removed, #applyRequestedCompaction would fire at every boundary
		// once the compact result exists → 3 calls. Exactly-once proves the gate.
		const { session } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} },
					{ type: "toolCall", id: "call_noop_1", name: "noop", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_noop_2", name: "noop", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact mid-loop then keep working");

		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("does not compact when the compact result is an error result (e: non-error guard)", async () => {
		// Omit the compact tool so the scripted call resolves to a synthetic
		// "Tool compact not found" error result (isError: true). The scan skips
		// error results, so no compaction runs.
		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "call_missing", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			{ includeCompactTool: false },
		);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact but it errors");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	// Each case builds a whole session harness and drives a full prompt
	// lifecycle, so running all three inside one `it` stacked ~3.6s of real work
	// against bun's 5s default and went flaky on a loaded box. `it.each` gives
	// every case its own budget, matching how the neighbouring session-boundary
	// suites parametrize.
	it.each(["Nothing to compact (session too small)", "Already compacted", "Compaction already in progress"])(
		"swallows the benign compaction failure %p at turn settle without throwing (g / 8)",
		async message => {
			// These are the no-op / already-running cases #applyRequestedCompaction is
			// documented to swallow (regex: nothing to compact | already compacted |
			// too small | already in progress). "Compaction already in progress" also
			// covers the re-entrancy branch (point 8). None may escape the settle path.
			const { session } = await createHarness([
				{
					content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			]);
			const compactSpy = vi.spyOn(session, "compact").mockRejectedValue(new Error(message));

			// prompt() must resolve — the benign failure is caught inside the settle
			// hook. If it escaped, the turn would reject.
			await expect(session.prompt("compact then benign failure")).resolves.toBeDefined();
			expect(compactSpy).toHaveBeenCalledTimes(1);
		},
	);

	it("completes the prompt when the real compact() lifecycle runs at settle (no resolved spy)", async () => {
		// The deadlock the P1 review flagged: onTurnEnd is awaited from inside the
		// active agent loop, and compact() aborts that operation (its abort() waits
		// on agent.waitForIdle(), which only resolves once onTurnEnd returns and the
		// loop unwinds). Awaiting compact() inline would hang the prompt forever.
		// Drive the REAL compact() — not a resolved spy — so a regression to the
		// inline await reproduces the hang here instead of hiding behind the spy.
		const { session } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		// Observe the real entrypoint without replacing it, so the actual lifecycle
		// (defer past settle → abort is a no-op → too-small no-op) still executes.
		const compactSpy = vi.spyOn(session, "compact");

		// A pre-fix inline await never resolves, so the prompt would hang; awaiting
		// it directly turns that into a bun:test timeout failure (the per-test
		// timeout below), pinning the regression to this test rather than masking
		// it with a resolved spy. Post-fix the deferred compaction runs after the
		// run unwinds and the prompt settles normally.
		await session.prompt("do the thing then compact");
		await session.waitForIdle();

		// The requested compaction ran for real (session too small → benign no-op,
		// swallowed inside the settle path).
		expect(compactSpy).toHaveBeenCalledTimes(1);
	}, 15_000);

	it("does NOT re-fire compaction on a later prompt that made no compact call (turn-scoped)", async () => {
		// The blocking turn-scoping bug: a compact result that survives the
		// transcript (guaranteed on the too-small no-op path) must not re-trigger
		// compaction on a later, unrelated settle. Prompt 1 requests compaction and
		// no-ops (too small). Prompt 2 makes NO compact call; its settle must not
		// re-consume the stale result. Pre-fix (whole-transcript scan, no consume
		// marker) prompt 2 re-fires → 2 calls. Turn-scoped → exactly 1.
		const { session } = await createHarness([
			// Prompt 1: request compaction.
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["ONE"], stopReason: "stop" },
			// Prompt 2: a plain noop turn, then a text stop. No compact call.
			{
				content: [{ type: "toolCall", id: "call_noop", name: "noop", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["TWO"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact");

		await session.prompt("finish task then compact");
		await session.waitForIdle();
		expect(compactSpy).toHaveBeenCalledTimes(1);

		await session.prompt("now do unrelated work");
		await session.waitForIdle();
		// Still exactly one: the second settle found no request for ITS turn.
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("captures the request from the turn even when compact and the terminal yield settle together (a)", async () => {
		// A single turn carries the `compact` result AND a terminal `yield`, so the
		// run aborts with the graceful terminal-yield reason and the settle
		// `onTurnEnd` fires in the SAME turn that produced the compact result. The
		// old wiring recorded the request from the fire-and-forget `message_end`
		// listener, which `Agent.#emit` does not await — so the awaited settle could
		// reach `#scheduleRequestedCompaction()` before that async listener set the
		// marker, and the compaction was silently dropped (0 calls) while the late
		// marker leaked into a later turn. Reading it synchronously from
		// `context.toolResults` in `onTurnEnd` closes that window: the result is
		// paired with the turn before the hook runs, so it is always visible here.
		const { session } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} },
					{ type: "toolCall", id: "call_yield", name: "yield", arguments: { result: { data: { ok: true } } } },
				],
				stopReason: "toolUse",
			},
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact and yield in one turn");
		await session.waitForIdle();

		// Exactly one: the settle read the compact result from its own turn's
		// results, not from a marker a still-pending listener had yet to set.
		expect(compactSpy).toHaveBeenCalledTimes(1);
	}, 15_000);

	it("does NOT fire a stale request on the next clean prompt when the compacting run errored before settle (b)", async () => {
		// `compact` is requested and its result pairs with the turn, but the
		// FOLLOWING inference errors — agent-core skips `onTurnEnd` on an errored
		// turn (see agent-loop `emitTurnEnd`), so the settle that would have
		// scheduled the compaction never runs and the request is left un-applied.
		// A later, unrelated prompt must NOT inherit it. The per-run reset clears
		// the pending request before the next prompt begins; without that clear the
		// stale request fires at prompt 2's clean settle → 1 call.
		const { session } = await createHarness([
			// Prompt 1: request compaction, then the next inference errors out.
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ throw: "provider exploded after compact" },
			// Prompt 2: a plain noop turn, then a clean text stop. No compact call.
			{
				content: [{ type: "toolCall", id: "call_noop", name: "noop", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["TWO"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		// The errored inference makes prompt 1 settle without ever reaching the
		// compaction schedule; the run resolves (the error is surfaced, not thrown).
		await session.prompt("compact then the model errors");
		await session.waitForIdle();

		await session.prompt("now do unrelated clean work");
		await session.waitForIdle();

		// Never fired: prompt 1's errored settle skipped the schedule, and the
		// per-run reset dropped the un-applied request before prompt 2's settle.
		expect(compactSpy).not.toHaveBeenCalled();
	}, 15_000);

	it("lets a session_stop continuation scheduled at the compacting settle run before compaction aborts it", async () => {
		// The compact-triggering settle also fires a session_stop hook that
		// schedules a hidden continuation turn. That continuation runs as a
		// tracked post-prompt task, which `agent.waitForIdle()` does NOT cover.
		// Since `compact()` calls `abort()` — draining the post-prompt controller
		// — the deferred compaction MUST first await the post-prompt tasks
		// settling, or the continuation is cancelled before it can run. Observe
		// the continuation by counting the extra model call it drives, and pin the
		// ordering: the continuation must finish BEFORE compact() is entered.
		let sessionStopCalls = 0;
		const extensionRunner = {
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop",
			// Only the first settle schedules a continuation; the continuation's
			// own settle returns undefined so the run terminates.
			emitSessionStop: async () => {
				sessionStopCalls++;
				return sessionStopCalls === 1 ? { continue: true, additionalContext: "keep going" } : undefined;
			},
		} as unknown as ExtensionRunner;

		const { session, mock } = await createHarness(
			[
				// Turn 1: request compaction and stop — this settle fires session_stop.
				{
					content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["first answer"], stopReason: "stop" },
				// Turn 2: the hidden session_stop continuation turn. Its model call
				// is the observable proof the continuation ran.
				{ content: ["continuation answer"], stopReason: "stop" },
			],
			{ extensionRunner },
		);

		// Prove ordering, not just occurrence: compact() must not be entered until
		// the continuation turn has streamed. Spy compact() to snapshot the model
		// call count at entry — a pre-fix abort would race the continuation and
		// enter compact() with the continuation turn's call still missing.
		let modelCallsAtCompact = -1;
		const compactSpy = vi.spyOn(session, "compact").mockImplementation(async () => {
			modelCallsAtCompact = mock.calls.length;
			return fakeCompaction();
		});

		await session.prompt("do the thing then compact");
		await session.waitForIdle();

		// The continuation turn ran: three model calls (turn 1, its stop, the
		// hidden continuation), and the hook fired at both settles.
		expect(sessionStopCalls).toBe(2);
		expect(mock.calls).toHaveLength(3);
		// The requested compaction still ran, exactly once...
		expect(compactSpy).toHaveBeenCalledTimes(1);
		// ...and only AFTER the continuation streamed — all three model calls were
		// already recorded when compact() was entered. RED (drop the
		// `#postPromptTasksPromise` await before compact): abort() drains the
		// continuation task, so it never streams (mock.calls stays at 2) and
		// compact() is entered early.
		expect(modelCallsAtCompact).toBe(3);
	}, 15_000);

	it("holds the terminal agent_end until the requested compaction pass completes (RPC/subscriber idle signal)", async () => {
		// A model-requested compaction runs the real `compact()` at settle, which
		// disconnects and calls `abort()`; abort's `#resetInFlight()` would flush
		// the deferred terminal `agent_end` mid-pass. Subscribers (rpc-mode, ACP,
		// Cursor) treat `agent_end` as the idle signal, so flushing before the
		// summary + history rewrite finishes lets a client fire its next prompt
		// into a disconnected, being-rewritten session. Drive the REAL compact()
		// and assert the terminal `agent_end` is emitted only AFTER the compaction
		// pass returns. Pre-fix the abort flushes it first → agent_end precedes
		// compact:done (RED).
		const { session } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const order: string[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") order.push("agent_end");
		});

		// Call through to the real lifecycle (abort + too-small no-op) but bracket
		// it so the ordering of the compaction's completion is observable. `finally`
		// records completion whether the too-small case throws (swallowed by the
		// settle path) or returns.
		const realCompact = session.compact.bind(session);
		const compactSpy = vi.spyOn(session, "compact").mockImplementation(async instructions => {
			try {
				return await realCompact(instructions);
			} finally {
				order.push("compact:done");
			}
		});

		await session.prompt("do the thing then compact");
		await session.waitForIdle();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(order).toContain("compact:done");
		expect(order).toContain("agent_end");
		// The idle signal must not reach subscribers until the rewrite pass is done.
		expect(order.indexOf("agent_end")).toBeGreaterThan(order.indexOf("compact:done"));
	}, 15_000);

	it("schedules a rewrite only when the compact result carries details.requested === true (marker, not name)", async () => {
		// An extension may re-register the built-in `compact` name (the SDK supports
		// replacing registry entries). A same-named wrapper that DECLINES — a
		// successful result WITHOUT the native tool's `requested: true` marker — must
		// not be treated as authorization for a real context rewrite. Name-only
		// matching (pre-fix) fires the rewrite anyway.
		const declineWrapper: AgentTool = {
			name: "compact",
			label: "Compact",
			description: "A wrapper that re-registers the compact name but declines to request a rewrite.",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "declined; not delegating" }] };
			},
		};

		const declined = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			{ compactToolOverride: declineWrapper },
		);
		const declinedSpy = vi.spyOn(declined.session, "compact").mockResolvedValue(fakeCompaction());
		await declined.session.prompt("call the wrapper compact");
		await declined.session.waitForIdle();
		// No marker → not authorization → no rewrite scheduled.
		expect(declinedSpy).not.toHaveBeenCalled();

		// A same-named wrapper that DOES set the marker still schedules the rewrite.
		const requestingWrapper: AgentTool = {
			name: "compact",
			label: "Compact",
			description: "A wrapper that re-registers the compact name and requests a rewrite via the marker.",
			parameters: type({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: "delegating to native compaction" }],
					details: { requested: true },
				};
			},
		};

		const requesting = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			{ compactToolOverride: requestingWrapper },
		);
		const requestingSpy = vi.spyOn(requesting.session, "compact").mockResolvedValue(fakeCompaction());
		await requesting.session.prompt("call the wrapper compact");
		await requesting.session.waitForIdle();
		// Marker present → authorization → exactly one rewrite.
		expect(requestingSpy).toHaveBeenCalledTimes(1);
	}, 15_000);

	it("does NOT re-fire a stale request on an agent-initiated sendCustomMessage turn after the compacting run errored (P2)", async () => {
		// A `compact` request is armed, but the FOLLOWING inference errors — so
		// agent-core skips `onTurnEnd` (see agent-loop `emitTurnEnd`) and the
		// settle that would have scheduled the compaction never runs, leaving the
		// marker un-applied. The prompt() entrypoint clears it via
		// `#resetPromptMaintenanceState`, but an agent-initiated
		// `sendCustomMessage(..., { triggerTurn: true })` reaches
		// `#promptAgentInitiatedMessage` WITHOUT `acceptTerminalEmptyStop`, which
		// pre-fix skipped that reset. Its unrelated clean settle then consumes the
		// stale marker and rewrites context with no `compact` call in this run.
		// Clearing the marker at every run entrypoint closes that leak.
		const { session } = await createHarness([
			// Prompt 1: request compaction, then the next inference errors out
			// before the settle can schedule the deferred compaction.
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ throw: "provider exploded after compact" },
			// The agent-initiated run: a plain noop turn, then a clean text stop.
			// No compact call of its own.
			{
				content: [{ type: "toolCall", id: "call_noop", name: "noop", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["TWO"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		// Arm the stale request: the errored inference makes prompt 1 settle
		// without ever scheduling the compaction, so the marker survives.
		await session.prompt("compact then the model errors");
		await session.waitForIdle();
		expect(compactSpy).not.toHaveBeenCalled();

		// The agent-initiated run (steer/follow-up delivery path, triggerTurn) —
		// NOT the operator prompt() path. Pre-fix this consumes the stale marker at
		// its clean settle and fires a rewrite.
		await session.sendCustomMessage(
			{ customType: "async-result", content: "unrelated background result" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		await session.waitForIdle();

		// Never fired: the run entrypoint dropped the un-applied request before the
		// agent-initiated turn began, so its clean settle found nothing to apply.
		expect(compactSpy).not.toHaveBeenCalled();
	}, 15_000);

	it("holds the terminal agent_end until the requested compaction completes even when a second settle re-schedules (P1)", async () => {
		// A model-requested compaction runs the real `compact()` at settle, which
		// disconnects and calls `abort()`; abort's `#resetInFlight()` flushes the
		// deferred terminal `agent_end` only while no requested compaction is
		// pending. When TWO settles each request a compaction — here the first
		// settle fires a session_stop continuation whose own turn requests
		// compaction again — the second scheduling must NOT start a rival detached
		// run. Pre-fix it overwrote `#requestedCompaction`; the rival then saw
		// `isCompacting` (the first pass's controller), returned fast, and its
		// `.finally` cleared the gate WHILE the first rewrite was still in flight —
		// so abort's flush emitted the terminal `agent_end` mid-pass. Coalescing
		// onto the single in-flight pass keeps the gate held until the rewrite
		// returns. Drive the REAL compact() (too-small no-op) so the abort +
		// isCompacting lifecycle is genuine, and bracket it to observe ordering.
		let sessionStopCalls = 0;
		const extensionRunner = {
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop",
			// Only the first settle schedules a continuation; the continuation's
			// own settle returns undefined so the run terminates.
			emitSessionStop: async () => {
				sessionStopCalls++;
				return sessionStopCalls === 1 ? { continue: true, additionalContext: "keep going" } : undefined;
			},
		} as unknown as ExtensionRunner;

		const { session } = await createHarness(
			[
				// Turn 1: request compaction and stop — this settle schedules run 1
				// AND fires the session_stop continuation.
				{
					content: [{ type: "toolCall", id: "call_compact_1", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["first answer"], stopReason: "stop" },
				// Turn 2: the hidden session_stop continuation ALSO requests
				// compaction. Its settle re-enters #scheduleRequestedCompaction while
				// run 1 is still parked awaiting the post-prompt continuation.
				{
					content: [{ type: "toolCall", id: "call_compact_2", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["continuation answer"], stopReason: "stop" },
			],
			{ extensionRunner },
		);

		const order: string[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") order.push("agent_end");
		});

		// Call through to the real lifecycle (abort + too-small no-op) but bracket
		// it so the compaction's completion is observable. `finally` records
		// completion whether the too-small case throws (swallowed by the settle
		// path) or returns.
		const realCompact = session.compact.bind(session);
		const compactSpy = vi.spyOn(session, "compact").mockImplementation(async instructions => {
			order.push("compact:start");
			try {
				return await realCompact(instructions);
			} finally {
				order.push("compact:done");
			}
		});

		await session.prompt("do the thing then compact");
		await session.waitForIdle();

		// The continuation turn ran (session_stop fired at both settles).
		expect(sessionStopCalls).toBe(2);
		// Exactly one rewrite pass: the second scheduling coalesced onto the first,
		// never starting a rival run.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		// The idle signal must not reach subscribers until the single rewrite pass
		// is done. RED (overwrite instead of coalesce): the rival run clears the
		// gate mid-pass, so agent_end precedes compact:done.
		expect(order).toContain("compact:done");
		expect(order).toContain("agent_end");
		expect(order.indexOf("agent_end")).toBeGreaterThan(order.indexOf("compact:done"));
	}, 15_000);
});

describe("AgentSession merges every compact request captured before the settle", () => {
	it("folds parallel compact calls in one batch into a single pending request (P2)", async () => {
		// A single tool batch carries TWO `compact` calls with distinct focus.
		// The old `.find()` retained only the first result, so the second call's
		// focus was silently discarded even though it reported success. The
		// merge-all folds both into the pending marker, and the settle passes the
		// combined focus to `compact()`.
		const { session } = await createHarness([
			{
				content: [
					{
						type: "toolCall",
						id: "call_compact_a",
						name: "compact",
						arguments: { instructions: "keep the migration plan" },
					},
					{
						type: "toolCall",
						id: "call_compact_b",
						name: "compact",
						arguments: { instructions: "also keep the rollback steps" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact twice in one batch with different focus");
		await session.waitForIdle();

		// Exactly one rewrite, carrying BOTH foci. RED (revert merge-all to
		// `.find()`): only the first call's focus survives, so the second focus
		// assertion fails with the compact arg equal to just "keep the migration
		// plan".
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const focus = compactSpy.mock.calls[0]?.[0];
		expect(focus).toContain("keep the migration plan");
		expect(focus).toContain("also keep the rollback steps");
	}, 15_000);

	it("folds compact calls across separate willContinue turns into one pending request (P2)", async () => {
		// Two `compact` calls in DIFFERENT tool-loop turns before the genuine
		// settle. Pre-fix each settle-boundary marker assignment overwrote the
		// focus captured from the earlier turn; merging combines both.
		const { session } = await createHarness([
			{
				content: [
					{
						type: "toolCall",
						id: "call_compact_1",
						name: "compact",
						arguments: { instructions: "keep the failing repro" },
					},
					{ type: "toolCall", id: "call_noop_1", name: "noop", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{
						type: "toolCall",
						id: "call_compact_2",
						name: "compact",
						arguments: { instructions: "and the stack trace" },
					},
					{ type: "toolCall", id: "call_noop_2", name: "noop", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact across two turns with different focus");
		await session.waitForIdle();

		// One rewrite carrying focus from both turns. RED (revert merge-all to
		// `.find()`): the second turn's assignment replaces the first turn's focus,
		// so only "and the stack trace" survives.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const focus = compactSpy.mock.calls[0]?.[0];
		expect(focus).toContain("keep the failing repro");
		expect(focus).toContain("and the stack trace");
	}, 15_000);
});

describe("AgentSession cancels a deferred compaction when the session is aborted", () => {
	it("does not fire the requested compaction when an abort bumps the generation before it applies (P2)", async () => {
		// The compact request is scheduled at settle, but its detached run parks
		// awaiting the post-prompt tasks (a hanging session_stop pass). An abort
		// while it is parked bumps `#promptGeneration` — the ONLY cancellation
		// signal available, since no compaction controller exists yet. The
		// captured-generation check must observe the bump and bail without ever
		// calling `compact()` (no LLM summary, no history rewrite).
		const stopReached = Promise.withResolvers<void>();
		const stopGate = Promise.withResolvers<undefined>();
		let sessionStopCalls = 0;
		const extensionRunner = {
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop",
			// The first (and only) settle parks here so the deferred compaction is
			// caught mid-wait; resolve the gate from the test only after the abort
			// has bumped the generation.
			emitSessionStop: async () => {
				sessionStopCalls++;
				stopReached.resolve();
				return stopGate.promise;
			},
		} as unknown as ExtensionRunner;

		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			{ extensionRunner },
		);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		const promptPromise = session.prompt("do the thing then compact");
		// The settle scheduled the deferred compaction; it is now parked awaiting
		// the hanging session_stop post-prompt task.
		await stopReached.promise;
		// Abort bumps `#promptGeneration` synchronously before its first await.
		const abortPromise = session.abort({ reason: USER_INTERRUPT_LABEL });
		// Let the session_stop pass return so the post-prompt tasks drain and the
		// parked deferred run resumes — into the generation check.
		stopGate.resolve(undefined);

		await abortPromise;
		await promptPromise;
		await session.waitForIdle();

		expect(sessionStopCalls).toBe(1);
		// The abort invalidated the deferred request: no compaction LLM call fired
		// and history was not rewritten. RED (revert the captured-generation
		// check): the deferred run applies anyway and `compact()` is called once.
		expect(compactSpy).not.toHaveBeenCalled();
	}, 15_000);

	it("does not schedule the compaction when the abort lands DURING the settle hook (P2)", async () => {
		// The sibling test above covers an abort that lands AFTER scheduling, which
		// the detached run's captured-generation check catches. This covers the
		// earlier window: the hook's entry check (`if (signal?.aborted) return`)
		// passes, then the hook awaits — prewalk's `setModelTemporary` on the
		// `write` result — and the abort bumps `#promptGeneration` inside that
		// await. Control returns and reaches `#scheduleRequestedCompaction()`,
		// which captures the ALREADY-BUMPED generation; the detached run's
		// recheck then compares that stale-but-equal pair and sees no change, so
		// the cancellation is invisible to it. The scheduler must re-check
		// cancellation itself against the generation the hook entered with.
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const { session } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_write", name: "write", arguments: {} },
					{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} },
					{ type: "toolCall", id: "call_yield", name: "yield", arguments: { result: { data: { ok: true } } } },
				],
				stopReason: "toolUse",
			},
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		// Arm prewalk so the settle hook takes its awaited hand-off branch, and
		// abort from inside that await — the precise mid-hook window.
		session.armPrewalk(bundled);
		let aborted: Promise<void> | undefined;
		vi.spyOn(session, "setModelTemporary").mockImplementation(async () => {
			aborted ??= session.abort({ reason: USER_INTERRUPT_LABEL });
			// Yield so the abort's synchronous generation bump lands before the
			// hook resumes and reaches the scheduling call.
			await Promise.resolve();
			return undefined;
		});

		await session.prompt("write, compact, and yield in one turn");
		await aborted;
		await session.waitForIdle();

		// The user cancelled before the request was ever scheduled: no summary LLM
		// call, no history rewrite. RED pre-fix — the scheduler captures the
		// post-bump generation, its recheck compares equal, and compact() fires.
		expect(compactSpy).not.toHaveBeenCalled();
	}, 15_000);
});

describe("AgentSession clears a stale compact marker before a queued resume", () => {
	it("does NOT fire a compact armed on the interrupted turn at the settle of a resumed queued turn (P2)", async () => {
		// A `compact` result is captured on a CONTINUING tool turn (willContinue
		// true), which arms `#pendingCompactionRequest` but does NOT schedule it —
		// only a `willContinue === false` settle does. The NEXT inference then
		// errors while a user steer is queued, so agent-core skips `onTurnEnd` and
		// the clean settle that would have scheduled the compaction never runs; the
		// marker survives. The post-settle stranded-message drain resumes the queued
		// steer through `agent.continue()` — a path that, unlike a fresh prompt, does
		// NOT run `#resetPromptMaintenanceState`. Pre-fix the stale marker rode into
		// the resumed turn and fired at ITS clean settle, scheduling the compaction
		// the interrupt should have cancelled. Clearing the marker in the drain,
		// before the resume, closes that leak.
		const harnessRef: { session?: AgentSession } = {};
		const { session, mock } = await createHarness([
			// Turn 1: request compaction + a noop, so the turn continues
			// (willContinue true) and the marker is armed but never scheduled.
			{
				content: [
					{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} },
					{ type: "toolCall", id: "call_noop", name: "noop", arguments: {} },
				],
				stopReason: "toolUse",
			},
			// Turn 2: a user steer lands mid-inference, then the inference errors —
			// the settle that would have scheduled the compaction is skipped.
			async () => {
				harnessRef.session?.agent.steer({
					role: "user",
					content: [{ type: "text", text: "resume after the interrupt" }],
					steering: true,
					attribution: "user",
					timestamp: Date.now(),
				});
				return { throw: "provider exploded after compact" };
			},
			// Turn 3: the drain resumes the queued steer; this turn settles cleanly.
			{ content: ["DONE"], stopReason: "stop" },
		]);
		harnessRef.session = session;

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact mid-loop, then the model errors with a steer queued");
		await session.waitForIdle();

		// The queued steer resumed and its turn settled: three model calls (turn 1,
		// the errored turn 2, the resumed turn 3). This proves the clean settle that
		// pre-fix consumed the stale marker actually ran.
		expect(mock.calls).toHaveLength(3);
		// Never fired: the stale request armed on the interrupted turn was cleared
		// before the resume, so the resumed turn's clean settle found nothing to
		// apply. RED (revert the marker-clear in #drainStrandedQueuedMessages): the
		// stale compaction fires at the resumed settle → compact called once.
		expect(compactSpy).not.toHaveBeenCalled();
	}, 15_000);
});

// A high-usage stat block: `input` above `compaction.thresholdTokens` makes the
// settling turn trip the automatic threshold pass, which is exactly the pass
// that must NOT pre-empt a pending requested compaction.
function highUsage(input: number) {
	return {
		input,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession requested compaction owns the rewrite over automatic threshold maintenance (P1)", () => {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");

	// Bundled model + real key: unlike the mock provider, an anthropic model is in
	// `getAvailable()`, so the automatic threshold pass can resolve a candidate and
	// actually commit a compaction entry — the state that makes a later requested
	// pass see "Already compacted" pre-fix.
	async function createThresholdHarness(instructions: string): Promise<AgentSession> {
		const tempDir = TempDir.createSync("@pi-compact-tool-threshold-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			// Auto-compaction ON with a tiny threshold: the settling turn's high
			// usage trips the automatic pass, reproducing the race.
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			// Keep the speculation grace band from deferring the blocking pass, and
			// keep an auto-continuation turn from adding scripted responses.
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		// Real CompactTool so its result carries the `requested: true` marker the
		// onTurnEnd wiring scans for and the focus instructions ride along.
		const compactTool = new CompactTool(topLevelToolSession()) as AgentTool;
		const tools: AgentTool[] = [compactTool];

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = call++;
				const stream = new AssistantMessageEventStream();
				// Turn 0: call `compact` with focus instructions (mid-loop). Turn 1:
				// a plain text stop whose high usage trips the automatic threshold at
				// the settle — the boundary where the requested pass is scheduled.
				const message =
					index === 0
						? {
								role: "assistant" as const,
								content: [
									{
										type: "toolCall" as const,
										id: "call_compact",
										name: "compact",
										arguments: { instructions },
									},
								],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: model.id,
								usage: highUsage(50_000),
								stopReason: "toolUse" as const,
								timestamp: Date.now(),
							}
						: {
								role: "assistant" as const,
								content: [{ type: "text" as const, text: "All done." }],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: model.id,
								usage: highUsage(50_000),
								stopReason: "stop" as const,
								timestamp: Date.now(),
							};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		activeHarnesses.push({ session, authStorage, tempDir });
		return session;
	}

	// Stub only the pure LLM summarizer so no network runs; it still commits a real
	// compaction entry and records the customInstructions each pass passed. Its 4th
	// argument is the customInstructions.
	function stubSummarizer(): void {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	it("applies the requested focus instructions instead of exiting 'Already compacted'", async () => {
		const instructions = "keep the failing test";
		const compactSpy = vi.spyOn(compactionModule, "compact");
		stubSummarizer();
		const session = await createThresholdHarness(instructions);

		await session.prompt("do the thing then compact with focus");
		await session.waitForIdle();

		// Pre-fix the automatic threshold pass commits first with `undefined`, so
		// the requested pass throws "Already compacted" before it can reach the
		// summarizer — no call ever carries the focus. Post-fix the automatic route
		// cedes to the pending requested pass, which owns the rewrite and carries it.
		const focusInstructions = compactSpy.mock.calls.map(args => args[3]);
		expect(focusInstructions).toContain(instructions);
	}, 15_000);
});

describe("AgentSession defers mid-turn maintenance while a compact request is armed (A)", () => {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");

	// A big assistant text block on the compact-carrying turn guarantees the
	// mid-turn cut point lands AFTER the earlier turn, so prepareCompaction has
	// something to summarize and the automatic mid-turn pass actually commits an
	// entry (the pre-fix leak) rather than no-opping on a too-small session.
	const bulkText = "context ".repeat(8000);

	function stubSummarizer(): void {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	async function createMidRunHarness(instructions: string): Promise<AgentSession> {
		const tempDir = TempDir.createSync("@pi-compact-tool-midrun-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			// A small keep window forces the cut forward so the mid-turn pass can
			// summarize the earlier turn instead of finding nothing to compact.
			"compaction.keepRecentTokens": 100,
			// Mid-turn maintenance ON: it is the pass under test.
			"compaction.midTurnEnabled": true,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const compactTool = new CompactTool(topLevelToolSession()) as AgentTool;
		const tools: AgentTool[] = [noopTool, compactTool];

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = call++;
				const stream = new AssistantMessageEventStream();
				// Turn 0: a small noop turn — under threshold, provides the earlier
				// turn the mid-turn cut later summarizes. Turn 1: call `compact` with
				// focus AND a paired `noop`, so the loop continues (willContinue true)
				// at THIS boundary — the mid-turn maintenance boundary. Its bulk text
				// crosses the threshold and gives the cut a summarizable prefix. Turn
				// 2: a plain text stop that genuinely settles.
				const message =
					index === 0
						? {
								role: "assistant" as const,
								content: [{ type: "toolCall" as const, id: "call_noop_0", name: "noop", arguments: {} }],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: model.id,
								usage: highUsage(200),
								stopReason: "toolUse" as const,
								timestamp: Date.now(),
							}
						: index === 1
							? {
									role: "assistant" as const,
									content: [
										{ type: "text" as const, text: bulkText },
										{
											type: "toolCall" as const,
											id: "call_compact",
											name: "compact",
											arguments: { instructions },
										},
										{ type: "toolCall" as const, id: "call_noop_1", name: "noop", arguments: {} },
									],
									api: "anthropic-messages" as const,
									provider: "anthropic" as const,
									model: model.id,
									usage: highUsage(50_000),
									stopReason: "toolUse" as const,
									timestamp: Date.now(),
								}
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: "All done." }],
									api: "anthropic-messages" as const,
									provider: "anthropic" as const,
									model: model.id,
									usage: highUsage(50_000),
									stopReason: "stop" as const,
									timestamp: Date.now(),
								};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		activeHarnesses.push({ session, authStorage, tempDir });
		return session;
	}

	it("does not let the mid-turn pass commit an undirected summary that strips the requested focus", async () => {
		const instructions = "keep the failing repro";
		const compactSpy = vi.spyOn(compactionModule, "compact");
		stubSummarizer();
		const session = await createMidRunHarness(instructions);

		await session.prompt("work, then compact mid-loop with focus");
		await session.waitForIdle();

		// Pre-fix the automatic mid-turn pass commits an undirected summary at the
		// compact-carrying (willContinue) boundary; the deferred requested pass then
		// exits "Already compacted" and never reaches the summarizer with the focus.
		// Post-fix the mid-turn pass cedes while the request is armed, so the
		// requested pass owns the single rewrite and carries the focus.
		const focusInstructions = compactSpy.mock.calls.map(args => args[3]);
		expect(focusInstructions).toContain(instructions);
	}, 15_000);
});

describe("AgentSession preserves later focus when coalescing compact requests (B)", () => {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");

	// Bulk text on the first turn guarantees the deferred requested pass has real
	// content to summarize, so it reaches the summarizer instead of no-opping.
	const bulkText = "context ".repeat(8000);

	function stubSummarizer(): void {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	async function createCoalesceHarness(firstFocus: string, secondFocus: string): Promise<AgentSession> {
		const tempDir = TempDir.createSync("@pi-compact-tool-coalesce-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"compaction.keepRecentTokens": 100,
			// The coalescing race is on the deferred SETTLE pass, not the mid-turn
			// pass — keep mid-turn off so nothing compacts before the settle.
			"compaction.midTurnEnabled": false,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		// A session_stop hook whose first fire schedules a hidden continuation
		// turn — that continuation calls `compact` AGAIN with different focus,
		// re-entering the schedule while the first deferred pass is still parked.
		let sessionStopCalls = 0;
		const extensionRunner = {
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop",
			emitSessionStop: async () => {
				sessionStopCalls++;
				return sessionStopCalls === 1 ? { continue: true, additionalContext: "keep going" } : undefined;
			},
		} as unknown as ExtensionRunner;

		const compactTool = new CompactTool(topLevelToolSession()) as AgentTool;
		const tools: AgentTool[] = [compactTool];

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = call++;
				const stream = new AssistantMessageEventStream();
				// Turn 0: bulk text + `compact` with the FIRST focus. Turn 1: text
				// stop that settles and schedules the deferred pass (and fires
				// session_stop → continuation). Turn 2: the continuation calls
				// `compact` with the SECOND focus while the first pass is parked.
				// Turn 3: the continuation's own text stop.
				let message: Record<string, unknown>;
				if (index === 0) {
					message = {
						role: "assistant",
						content: [
							{ type: "text", text: bulkText },
							{
								type: "toolCall",
								id: "call_compact_1",
								name: "compact",
								arguments: { instructions: firstFocus },
							},
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: model.id,
						usage: highUsage(50_000),
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
				} else if (index === 1) {
					message = {
						role: "assistant",
						content: [{ type: "text", text: "first answer" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: model.id,
						usage: highUsage(50_000),
						stopReason: "stop",
						timestamp: Date.now(),
					};
				} else if (index === 2) {
					message = {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_compact_2",
								name: "compact",
								arguments: { instructions: secondFocus },
							},
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: model.id,
						usage: highUsage(50_000),
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
				} else {
					message = {
						role: "assistant",
						content: [{ type: "text", text: "continuation answer" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: model.id,
						usage: highUsage(50_000),
						stopReason: "stop",
						timestamp: Date.now(),
					};
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message as never });
					stream.push({ type: "done", reason: message.stopReason as never, message: message as never });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner,
		});
		activeHarnesses.push({ session, authStorage, tempDir });
		return session;
	}

	it("merges the later request's focus into the pending pass instead of discarding it", async () => {
		const firstFocus = "keep the migration plan";
		const secondFocus = "also keep the rollback steps";
		const compactSpy = vi.spyOn(compactionModule, "compact");
		stubSummarizer();
		const session = await createCoalesceHarness(firstFocus, secondFocus);

		await session.prompt("compact, then compact again with different focus");
		await session.waitForIdle();

		// The single coalesced rewrite must honor BOTH foci. Pre-fix the second
		// schedule returns early (`if (#requestedCompaction) return`) and the
		// pending closure keeps only the first focus, so the later focus is
		// silently discarded. Post-fix it is merged into the pending pass.
		const focusInstructions = compactSpy.mock.calls.map(args => String(args[3] ?? ""));
		expect(focusInstructions.some(focus => focus.includes(secondFocus))).toBe(true);
		expect(focusInstructions.some(focus => focus.includes(firstFocus))).toBe(true);
	}, 15_000);
});

describe("AgentSession flushes the deferred agent_end when the requested compaction clears", () => {
	it("does not strand the terminal agent_end when the compacting run came from an idle injection", async () => {
		// `#flushPendingAgentEnd()` RE-DEFERS the terminal `agent_end` while
		// `#requestedCompaction` is set, so a subscriber is not told "idle" during
		// the rewrite. That re-defer relies on a later flush once the gate clears.
		// The explicit-prompt path provides one: it awaits
		// `#waitForPostPromptRecovery()` (which drains `#requestedCompaction`)
		// BEFORE its `#endInFlight()`. The yield-queue idle injection does not —
		// it calls `#endInFlight()` straight out of `agent.prompt()`, so the only
		// flush happens while the compaction is still in flight and re-defers.
		// Nothing calls the flush afterwards and the terminal `agent_end` is lost:
		// an RPC/ACP subscriber never learns the session went idle. Drive that path
		// via a launch completion (a real idle injection) whose turn calls
		// `compact`.
		const { session } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const order: string[] = [];
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type === "agent_end") {
				agentEnds++;
				order.push("agent_end");
			}
		});

		// Hold the pass open across the injection's `#endInFlight()` so the flush
		// attempt genuinely observes `#requestedCompaction` set and re-defers. An
		// instantly-resolving stub can clear the gate before that flush runs and
		// would hide the strand.
		const compactStarted = Promise.withResolvers<void>();
		const compactGate = Promise.withResolvers<void>();
		const compactSpy = vi.spyOn(session, "compact").mockImplementation(async () => {
			order.push("compact:start");
			compactStarted.resolve();
			await compactGate.promise;
			order.push("compact:done");
			return fakeCompaction();
		});

		const owner = session.sessionManager.getSessionId();
		await session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "compact-idle-injection",
			owner,
			daemon: {
				name: "worker",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		});
		// The injection's own `#endInFlight()` has now run (its flush attempt saw
		// the open gate and re-deferred). Release the pass and let the session
		// reach a real idle.
		await compactStarted.promise;
		compactGate.resolve();
		await session.waitForIdle();
		// The injected turn requested a compaction, so the terminal `agent_end`
		// must be both DELIVERED and delivered only after the rewrite finished.
		// Subscribers (rpc-mode, ACP, Cursor) treat it as "session is idle": an
		// early emit invites the next prompt into a disconnected, being-rewritten
		// session, and a missing one leaves the client hanging forever.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(agentEnds).toBeGreaterThan(0);
		expect(order.indexOf("agent_end")).toBeGreaterThan(order.indexOf("compact:done"));
	}, 15_000);
});
