import { afterEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const child = path.join(import.meta.dir, "fixtures", "agent-session-signal-exit-child.ts");

// POSIX signal semantics: SIGTERM runs the postmortem pass and exits 143. Postmortem runs
// registrations newest first, so a host teardown registered after the session begins disposal
// before the session's own exit recorder runs, and one registered before it (ACP's) only after.
for (const order of ["host-after-session", "host-before-session"] as const) {
	test.skipIf(process.platform === "win32")(
		`SIGTERM records session_exit after the aborted assistant message (${order})`,
		async () => {
			const tempDir = TempDir.createSync("@pi-session-signal-exit-");
			const childProcess = Bun.spawn([process.execPath, child, tempDir.path(), order], {
				cwd: import.meta.dir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...Bun.env },
			});
			try {
				const reader = (childProcess.stdout as ReadableStream<Uint8Array>).getReader();
				const sessionFile = await withTimeout(
					(async () => {
						let output = "";
						while (true) {
							const chunk = await reader.read();
							if (chunk.done) throw new Error(`Child exited before readiness: ${output}`);
							output += new TextDecoder().decode(chunk.value);
							for (const line of output.split("\n")) {
								try {
									const message = JSON.parse(line) as { ready?: boolean; sessionFile?: string };
									if (message.ready && message.sessionFile) return message.sessionFile;
								} catch {}
							}
						}
					})(),
					30_000,
					"Child did not become ready for SIGTERM",
				);
				childProcess.kill("SIGTERM");
				const exitCode = await withTimeout(childProcess.exited, 30_000, "SIGTERM child did not exit");
				const reopened = await SessionManager.open(sessionFile, tempDir.path());
				const entries = reopened.getEntries();
				await reopened.close();
				const exitIndex = entries.findIndex(
					entry => entry.type === "custom" && entry.customType === "session_exit",
				);

				expect(exitCode).toBe(143);
				expect(exitIndex).toBeGreaterThanOrEqual(0);
				expect(entries.slice(exitIndex + 1)).toEqual([]);
				const exit = entries[exitIndex];
				if (exit?.type !== "custom") throw new Error("Expected session exit entry");
				expect(exit.data).toMatchObject({ reason: "sigterm", kind: "signal" });
				// The marker closes the turn the signal aborted, which is on disk ahead of it.
				expect(
					entries
						.slice(0, exitIndex)
						.some(
							entry =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.stopReason === "aborted",
						),
				).toBe(true);
			} finally {
				if (childProcess.exitCode === null) {
					childProcess.kill("SIGKILL");
					await childProcess.exited;
				}
				tempDir.removeSync();
			}
		},
		45_000,
	);
}

test("a cleanup pass whose disposal never records the marker writes it and seals the session", async () => {
	const tempDir = TempDir.createSync("@pi-session-exit-deadline-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	// The recorder is the session's own postmortem registration; a real pass would also run every other one.
	let recorder: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
	const register = postmortem.register;
	vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
		if (id.startsWith("agent-session:")) recorder = callback;
		return register(id, callback, options);
	});
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: createMockModel({ responses: [{ content: ["answer"] }] }).stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
	});
	try {
		await session.prompt("answer once");
		if (!recorder) throw new Error("Expected the session's exit recorder");
		// A wrapper began disposal but never reaches dispose(): the pass must not wait forever.
		session.beginDispose();
		vi.useFakeTimers();
		const recording = recorder(postmortem.Reason.SIGTERM);
		vi.advanceTimersByTime(8_000);
		await recording;
		vi.useRealTimers();
		manager.appendCustomEntry("written-after-the-marker", { late: true });
		await session.dispose();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const entries = reopened.getEntries();
		await reopened.close();
		const last = entries.at(-1);
		if (last?.type !== "custom") throw new Error("Expected session_exit as the last entry");
		expect(last.customType).toBe("session_exit");
		expect(last.data).toMatchObject({ reason: "sigterm", kind: "signal" });
	} finally {
		authStorage.close();
		tempDir.removeSync();
	}
}, 30_000);
