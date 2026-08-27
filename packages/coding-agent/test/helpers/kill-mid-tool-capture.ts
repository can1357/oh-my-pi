import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type ToolCallContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

export const KILL_MID_TOOL_CALL_ID = "call_kill_mid_tool_9f3c";
export const KILL_MID_TOOL_COMMAND_MARKER = "KILLMIDTOOL_MARKER_9F3C";

/**
 * Drives a real `bash` call through a real `AgentSession`/`SessionManager`
 * (persisted, on-disk) that blocks on a lock file, then reads the session
 * JSONL back off disk *while the process is still blocked* -- the durable,
 * on-disk signature a hard kill mid-tool would leave behind: exactly one
 * `tool_execution_started` v4 journal entry for the call and zero
 * `tool_execution_settled` counterparts.
 *
 * The command cannot have finished by the time the on-disk snapshot is taken
 * (it is waiting on a lock file this function has not created yet), so this
 * is a genuine capture of an in-flight execution's durable state, not a
 * hand-built fixture standing in for one.
 *
 * The blocked call is released and allowed to finish normally before this
 * resolves, so callers never have to hard-kill a live child process; disposal
 * is the caller's responsibility via the returned `dispose()`.
 */
export async function captureKillMidToolJournal(): Promise<{
	readonly capturedEntries: SessionEntry[];
	readonly callId: string;
	readonly session: AgentSession;
	readonly dispose: () => Promise<void>;
}> {
	const tempDir = path.join(os.tmpdir(), `pi-kill-mid-tool-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	const lockFile = path.join(tempDir, "release.lock");

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

	const blockingCommand = `while [ ! -f "${lockFile}" ]; do sleep 0.02; done; echo ${KILL_MID_TOOL_COMMAND_MARKER}`;
	const scriptedResponses: MockResponse[] = [
		{
			content: [
				{
					type: "toolCall",
					id: KILL_MID_TOOL_CALL_ID,
					name: "bash",
					arguments: { command: blockingCommand, timeout: 30 },
				},
			],
			stopReason: "toolUse",
		},
		{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
	];
	const doneReply: MockResponse = { content: [{ type: "text", text: "done" }], stopReason: "stop" };
	const mock = createMockModel({ handler: () => scriptedResponses.shift() ?? doneReply });

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [bashTool as unknown as AgentTool], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
		// Without a `getToolContext`, `agent-loop.ts` cannot thread the
		// presentation producer through `AgentToolContext` and the call falls
		// back to `legacy_snapshot` -- the exact route this capture must NOT
		// exercise, matching `session-tool-execution-started-journal.test.ts`.
		getToolContext: ((toolCall?: ToolCallContext) => (toolCall === undefined ? undefined : { toolCall })) as never,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([[bashTool.name, bashTool as unknown as AgentTool]]),
	});

	const promptPromise = session.prompt("run the fixture command");

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("expected a persisted session file");

	const deadline = Date.now() + 5_000;
	let capturedEntries: SessionEntry[] = [];
	let sawStarted = false;
	while (Date.now() < deadline) {
		capturedEntries = (await loadEntriesFromFile(sessionFile)).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		if (capturedEntries.some(entry => entry.type === "tool_execution_started")) {
			sawStarted = true;
			break;
		}
		await Bun.sleep(20);
	}
	const teardown = async (): Promise<void> => {
		try {
			fs.writeFileSync(lockFile, "release");
		} catch {
			// already released or removed
		}
		await promptPromise.catch(() => undefined);
		await session.waitForIdle();
		await session.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
		resetSettingsForTest();
	};
	if (!sawStarted) {
		await teardown();
		throw new Error("timed out waiting for the durable tool_execution_started journal entry to land on disk");
	}

	return { capturedEntries, callId: KILL_MID_TOOL_CALL_ID, session, dispose: teardown };
}
