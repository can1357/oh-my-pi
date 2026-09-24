import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncJobSnapshot, AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	tempDir: TempDir;
	setStreaming: (value: boolean) => void;
	setJobs: (running?: AsyncJobSnapshotItem[], recent?: AsyncJobSnapshotItem[]) => void;
	getSnapshotCalls: () => number;
};

let harness: Harness | undefined;

async function createHarness(): Promise<Harness> {
	if (harness) {
		harness.setStreaming(false);
		harness.mode.clearTransientSessionUi();
		harness.setJobs();
		harness.mode.chatContainer.disposeChildren();
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-deferred-notice-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Deferred notice", "user");
	let streaming = false;
	let snapshot: AsyncJobSnapshot = {
		running: [],
		recent: [],
		delivery: { queued: 0, delivering: false, pendingJobIds: [] },
	};
	let snapshotCalls = 0;
	const session = {
		sessionManager,
		settings,
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		getAsyncJobSnapshot: (options?: { recentLimit?: number }) => {
			snapshotCalls++;
			return options?.recentLimit === 0 ? { ...snapshot, recent: [] } : snapshot;
		},
		get isStreaming() {
			return streaming;
		},
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	harness = {
		mode,
		tempDir,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		setJobs: (running = [], recent = []) => {
			snapshot = { running, recent, delivery: { queued: 0, delivering: false, pendingJobIds: [] } };
		},
		getSnapshotCalls: () => snapshotCalls,
	};
	return harness;
}

function noticeText(mode: InteractiveMode): string {
	return mode.deferredCommandContainer.render(120).join("\n");
}

function jobsText(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.jobsContainer.render(120).join("\n"));
}
function transcriptRowCount(mode: InteractiveMode): number {
	return mode.chatContainer.render(120).length;
}

function transcriptText(mode: InteractiveMode): string {
	return mode.chatContainer.render(120).join("\n");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode deferred command preview", () => {
	it("shows the panel immediately mid-turn without touching the transcript", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const transcriptBefore = transcriptRowCount(mode);

		mode.presentCommandOutput(new Text("Claude 5 Hour: 62% used", 1, 0));

		// The answer is visible right away, which is the whole point: before this,
		// a command run mid-turn was indistinguishable from a dead one.
		expect(noticeText(mode)).toContain("Claude 5 Hour: 62% used");
		// But never via the transcript: a mid-turn transcript mount re-renders rows
		// below the growing live block and duplicates them in native scrollback
		// (issues #4806/#6767), which is what deferral was introduced to stop.
		expect(transcriptRowCount(mode)).toBe(transcriptBefore);
		expect(transcriptText(mode)).not.toContain("Claude 5 Hour");
	});

	it("counts commands rather than the components each one queues", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);

		// One command commonly queues a spacer plus its panel; that is still one
		// command from the user's point of view.
		mode.presentCommandOutput([new Text("spacer", 1, 0), new Text("usage panel", 1, 0)]);
		expect(noticeText(mode)).toContain("1 command output");

		mode.presentCommandOutput(new Text("advisor panel", 1, 0));
		expect(noticeText(mode)).toContain("2 command outputs");
	});

	it("caps a tall panel so the prompt stays on screen", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const tall = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");

		mode.presentCommandOutput(new Text(tall, 1, 0));

		const rows = mode.deferredCommandContainer.render(120);
		expect(rows.length).toBeLessThan(60);
		expect(rows.join("\n")).toContain("row 0");
		expect(rows.join("\n")).toContain("more rows");
		// The tail is not silently dropped: it arrives in full at the settle.
		expect(rows.join("\n")).not.toContain("row 199");
	});

	it("clears the preview and mounts the panels once the turn settles", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("usage panel", 1, 0));
		expect(noticeText(mode)).not.toBe("");

		setStreaming(false);
		mode.flushPendingCommandOutput();

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("usage panel");
	});

	it("shows no preview when the agent is idle, since output mounts immediately", async () => {
		const { mode } = await createHarness();

		mode.presentCommandOutput(new Text("usage panel", 1, 0));

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("usage panel");
	});

	it("drops a stale preview when the session is reset while output is queued", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("usage panel", 1, 0));
		expect(noticeText(mode)).not.toBe("");

		mode.clearTransientSessionUi();

		expect(noticeText(mode)).toBe("");
	});

	it("starts the queue over after a reset, so a later command previews alone", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("stale panel", 1, 0));

		// The reset keeps the same session id here, so nothing downstream can
		// recognise the leftover queue as stale; it has to be dropped at the reset.
		mode.clearTransientSessionUi();
		mode.presentCommandOutput(new Text("fresh panel", 1, 0));

		const notice = noticeText(mode);
		expect(notice).toContain("fresh panel");
		expect(notice).not.toContain("stale panel");
		expect(notice).toContain("1 command output");
		expect(notice).not.toContain("2 command outputs");
	});
});

