/**
 * End-to-end coverage for the brush-core embedded-host session-detach fix.
 *
 * Branch: `fix/brush-detach-when-embedded`
 * Target commit: b0950f7ed
 *
 * The fix lives in `crates/vendor/brush-core/src/commands.rs` and is
 * verified at the unit level by `pi-natives::shell::tests::child_session_action`
 * (truth-table) and `embedded_external_command_runs_in_its_own_session` (real
 * brush spawn). This test pulls the fix end-to-end through the OMP coding
 * agent stack:
 *
 *   AgentSession.prompt
 *     → Agent.prompt (real)
 *       → Agent loop dispatches a tool call
 *         → BashTool.execute
 *           → executeBash
 *             → pi-natives `Shell.run` (real native binding)
 *               → brush-core::execute_external_command (the patched code)
 *                 → spawned child reports getsid()/getpid()
 *
 * The assistant's first turn is a scripted `bash` tool call asking Python to
 * print `getsid(0) getpid()`. The second scripted turn is a stop. After the
 * loop settles, we extract the child's session ID from the persisted
 * `toolResult` message and compare it against the test runner's session ID.
 *
 * Pre-fix (`new_pg=false` skipped `detach_session()`), the spawned child
 * inherits the test runner's session, so `child_sid === host_sid`.
 *
 * Post-fix, the embedded-host branch of `child_session_action` returns
 * `DetachSession`, brush calls `setsid()` before exec, and the child becomes
 * its own session leader: `child_sid === child_pid` and
 * `child_sid !== host_sid`.
 *
 * If this test ever starts failing on macOS/Linux, the embedded-host bug is
 * back and `BashTool` invocations that touch `/dev/tty` or `tcsetpgrp` can
 * SIGTTIN/SIGTTOU the OMP host process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { BashTool, type ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

/** Scripted assistant turn that issues a single `bash` tool call. */
function bashCall(command: string, callId: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command, timeout: 10 } }],
		stopReason: "toolUse",
	};
}

/** Scripted plain-text assistant turn with `stopReason: "stop"`. */
function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

/**
 * Pull the text of the most recent `toolResult` for the given tool-call id out
 * of the agent's persisted message log.
 *
 * Returning `undefined` rather than throwing keeps the failure mode obvious in
 * the test assertion: the test prints what it actually saw.
 */
function getToolResultText(messages: AgentMessage[], callId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult") continue;
		if (message.toolCallId !== callId) continue;
		const textBlock = message.content.find((block): block is { type: "text"; text: string } => block.type === "text");
		return textBlock?.text;
	}
	return undefined;
}

const PYTHON_PROBE = `python3 -c "import os; print(os.getsid(0), os.getpid())"`;

/**
 * Snapshot the current process's session id by spawning a probe directly.
 * `process.getsid` does not exist on Bun/Node — this is the most portable way.
 */
function snapshotHostSessionId(): number {
	const probe = spawnSync("python3", ["-c", "import os; print(os.getsid(0))"], { encoding: "utf8" });
	if (probe.status !== 0) {
		throw new Error(`host SID probe failed: ${probe.stderr}`);
	}
	return Number.parseInt(probe.stdout.trim(), 10);
}

/**
 * Skip the entire suite if `python3` is not available. The brush-core fix is
 * platform-conditional (POSIX only) and the probe needs `getsid`.
 */
function pythonAvailable(): boolean {
	if (process.platform === "win32") return false;
	const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
	return probe.status === 0;
}

describe("BashTool through AgentSession runs children in their own session (e2e)", () => {
	const skip = !pythonAvailable();

	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: MockResponse[];
	let hostSid: number;

	beforeAll(() => {
		if (skip) return;
		hostSid = snapshotHostSessionId();
	});

	beforeEach(async () => {
		if (skip) return;

		tempDir = path.join(os.tmpdir(), `pi-bash-detach-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		// Fresh isolated Settings rooted in tempDir so we don't pick up the
		// developer's real config (snapshots, shell prefix, etc).
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
			// BashTool consults these — keep them off so the test path is the simple
			// synchronous `executeBash` call, not the async-job manager.
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => "*",
		};
		const bashTool = new BashTool(toolSession);

		scriptedResponses = [];

		const mock = createMockModel({
			handler: () => scriptedResponses.shift() ?? stopReply("done"),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [bashTool as unknown as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool as unknown as AgentTool]]),
		});
	});

	afterEach(async () => {
		if (skip) return;
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it.skipIf(skip)("spawned child runs as its own session leader, not in the host's session", async () => {
		const callId = "call_bash_probe";
		scriptedResponses = [bashCall(PYTHON_PROBE, callId), stopReply("ok")];

		await session.prompt("probe child session id");
		await session.waitForIdle();

		const resultText = getToolResultText(session.agent.state.messages, callId);
		expect(resultText, "expected a toolResult for the bash call").toBeDefined();

		// `executeBash` wraps its own metadata around the raw output. We only
		// care about the `<sid> <pid>` line the Python probe emitted. Pull the
		// first whitespace-separated pair of positive integers.
		const match = resultText!.match(/(\d+)\s+(\d+)/);
		expect(match, `expected '<sid> <pid>' in tool result, saw: ${JSON.stringify(resultText)}`).not.toBeNull();
		const childSid = Number.parseInt(match![1]!, 10);
		const childPid = Number.parseInt(match![2]!, 10);

		expect(childSid).toBeGreaterThan(0);
		expect(childPid).toBeGreaterThan(0);

		// Pre-fix behavior: child inherits host's session.
		expect(
			childSid,
			`child sid (${childSid}) equals host sid (${hostSid}) — embedded-host detach regressed`,
		).not.toBe(hostSid);

		// Post-fix: brush ran setsid() so the child is its own session leader.
		expect(childSid, `child sid (${childSid}) !== child pid (${childPid}) — child is not session leader`).toBe(
			childPid,
		);
	});

	it.skipIf(skip)("pipelines through BashTool still produce both stages' output (no setsid breakage)", async () => {
		// Sanity check that the embedded-host detach (which calls `setsid` on solo
		// children) does not break multi-process commands. The brush-core fix carves
		// out the `in_pipeline_group` case in `child_session_action`; this test asserts
		// that pipelines run end-to-end through the agent and produce both stages'
		// output with exit code 0.
		//
		// Note: the `in_pipeline_group=true` branch is unreachable from a non-
		// interactive embedded brush (every stage spawns with `process_group_id=None`
		// and falls into the embedded-host `DetachSession` rule). The fact that the
		// pipeline still works is the load-bearing assertion: `setsid` is benign for
		// stages that are already kernel-default pgroup leaders. The pgroup carve-out
		// matters only for the interactive shell path, which is unit-tested in the
		// rust truth-table.
		const callId = "call_bash_pipeline";
		const command =
			"python3 -c \"print('stage_a')\" | " +
			"python3 -c \"import sys; data=sys.stdin.read().strip(); print('stage_b', data)\"";
		scriptedResponses = [bashCall(command, callId), stopReply("ok")];

		await session.prompt("probe pipeline");
		await session.waitForIdle();

		const resultText = getToolResultText(session.agent.state.messages, callId);
		expect(resultText, "expected a toolResult for the pipeline bash call").toBeDefined();
		expect(resultText, `pipeline output missing 'stage_b stage_a': ${JSON.stringify(resultText)}`).toContain(
			"stage_b stage_a",
		);
	});
});
