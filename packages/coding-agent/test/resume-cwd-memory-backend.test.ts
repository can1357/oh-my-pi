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

/** What memory does in a directory: Mnemopi starts there, Mnemopi fails to start there, or memory is off. */
type MemoryInDirectory = "Mnemopi starts" | "Mnemopi fails" | "memory off";

// A TUI /resume of a session recorded in another directory, and a TUI /move, move the process there and
// rebind memory. A Mnemopi start failure is best-effort at startup; a move must not end the session over it
// unless Mnemopi was running before the move, and a return to the source must not end it either.
describe("TUI /resume and /move into another directory with Mnemopi memory", () => {
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
	 * A TUI on a session in `source`, and a saved session recorded in `destination`. The agent config sets the
	 * source's memory and the destination's project config overrides it. An existing directory is not a SQLite
	 * database: as Mnemopi's database it fails every start. `targetModel` is the saved session's model.
	 */
	async function tuiFixture(
		memory: { source: MemoryInDirectory; destination: MemoryInDirectory },
		targetModel?: string,
	) {
		const sourceCwd = path.join(root.path(), "source");
		const destinationCwd = path.join(root.path(), "destination");
		const agentDir = path.join(root.path(), "agent");
		const sourceDbPath = path.join(root.path(), "memory.db");
		const destinationDbPath = path.join(root.path(), "destination-memory.db");
		fs.mkdirSync(sourceCwd, { recursive: true });
		fs.mkdirSync(destinationCwd, { recursive: true });
		const memoryConfig = (inDirectory: MemoryInDirectory, dbPath: string) => ({
			memory: { backend: inDirectory === "memory off" ? "off" : "mnemopi" },
			mnemopi: { dbPath: inDirectory === "Mnemopi fails" ? root.path() : dbPath },
		});
		const source = memoryConfig(memory.source, sourceDbPath);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			Bun.YAML.stringify({
				...source,
				mnemopi: { scoping: "global", autoRetain: false, noEmbeddings: true, llmMode: "none", ...source.mnemopi },
			}),
		);
		await Bun.write(
			path.join(getProjectAgentDir(destinationCwd), "config.yml"),
			Bun.YAML.stringify(memoryConfig(memory.destination, destinationDbPath)),
		);

		const target = SessionManager.create(
			destinationCwd,
			SessionManager.getDefaultSessionDir(destinationCwd, agentDir),
		);
		if (targetModel) target.appendModelChange(targetModel, "default");
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
		// The SDK starts memory in the background; a user's /resume or /move comes after that start settled.
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
		if (memory.source !== "memory off") await memoryStart.promise;
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
		/** The warnings on screen, in order. */
		const warnings = () => screen.filter(line => line.startsWith("warning: "));
		/** The kind of each line on screen, in order: `transcript`, `warning` or `error`. */
		const kinds = () => screen.map(line => line.split(":")[0]);
		/**
		 * Watch the next TUI command's cwd applications: `settled` turns true once the first one, a forward move with
		 * its own return to the source, has finished.
		 */
		const firstCwdApplication = () => {
			const application = { settled: false };
			const apply = mode.applyCwdChange.bind(mode);
			vi.spyOn(mode, "applyCwdChange").mockImplementation(async (...args) => {
				try {
					return await apply(...args);
				} finally {
					application.settled = true;
				}
			});
			return application;
		};

		/** What the user is left with after a TUI command settled. */
		const settle = async (command: Promise<unknown>) => {
			const outcome = await command.then(
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
		/** Resume the destination session through the TUI. */
		const resume = () => settle(mode.handleResumeSession(targetFile));
		/** `/move` the session to the destination through the TUI. */
		const move = () => settle(mode.handleMoveCommand(destinationCwd));
		return {
			mode,
			session,
			resume,
			move,
			screen,
			warnings,
			kinds,
			firstCwdApplication,
			sourceCwd,
			destinationCwd,
			sourceFile,
			targetFile,
			sourceDbPath,
		};
	}

	it("opens the session in its own directory with memory off and a warning when Mnemopi had not started", async () => {
		const { session, resume, screen, destinationCwd, targetFile } = await tuiFixture({
			source: "Mnemopi fails",
			destination: "Mnemopi fails",
		});
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
		const { session, resume, screen, sourceCwd, sourceFile, sourceDbPath } = await tuiFixture({
			source: "Mnemopi starts",
			destination: "Mnemopi fails",
		});
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

	// The refused move already stopped the source's Mnemopi. The return to the source takes the session back to its
	// directory with memory off, even when the source's Mnemopi cannot start again.
	it("keeps the session in its directory, with the error and then a warning, when the rollback cannot restart Mnemopi", async () => {
		const { session, resume, kinds, warnings, sourceCwd, sourceFile, sourceDbPath } = await tuiFixture({
			source: "Mnemopi starts",
			destination: "Mnemopi fails",
		});
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
		// From here no Mnemopi start installs a state, as a failed start does.
		vi.spyOn(mnemopiBackend, "start").mockImplementation(async () => {});

		expect(await resume()).toEqual({
			outcome: "resolved",
			disposed: false,
			sessionFile: sourceFile,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		// The switch does not commit, so nothing re-renders the transcript: the warning shows at once, after the error.
		expect(kinds()).toEqual(["error", "warning"]);
		expect(warnings()).toEqual([expect.stringContaining("Mnemopi")]);
		expect(warnings()[0]).toContain(shortenPath(sourceCwd));
	});

	// The destination's Mnemopi runs when the resume rolls back; it is not memory the source had, so the return to
	// the source must not be refused over it.
	it("returns to the source with memory off when the destination started Mnemopi and the resume then failed", async () => {
		const { session, resume, warnings, sourceCwd, sourceFile } = await tuiFixture(
			{ source: "Mnemopi fails", destination: "Mnemopi starts" },
			"missing-provider/missing-model",
		);
		expect(session.getMnemopiSessionState()).toBeUndefined();

		expect(await resume()).toEqual({
			outcome: expect.stringMatching(/^threw: .*missing-provider\/missing-model/),
			disposed: false,
			sessionFile: sourceFile,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		expect(warnings()).toEqual([expect.stringContaining("Mnemopi")]);
		expect(warnings()[0]).toContain(shortenPath(sourceCwd));
	});

	it("shows no warning for the abandoned destination when the resume rolls back to a source without memory", async () => {
		const { session, resume, warnings, sourceCwd, sourceFile } = await tuiFixture(
			{ source: "memory off", destination: "Mnemopi fails" },
			"missing-provider/missing-model",
		);

		expect(await resume()).toEqual({
			outcome: expect.stringMatching(/^threw: .*missing-provider\/missing-model/),
			disposed: false,
			sessionFile: sourceFile,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		expect(warnings()).toEqual([]);
	});

	// `/move` rolls the session file back and then applies the source directory a second time.
	it("/move shows one warning, after the error, when its rollback cannot restart Mnemopi", async () => {
		const { session, move, kinds, warnings, sourceCwd, sourceDbPath } = await tuiFixture({
			source: "Mnemopi starts",
			destination: "Mnemopi fails",
		});
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
		// From here no Mnemopi start installs a state, as a failed start does.
		vi.spyOn(mnemopiBackend, "start").mockImplementation(async () => {});

		expect(await move()).toMatchObject({
			outcome: "resolved",
			disposed: false,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		expect(kinds()).toEqual(["error", "warning"]);
		expect(warnings()).toEqual([expect.stringContaining("Mnemopi")]);
		expect(warnings()[0]).toContain(shortenPath(sourceCwd));
	});

	it("/move shows no warning when the second application of the source restarts Mnemopi", async () => {
		const { session, move, warnings, firstCwdApplication, sourceCwd, sourceDbPath } = await tuiFixture({
			source: "Mnemopi starts",
			destination: "Mnemopi fails",
		});
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
		// Mnemopi fails to start until the first cwd application, the refused destination and its own return to the
		// source, has settled; it starts again for the second.
		const application = firstCwdApplication();
		const start = mnemopiBackend.start;
		vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
			if (application.settled) await start.call(mnemopiBackend, options);
		});

		expect(await move()).toMatchObject({
			outcome: "resolved",
			disposed: false,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
		expect(warnings()).toEqual([]);
	});

	// The destination's Mnemopi runs when the move's own return to the source starts; that return must not be
	// refused over it.
	it("/move returns to the source at once when the destination started Mnemopi and the move then failed", async () => {
		const { session, move, screen, kinds, warnings, sourceCwd } = await tuiFixture({
			source: "Mnemopi fails",
			destination: "Mnemopi starts",
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		vi.spyOn(session, "refreshProjectScope").mockRejectedValueOnce(new Error("destination project scope failed"));

		expect(await move()).toMatchObject({
			outcome: "resolved",
			disposed: false,
			cwd: sourceCwd,
			processCwd: sourceCwd,
		});
		expect(session.getMnemopiSessionState()).toBeUndefined();
		// One error, the destination's, then the warning for the source the session is back in.
		expect(kinds()).toEqual(["error", "warning"]);
		expect(screen[0]).toContain("destination project scope failed");
		expect(warnings()[0]).toContain(shortenPath(sourceCwd));
	});
});
