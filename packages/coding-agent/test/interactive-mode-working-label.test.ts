/**
 * A live (function) working label — the background-job wait row — is re-read
 * on every tick and kept to one terminal row. Without the clamp a long list of
 * job ids wrapped the working row onto a second line at narrow widths.
 *
 * The wait label also survives the paused run's own submission returning: the
 * pause can reach the UI first, and the submission's settle used to put the
 * label back to "Working…".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { StatusHud } from "../src/ui/dock";
import { createModeTerminal, renderRows } from "./helpers/mode-terminal";

describe("InteractiveMode live working label", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let jobs: AsyncJobManager;
	let jobGate: PromiseWithResolvers<string>;
	let session: AgentSession;
	let mode: InteractiveMode;

	function statusRows(columns: number): string[] {
		return renderRows(() => StatusHud({ model: mode.hud.status }), columns)
			.map(line => line.trimEnd())
			.filter(line => line.length > 0);
	}

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-working-label-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const mock = createMockModel({ responses: [{ content: ["job started"], stopReason: "stop" }] });
		jobs = new AsyncJobManager({});
		jobGate = Promise.withResolvers<string>();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			asyncJobManager: jobs,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		jobGate.resolve("done");
		mode.stop();
		await session.dispose();
		jobs.cancelAll();
		await jobs.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	it("keeps a long live label on one row", () => {
		const columns = 40;
		const ids = ["bg_1", "bg_2", "bg_3", "bg_4", "bg_5", "bg_6"];
		mode.ensureWorkingRow();
		mode.setWorkingMessage(() => `Waiting for ${ids.length} background jobs: ${ids.join(", ")}`);

		const rows = statusRows(columns);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Waiting for 6 background jobs");
		expect(Bun.stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(columns);
	});

	it("keeps naming the wait when the paused run's submission returns after its pause", async () => {
		const jobId = jobs.register("bash", "sleep 150", async () => await jobGate.promise);
		const input = mode.startPendingSubmission({ text: "start the long job" });
		await session.prompt(input.text);
		await session.waitForIdle();
		expect(mode.eventController.isAwaitingAsyncWork()).toBe(true);

		// The run's `agent_pause` reached the UI before the submission returned.
		mode.eventController.showAsyncWait();
		mode.finishPendingSubmission(input);

		const rows = statusRows(120);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain(`Waiting for background job ${jobId}`);
	});
});
