import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComposerShape } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionPins from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("InteractiveMode session pin indicator", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		initTheme();
	});
	beforeEach(() => {
		resetSettingsForTest();
		// init() starts a ProcessTerminal; keep it off the real terminal.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps a direct pin change when a pins-file reload started earlier resolves later", async () => {
		const dir = TempDir.createSync("omp-session-pin-");
		cleanups.push(() => dir.removeSync());
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const registry = new ModelRegistry(createInMemoryAuthStorage());
		cleanups.push(() => registry.authStorage.close());
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: false,
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		cleanups.push(() => session.dispose());
		const sessionId = session.sessionManager.getSessionId();
		// The startup reload reads the pins file before `/pin` writes it, and resolves after.
		const staleRead = Promise.withResolvers<Set<string>>();
		vi.spyOn(sessionPins, "loadPinnedSessionIds").mockReturnValue(staleRead.promise);

		const mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		cleanups.push(() => mode.stop());
		await mode.init();

		mode.applySessionPin(sessionId, true);
		staleRead.resolve(new Set());
		// The reload's continuation was queued on this promise first, so it has run once this await returns.
		await staleRead.promise;

		expect(mode.statusLine.isSessionPinned(sessionId)).toBe(true);
	});

	it("renders the session pin indicator with theme accent in band mode trailer", async () => {
		const dir = TempDir.createSync("omp-session-pin-");
		cleanups.push(() => dir.removeSync());
		await Settings.init({ inMemory: true, cwd: dir.path() });
		cfgComposerShape.set(settings, "band");
		const registry = new ModelRegistry(createInMemoryAuthStorage());
		cleanups.push(() => registry.authStorage.close());
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "composer.shape": "band" }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: false,
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		cleanups.push(() => session.dispose());
		const sessionId = session.sessionManager.getSessionId();
		await session.sessionManager.setSessionName("CHROME: Audit Outreach Leads Status");

		const mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		cleanups.push(() => mode.stop());
		await mode.init();

		mode.applySessionPin(sessionId, true);

		expect(mode.renderIdleStatusHud(80)?.[1]).toEndWith(
			`${theme.fg("accent", theme.icon.pin)} \x1b[2;3mCHROME: Audit Outreach Leads Status\x1b[23;22m`,
		);
	});
});
