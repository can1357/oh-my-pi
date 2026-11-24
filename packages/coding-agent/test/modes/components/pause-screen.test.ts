import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-control";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { Settings } from "../../../src/config/settings";
import { attachTerminal, createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** `/pause` running over a fixture context whose session is `session`; the screen on a terminal. */
interface PauseRun {
	readonly ctx: InteractiveModeContext;
	readonly term: TestTerminal;
	readonly done: Promise<void>;
	readonly statuses: string[];
	screen(): string;
}

function startPause(session: object = idleSession()): PauseRun {
	const statuses: string[] = [];
	const ctx = createInteractiveModeContext({
		showStatus: (message: string) => {
			statuses.push(message);
		},
	});
	// The session itself, not merged into the fixture's: the test moves its state while the screen polls.
	Object.defineProperty(ctx, "session", { value: session, configurable: true });
	const pause = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "pause");
	if (!pause?.handleTui) throw new Error("expected /pause TUI handler");
	const runtime = { draftDetached: true, ctx } as unknown as TuiSlashCommandRuntime;
	const done = Promise.resolve(pause.handleTui({ name: "pause", args: "", text: "/pause" }, runtime)).then(() => {});
	const term = attachTerminal(ctx, { columns: 80, rows: 30 });
	return {
		ctx,
		term,
		done,
		statuses,
		screen() {
			term.render();
			return (term.fullscreen() ?? term.rows()).map(row => Bun.stripANSI(row)).join("\n");
		},
	};
}

function idleSession(): object {
	return {
		isStreaming: false,
		agent: { isPaused: false },
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobTree: () => null,
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.useRealTimers();
	AgentRegistry.resetGlobalForTests();
	if (agentPauseGate.paused) agentPauseGate.resume();
});

describe("pause screen", () => {
	it("does not request mouse reporting while paused, so the terminal keeps native selection", async () => {
		// Fullscreen apps open with mouse off unless they ask otherwise (presentFullscreen); a mouse
		// request here would make the terminal send reports the paused screen drops.
		const run = startPause();
		try {
			expect(run.ctx.shell.overlays.mouse()).toBe("off");
		} finally {
			run.term.press("enter");
			await run.done;
			run.term.dispose();
		}
	});

	it("stops waiting on parked or quota-yielded advisor work", async () => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		const rootAgent = { isPaused: false };
		const subagentAgent = { isPaused: false };
		const advisorStatus = { name: "Review", status: "running", yielded: false, backlog: 1, isPaused: false };
		const noAdvisors = () => ({ configured: false, advisors: [] });
		AgentRegistry.global().register({
			id: "Main/worker",
			displayName: "worker",
			kind: "sub",
			status: "running",
			session: {
				isStreaming: true,
				runStartedAt: 1,
				agent: subagentAgent,
				getAdvisorStatusOverview: noAdvisors,
			} as unknown as AgentSession,
		});
		AgentRegistry.global().register({
			id: "Main/stale-worker",
			displayName: "stale worker",
			kind: "sub",
			status: "running",
			session: {
				isStreaming: false,
				agent: { isPaused: false },
				getAdvisorStatusOverview: noAdvisors,
			} as unknown as AgentSession,
		});
		const run = startPause({
			isStreaming: true,
			agent: rootAgent,
			getAdvisorStatusOverview: () => ({ configured: true, advisors: [advisorStatus] }),
			getAsyncJobTree: () => null,
		});
		try {
			const active = run.screen();
			expect(active).toContain("Pausing — waiting for work to settle");
			expect(active).toContain("Unsettled turns: 3");
			expect(active).toContain("Unfinished jobs: 0");

			rootAgent.isPaused = true;
			advisorStatus.yielded = true;
			vi.advanceTimersByTime(1_000);
			const liveWorkerOnly = run.screen();
			expect(liveWorkerOnly).toContain("Pausing — waiting for work to settle");
			expect(liveWorkerOnly).toContain("Unsettled turns: 1");

			subagentAgent.isPaused = true;
			vi.advanceTimersByTime(1_000);
			const quotaHalted = run.screen();
			expect(quotaHalted).toContain("Paused — ready to suspend");
			expect(quotaHalted).not.toContain("Unsettled turns:");
			expect(quotaHalted).not.toContain("Unfinished jobs:");

			advisorStatus.yielded = false;
			vi.advanceTimersByTime(1_000);
			const eligible = run.screen();
			expect(eligible).toContain("Pausing — waiting for work to settle");
			expect(eligible).toContain("Unsettled turns: 1");

			advisorStatus.isPaused = true;
			vi.advanceTimersByTime(1_000);
			const parked = run.screen();
			expect(parked).toContain("Paused — ready to suspend");
			expect(parked).not.toContain("Unsettled turns:");
		} finally {
			run.term.press("enter");
			await run.done;
			run.term.dispose();
		}
	});

	it("keeps waiting on a parked subagent's advisor and on task jobs whose subagent is not live", async () => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		const childAdvisor = { name: "Review", status: "running", yielded: false, backlog: 1, isPaused: false };
		AgentRegistry.global().register({
			id: "Main/parked",
			displayName: "parked",
			kind: "sub",
			status: "running",
			session: {
				isStreaming: true,
				runStartedAt: 1,
				agent: { isPaused: true },
				getAdvisorStatusOverview: () => ({ configured: true, advisors: [childAdvisor] }),
			} as unknown as AgentSession,
		});
		// Pre-live: registered `running` before its session exists.
		AgentRegistry.global().register({
			id: "Main/starting",
			displayName: "starting",
			kind: "sub",
			status: "running",
			session: null,
		});
		const taskJob = (agentId: string) => ({ type: "task", agentId });
		const running = [taskJob("Main/parked"), taskJob("Main/starting"), { type: "bash", agentId: undefined }];
		const run = startPause({
			isStreaming: false,
			agent: { isPaused: false },
			getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			getAsyncJobTree: () => ({ running }),
		});
		try {
			// Parked child's advisor still reviewing → 1 turn; the parked child's task job is
			// represented by its live ref, the pre-live child's task job and the bash job are not.
			const active = run.screen();
			expect(active).toContain("Unsettled turns: 1");
			expect(active).toContain("Unfinished jobs: 2");

			childAdvisor.isPaused = true;
			running.splice(1);
			vi.advanceTimersByTime(1_000);
			expect(run.screen()).toContain("Paused — ready to suspend");
		} finally {
			run.term.press("enter");
			await run.done;
			run.term.dispose();
		}
	});

	describe("gate", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			expect(agentPauseGate.paused).toBe(false);
			const run = startPause();
			try {
				expect(agentPauseGate.paused).toBe(true);
				expect(run.screen()).toContain("Paused");
				run.term.press("escape");
				await run.done;
			} finally {
				run.term.dispose();
			}
			expect(agentPauseGate.paused).toBe(false);
			expect(run.statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const run = startPause();
			try {
				run.term.press("ctrl+c");
				await run.done;
			} finally {
				run.term.dispose();
			}
			expect(agentPauseGate.paused).toBe(false);
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const run = startPause();
			try {
				await run.done; // must resolve immediately, not park
				expect(run.ctx.shell.overlays.open()).toBe(false);
				expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
			} finally {
				run.term.dispose();
			}
		});
	});
});
