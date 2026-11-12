/**
 * `runRootCommand`'s `runSessionHost` dependency: an embedder runs the fully started session in its own
 * host instead of the TUI, print or RPC modes.
 */
import { afterEach, expect, it } from "bun:test";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand, type SessionHostContext } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	clearOmpExtensionCliRoots();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function launchArgs(sessionDir: string): Args {
	const parsed = parseArgs([]);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = sessionDir;
	return parsed;
}

it("hands a session without a model to the host, with the tool UI enabled, instead of exiting", async () => {
	const dir = TempDir.createSync("@pi-session-host-");
	tempDirs.push(dir);
	const authStorage = await AuthStorage.create(":memory:");
	const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
	// No model: print and RPC launches stop at "No models available"; a host lets its user log in first.
	const session = {
		extensionRunner: undefined,
		model: undefined,
		settings: Settings.isolated(),
		sessionManager: manager,
		subscribe: () => {},
		addDisposer: () => {},
		setScopedModelsRefresher: () => {},
		getAllToolNames: () => [],
		validateRetryFallbackChains: () => {},
		dispose: () => manager.close(),
	} as unknown as AgentSession;
	let sessionOptions: CreateAgentSessionOptions | undefined;
	let hosted: { session: AgentSession; host: SessionHostContext } | undefined;
	try {
		await runRootCommand(launchArgs(dir.path()), [], {
			discoverAuthStorage: async () => authStorage,
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			createAgentSession: async options => {
				sessionOptions = options;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
			runSessionHost: async (hostedSession, host) => {
				hosted = { session: hostedSession, host };
			},
		});
	} finally {
		logger.endTiming();
		authStorage.close();
		await manager.close().catch(() => undefined);
	}
	expect(hosted?.session).toBe(session);
	expect(typeof hosted?.host.setToolUIContext).toBe("function");
	expect(sessionOptions?.hasUI).toBe(true);
}, 15_000);
