/**
 * `AgentSession` writes the `settled` arm
 * of the v4 persisted tool journal — `PersistedToolExecutionSettled` —
 * alongside the `started` arm it already writes, reusing the same
 * `executionId` and carrying the `ToolPresentationRecord` the live-record
 * accumulator folded, plus the agent loop's own post-hook model content as
 * the frozen model projection. The projection must never be re-derived from
 * the display record via `renderModelContent`.
 *
 * This is a real `BashTool` call driven through a real `AgentSession` with a
 * persisted (on-disk) `SessionManager`, mirroring
 * `session-tool-execution-started-journal.test.ts` and
 * `session-live-tool-presentation-record.test.ts`'s own harness — the
 * presentation route selection, the `tool_presentation` event sequence, and
 * the session JSONL write are all real production code, not hand-built
 * fixtures.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { ToolPresentationRecord } from "@oh-my-pi/pi-agent-core/presentation";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { persistedToolJournalSchema } from "@oh-my-pi/pi-coding-agent/presentation/schemas/journal";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function bashCall(command: string, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command, timeout: 20 } }],
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
	const tempDir = path.join(os.tmpdir(), `pi-tool-exec-settled-journal-test-${Snowflake.next()}`);
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
	// Persisted (not in-memory) so both journal entries actually reach the
	// session JSONL on disk — the acceptance criterion is a written file.
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
		// Without a `getToolContext`, the presentation producer is never
		// threaded through `AgentToolContext` and every call falls back to
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

describe("AgentSession tool_execution_settled journal producer", () => {
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

	it("persists a matching started/settled pair with the accumulator's own folded presentation, schema-valid on disk", async () => {
		const FIXTURE_LINE = "journal-settled-fixture-line-6e91";
		const CALL_ID = "call_settled_journal_probe_6e91";
		harness = await buildHarness(`printf '${FIXTURE_LINE}\\n'`, CALL_ID);
		const { session, sessionManager } = harness;

		// The live accumulator's own pending map entry is deleted by the time a
		// subscriber observes the `settled` event itself (tracking runs before
		// subscriber dispatch), so the last snapshot taken on any preceding
		// `tool_presentation` event for this call is the accumulator's true final
		// fold — the same value `record.finish()` computed at settlement.
		let lastSnapshot: ToolPresentationRecord | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_presentation" || event.toolCallId !== CALL_ID) return;
			const pending = session?.pendingToolPresentationsForTests().get(CALL_ID);
			if (pending) lastSnapshot = pending.presentation;
		});

		try {
			await session.prompt("run the fixture command");
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}

		if (!lastSnapshot) throw new Error("expected at least one pre-settlement presentation snapshot");
		expect(lastSnapshot.stream?.text).toContain(FIXTURE_LINE);

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		const entries = await loadEntriesFromFile(sessionFile);

		// 1. Both journal entries for this call are present.
		const startedEntry = entries.find(entry => "type" in entry && entry.type === "tool_execution_started");
		if (startedEntry?.type !== "tool_execution_started") {
			throw new Error(`expected a tool_execution_started journal entry, saw: ${JSON.stringify(entries)}`);
		}
		const settledEntry = entries.find(entry => "type" in entry && entry.type === "tool_execution_settled");
		if (settledEntry?.type !== "tool_execution_settled") {
			throw new Error(`expected a tool_execution_settled journal entry, saw: ${JSON.stringify(entries)}`);
		}

		// 2. Exactly one of each — settlement never re-mints or duplicates.
		expect(entries.filter(entry => "type" in entry && entry.type === "tool_execution_started")).toHaveLength(1);
		expect(entries.filter(entry => "type" in entry && entry.type === "tool_execution_settled")).toHaveLength(1);

		// 3. The settled entry reuses the exact executionId the started entry minted.
		expect(settledEntry.executionId).toBe(startedEntry.executionId);

		// 4. The settled entry's outcome reflects the real (successful) bash run.
		expect(settledEntry.outcome.kind).toBe("succeeded");

		// 5. The persisted presentation is exactly what the live accumulator folded
		// pre-settlement — proving the map entry was read (and `finish()` taken)
		// before it was deleted, not after.
		expect(settledEntry.presentation).toEqual(lastSnapshot);

		// 6. The frozen model projection actually carries the fixture's stream text.
		const modelText = settledEntry.modelProjection.content.find(block => block.type === "text");
		expect(modelText?.type === "text" ? modelText.text : undefined).toContain(FIXTURE_LINE);

		// 7. What's actually on disk round-trips through the real v4 zod schema for
		// both entries — proving schema validity, not just TS shape.
		for (const entry of [startedEntry, settledEntry]) {
			const { id: _id, parentId: _parentId, timestamp: _timestamp, ...journalOnly } = entry;
			const parsed = persistedToolJournalSchema.safeParse(journalOnly);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	/**
	 * Regression: on a run whose raw output exceeds bash's inline
	 * model-content retention budget, the presentation record keeps every
	 * delivered byte (`live-record.ts`: "the record keeps every delivered byte
	 * of the window it saw"), but the model actually received a
	 * middle-elided summary — a materially different, shorter string missing
	 * a whole run of lines from the middle. Deriving `modelProjection` via
	 * `renderModelContent(presentation)`, which reads `record.stream.text`
	 * directly, would instead persist the FULL, un-elided bytes as the
	 * "frozen model projection" — silently claiming the model saw lines it
	 * never did. This asserts the persisted projection carries the real
	 * middle-elision marker (verified by direct trace against the live
	 * `BashTool`, not inferred from source reading alone) and is missing
	 * exactly the lines that marker says were elided, which a re-derivation
	 * from the uncapped display record could never produce.
	 */
	it("persists the tool's real, middle-elided model content, not the accumulator's full retained stream, for output exceeding the inline retention budget", async () => {
		const LINE_COUNT = 3000; // 3000 * 32 bytes = ~93 KB, well over the retention budget.
		const MIDPOINT_LINE = Math.floor(LINE_COUNT / 2); // Comfortably inside the elided middle range.
		const CALL_ID = "call_settled_journal_capped_probe_d81a";
		// Fixed-width (32 bytes incl. newline), unique per line (the zero-padded
		// index), generated by a real subprocess loop — no ad-hoc byte math on
		// the test's side, just a deterministic, independently-reproducible
		// fixture.
		const command = `for i in $(seq 1 ${LINE_COUNT}); do printf 'CAP-LINE-%04d-PADDING\\n' "$i"; done`;
		harness = await buildHarness(command, CALL_ID);
		const { session, sessionManager } = harness;

		let lastSnapshot: ToolPresentationRecord | undefined;
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_presentation" || event.toolCallId !== CALL_ID) return;
			const pending = session?.pendingToolPresentationsForTests().get(CALL_ID);
			if (pending) lastSnapshot = pending.presentation;
		});

		try {
			await session.prompt("run the capped fixture command");
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}

		if (!lastSnapshot?.stream) throw new Error("expected a retained stream on the pre-settlement snapshot");
		const rawStreamText = lastSnapshot.stream.text;

		// The accumulator genuinely retained everything, including a line deep
		// in what the model's own retention elides — proving the raw stream was
		// never capped at the presentation layer (a naive
		// `renderModelContent(presentation)` derivation would have persisted as
		// "the model projection").
		expect(rawStreamText).toContain("CAP-LINE-0001-PADDING");
		expect(rawStreamText).toContain(`CAP-LINE-${String(MIDPOINT_LINE).padStart(4, "0")}-PADDING`);
		expect(rawStreamText).toContain(`CAP-LINE-${LINE_COUNT}-PADDING`);
		expect(Buffer.byteLength(rawStreamText, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		const entries = await loadEntriesFromFile(sessionFile);
		const settledEntry = entries.find(entry => "type" in entry && entry.type === "tool_execution_settled");
		if (settledEntry?.type !== "tool_execution_settled") {
			throw new Error(`expected a tool_execution_settled journal entry, saw: ${JSON.stringify(entries)}`);
		}
		const modelTextBlock = settledEntry.modelProjection.content.find(block => block.type === "text");
		const persistedModelText = modelTextBlock?.type === "text" ? modelTextBlock.text : undefined;
		if (persistedModelText === undefined) throw new Error("expected a text block in the frozen model projection");

		// The real middle-elision notice (`"[…<N>ln elided…]"`, confirmed by
		// direct trace against the live `BashTool`) is a fingerprint no display
		// reconstruction can produce: `renderModelContent(presentation)` (round
		// 01's derivation) reads `record.stream.text` verbatim, which never
		// contains an elision marker at all, since the accumulator retains
		// every delivered byte uncapped. Its presence here is direct,
		// unambiguous evidence the persisted projection came from the tool's
		// real, elided result content, not a re-derivation from the display
		// record.
		expect(rawStreamText).not.toContain("elided");
		expect(persistedModelText).toContain("elided");
		// ...which is strictly shorter than the full retained stream (the
		// elision actually did something on this fixture) — a vacuous pass
		// (equal lengths) would mean the fixture never exceeded the budget.
		expect(persistedModelText.length).toBeLessThan(rawStreamText.length);
		// ...retains both the head and the tail (middle elision, confirmed by
		// trace: `headRange`/`tailRange` bracket a genuinely elided middle)...
		expect(persistedModelText).toContain("CAP-LINE-0001-PADDING");
		expect(persistedModelText).toContain(`CAP-LINE-${LINE_COUNT}-PADDING`);
		// ...but is missing a line the raw stream still has, deep in the
		// elided middle range — a naive full-stream projection would wrongly
		// persist it as though the model saw it.
		expect(persistedModelText).not.toContain(`CAP-LINE-${String(MIDPOINT_LINE).padStart(4, "0")}-PADDING`);
	});
});