describe("InteractiveMode live jobs HUD", () => {
	const first: AsyncJobSnapshotItem = {
		id: "bash_first",
		type: "bash",
		status: "running",
		label: "compile first",
		startTime: 0,
		agentId: undefined,
	};
	const second: AsyncJobSnapshotItem = { ...first, id: "bash_second", label: "compile second" };

	it("opens mid-turn before jobs start, refreshes in place, and persists past turn completion without transcript rows", async () => {
		const { mode, setStreaming, setJobs } = await createHarness();
		vi.useFakeTimers();
		setStreaming(true);
		const transcriptBefore = transcriptRowCount(mode);
		await mode.handleJobsCommand();
		expect(jobsText(mode)).toContain("Running: 0");
		expect(noticeText(mode)).toBe("");

		setJobs([first]);
		vi.advanceTimersByTime(1000);
		expect(jobsText(mode)).toContain("compile first");

		setStreaming(false);
		mode.flushPendingCommandOutput();
		setJobs([second]);
		vi.advanceTimersByTime(1000);
		expect(jobsText(mode)).toContain("compile second");
		expect(jobsText(mode)).not.toContain("compile first");

		setJobs([]);
		vi.advanceTimersByTime(1000);
		expect(jobsText(mode)).toContain("Running: 0");
		expect(jobsText(mode)).not.toContain("compile second");
		expect(transcriptRowCount(mode)).toBe(transcriptBefore);
	});

	it("dismisses on the second call and stops refreshing until reopened", async () => {
		const { mode, setJobs, getSnapshotCalls } = await createHarness();
		vi.useFakeTimers();
		setJobs([first]);
		await mode.handleJobsCommand();
		expect(jobsText(mode)).toContain("compile first");
		await mode.handleJobsCommand();
		expect(jobsText(mode)).toBe("");
		const callsAfterDismissal = getSnapshotCalls();
		vi.advanceTimersByTime(3000);
		expect(getSnapshotCalls()).toBe(callsAfterDismissal);

		setJobs([second]);
		await mode.handleJobsCommand();
		expect(jobsText(mode)).toContain("compile second");
		expect(jobsText(mode)).not.toContain("compile first");
	});

	it("drops the HUD and its poller when transient session UI is cleared", async () => {
		const { mode, setJobs, getSnapshotCalls } = await createHarness();
		vi.useFakeTimers();
		setJobs([first]);
		await mode.handleJobsCommand();
		mode.clearTransientSessionUi();
		expect(jobsText(mode)).toBe("");
		const callsAfterReset = getSnapshotCalls();
		vi.advanceTimersByTime(3000);
		expect(getSnapshotCalls()).toBe(callsAfterReset);
	});

	it("keeps the idle one-time report with recent jobs in the transcript", async () => {
		const { mode, setJobs, getSnapshotCalls } = await createHarness();
		vi.useFakeTimers();
		setJobs([], [{ ...first, status: "completed" }]);
		await mode.handleJobsCommand();
		expect(jobsText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("compile first");
		const callsAfterReport = getSnapshotCalls();
		vi.advanceTimersByTime(3000);
		expect(getSnapshotCalls()).toBe(callsAfterReport);
	});

	it("clears the HUD and stops polling when the mode stops", async () => {
		const { mode, setJobs, getSnapshotCalls } = await createHarness();
		vi.useFakeTimers();
		setJobs([first]);
		await mode.handleJobsCommand();
		mode.stop();
		expect(jobsText(mode)).toBe("");
		const callsAfterStop = getSnapshotCalls();
		vi.advanceTimersByTime(3000);
		expect(getSnapshotCalls()).toBe(callsAfterStop);
	});
});
