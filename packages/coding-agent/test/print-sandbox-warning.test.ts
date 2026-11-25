/**
 * Contract (F16): in print mode the sandbox warning reaches stderr whole. The
 * sink `runRootCommand` installs for non-interactive launches must not cut a
 * long warning to the TUI's display width.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { parseArgs, type Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../src/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/** Long enough that the TUI's 100-cell display bound would cut it. */
const LONG_REASON =
	"the seatbelt backend needs sandbox-exec, which this host does not provide: install the Xcode command line tools and restart omp, or set sandbox.fallback to block";

const tempDirs: TempDir[] = [];
let state: SettingsTestState | undefined;

beforeEach(() => {
	state = beginSettingsTest();
});

afterEach(async () => {
	clearOmpExtensionCliRoots();
	SandboxRuntime.resetForTest();
	SandboxRuntime.setWarningSink(undefined);
	restoreSettingsTestState(state);
	state = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function printArgs(): Args {
	const parsed = parseArgs(["--print", "hello"]);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	return parsed;
}

describe("print-mode sandbox warning sink", () => {
	it("writes the unavailable-sandbox warning to stderr without truncating it", async () => {
		const dir = TempDir.createSync("@pi-print-sandbox-warning-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(":memory:");
		const settings = await Settings.init({
			inMemory: true,
			cwd: dir.path(),
			overrides: { "marketplace.autoUpdate": "off" },
		});
		cfgSandboxEnabled.set(settings, true);
		SandboxRuntime.resetForTest({
			supported: false,
			reason: LONG_REASON,
			proxy: false,
			warnings: [],
			networkMissing: [],
		});

		const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
		const session = {
			extensionRunner: undefined,
			model: { provider: "anthropic", id: "test-model" },
			settings,
			sessionManager: manager,
			subscribe: () => {},
			addDisposer: () => {},
			setScopedModelsRefresher: () => {},
			getAllToolNames: () => [],
			validateRetryFallbackChains: () => {},
			getLastAssistantMessage: () => undefined,
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => {},
			dispose: async () => {},
		} as unknown as AgentSession;

		const chunks: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			chunks.push(String(chunk));
			return true;
		}) as never);
		const quit = spyOn(postmortem, "quit").mockImplementation(async () => {});
		try {
			await runRootCommand(printArgs(), ["--print", "hello"], {
				settings,
				discoverAuthStorage: async () => authStorage,
				createAgentSession: async () => ({ session }) as unknown as CreateAgentSessionResult,
			});
			// Printing happens on `applies`: the sink runRootCommand installed is still the live one.
			const runtime = await SandboxRuntime.for(dir.path());
			expect(runtime.applies("bash")).toBe(false);
		} finally {
			stderr.mockRestore();
			quit.mockRestore();
			authStorage.close();
			await manager.close().catch(() => undefined);
		}

		const written = chunks.join("");
		expect(written).toContain(`Sandbox unavailable (${LONG_REASON});`);
		expect(written).not.toContain("…");
	});
});
