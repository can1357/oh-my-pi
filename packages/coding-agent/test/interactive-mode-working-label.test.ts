/**
 * A live (function) working label — the background-job wait row — is re-read
 * on every tick and kept to one terminal row. Without the clamp a long list of
 * job ids wrapped the working row onto a second line at narrow widths.
 *
 * While the run is paused on outside work, the row keeps naming the wait
 * whatever else takes it down: the paused prompt's own submission returning
 * after the pause reached the UI (it used to read "Working…"), an error, or a
 * maintenance step such as `/wt` or a `/tree` summary (they used to leave no
 * row at all). A gap the run did not yield in gets no wait label.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { StatusHud } from "../src/ui/dock";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { createModeTerminal, renderRows } from "./helpers/mode-terminal";

describe("InteractiveMode working label", () => {
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

	/** Run a prompt that starts a background job; the run then waits on it, its pause not shown yet. */
	async function runOnJob(): Promise<{ jobId: string; input: SubmittedUserInput }> {
		const jobId = jobs.register("bash", "sleep 150", async () => await jobGate.promise);
		const input = mode.startPendingSubmission({ text: "start the long job" });
		await session.prompt(input.text);
		await session.waitForIdle();
		expect(mode.eventController.isAwaitingAsyncWork()).toBe(true);
		return { jobId, input };
	}

	/** {@link runOnJob}, with the run's yielded `agent_pause` shown. */
	async function pauseOnJob(): Promise<{ jobId: string; input: SubmittedUserInput }> {
		const run = await runOnJob();
		mode.eventController.showAsyncWait();
		return run;
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
		const { jobId, input } = await pauseOnJob();
		mode.finishPendingSubmission(input);

		expect(statusRows(120)).toEqual([expect.stringContaining(`Waiting for background job ${jobId}`)]);
	});

	it("brings the wait back after an error while the run waits", async () => {
		const { jobId, input } = await pauseOnJob();
		mode.finishPendingSubmission(input);
		mode.showError("Unknown /skills subcommand: bogus");

		expect(statusRows(120)).toEqual([expect.stringContaining(`Waiting for background job ${jobId}`)]);
	});

	it("brings the wait back once a maintenance step that took the row finishes", async () => {
		const { jobId, input } = await pauseOnJob();
		mode.finishPendingSubmission(input);
		mode.showWorking("maintenance", { label: "Creating worktree on wt/test…", startedAt: Date.now() });
		expect(statusRows(120)).toEqual([expect.stringContaining("Creating worktree on wt/test…")]);

		mode.clearWorking("maintenance");
		expect(statusRows(120)).toEqual([expect.stringContaining(`Waiting for background job ${jobId}`)]);
	});

	it("names no wait when a row comes down in a gap the run did not yield in", async () => {
		const { input } = await runOnJob();
		mode.finishPendingSubmission(input);
		mode.showWorking("compaction", { label: "Auto context-full maintenance…", startedAt: Date.now() });

		mode.clearWorking("compaction");
		expect(statusRows(120)).toEqual([]);
	});

	it("falls back in start order after a running tool's ID changes", async () => {
		mode.isInitialized = true;
		const workingRow = () => statusRows(120).join("\n");
		const controller = mode.eventController;
		await controller.handleEvent({ type: "agent_start" });
		const start = (toolCallId: string, intent: string) =>
			controller.handleEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "bash",
				args: { command: "date -u" },
				intent,
			});
		const finish = (toolCallId: string) =>
			controller.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "bash",
				result: { content: [{ type: "text", text: "command output" }], details: undefined },
				isError: false,
			});
		const streamed = createAssistantMessage("");
		const first = { type: "toolCall" as const, id: "provisional", name: "bash", arguments: { command: "date -u" } };
		streamed.content = [first, { ...first, id: "second" }, { ...first, id: "third" }];
		await controller.handleEvent({ type: "message_start", message: streamed });
		await controller.syncAssistantMessage(streamed);
		await start(first.id, "Timing first command");
		await start("second", "Timing second command");
		await start("third", "Timing third command");
		await controller.handleEvent({
			type: "message_end",
			message: { ...streamed, content: [{ ...first, id: "final" }, ...streamed.content.slice(1)] },
		});
		expect(workingRow()).toContain("Timing third command");

		await finish("third");
		expect(workingRow()).toContain("Timing second command");
		await finish("second");
		expect(workingRow()).toContain("Timing first command");
		await finish("final");
		expect(workingRow()).toContain("Working…");
	});
});
