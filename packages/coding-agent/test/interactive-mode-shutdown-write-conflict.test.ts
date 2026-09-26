import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

// Regression coverage for #12238: a corrupted session file makes the close-time
// atomic rewrite fail closed with SessionWriteConflictError (it refuses to
// clobber bytes another writer added). The guard is correct, but shutdown() used
// to swallow the error, reset its own latch, and return without ever exiting —
// so the process stayed alive and every further Ctrl+C repeated the identical
// failure. The escape hatch is a second Ctrl+C that exits without writing the
// session log, and it must be reachable with a SINGLE press after the error
// message (the double-tap gate would otherwise demand two rapid presses).
//
// The conflict is produced by the REAL persistence path, not a mocked error:
// a file-backed SessionManager materializes a genuine session file, the test
// corrupts it exactly like the reporter did (`echo garbage >> sessionfile`),
// and the next real rewrite runs the storage expectedSize guard for real. The
// guard throws the genuine SessionWriteConflictError, the manager latches it,
// and the real dispose()/close() rethrows it into shutdown().
describe("InteractiveMode shutdown when the session write conflicts (#12238)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: TempDir;
	let sessionFile: string;
	let corruptedBytes: string;
	let quitSpy: Mock<typeof postmortem.quit>;
	let quitCalled: PromiseWithResolvers<void>;
	let exitSpy: Mock<typeof postmortem.exitProcess>;
	let showErrorSpy: Mock<typeof InteractiveMode.prototype.showError>;
	let disposeSpy: Mock<typeof session.dispose>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-shutdown-conflict-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		// File-backed (not inMemory): the expectedSize guard under test lives in
		// the real storage backend's rewrite path.
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};

		// A real conversation crosses the lazy gate and materializes the session
		// file on disk. Then apply the reporter's exact corruption while the
		// manager still holds its pre-corruption expectedSize.
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "yo" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			api: "anthropic-messages",
			timestamp: Date.now(),
		});
		await sessionManager.ensureOnDisk();
		const materializedFile = sessionManager.getSessionFile();
		if (!materializedFile) throw new Error("expected a materialized session file");
		sessionFile = materializedFile;
		await fs.appendFile(sessionFile, "you're now broken\n");
		corruptedBytes = await Bun.file(sessionFile).text();

		// Any real full-body rewrite (compaction, branch, entry discard, title
		// repair) now runs the storage guard against the externally modified
		// file. It throws the genuine SessionWriteConflictError, which the
		// manager latches as its disk failure; the close() inside dispose()
		// rethrows that latched error — this is the exact propagation the
		// reporter hit, with no mocked error construction.
		await sessionManager.rewriteEntries().catch(() => undefined);

		quitCalled = Promise.withResolvers<void>();
		quitSpy = vi.spyOn(postmortem, "quit").mockImplementation(async () => {
			quitCalled.resolve();
		});
		exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		showErrorSpy = vi.spyOn(mode, "showError").mockImplementation(() => {});
		// Observe only: the real dispose implementation runs.
		disposeSpy = vi.spyOn(session, "dispose");
	});

	/** Revoke write permission on the session directory: every publish then fails for real. */
	async function sealSessionDir(): Promise<void> {
		await fs.chmod(path.dirname(sessionFile), 0o555);
	}

	afterEach(async () => {
		await fs.chmod(path.dirname(sessionFile), 0o755).catch(() => undefined);
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("saves the session after an external writer changed the file", async () => {
		await mode.shutdown();

		const message = showErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(message).not.toContain("Could not close session");
		expect(mode.teardownFailed).toBe(false);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		await expect(disposeSpy.mock.results[0]!.value).resolves.toBeUndefined();
		// The transcript is durable and the unparseable bytes are gone.
		const persisted = await Bun.file(sessionFile).text();
		expect(persisted).not.toBe(corruptedBytes);
		expect(persisted).toContain("yo");
		expect(persisted).not.toContain("you're now broken");
	});

	it("exits without writing the session log on the second attempt", async () => {
		await sealSessionDir();
		await mode.shutdown();
		await mode.shutdown();

		// The second Ctrl+C is the escape hatch: it quits rather than re-running
		// the teardown that already failed once (dispose stays memoized at 1 call).
		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("a single Ctrl+C keypress after the failure reaches the escape hatch", async () => {
		await sealSessionDir();
		await mode.shutdown(); // arms the escape hatch and shows the message
		quitSpy.mockClear();

		// The user-facing path: one Ctrl+C, long after the original gesture, so the
		// 500ms double-tap gate would normally just clear the editor. With a failed
		// teardown armed it must route straight into shutdown()'s force-quit.
		mode.lastSigintTime = 0; // a single, non-double-tapped press
		mode.handleCtrlC();
		await quitCalled.promise;

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1); // never re-runs the doomed teardown
	});

	it("a failed restart arms the same single-Ctrl+C escape hatch", async () => {
		await sealSessionDir();
		await mode.restart();
		quitSpy.mockClear();

		mode.lastSigintTime = 0;
		mode.handleCtrlC();
		await quitCalled.promise;

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("bypasses a guarded process.exit after cleanup", async () => {
		await sealSessionDir();
		await mode.shutdown();
		quitSpy.mockRejectedValueOnce(new Error("process.exit is guarded"));

		await mode.shutdown();

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledTimes(1);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});
