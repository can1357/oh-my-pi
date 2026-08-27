/**
 * `AgentSession` folds live `tool_presentation`
 * events into a {@link LiveToolPresentationRecord} accumulator per in-flight
 * call, keyed by `toolCallId` in `#pendingToolPresentations`, reusing the same
 * `ToolExecutionId` the journal's `started` record already minted.
 *
 * This is a real `BashTool` call driven through a real `AgentSession` with a
 * persisted (on-disk) `SessionManager`, mirroring
 * `session-tool-execution-started-journal.test.ts`'s own harness — the
 * presentation route selection, the `tool_presentation` event sequence, and the
 * session JSONL write are all real production code, not hand-built fixtures.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type ToolCallContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PendingToolPresentationSnapshot } from "@oh-my-pi/pi-coding-agent/presentation/live-record";
import { persistedToolJournalSchema } from "@oh-my-pi/pi-coding-agent/presentation/schemas/journal";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Fixed-width, unique fixture lines emitted with a real delay between them, so
// the accumulator actually folds more than one `terminal_append` — a single
// one-shot chunk would not exercise the fold at all.
const FIXTURE_LINE_ONE = "stream-chunk-one-fdb1";
const FIXTURE_LINE_TWO = "stream-chunk-two-fdb1";
const STREAMING_BASH_COMMAND = `printf '${FIXTURE_LINE_ONE}\\n'; sleep 0.2; printf '${FIXTURE_LINE_TWO}\\n'`;
const CALL_ID = "call_live_record_probe_fdb1";
const LONG_RUNNING_COMMAND = "sleep 30";
const LONG_RUNNING_CALL_ID = "call_live_record_abort_fdb1";

function bashCall(command: string, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command, timeout: 60 } }],
		stopReason: "toolUse",
	};
}

function stopReply(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

interface Harness {
	readonly session: AgentSession;
	readonly authStorage: AuthStorage;
	readonly tempDir: string;
	readonly sessionManager: SessionManager;
}

async function buildHarness(command: string, callId: string): Promise<Harness> {
	const tempDir = path.join(os.tmpdir(), `pi-live-tool-presentation-test-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: tempDir });

	const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
	});
	const sessionManager = SessionManager.create(tempDir, tempDir);

	const toolSession: ToolSession = {
		cwd: tempDir,
		hasUI: false,
		settings,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
	};
	const bashTool = new BashTool(toolSession);

	const scriptedResponses: MockResponse[] = [bashCall(command, callId), stopReply("done")];
	const mock = createMockModel({ handler: () => scriptedResponses.shift() ?? stopReply("done") });

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [bashTool as unknown as AgentTool], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
		// Without a `getToolContext`, the presentation producer is never threaded
		// through `AgentToolContext` and every call falls back to
		// `legacy_snapshot` — the one route this suite must NOT exercise.
		getToolContext: ((toolCall?: ToolCallContext) => (toolCall === undefined ? undefined : { toolCall })) as never,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([[bashTool.name, bashTool as unknown as AgentTool]]),
	});

	return { session, authStorage, tempDir, sessionManager };
}

describe("AgentSession live tool_presentation → ToolPresentationRecord folding", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.session.dispose();
			harness.authStorage.close();
			if (fs.existsSync(harness.tempDir)) removeSyncWithRetries(harness.tempDir);
		}
		harness = undefined;
		resetSettingsForTest();
	});

	it("populates the pending map at started with the journal's executionId, folds real streamed bytes, and clears at settled", async () => {
		harness = await buildHarness(STREAMING_BASH_COMMAND, CALL_ID);
		const { session, sessionManager } = harness;

		expect(session.pendingToolPresentationsForTests().size).toBe(0);

		let sawPendingDuringRun = false;
		let observedExecutionId: string | undefined;
		let observedStreamTextDuringRun: string | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_presentation" || event.toolCallId !== CALL_ID) return;
			if (event.event.type !== "terminal_append") return;
			const pending = session.pendingToolPresentationsForTests().get(CALL_ID);
			if (pending) {
				sawPendingDuringRun = true;
				observedExecutionId = pending.executionId;
				// `finish()` is a pure, repeatable snapshot (see live-record.ts's own
				// doc comment) — reading it here proves the accessor exposes an
				// immutable projection, not the live mutable builder, while still
				// proving real streamed bytes are observable mid-run.
				observedStreamTextDuringRun = pending.presentation.stream?.text;
			}
		});

		try {
			await session.prompt("run the streaming fixture command");
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}

		// 1. The map was actually populated and folding mid-run, not just at the
		// bookends — this is what proves real terminal output reached the fold.
		expect(sawPendingDuringRun).toBe(true);
		expect(observedStreamTextDuringRun).toContain(FIXTURE_LINE_ONE);

		// 2. The map returns to its pre-call baseline (empty) once the call settles.
		expect(session.pendingToolPresentationsForTests().size).toBe(0);

		// 3. The executionId observed live is the same one the v4 journal's
		// `started` record persisted — proving the accumulator's owner reused the
		// already-minted id rather than minting a second one.
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		const entries = await loadEntriesFromFile(sessionFile);
		const journalEntry = entries.find(entry => "type" in entry && entry.type === "tool_execution_started");
		if (journalEntry?.type !== "tool_execution_started") {
			throw new Error(`expected a tool_execution_started journal entry, saw: ${JSON.stringify(entries)}`);
		}
		expect(observedExecutionId).toBe(journalEntry.executionId);

		const { id: _id, parentId: _parentId, timestamp: _timestamp, ...journalOnly } = journalEntry;
		const parsed = persistedToolJournalSchema.safeParse(journalOnly);
		expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
	});

	it("clears an in-flight entry on beginDispose() so an interrupted call cannot leak for the life of the session", async () => {
		harness = await buildHarness(LONG_RUNNING_COMMAND, LONG_RUNNING_CALL_ID);
		const { session } = harness;

		const started = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (
				event.type === "tool_presentation" &&
				event.toolCallId === LONG_RUNNING_CALL_ID &&
				event.event.type === "started"
			) {
				started.resolve();
			}
		});

		const promptPromise = session.prompt("run the long-running fixture command");
		try {
			await started.promise;
			// The call has started and is still running (`sleep 30`) — the map must
			// hold its entry right now.
			expect(session.pendingToolPresentationsForTests().has(LONG_RUNNING_CALL_ID)).toBe(true);

			// The synchronous teardown gate every `dispose()` call runs first —
			// exercised directly so this test isolates the leak-safety hook itself
			// rather than the whole async dispose pipeline.
			session.beginDispose();
			expect(session.pendingToolPresentationsForTests().size).toBe(0);
		} finally {
			unsubscribe();
			await session.dispose().catch(() => {});
			await promptPromise.catch(() => {});
		}
	});

	it("clears an in-flight entry the moment a session transition detaches the agent listener, without any dispose", async () => {
		harness = await buildHarness(LONG_RUNNING_COMMAND, LONG_RUNNING_CALL_ID);
		const { session } = harness;

		const started = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (
				event.type === "tool_presentation" &&
				event.toolCallId === LONG_RUNNING_CALL_ID &&
				event.event.type === "started"
			) {
				started.resolve();
			}
		});

		const promptPromise = session.prompt("run the long-running fixture command");
		try {
			await started.promise;
			expect(session.pendingToolPresentationsForTests().has(LONG_RUNNING_CALL_ID)).toBe(true);

			// `newSession()` (like `switchSession()` and `SessionMaintenance.compact()`)
			// calls `#disconnectFromAgent()` synchronously, *before* its first `await`,
			// then `await`s `abort()` — so the aborted call's `settled` event is
			// emitted with no listener attached and can never reach
			// `#trackToolPresentation`. Calling `newSession()` runs that synchronous
			// prefix (no extension handlers are registered in this harness, so nothing
			// awaits before the disconnect) before returning a pending promise, so the
			// map must already be empty right here — with no `dispose()` anywhere in
			// this test.
			const newSessionPromise = session.newSession();
			expect(session.pendingToolPresentationsForTests().size).toBe(0);
			await newSessionPromise;
		} finally {
			unsubscribe();
			await promptPromise.catch(() => {});
		}
	});

	it("cannot mutate live accumulator state through pendingToolPresentationsForTests()'s nested fact objects", async () => {
		const NESTED_MUTATION_CALL_ID = "call_live_record_nested_mutation_fdb1";
		harness = await buildHarness(STREAMING_BASH_COMMAND, NESTED_MUTATION_CALL_ID);
		const { session } = harness;

		// `publishCommonFacts` (bash.ts) declares its `wall_time` fact right
		// before the tool returns — after every `terminal_append`, but strictly
		// before the agent loop emits `settled` and `#trackToolPresentation`
		// removes the map entry. Capturing the snapshot on this real `fact` event
		// (not a hand-built fixture) is what proves the accessor's contract holds
		// at the actual call site the review named, not just at the accumulator
		// unit level.
		let snapshotWithFact: ReadonlyMap<string, PendingToolPresentationSnapshot> | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_presentation" || event.toolCallId !== NESTED_MUTATION_CALL_ID) return;
			if (event.event.type !== "fact" || snapshotWithFact) return;
			snapshotWithFact = session.pendingToolPresentationsForTests();
		});

		try {
			await session.prompt("run the streaming fixture command");
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}

		const pending = snapshotWithFact?.get(NESTED_MUTATION_CALL_ID);
		if (!pending) throw new Error("expected a fact event to have populated the snapshot before settlement");
		const originalFact = pending.presentation.facts[0];
		if (!originalFact) throw new Error("expected at least one declared fact (wall_time)");
		const originalFactSnapshot = { ...originalFact };

		// The accessor's whole contract is that this must not silently succeed:
		// every reachable fact/attachment/gap is deep-frozen at the moment `fold`
		// ingested it, so a caller cannot reach into a nested value and inject a
		// mutation into the live accumulator without any cast.
		expect(() => Object.assign(originalFact, { ms: -1 })).toThrow();

		// And the attempted (rejected) mutation left nothing behind: a fresh read
		// through the same accessor still reports the original, unmutated value.
		const laterSnapshot = session.pendingToolPresentationsForTests();
		const stillPending = laterSnapshot.get(NESTED_MUTATION_CALL_ID);
		if (stillPending) {
			expect(stillPending.presentation.facts[0]).toEqual(originalFactSnapshot);
		}
	});
});
