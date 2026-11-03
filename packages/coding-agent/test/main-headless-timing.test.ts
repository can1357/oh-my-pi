/**
 * Startup timing records spans into one in-memory tree until `endTiming()`.
 * Headless runners (print, RPC, ACP) are long-lived, so work done after
 * startup — every session and subagent the run spawns — must not keep
 * appending to that tree for the life of the process.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { parseArgs, type Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { installEnvRestores, installMockRestores, testLifetime } from "../../utils/test/helpers/mock-restores";
import { createTeardownFence } from "./helpers/teardown-fence";

installMockRestores();
// The async afterEach can time out, and Bun then skips `onTestFinished`; this owner still puts
// PI_TIMING back at the next test and when the file ends.
installEnvRestores(["PI_TIMING"]);

const tempDirs: TempDir[] = [];
/** Parks a body abandoned on timeout before `runRootCommand` reaches the real `postmortem.quit`. */
const fence = createTeardownFence();

afterEach(async () => {
	fence.close();
	vi.restoreAllMocks();
	// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
	clearOmpExtensionCliRoots();

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
		const life = testLifetime();
		// Print mode intentionally keeps recording under PI_TIMING; this case covers the default.
		// Every await goes through `step`, so a body abandoned on timeout parks before it installs
		// the quit spy or reaches `postmortem.quit` (see `fence`).
		const step = fence.forThisTest();
		const dir = TempDir.createSync("@pi-headless-timing-");
		tempDirs.push(dir);
		const authStorage = await step(() => AuthStorage.create(":memory:"));
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
			validateRetryFallbackChains: () => {},
			getLastAssistantMessage: () => undefined,
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: () => step(async () => {}),
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: () => step(async () => true),
			prompt: () =>
				step(async () => {
					recordedDuringPrompt = spanRecorded();
				}),
			dispose: () => step(() => manager.close()),
		} as unknown as AgentSession;
		const quitSpy = spyOn(postmortem, "quit").mockImplementation(async () => {});
		life.assertLive();
		delete process.env.PI_TIMING;
		try {
			await runRootCommand(headlessArgs(["--print", "hello"], dir.path()), ["--print", "hello"], {
				discoverAuthStorage: () => step(async () => authStorage),
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
				createAgentSession: () => step(async () => ({ session }) as unknown as CreateAgentSessionResult),
			});
		} finally {
			logger.endTiming();
			quitSpy.mockRestore();
			authStorage.close();
			await manager.close().catch(() => undefined);
		}
		expect(recordedDuringPrompt).toBe(false);
	}, 15_000);

	it("stops recording before the ACP server runs", async () => {
		// Guarded too: a late `runRootCommand` would register CLI extension roots during a later test.
		const step = fence.forThisTest();
		const dir = TempDir.createSync("@pi-headless-timing-");
		tempDirs.push(dir);
		const authStorage = await step(() => AuthStorage.create(":memory:"));
		let recordedWhileServing: boolean | undefined;
		// The ACP server never returns; the stub stops it with a sentinel once it has observed.
		const stopServing = new Error("stop ACP server");
		try {
			await runRootCommand(headlessArgs(["--mode", "acp"], dir.path()), ["--mode", "acp"], {
				discoverAuthStorage: () => step(async () => authStorage),
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
