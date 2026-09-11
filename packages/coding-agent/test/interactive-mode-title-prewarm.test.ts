import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Issue #6462: the first submit used to spawn the local tiny-title worker
// synchronously ahead of the first frame, and title generation started before
// the optimistic user row painted. Startup now prewarms an idle worker, and the
// submit handler paints the pending row before kicking off titling.
describe("InteractiveMode tiny-title prewarm", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	// Titling (and thus the prewarm gate) is disabled when PI_NO_TITLE is set,
	// which the test env exports globally. Clear it per-test and restore after.
	let previousNoTitle: string | undefined;

	beforeAll(() => {
		initTheme();
		tempDir = TempDir.createSync("@pi-interactive-mode-title-prewarm-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from writing escape queries to the real
		// terminal; the test only drives the mode API, not real terminal I/O.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, () => {}, [], undefined, undefined);
		// A real fs.watch on repo HEAD in a parallel Bun worker can trip a Bun
		// SIGTRAP in the suite; this contract does not need branch watching.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		resetSettingsForTest();
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("prewarms the configured local worker on startup for an unnamed session", async () => {
		session.settings.set("providers.tinyModel", "lfm2.5-230m");
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});

		await mode.init();
		// The prewarm call is deferred behind a setImmediate queued during
		// init() (see interactive-mode.ts); init()'s own awaits are promise
		// microtasks that can resolve without yielding to the immediate
		// queue, so the prewarm may not have fired yet when init() settles.
		// Flush one immediate tick before asserting.
		const immediateFlushed = Promise.withResolvers<void>();
		setImmediate(immediateFlushed.resolve);
		await immediateFlushed.promise;

		expect(prewarm).toHaveBeenCalledWith("lfm2.5-230m");
	});

	it("does not prewarm when the session is already named", async () => {
		session.settings.set("providers.tinyModel", "lfm2.5-230m");
		vi.spyOn(mode.sessionManager, "getSessionName").mockReturnValue("resumed-session");
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});

		await mode.init();

		expect(prewarm).not.toHaveBeenCalled();
	});

	it("paints the pending user row before starting title generation", async () => {
		await mode.init();

		const order: string[] = [];
		vi.spyOn(mode, "startPendingSubmission").mockImplementation(input => {
			order.push("pending-row");
			return { text: input.text, cancelled: false, started: false };
		});
		const generateTitle = vi.spyOn(session, "generateTitle").mockImplementation(async () => {
			order.push("title-gen");
			return null;
		});
		const onInput = vi.fn();
		mode.onInputCallback = onInput;

		await mode.editor.onSubmit?.("investigate the failing title worker");

		expect(order).toEqual(["pending-row", "title-gen"]);
		expect(generateTitle).toHaveBeenCalledWith("investigate the failing title worker");
		expect(onInput).toHaveBeenCalledTimes(1);
	});
});
