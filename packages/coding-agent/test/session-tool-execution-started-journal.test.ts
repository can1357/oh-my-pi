/**
 * `AgentSession` writes an additional
 * `PersistedToolExecutionStarted` v4 journal entry alongside the
 * pre-existing `TOOL_EXECUTION_START_CUSTOM_TYPE` resume-warning bookkeeping
 * entry, for every tool call that runs on the typed `presentation_events`
 * protocol.
 *
 * This is a real `BashTool` call driven through a real `AgentSession` with a
 * persisted (on-disk) `SessionManager`, mirroring
 * `agent-session-bash-detach.test.ts`'s harness — the presentation route
 * selection (`BashTool.presentation.selects`), the `tool_presentation`
 * `started` event, and the session JSONL write are all real production code,
 * not hand-built fixtures.
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
import { persistedToolJournalSchema } from "@oh-my-pi/pi-coding-agent/presentation/schemas/journal";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const UNIQUE_BASH_COMMAND = "printf 'journal-started-fixture-9f3c'";
const CALL_ID = "call_journal_probe_9f3c";

function bashCall(command: string, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command, timeout: 10 } }],
		stopReason: "toolUse",
	};
}

function stopReply(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

describe("AgentSession#recordToolExecutionStartedJournal", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
		tempDir = undefined;
		resetSettingsForTest();
	});

	it("persists both the legacy start marker and the new journal entry for a real bash call, schema-valid on disk", async () => {
		tempDir = path.join(os.tmpdir(), `pi-tool-exec-started-journal-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
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
		// Persisted (not in-memory) so the journal entry actually reaches the
		// session JSONL on disk — the acceptance criterion is a written file,
		// not an in-process entry list.
		const sessionManager = SessionManager.create(tempDir, tempDir);

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		};
		const bashTool = new BashTool(toolSession);

		const scriptedResponses: MockResponse[] = [bashCall(UNIQUE_BASH_COMMAND, CALL_ID), stopReply("done")];
		const mock = createMockModel({ handler: () => scriptedResponses.shift() ?? stopReply("done") });

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool as unknown as AgentTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
			// Minimal `getToolContext`, matching `acp-deterministic-phase-gate.test.ts`'s
			// `threadingHost`: without one, `agent-loop.ts` cannot thread the presentation
			// producer through `AgentToolContext` and every call falls back to
			// `legacy_snapshot` — which is exactly the route this test must NOT exercise.
			getToolContext: ((toolCall?: ToolCallContext) => (toolCall === undefined ? undefined : { toolCall })) as never,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool as unknown as AgentTool]]),
		});

		await session.prompt("run the fixture command");
		await session.waitForIdle();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		const entries = await loadEntriesFromFile(sessionFile);

		// 1. The pre-existing, unrelated bookkeeping entry is untouched.
		const legacyMarker = entries.find(
			entry => "type" in entry && entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE,
		);
		if (legacyMarker?.type !== "custom")
			throw new Error("expected the legacy tool_execution_start marker to persist");
		expect(legacyMarker.data).toMatchObject({ toolCallId: CALL_ID, toolName: "bash" });

		// 2. The new, additional v4 journal entry is also present.
		const journalEntry = entries.find(entry => "type" in entry && entry.type === "tool_execution_started");
		if (journalEntry?.type !== "tool_execution_started") {
			throw new Error(`expected a tool_execution_started journal entry, saw: ${JSON.stringify(entries)}`);
		}
		expect(journalEntry.call.toolName).toBe("bash");
		expect(journalEntry.call.rawInput).toMatchObject({ command: UNIQUE_BASH_COMMAND });
		expect(journalEntry.recordVersion).toBe(1);
		expect(journalEntry.presentation.facts).toEqual([]);

		// 3. What's actually on disk round-trips through the real v4 zod schema —
		// proving schema validity, not just TS shape. `id`/`parentId`/`timestamp`
		// are the `SessionEntryBase` fields the journal schema itself does not
		// model (it validates the `PersistedToolJournal` shape, not the session
		// entry envelope), so they are stripped before validating.
		const { id: _id, parentId: _parentId, timestamp: _timestamp, ...journalOnly } = journalEntry;
		const parsed = persistedToolJournalSchema.safeParse(journalOnly);
		expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
	});
});
