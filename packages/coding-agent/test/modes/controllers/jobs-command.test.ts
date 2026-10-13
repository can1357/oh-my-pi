import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const WIDTH = 60;

/** `/jobs full` in text mode, as the report box above the editor shows it: its content rows, borders stripped. */
async function renderFullJobs(running: AsyncJobSnapshotItem[]): Promise<string[]> {
	const reportContainer = new Container();
	const ctx = {
		ui: { terminal: { columns: WIDTH, rows: 200 }, requestRender: () => {} },
		keybindings: { getKeys: () => ["escape"] },
		reportContainer,
		commandReportRows: () => 200,
		session: {
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleJobsCommand({ full: true });
	return reportContainer
		.render(WIDTH)
		.map(line => Bun.stripANSI(line))
		.filter(line => line.startsWith("│"))
		.map(line => line.slice(2, -2).trimEnd());
}

describe("CommandController /jobs full", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps every line of a multi-line or wrapped command indented under its job row", async () => {
		const longLine = `python /tmp/x.py ${"--flag ".repeat(12)}END`;
		const command = `cat <<'EOF' > /tmp/x.py\nimport sys\nEOF\n${longLine}`;
		const startTime = Date.now();
		const lines = await renderFullJobs([
			{ id: "bash-1", type: "bash", status: "running", label: "cat <<'EOF'...", command, startTime },
			{ id: "bash-2", type: "bash", status: "running", label: "sleep 5", startTime },
		]);

		const first = lines.findIndex(line => line.includes("bash-1"));
		const second = lines.findIndex(line => line.includes("bash-2"));
		const commandLines = lines.slice(first + 1, second);
		// Job rows start the report body; command lines sit two columns deeper.
		expect(lines[first]).toMatch(/^\S/);
		expect(commandLines.length).toBeGreaterThan(4);
		for (const line of commandLines) expect(line).toMatch(/^ {2}\S/);
		expect(commandLines.map(line => line.trim()).join(" ")).toContain("import sys EOF python /tmp/x.py --flag");
		expect(commandLines.at(-1)).toEndWith("END");
		expect(lines[second + 1]).toBe("  sleep 5");
	});
});

