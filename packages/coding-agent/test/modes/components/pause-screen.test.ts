import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-control";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { Settings } from "../../../src/config/settings";
import {
	PauseScreenComponent,
	type PauseScreenHost,
	type PauseWorkStatus,
	renderPauseScreen,
	runPauseScreen,
} from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

// Strip SGR colors so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

interface FakeHost {
	host: PauseScreenHost;
	shown: Component[];
	statuses: string[];
	/** Teardown steps in the order the screen ran them. */
	order: string[];
	requestCount(): number;
	hiddenCount(): number;
}
function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const statuses: string[] = [];
	const order: string[] = [];
	let hidden = 0;
	let requests = 0;
	const host: PauseScreenHost = {
		ui: {
			showOverlay(component) {
				shown.push(component);
				return {
					hide: () => {
						hidden++;
						order.push("hide");
					},
					setHidden() {},
					isHidden: () => false,
				};
			},
			setFocus() {},
			requestRender() {
				requests++;
			},
			renderNow() {
				order.push("paint");
			},
			terminal: { rows },
		},
		showStatus(message) {
			statuses.push(message);
		},
	};
	return { host, shown, statuses, order, requestCount: () => requests, hiddenCount: () => hidden };
}

describe("pause screen", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		agentPauseGate.resume();
		setNativeRendering(false);
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
	});

	describe("renderPauseScreen", () => {
		it("shows both outstanding counters in the compact ANSI layout while either is positive", () => {
			const lines = renderPauseScreen(48, 12, 3_000, undefined, {
				unsettledTurns: 4,
				unfinishedJobs: 12,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(12);
			expect(text).toContain("Pausing — waiting for work to settle");
			expect(text).toContain("Unsettled turns: 4");
			expect(text).toContain("Unfinished jobs: 12");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});
		it("keeps active work counts and resume visible on a five-row compact screen with a session name", () => {
			const lines = renderPauseScreen(48, 5, 3_000, "Long compact session name", {
				unsettledTurns: 1,
				unfinishedJobs: 1,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(5);
			expect(text).toContain("Pausing — waiting for work to settle");
			expect(text).toContain("Unsettled turns: 1");
			expect(text).toContain("Unfinished jobs: 1");
			expect(text).toContain("Long compact session name");
			expect(text).toContain("to resume");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});

		it("combines both active counters into one labeled row at three rows", () => {
			const lines = renderPauseScreen(48, 3, 3_000, undefined, {
				unsettledTurns: 1,
				unfinishedJobs: 1,
			});
			const visibleLines = lines.map(stripAnsi);
			expect(lines).toHaveLength(3);
			expect(visibleLines[0]).toContain("Pausing — waiting for work to settle");
			expect(visibleLines[1]).toContain("Turns: 1 · Jobs: 1");
			expect(visibleLines[2]).toContain("to resume");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});

		it("retains active counts and a resume hint in one- and two-row fallbacks", () => {
			for (const height of [1, 2]) {
				const lines = renderPauseScreen(48, height, 3_000, undefined, {
					unsettledTurns: 1,
					unfinishedJobs: 2,
				});
				const text = lines.map(stripAnsi).join("\n");
				expect(lines).toHaveLength(height);
				expect(text).toContain("T:1");
				expect(text).toContain("J:2");
				expect(text).toContain("to resume");
				for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
			}
		});

		it("keeps abbreviated active counts and resume visible on a 16-column one-row screen", () => {
			const lines = renderPauseScreen(16, 1, 3_000, undefined, {
				unsettledTurns: 1,
				unfinishedJobs: 2,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(1);
			expect(text).toContain("T1");
			expect(text).toContain("J2");
			expect(text).toContain("resume");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(16);
		});

		it("keeps resume visible without counters on a settled 16-column one-row screen", () => {
			const lines = renderPauseScreen(16, 1, 3_000);
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(1);
			expect(text).toContain("resume");
			expect(text).not.toMatch(/\bT:?\d|\bJ:?\d/);
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(16);
		});

		it("drops to the compact card on small terminals", () => {
			const lines = renderPauseScreen(40, 10, 3_000);
			expect(lines.length).toBe(10);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("▌▌ P A U S E D");
			expect(text).toContain("paused for 0:03");
			expect(text).not.toContain("█".repeat(5)); // no room for the big glyph
		});

		it("paints the full scene with glyph, title, explainer, hours clock, and resume hint", () => {
			const lines = renderPauseScreen(80, 24, 3_725_000).map(stripAnsi);
			const text = lines.join("\n");
			expect(lines).toHaveLength(24);
			expect(text).toContain("█".repeat(5));
			expect(text).toContain("P A U S E D");
			expect(text).toContain("Main agent, subagents, and advisor");
			expect(text).toContain("Paused — ready to suspend");
			expect(text).toContain("paused for 1:02:05");
			expect(text).toContain("— resume");
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		});

		it("displays the session name when provided in full mode", () => {
			const lines = renderPauseScreen(80, 24, 65_000, "My Awesome Session");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("My Awesome Session");
			expect(text).toContain("P A U S E D");
		});

		it("displays the session name when provided in compact mode", () => {
			const lines = renderPauseScreen(40, 10, 3_000, "Compact Session Title");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("Compact Session Title");
			expect(text).not.toContain("Unsettled turns:");
			expect(text).not.toContain("Unfinished jobs:");
			expect(text).toContain("to resume");
			expect(text).toContain("▌▌ P A U S E D");
		});
	});
	it("stops waiting on parked or quota-yielded advisor work", async () => {
		vi.useFakeTimers();
		setNativeRendering(false);
		AgentRegistry.resetGlobalForTests();
		const rootAgent = { isPaused: false };
		const subagentAgent = { isPaused: false };
		const advisorStatus = {
			name: "Review",
			status: "running",
			yielded: false,
			backlog: 1,
			isPaused: false,
		};
		const noAdvisors = () => ({ configured: false, advisors: [] });
		AgentRegistry.global().register({
			id: "Main/worker",
			displayName: "worker",
			kind: "sub",
			status: "running",
			session: {
				isStreaming: true,
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
		const { host, shown } = makeHost();
		const ctx = {
			...host,
			session: {
				isStreaming: true,
				agent: rootAgent,
				getAdvisorStatusOverview: () => ({
					configured: true,
					advisors: [advisorStatus],
				}),
				getAsyncJobTree: () => null,
			},
		};
		const runtime = { draftDetached: true, ctx } as unknown as TuiSlashCommandRuntime;
		const pause = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "pause");
		if (!pause?.handleTui) throw new Error("expected /pause TUI handler");
		const running = pause.handleTui({ name: "pause", args: "", text: "/pause" }, runtime);
		const component = shown[0];
		if (!(component instanceof PauseScreenComponent)) throw new Error("expected /pause screen");

		try {
			const active = component.render(80).map(stripAnsi).join("\n");
			expect(active).toContain("Pausing — waiting for work to settle");
			expect(active).toContain("Unsettled turns: 3");
			expect(active).toContain("Unfinished jobs: 0");

			rootAgent.isPaused = true;
			advisorStatus.yielded = true;
			vi.advanceTimersByTime(1_000);
			const liveWorkerOnly = component.render(80).map(stripAnsi).join("\n");
			expect(liveWorkerOnly).toContain("Pausing — waiting for work to settle");
			expect(liveWorkerOnly).toContain("Unsettled turns: 1");
			expect(liveWorkerOnly).toContain("Unfinished jobs: 0");

			subagentAgent.isPaused = true;
			vi.advanceTimersByTime(1_000);
			const quotaHalted = component.render(80).map(stripAnsi).join("\n");
			expect(quotaHalted).toContain("Paused — ready to suspend");
			expect(quotaHalted).not.toContain("Unsettled turns:");
			expect(quotaHalted).not.toContain("Unfinished jobs:");

			advisorStatus.yielded = false;
			vi.advanceTimersByTime(1_000);
			const eligible = component.render(80).map(stripAnsi).join("\n");
			expect(eligible).toContain("Pausing — waiting for work to settle");
			expect(eligible).toContain("Unsettled turns: 1");
			expect(eligible).toContain("Unfinished jobs: 0");

			advisorStatus.isPaused = true;
			vi.advanceTimersByTime(1_000);
			const parked = component.render(80).map(stripAnsi).join("\n");
			expect(parked).toContain("Paused — ready to suspend");
			expect(parked).not.toContain("Unsettled turns:");
			expect(parked).not.toContain("Unfinished jobs:");
		} finally {
			component.handleInput("\r");
			await running;
		}
	});

	it("keeps waiting on a parked subagent's advisor and on task jobs whose subagent is not live", async () => {
		vi.useFakeTimers();
		setNativeRendering(false);
		AgentRegistry.resetGlobalForTests();
		const childAdvisor = { name: "Review", status: "running", yielded: false, backlog: 1, isPaused: false };
		AgentRegistry.global().register({
			id: "Main/parked",
			displayName: "parked",
			kind: "sub",
			status: "running",
			session: {
				isStreaming: true,
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
		const { host, shown } = makeHost();
		const ctx = {
			...host,
			session: {
				isStreaming: false,
				agent: { isPaused: false },
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
				getAsyncJobTree: () => ({ running }),
			},
		};
		const runtime = { draftDetached: true, ctx } as unknown as TuiSlashCommandRuntime;
		const pause = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "pause");
		if (!pause?.handleTui) throw new Error("expected /pause TUI handler");
		const done = pause.handleTui({ name: "pause", args: "", text: "/pause" }, runtime);
		const component = shown[0];
		if (!(component instanceof PauseScreenComponent)) throw new Error("expected /pause screen");

		try {
			// Parked child's advisor still reviewing → 1 turn; the parked child's task job is
			// represented by its live ref, the pre-live child's task job and the bash job are not.
			const active = component.render(80).map(stripAnsi).join("\n");
			expect(active).toContain("Unsettled turns: 1");
			expect(active).toContain("Unfinished jobs: 2");

			childAdvisor.isPaused = true;
			running.splice(1);
			vi.advanceTimersByTime(1_000);
			const settled = component.render(80).map(stripAnsi).join("\n");
			expect(settled).toContain("Paused — ready to suspend");
		} finally {
			component.handleInput("\r");
			await done;
		}
	});

	describe("native sheet", () => {
		// Every described node, depth-first (components inside are not walked).
		const nodes = (root: NativeChild): NativeNode[] => {
			if (!("k" in root)) return [];
			return [root, ...(root.c ?? []).flatMap(nodes)];
		};
		const texts = (root: NativeNode): string =>
			nodes(root)
				.map(n => {
					const p = n.p as { text?: string; spans?: { t: string }[] } | undefined;
					return p?.text ?? p?.spans?.map(s => s.t).join("") ?? "";
				})
				.join("\n");
		const countRoles: Record<string, true> = {
			"omp.pause.unsettled-turn-count": true,
			"omp.pause.unfinished-job-count": true,
		};
		const countNodes = (root: NativeChild): NativeNode[] =>
			nodes(root).filter(n => countRoles[(n.p as { role?: string } | undefined)?.role ?? ""] === true);
		const wireNodes = (root: TspNode): TspNode[] => [root, ...(root.c ?? []).flatMap(wireNodes)];
		const wireCountNodes = (root: TspNode): TspNode[] =>
			wireNodes(root).filter(n => countRoles[(n.p as { role?: string } | undefined)?.role ?? ""] === true);

		it("shows outstanding status and counts in semantic text nodes", () => {
			const { host } = makeHost();
			const sheet = new PauseScreenComponent(
				{ ...host, sessionName: "Credit backpressure" },
				{ getWorkStatus: () => ({ unsettledTurns: 0, unfinishedJobs: 2 }) },
			);
			const root = sheet.describe();
			const all = nodes(root);
			const clock = all.find(n => n.k === "elapsed");
			expect(clock?.p).toMatchObject({ format: "clock" });
			const shown = texts(root);
			expect(shown).toContain("Credit backpressure");
			expect(shown).toContain("Pausing — waiting for work to settle");
			expect(shown).toContain("Unsettled turns: 0");
			expect(shown).toContain("Unfinished jobs: 2");

			const buttons = all.filter(n => (n.p as { role?: string } | undefined)?.role === "omp.btn");
			expect(buttons.length).toBe(1);
			const resume = buttons[0]!.p as { tone?: string; title?: string; actions?: { click?: string } };
			expect(resume.tone).toBe("accent");
			expect(resume.actions?.click).toBe("resume");
			expect(resume.title).toStartWith("Resume  esc");
			expect(sheet.nativeOverlay).toMatchObject({ role: "omp.overlay.pause", head: "Paused" });
		});

		it("names the whole session when it has no name", () => {
			const { host } = makeHost();
			expect(texts(new PauseScreenComponent(host).describe())).toContain("Every agent in this session");
		});
		it("hides both counter rows at zero and restores them on late work in both layouts", async () => {
			vi.useFakeTimers();
			setNativeRendering(false);
			const work: PauseWorkStatus = { unsettledTurns: 0, unfinishedJobs: 1 };
			const { host, requestCount } = makeHost(24);
			const sheet = new PauseScreenComponent(host, { getWorkStatus: () => work });
			const layouts = () => [80, 48].map(width => sheet.render(width).map(stripAnsi).join("\n"));
			const counters = ["Unsettled turns:", "Unfinished jobs:"];
			for (const text of layouts()) {
				expect(text).toContain("Pausing — waiting for work to settle");
				for (const counter of counters) expect(text).toContain(counter);
			}

			const running = sheet.run();
			try {
				work.unfinishedJobs = 0;
				vi.advanceTimersByTime(1_000);
				const zeroLayouts = layouts();
				for (const zero of zeroLayouts) {
					expect(zero).toContain("Paused — ready to suspend");
					for (const counter of counters) expect(zero).not.toContain(counter);
					expect(zero).toContain("paused for");
					expect(zero).toContain("resume");
				}
				const rendersAtZero = requestCount();

				work.unsettledTurns = 1;
				vi.advanceTimersByTime(1_000);
				for (const lateWork of layouts()) {
					expect(lateWork).toContain("Pausing — waiting for work to settle");
					expect(lateWork).toContain("Unsettled turns: 1");
					expect(lateWork).toContain("Unfinished jobs: 0");
				}
				expect(requestCount()).toBeGreaterThan(rendersAtZero);
			} finally {
				sheet.handleInput("\r");
				sheet.dispose();
				await running;
			}
		});

		it("invalidates the cached native tree and deletes and restores counter rows as counts change", async () => {
			vi.useFakeTimers();
			setNativeRendering(true);
			const work: PauseWorkStatus = { unsettledTurns: 0, unfinishedJobs: 1 };
			const { host, requestCount } = makeHost();
			const sheet = new PauseScreenComponent(host, { getWorkStatus: () => work });
			const context: DescribeContext = {
				cols: 80,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			};
			const reconciler = new Reconciler("pause");
			const document = new TspDocument("pause");
			const regions = { main: [], dock: [], layer: [sheet] };
			let sequence = 0;
			const reconcile = () => {
				const ops = reconciler.reconcile(regions, context);
				expect(document.applyFrame({ sf: document.surface, s: ++sequence, ops })).toEqual([]);
				return ops;
			};
			const initial = sheet.describe();
			expect(sheet.describe()).toBe(initial);
			reconcile();
			const initialCountIds = wireCountNodes(document.snapshot()).map(n => n.id);
			expect(initialCountIds).toHaveLength(2);

			const running = sheet.run();
			const requestsBeforeZero = requestCount();
			try {
				work.unfinishedJobs = 0;
				vi.advanceTimersByTime(1_000);
				const zero = sheet.describe();
				const zeroOps = reconcile();
				expect(zero).not.toBe(initial);
				expect(texts(zero)).toContain("Paused — ready to suspend");
				const zeroNodes = nodes(zero);
				expect(zeroNodes.some(n => n.k === "elapsed")).toBe(true);
				const zeroButtons = zeroNodes.filter(n => (n.p as { role?: string } | undefined)?.role === "omp.btn");
				expect(zeroButtons).toHaveLength(1);
				expect(zeroButtons[0]!.p).toMatchObject({ tone: "accent", actions: { click: "resume" } });
				expect(countNodes(zero)).toHaveLength(0);
				expect(wireCountNodes(document.snapshot())).toHaveLength(0);
				for (const id of initialCountIds) expect(zeroOps).toContainEqual(["del", id]);
				expect(requestCount()).toBeGreaterThan(requestsBeforeZero);
				const requestsAtZero = requestCount();

				vi.advanceTimersByTime(1_000);
				expect(sheet.describe()).toBe(zero);
				expect(requestCount()).toBe(requestsAtZero);

				work.unsettledTurns = 1;
				vi.advanceTimersByTime(1_000);
				const lateWork = sheet.describe();
				const lateWorkOps = reconcile();
				expect(lateWork).not.toBe(zero);
				expect(texts(lateWork)).toContain("Pausing — waiting for work to settle");
				expect(countNodes(lateWork)).toHaveLength(2);
				expect(wireCountNodes(document.snapshot())).toHaveLength(2);
				expect(
					lateWorkOps.flatMap(op => (op[0] === "add" ? wireCountNodes(op[4]) : [])).map(n => n.p?.role),
				).toEqual(expect.arrayContaining(["omp.pause.unsettled-turn-count", "omp.pause.unfinished-job-count"]));
				expect(texts(lateWork)).toContain("Unsettled turns: 1");
				expect(texts(lateWork)).toContain("Unfinished jobs: 0");
				const buttons = wireNodes(document.snapshot()).filter(
					n => (n.p as { role?: string } | undefined)?.role === "omp.btn",
				);
				expect(buttons).toHaveLength(1);
				expect(buttons[0]!.p).toMatchObject({ tone: "accent", actions: { click: "resume" } });
				expect(requestCount()).toBeGreaterThan(requestsAtZero);
			} finally {
				sheet.handleInput("\r");
				sheet.dispose();
				await running;
			}
		});

		it("resumes from the Resume button", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host); // shows the sheet synchronously, before its first await
			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleNativeEvent({ type: "action", key: "actions/resume", act: "resume", mods: [] });
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});
	});

	describe("runPauseScreen", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			const { host, shown, statuses, hiddenCount } = makeHost();
			expect(agentPauseGate.paused).toBe(false);

			const run = runPauseScreen(host);
			await Bun.sleep(1);
			expect(agentPauseGate.paused).toBe(true);
			expect(shown.length).toBe(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x1b"); // escape → resume
			}
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("paints the frame that drops the screen before the gate opens", async () => {
			// The pane must never show PAUSED for a gate that is already open.
			// `hide()` alone only schedules a frame, and the loops this resume
			// wakes run first, so the alternate screen keeps the overlay for as
			// long as they keep the event loop busy (pane %11, 2026-10-28: 4.4 s
			// after the key, hold timer frozen, while the session already ran).
			const { host, shown, order } = makeHost();
			const unsubscribe = agentPauseGate.onChange(paused => {
				if (!paused) order.push("gate open");
			});
			try {
				const run = runPauseScreen(host);
				const component = shown[0]; // showOverlay runs before the first await
				if (!(component instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
				component.handleInput("\x1b");
				await run;
			} finally {
				unsubscribe();
			}
			expect(order).toEqual(["hide", "paint", "gate open"]);
		});

		it("releases the gate even when the teardown throws", async () => {
			// A leaked pause freezes every agent in the process with no UI left
			// to release it, so no teardown step may skip the release.
			const { host, shown } = makeHost();
			const show = host.ui.showOverlay.bind(host.ui);
			host.ui.showOverlay = (component, options) => ({
				...show(component, options),
				hide: () => {
					throw new Error("hide failed");
				},
			});
			const run = runPauseScreen(host);
			const component = shown[0];
			if (!(component instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
			component.handleInput("\x1b");
			await expect(run).rejects.toThrow("hide failed");
			expect(agentPauseGate.paused).toBe(false);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x03"); // ctrl+c
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const { host, shown } = makeHost();
			await runPauseScreen(host); // must resolve immediately, not park
			expect(shown.length).toBe(0);
			expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
		});

		it("resumes on space and enter encoded by modifyOtherKeys or the Kitty protocol", async () => {
			// tmux with `extended-keys on` sends the key as an escape sequence,
			// so a pane there answered only Escape: the operator pressed Space,
			// nothing happened, and the screen said it should have.
			for (const key of [
				"\x1b[27;1;32~", // modifyOtherKeys space
				"\x1b[27;1;13~", // modifyOtherKeys enter
				"\x1b[32u", // Kitty space
				"\x1b[13u", // Kitty enter
			]) {
				const { host, shown } = makeHost();
				const run = runPauseScreen(host);
				const component = shown[0];
				if (!(component instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
				component.handleInput(key);
				await run;
				expect(agentPauseGate.paused).toBe(false);
			}
		});

		it("keeps holding when one pty read coalesces typed text and the enter after it", async () => {
			// A pty read batches bytes that arrive faster than the TUI drains
			// them, so a word typed at the pane and its terminator reach
			// handleInput as one chunk. Matching an encoded key must not start
			// matching a chunk that merely ends with one.
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			const component = shown[0];
			if (!(component instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
			for (const chunk of [
				"/pause\r",
				"/pause\x1b[27;1;13~",
				"\x1b[27;1;47~\x1b[27;1;112~\x1b[27;1;13~",
				"\x1b[47u\x1b[112u\x1b[13u",
			]) {
				component.handleInput(chunk);
				expect(agentPauseGate.paused).toBe(true);
			}
			component.handleInput("\x1b");
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("keeps holding for input that is not a resume key", async () => {
			// An arrow, a mouse report, a paste and a modified space are not
			// resume keys in any encoding.
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			const component = shown[0];
			if (!(component instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
			for (const chunk of ["\x1b[A", "\x1b[<0;10;5M", "\x1b[200~ \x1b[201~", "\x1b[27;2;32~"]) {
				component.handleInput(chunk);
				expect(agentPauseGate.paused).toBe(true);
			}
			component.handleInput("\x1b");
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});
	});
});
