import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ROWS = 32;

/** The rendered viewport, as a real terminal would show it. */
function screen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("/jobs kill through the real terminal input path", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-kill-term-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
			agentId: "main",
		});
		term = new VirtualTerminal(120, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Type a line into the composer and submit it, waiting for the render to settle. */
	async function submit(line: string, rendered: string): Promise<void> {
		term.sendInput(line);
		await term.waitForRender(() => screen(term).some(row => row.includes(line)));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes(rendered)));
	}

	it("cancels the job and shows the confirmation in the status area", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "sleep 999", () => gate.promise, { id: "demo-1", ownerId: "main" });
		expect(session.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual(["demo-1"]);

		await submit("/jobs kill demo-1", "Cancelled background job demo-1.");

		expect(manager.getJob("demo-1")?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		gate.resolve("done");
	});

	it("echoes an unknown id on one line", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		await submit("/jobs kill nope", 'No running background job with id "nope".');

		expect(screen(term).some(row => row.includes('No running background job with id "nope".'))).toBe(true);
	});
});