describe("/jobs opens the live jobs sheet", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let wasNative: boolean;

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-native-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
			agentId: "main",
		});
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
		wasNative = isNativeRendering();
		setNativeRendering(true);
	});

	afterEach(async () => {
		setNativeRendering(wasNative);
		mode?.stop();
		HistoryStorage.close();
		vi.restoreAllMocks();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("the native sheet's select/cancel actions cancel the selected owner job and Close dismisses it", async () => {
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const idA = manager.register("bash", "sleep 111", () => gates[0].promise, { ownerId: "main" });
		const idB = manager.register("bash", "cargo test --workspace", () => gates[1].promise, { ownerId: "main" });
		const transcript = [...mode.chatContainer.children];

		await mode.handleJobsCommand();

		// The native surface's Cancel acts on the row it reports selected, not on
		// the first roster row: selecting the second running job and cancelling
		// goes through the same owner-scoped cancel `/jobs kill` uses.
		expect(mode.ui.hasOverlay()).toBe(true);
		const sheet = mode.ui.overlayStack.at(-1)?.component;
		sheet?.handleNativeEvent?.({ type: "select", key: "jobs", item: idB });
		sheet?.handleNativeEvent?.({ type: "action", key: "cancel", act: "cancel", mods: [] });
		expect(manager.getJob(idB)?.status).toBe("cancelled");
		expect(manager.getJob(idA)?.status).toBe("running");
		expect(mode.chatContainer.children).toEqual(transcript);

		// Close only dismisses the surface: job rows keep their state for the next open.
		sheet?.handleNativeEvent?.({ type: "action", key: "close", act: "close", mods: [] });
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(manager.getJob(idB)?.status).toBe("cancelled");
		expect(manager.getJob(idA)?.status).toBe("running");
		expect(mode.chatContainer.children).toEqual(transcript);
		gates[0].resolve("done");
		gates[1].resolve("done");
	});

	it("`/jobs kill <id>` cancels the running job through the TUI dispatcher", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 999", () => gate.promise, { ownerId: "main" });
		const showStatus = vi.spyOn(mode, "showStatus");

		const handled = await executeBuiltinSlashCommand(`/jobs kill ${id}`, { ctx: mode });

		expect(handled).toBe(true);
		expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		expect(showStatus).toHaveBeenCalledWith(`Cancelled background job ${id}.`);
		gate.resolve("done");
	});

	it("`/jobs kill all` cancels every running job", async () => {
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const ids = gates.map((gate, index) =>
			manager.register("bash", `job-${index}`, () => gate.promise, { ownerId: "main" }),
		);

		const handled = await executeBuiltinSlashCommand("/jobs kill all", { ctx: mode });

		expect(handled).toBe(true);
		for (const id of ids) expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		for (const gate of gates) gate.resolve("done");
	});

	it("`/jobs kill <bogus>` reports the miss without cancelling", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 999", () => gate.promise, { ownerId: "main" });
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand("/jobs kill nope", { ctx: mode });

		expect(manager.getJob(id)?.status).toBe("running");
		expect(showStatus).toHaveBeenCalledWith('No running background job with id "nope".');
		gate.resolve("done");
	});

	it("`/jobs kill all` leaves a job owned by another session running", async () => {
		const ownedGate = Promise.withResolvers<string>();
		const foreignGate = Promise.withResolvers<string>();
		const ownedId = manager.register("bash", "mine", () => ownedGate.promise, { ownerId: "main" });
		const foreignId = manager.register("bash", "theirs", () => foreignGate.promise, { ownerId: "other" });

		const handled = await executeBuiltinSlashCommand("/jobs kill all", { ctx: mode });

		expect(handled).toBe(true);
		expect(manager.getJob(ownedId)?.status).toBe("cancelled");
		expect(manager.getJob(foreignId)?.status).toBe("running");
		ownedGate.resolve("done");
		foreignGate.resolve("done");
	});

	it("`/jobs kill <id>` refuses a job owned by another session", async () => {
		const foreignGate = Promise.withResolvers<string>();
		const foreignId = manager.register("bash", "theirs", () => foreignGate.promise, { ownerId: "other" });
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand(`/jobs kill ${foreignId}`, { ctx: mode });

		expect(manager.getJob(foreignId)?.status).toBe("running");
		expect(showStatus).toHaveBeenCalledWith(`No running background job with id "${foreignId}".`);
		foreignGate.resolve("done");
	});
});

const PLAIN_ROWS = 32;
const PLAIN_COLUMNS = 120;
const PLAIN_MULTILINE = "cat <<'EOF' > /tmp/x.py\nimport sys\nEOF\npython /tmp/x.py --flag";

/** The visible screen rows, ANSI stripped and right-trimmed. */
function plainScreen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

/**
 * `/jobs` on a terminal without the native surface: the composer's keystrokes
 * run through the real slash dispatcher and the fullscreen page draws on the
 * real screen.
 */
