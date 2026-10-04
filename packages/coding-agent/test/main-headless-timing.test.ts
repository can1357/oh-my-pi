/**
 * Startup timing records spans into one in-memory tree until `endTiming()`.
 * Headless runners (print, RPC, ACP) are long-lived, so work done after
 * startup — every session and subagent the run spawns — must not keep
 * appending to that tree for the life of the process.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseArgs, type Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/** Whether a span opened now would be recorded into the startup timing tree. */
function spanRecorded(): boolean {
	return logger.time("post-startup-work", () => logger.openSpanPath().includes("post-startup-work"));
}

function headlessArgs(argv: string[], sessionDir: string): Args {
	const parsed = parseArgs(argv);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = sessionDir;
	return parsed;
}

describe("startup timing after a headless runner starts", () => {
	it("stops recording before print mode runs the prompt", async () => {
		const dir = TempDir.createSync("@pi-headless-timing-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(":memory:");
		const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
		let recordedDuringPrompt: boolean | undefined;
		const session = {
			extensionRunner: undefined,
			model: { provider: "anthropic", id: "test-model" },
			settings: Settings.isolated(),
			sessionManager: manager,
			subscribe: () => {},
			addDisposer: () => {},
			getAllToolNames: () => [],
			getAgentId: () => "Main",
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			getLastAssistantMessage: () => undefined,
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => {
				recordedDuringPrompt = spanRecorded();
			},
			dispose: () => manager.close(),
		} as unknown as AgentSession;
		const quitSpy = spyOn(postmortem, "quit").mockImplementation(async () => {});
		// Print mode intentionally keeps recording under PI_TIMING; this case covers the default.
		const savedTiming = process.env.PI_TIMING;
		delete process.env.PI_TIMING;
		try {
			await runRootCommand(headlessArgs(["--print", "hello"], dir.path()), ["--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
				createAgentSession: async () => ({ session }) as unknown as CreateAgentSessionResult,
			});
		} finally {
			if (savedTiming !== undefined) process.env.PI_TIMING = savedTiming;
			logger.endTiming();
			quitSpy.mockRestore();
			authStorage.close();
			await manager.close().catch(() => undefined);
		}
		expect(recordedDuringPrompt).toBe(false);
	}, 15_000);

	it("stops recording before the ACP server runs", async () => {
		const dir = TempDir.createSync("@pi-headless-timing-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(":memory:");
		let recordedWhileServing: boolean | undefined;
		// The ACP server never returns; the stub stops it with a sentinel once it has observed.
		const stopServing = new Error("stop ACP server");
		try {
			await runRootCommand(headlessArgs(["--mode", "acp"], dir.path()), ["--mode", "acp"], {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
				runAcpMode: async () => {
					recordedWhileServing = spanRecorded();
					throw stopServing;
				},
			});
		} catch (error) {
			if (error !== stopServing) throw error;
		} finally {
			logger.endTiming();
			authStorage.close();
		}
		expect(recordedWhileServing).toBe(false);
	}, 15_000);
});
