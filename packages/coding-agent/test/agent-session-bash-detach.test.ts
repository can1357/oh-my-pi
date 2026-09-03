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
 * The assistant's first turn is one scripted `bash` tool call that runs both
 * the session-ID probe and a two-stage pipeline. The second scripted turn is a
 * stop. We inspect the resulting `toolResult` for the child's session identity
 * and the pipeline's output.
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
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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

		authStorage = createInMemoryAuthStorage();
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

	it.skipIf(skip)("preserves detached children and pipeline execution through BashTool", async () => {
		const callId = "call_bash_lifecycle";
		const command =
			`${PYTHON_PROBE}; ` +
			"python3 -c \"print('stage_a')\" | " +
			"python3 -c \"import sys; data=sys.stdin.read().strip(); print('stage_b', data)\"";
		scriptedResponses = [bashCall(command, callId), stopReply("ok")];

		await session.prompt("probe child session id and pipeline");

		const resultText = getToolResultText(session.agent.state.messages, callId);
		expect(resultText, "expected a toolResult for the bash lifecycle probe").toBeDefined();

		// The standalone probe covers the embedded-host DetachSession path. The
		// following pipeline in the same real BashTool invocation guards against
		// setsid breaking multi-process commands.
		const match = resultText!.match(/(\d+)\s+(\d+)/);
		expect(match, `expected '<sid> <pid>' in tool result, saw: ${JSON.stringify(resultText)}`).not.toBeNull();
		const childSid = Number.parseInt(match![1]!, 10);
		const childPid = Number.parseInt(match![2]!, 10);

		expect(childSid).toBeGreaterThan(0);
		expect(childPid).toBeGreaterThan(0);
		expect(
			childSid,
			`child sid (${childSid}) equals host sid (${hostSid}) — embedded-host detach regressed`,
		).not.toBe(hostSid);
		expect(childSid, `child sid (${childSid}) !== child pid (${childPid}) — child is not session leader`).toBe(
			childPid,
		);
		expect(resultText, `pipeline output missing 'stage_b stage_a': ${JSON.stringify(resultText)}`).toContain(
			"stage_b stage_a",
		);
	});
});