describe("/jobs on a plain terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let wasNative: boolean;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-plain-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
			agentId: "main",
		});
		wasNative = isNativeRendering();
		setNativeRendering(false);
		term = new VirtualTerminal(PLAIN_COLUMNS, PLAIN_ROWS);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
	});

	afterEach(async () => {
		setNativeRendering(wasNative);
		mode?.stop();
		HistoryStorage.close();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Boot the composer, put `rows` transcript lines on screen, return the last one. */
	async function mount(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => plainScreen(term).includes(last));
		return last;
	}

	it("keyboard `/jobs` opens the fullscreen page: narrow hides the log until Tab, PgUp pauses, End resumes, Esc closes without cancelling, and `/jobs full` still prints the report", async () => {
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		// Job A's output streams far more history lines than one screen holds, with
		// the newest line last: a pane that clips its content or draws past the
		// viewport loses `job-a-output`, an older-first one loses the history.
		const history = Array.from({ length: 60 }, (_v, i) => `job-a-history-${i}`);
		let reportA: ((text: string) => Promise<void>) | undefined;
		const idA = manager.register(
			"bash",
			"sleep 111",
			async ctx => {
				reportA = text => ctx.reportProgress(text);
				await ctx.reportProgress([...history, "job-a-output"].join("\n"));
				return gates[0].promise;
			},
			{ ownerId: "main", process: { command: PLAIN_MULTILINE, cwd: tempDir.path(), pids: () => [] } },
		);
		const idB = manager.register(
			"bash",
			"sleep 222",
			async ctx => {
				await ctx.reportProgress("job-b-output");
				return gates[1].promise;
			},
			{ ownerId: "main" },
		);
		const last = await mount(3);
		const transcript = [...mode.chatContainer.children];

		// The keystrokes a user types reach the page through the slash dispatcher.
		term.sendInput("/jobs");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("/jobs")));
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("Background jobs")));

		expect(mode.ui.hasOverlay()).toBe(true);
		const opened = plainScreen(term);
		expect(opened.some(row => row.includes(idA))).toBe(true);
		expect(opened.some(row => row.includes("sleep 111"))).toBe(true);
		expect(opened.some(row => row.includes("job-a-output"))).toBe(true);
		expect(opened.some(row => row.includes("job-b-output"))).toBe(false);
		// The wide frame carries the newest line of the long tail plus a window of
		// the history above it, not just the latest progress string.
		expect(opened.filter(row => row.includes("job-a-history-")).length).toBeGreaterThan(8);
		expect(mode.chatContainer.children).toEqual(transcript);

		// A repeat request keeps the open surface instead of stacking another.
		const openOverlays = mode.ui.overlayStack.length;
		mode.showBackgroundJobs();
		expect(mode.ui.hasOverlay()).toBe(true);
		expect(mode.ui.overlayStack.length).toBe(openOverlays);

		// PgUp pauses the tail: output appended after it must not jump the viewport.
		term.sendInput("\x1b[5~");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("paused")));
		// The split composes the roster and the log into shared rows, so compare the
		// log's own line numbers rather than whole rows (ages tick on the left).
		const paused = plainScreen(term)
			.map(row => /job-a-history-(\d+)/.exec(row)?.[1])
			.filter(index => index !== undefined);
		expect(paused.length).toBeGreaterThan(0);
		await reportA?.([...history, "job-a-output", "job-a-appended"].join("\n"));
		mode.ui.requestRender();
		await term.waitForRender();
		const afterAppend = plainScreen(term)
			.map(row => /job-a-history-(\d+)/.exec(row)?.[1])
			.filter(index => index !== undefined);
		expect(afterAppend).toEqual(paused);
		expect(plainScreen(term).some(row => row.includes("job-a-appended"))).toBe(false);

		// End resumes the tail: the newest line follows again.
		term.sendInput("\x1b[F");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("following")));
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("job-a-appended")));
		expect(plainScreen(term).some(row => row.includes("job-a-appended"))).toBe(true);

		// Narrow (40 columns): the frame drops to the roster alone, so the log is
		// hidden until Tab opens the selected job's details.
		term.resize(40, 12);
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			if (rows.some(row => row.includes("job-a-appended"))) return false;
			if (!rows.some(row => row.includes(idA))) return false;
			return rows.every(row => row.length <= 40);
		});
		const narrow = plainScreen(term);
		expect(narrow.some(row => row.includes("job-a-appended"))).toBe(false);
		expect(narrow.every(row => row.length <= 40)).toBe(true);
		expect(mode.chatContainer.children).toEqual(transcript);

		// Tab opens the selected job's details (the title names the selected id and
		// the output returns); Esc drops back.
		term.sendInput("\t");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("job-a-appended")));
		expect(plainScreen(term).some(row => row.includes(`Background jobs · ${idA}`))).toBe(true);
		term.sendInput("\x1b");
		await term.waitForRender(() => !plainScreen(term).some(row => row.includes("job-a-appended")));
		expect(plainScreen(term).some(row => row.includes(idA))).toBe(true);

		// Growing back restores the wide split with the log inline again — the
		// frame is rebuilt for the live terminal, not the stale narrow one.
		term.resize(PLAIN_COLUMNS, PLAIN_ROWS);
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("job-a-appended")));
		expect(mode.chatContainer.children).toEqual(transcript);

		// ↓ moves the selection; X cancels that job only — the same owner-scoped
		// cancel `/jobs kill` uses — and Esc closes from the roster without touching A.
		term.sendInput("\x1b[B");
		term.sendInput("x");
		await term.waitForRender(() => manager.getJob(idB)?.status === "cancelled");
		expect(manager.getJob(idB)?.status).toBe("cancelled");
		expect(manager.getJob(idA)?.status).toBe("running");
		expect(mode.chatContainer.children).toEqual(transcript);

		term.sendInput("\x1b");
		// The restored-main contract is positive: the overlay is gone, no page
		// title remains, and the transcript row is back on the main buffer. A
		// negative predicate alone would pass on the stale restoration frame the
		// alt-screen exit writes before the main screen is recomposed.
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			return !mode.ui.hasOverlay() && !rows.some(row => row.includes("Background jobs")) && rows.includes(last);
		});
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(manager.getJob(idA)?.status).toBe("running");
		expect(plainScreen(term)).toContain(last);
		expect(mode.chatContainer.children).toEqual(transcript);
		expect(term.getScrollBuffer().some(row => Bun.stripANSI(row).includes("Background jobs"))).toBe(false);

		// `/jobs full` keeps the static report at the full viewport: the running job
		// with its multiline command, and the cancelled job under Recent Jobs (the
		// report must not drop a settled job just because it was cancelled).
		term.sendInput("/jobs full");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("/jobs full")));
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("Background Jobs")));
		const report = plainScreen(term);
		expect(report.some(row => row.includes("Running: 1"))).toBe(true);
		expect(report.some(row => row.includes("Recent Jobs"))).toBe(true);
		expect(report.some(row => row.includes("sleep 222"))).toBe(true);
		expect(report.some(row => row.includes("cancelled"))).toBe(true);
		expect(report.some(row => row.includes("import sys"))).toBe(true);
		expect(mode.chatContainer.children).toEqual(transcript);

		gates[0].resolve("done");
		gates[1].resolve("done");
	});

	it("a session transition closes the open page without cancelling its jobs", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 777", () => gate.promise, { ownerId: "main" });
		const last = await mount(2);
		const transcript = [...mode.chatContainer.children];

		term.sendInput("/jobs");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("/jobs")));
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("Background jobs")));
		expect(mode.ui.hasOverlay()).toBe(true);

		// The page polls the session it was opened over: a switch must close it
		// rather than leave it repainting the former session's jobs. Wait for the
		// positive restored-main contract, not just the page title's absence — the
		// alt-screen exit writes a stale restoration frame before the main screen
		// is recomposed.
		mode.clearTransientSessionUi();
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			return !mode.ui.hasOverlay() && !rows.some(row => row.includes("Background jobs")) && rows.includes(last);
		});
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(manager.getJob(id)?.status).toBe("running");
		expect(mode.chatContainer.children).toEqual(transcript);
		expect(plainScreen(term)).toContain(last);

		gate.resolve("done");
	});

	it("defaults to bash only over a live manager task job: `a` restores it, toggling back recovers bash, and nothing is cancelled or consumed", async () => {
		const bashGate = Promise.withResolvers<string>();
		const taskGate = Promise.withResolvers<string>();
		const idBash = manager.register(
			"bash",
			"sleep 111",
			async ctx => {
				await ctx.reportProgress(["bash-out-1", "bash-out-2", "bash-out-final"].join("\n"));
				return bashGate.promise;
			},
			{ ownerId: "main", process: { command: "sleep 111", cwd: tempDir.path(), pids: () => [] } },
		);
		const idTask = manager.register(
			"task",
			"explore the repo",
			async ctx => {
				await ctx.reportProgress("task-progress-live");
				return taskGate.promise;
			},
			{ ownerId: "main" },
		);
		const last = await mount(2);
		const transcript = [...mode.chatContainer.children];

		term.sendInput("/jobs");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("/jobs")));
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("Background jobs")));

		// Bash-only default: the bash job and its output are live on the page
		// while the task job stays off it — no row, no output.
		const opened = plainScreen(term);
		expect(opened.some(row => row.includes("Background jobs · bash"))).toBe(true);
		expect(opened.some(row => row.includes(idBash))).toBe(true);
		expect(opened.some(row => row.includes("bash-out-final"))).toBe(true);
		expect(opened.some(row => row.includes(idTask))).toBe(false);
		expect(opened.some(row => row.includes("task-progress-live"))).toBe(false);

		// The runtime registry still holds every job, and the session snapshot
		// still lists the task the page is hiding — the filter is view-only.
		expect(manager.getJob(idTask)?.status).toBe("running");
		expect(manager.getAllJobs({ ownerId: "main" }).map(backendJob => backendJob.id)).toEqual(
			expect.arrayContaining([idBash, idTask]),
		);
		const snapshot = session.getAsyncJobSnapshot();
		expect(snapshot?.running.some(item => item.id === idTask && item.type === "task")).toBe(true);

		// `a` restores all jobs: the task row appears while the retained bash
		// selection keeps its output pane.
		term.sendInput("a");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes(idTask)));
		const allRows = plainScreen(term);
		expect(allRows.some(row => row.includes("Background jobs · all"))).toBe(true);
		expect(allRows.some(row => row.includes(idBash))).toBe(true);
		expect(allRows.some(row => row.includes("bash-out-final"))).toBe(true);

		// ↓ selects the task; its own reported output fills the detail pane.
		term.sendInput("\x1b[B");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("task-progress-live")));

		// Toggle back from the roster: the task hides again and the page shows the
		// bash job's output.
		term.sendInput("a");
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			return !rows.some(row => row.includes(idTask)) && rows.some(row => row.includes("bash-out-final"));
		});

		// Toggling alone cancelled nothing and consumed no results.
		expect(manager.getJob(idTask)?.status).toBe("running");
		expect(manager.getJob(idBash)?.status).toBe("running");
		expect(manager.isJobResultConsumed(idTask)).toBe(false);
		expect(manager.isJobResultConsumed(idBash)).toBe(false);
		expect(mode.chatContainer.children).toEqual(transcript);

		// The expanded log carries the same toggle: open the bash log, press `a`
		// there, and the task is back on the roster once the log is collapsed.
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes(`Background jobs · ${idBash}`)));
		term.sendInput("a");
		term.sendInput("\x1b");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes(idTask)));
		expect(plainScreen(term).some(row => row.includes("task-progress-live"))).toBe(false);

		// And back to bash-only from the roster, then a clean close.
		term.sendInput("a");
		await term.waitForRender(() => !plainScreen(term).some(row => row.includes(idTask)));
		term.sendInput("\x1b");
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			return !mode.ui.hasOverlay() && !rows.some(row => row.includes("Background jobs")) && rows.includes(last);
		});
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(manager.getJob(idTask)?.status).toBe("running");
		expect(mode.chatContainer.children).toEqual(transcript);

		bashGate.resolve("done");
		taskGate.resolve("done");
	});
});
