import { expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

it("pauses an armed loop after a terminal provider error instead of duplicating its @file attachment", async () => {
	initTheme();
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@omp-loop-provider-error-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let pendingInput: Promise<SubmittedUserInput> | undefined;
	try {
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = createMockModel({
			responses: [
				{
					content: [],
					stopReason: "error",
					errorMessage: "This request would exceed your account's rate limit. Please try again later.",
				},
			],
		});
		authStorage.keys.setRuntime("mock", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: model.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		await mode.init({ suppressWelcomeIntro: true });
		await Bun.write(path.join(tempDir.path(), "task.md"), "Implement the task.\n");
		mode.loopModeEnabled = true;
		mode.loopPrompt = "@task.md";
		await session.prompt("@task.md");
		await session.waitForIdle();

		vi.useFakeTimers();
		const submitted: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => submitted.push(input));
		vi.advanceTimersByTime(800);
		await Promise.resolve();
		await Promise.resolve();
		expect(submitted).toHaveLength(0);
		expect(mode.loopModePaused).toBe(true);
		expect(mode.loopPrompt).toBeUndefined();
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "message" && entry.message.role === "fileMention"),
		).toHaveLength(1);
	} finally {
		mode?.disableLoopMode();
		if (mode?.onInputCallback) mode.onInputCallback({ text: "", cancelled: true, started: false });
		await pendingInput;
		mode?.stop();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	}
});
