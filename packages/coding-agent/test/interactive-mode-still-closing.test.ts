import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

describe("InteractiveMode long shutdown status", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-still-closing-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.useRealTimers();
		mode.stop();
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it.each(["live command", "BTW history", "main session"] as const)(
		"shows progress only once pending %s cleanup lingers",
		async pendingCleanup => {
			vi.useFakeTimers();
			const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holdCleanup = () => {
				entered.resolve();
				return release.promise;
			};
			const dispose = vi.spyOn(session, "dispose").mockResolvedValue(undefined);
			if (pendingCleanup === "live command") {
				vi.spyOn(LiveCommandController.prototype, "stop").mockImplementation(holdCleanup);
			} else if (pendingCleanup === "BTW history") {
				vi.spyOn(BtwController.prototype, "flush").mockImplementation(holdCleanup);
			} else {
				dispose.mockImplementation(holdCleanup);
			}

			const shutdown = mode.shutdown();
			await entered.promise;
			expect(showStatus).not.toHaveBeenCalled();
			expect(postmortem.quit).not.toHaveBeenCalled();

			vi.advanceTimersByTime(2_999);
			expect(showStatus).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(showStatus).toHaveBeenCalledTimes(1);
			expect(postmortem.quit).not.toHaveBeenCalled();

			release.resolve();
			await shutdown;
			expect(postmortem.quit).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(10_000);
			expect(showStatus).toHaveBeenCalledTimes(1);
		},
	);

	it("cancels pending progress before returning the terminal", async () => {
		vi.useFakeTimers();
		const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(session, "dispose").mockResolvedValue(undefined);
		const draining = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		// The shell stops last: its driver drains in-flight keys and restores the terminal.
		vi.spyOn(mode.shell, "stop").mockImplementation(() => {
			draining.resolve();
			return drained.promise;
		});

		const shutdown = mode.shutdown();
		await draining.promise;
		vi.advanceTimersByTime(10_000);
		expect(showStatus).not.toHaveBeenCalled();
		expect(postmortem.quit).not.toHaveBeenCalled();

		drained.resolve();
		await shutdown;
		expect(postmortem.quit).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10_000);
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("cancels progress after a BTW flush failure and allows shutdown to retry", async () => {
		vi.useFakeTimers();
		const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});
		const stop = vi.spyOn(mode, "stop");
		const dispose = vi.spyOn(session, "dispose").mockResolvedValue(undefined);
		const entered = Promise.withResolvers<void>();
		const flush = Promise.withResolvers<void>();
		vi.spyOn(BtwController.prototype, "flush").mockImplementationOnce(() => {
			entered.resolve();
			return flush.promise;
		});

		const shutdown = mode.shutdown();
		await entered.promise;
		const failure = new Error("history storage unavailable");
		flush.reject(failure);
		await shutdown;
		expect(showError).toHaveBeenCalledWith(expect.stringContaining(failure.message));
		expect(mode.isShuttingDown).toBe(false);
		expect(dispose).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(postmortem.quit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10_000);
		expect(showStatus).not.toHaveBeenCalled();

		await mode.shutdown();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(postmortem.quit).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10_000);
		expect(showStatus).not.toHaveBeenCalled();
	});
});
