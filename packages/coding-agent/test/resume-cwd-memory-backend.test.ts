import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { getProjectAgentDir, getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { shortenPath } from "../src/utils/render-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createModeTerminal } from "./helpers/mode-terminal";

// The TUI /resume of a session recorded in another directory moves the process there and
// rebinds memory. A Mnemopi start failure is best-effort at startup; the move must not end
// the session over it unless Mnemopi was running before the move.
describe("/resume into another directory with Mnemopi memory", () => {
	let root: TempDir;
	let originalProjectDir: string;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => initTheme());
	beforeEach(() => {
		resetSettingsForTest();
		originalProjectDir = getProjectDir();
		root = TempDir.createSync("@omp-resume-cwd-memory-");
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		resetMemoryForTests();
		resetSettingsForTest();
		AgentStorage.close();
		root.removeSync();
	});

	/**
	 * A TUI on a session in `source`, with Mnemopi selected in the agent config, and a saved
	 * session recorded in `destination`. An existing directory is not a SQLite database: as
	 * Mnemopi's database it fails every start, in the agent config, or only in the destination
	 * through that project's config.
	 */
	async function resumeFixture(mnemopiFails: "everywhere" | "in the destination") {
		const sourceCwd = path.join(root.path(), "source");
		const destinationCwd = path.join(root.path(), "destination");
		const agentDir = path.join(root.path(), "agent");
		const sourceDbPath = path.join(root.path(), "memory.db");
		fs.mkdirSync(sourceCwd, { recursive: true });
		fs.mkdirSync(destinationCwd, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			Bun.YAML.stringify({
				memory: { backend: "mnemopi" },
				mnemopi: {
					scoping: "global",
					autoRetain: false,
					noEmbeddings: true,
					llmMode: "none",
					dbPath: mnemopiFails === "everywhere" ? root.path() : sourceDbPath,
				},
			}),
		);
		if (mnemopiFails === "in the destination") {
			await Bun.write(
				path.join(getProjectAgentDir(destinationCwd), "config.yml"),
				Bun.YAML.stringify({ mnemopi: { dbPath: root.path() } }),
			);
		}

		const target = SessionManager.create(
			destinationCwd,
			SessionManager.getDefaultSessionDir(destinationCwd, agentDir),
		);
		target.appendMessage({ role: "user", content: "Destination session", timestamp: Date.now() });
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile()!;
		await target.close();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.getDefaultSessionDir(sourceCwd, agentDir));
		sessionManager.appendMessage({ role: "user", content: "Source session", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		const sourceFile = sessionManager.getSessionFile()!;

		setProjectDir(sourceCwd);
		// The TUI's applyCwdChange re-scopes the global settings; the session must hold the same instance.
		const settings = await Settings.init({ cwd: sourceCwd, agentDir });
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("openai", "test-key");
		// The SDK starts memory in the background; a user's /resume comes after that start settled.
		const memoryStart = Promise.withResolvers<void>();
		const start = mnemopiBackend.start;
		const startSpy = vi.spyOn(mnemopiBackend, "start").mockImplementation(options => {
			const started = start.call(mnemopiBackend, options);
			memoryStart.resolve(started);
			return started;
		});
		const { session } = await createAgentSession({
			cwd: sourceCwd,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(root.path(), "models.yml")),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		cleanups.push(() => session.dispose());
		await memoryStart.promise;
		startSpy.mockRestore();

		// The mode's shell runs on an in-memory terminal, not the process terminal.
		const term = createModeTerminal();
		await term.start();
		cleanups.push(() => term.dispose());
		const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		cleanups.push(async () => {
			mode.stop();
			await mode.shell.stop();
		});
		// What reaches the screen, in order. The transcript re-render after a switch clears every line shown before it.
		const screen: string[] = [];
		vi.spyOn(mode, "renderInitialMessages").mockImplementation(async () => {
			screen.length = 0;
			screen.push("transcript");
		});
		vi.spyOn(mode, "reloadTodos").mockResolvedValue(undefined);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(mode, "showWarning").mockImplementation(message => {
			screen.push(`warning: ${message}`);
		});
		vi.spyOn(mode, "showError").mockImplementation(message => {
			screen.push(`error: ${message}`);
		});

		/** Resume the destination session through the TUI and report what the user is left with. */
		const resume = async () => {
			const outcome = await mode.handleResumeSession(targetFile).then(
				() => "resolved",
				(error: unknown) => `threw: ${error instanceof Error ? error.message : String(error)}`,
			);
			return {
				outcome,
				disposed: session.isDisposed,
				sessionFile: session.sessionFile,
				cwd: session.sessionManager.getCwd(),
				processCwd: getProjectDir(),
			};
		};
		return { session, resume, screen, sourceCwd, destinationCwd, sourceFile, targetFile, sourceDbPath };
	}

	it("opens the session in its own directory with memory off and a warning when Mnemopi had not started", async () => {
		const { session, resume, screen, destinationCwd, targetFile } = await resumeFixture("everywhere");
		// Startup is best-effort: the session runs without memory.
		expect(session.getMnemopiSessionState()).toBeUndefined();

		expect(await resume()).toEqual({
			outcome: "resolved",
			disposed: false,
			sessionFile: targetFile,
			cwd: destinationCwd,
			processCwd: destinationCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		expect(screen).toEqual(["transcript", expect.stringMatching(/^warning: .*Mnemopi/)]);
	});

	it("refuses the move and keeps the session in its directory when Mnemopi ran there", async () => {
		const { session, resume, screen, sourceCwd, sourceFile, sourceDbPath } =
			await resumeFixture("in the destination");
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);

		expect(await resume()).toEqual({
			outcome: "resolved",
			disposed: false,
			sessionFile: sourceFile,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		// The rollback restarted the source's memory, so nothing is off.
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
		expect(screen).toEqual([expect.stringMatching(/^error: .*Mnemopi backend failed to initialise/)]);
	});

	// The refused move already stopped the source's Mnemopi, so the rollback reads its own state: no memory ran. It
	// takes the session back to its directory with memory off, even when the source's Mnemopi cannot start again.
	it("keeps the session in its directory, with the error and then a warning, when the rollback cannot restart Mnemopi", async () => {
		const { session, resume, screen, sourceCwd, sourceFile, sourceDbPath } =
			await resumeFixture("in the destination");
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
		// From here no Mnemopi start installs a state: neither the destination's nor the source's in the rollback.
		vi.spyOn(mnemopiBackend, "start").mockImplementation(async () => {});

		expect(await resume()).toEqual({
			outcome: "resolved",
			disposed: false,
			sessionFile: sourceFile,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		// The switch does not commit, so nothing re-renders the transcript: the rollback's warning shows at once.
		expect(screen).toEqual([
			expect.stringMatching(/^error: .*Mnemopi backend failed to initialise/),
			`warning: Memory is off: Mnemopi did not start in ${shortenPath(sourceCwd)}. The omp log has the cause.`,
		]);
	});
});
