/**
 * Regression: the agent hub row order must be stable while the hub is open.
 *
 * The hub is sorted by lastActivity on first open, but after that keyboard
 * selection must not jump around as agents heartbeat or update activity. New
 * agents that appear while the hub is open are appended at the end.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type AgentHubDeps, AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentActivityIndex, type AgentActivityRow } from "../src/activity";

interface GeometryStub {
	setRows(n: number): void;
	restore(): void;
}

function stubStdoutGeometry(cols: number): GeometryStub {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function makeHub(agents: AgentRegistry, overrides: Partial<AgentHubDeps> = {}) {
	return new AgentHubOverlayComponent({
		settings: Settings.isolated(),
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
		...overrides,
	});
}

interface RenderedAgentRow {
	id: string;
	selected: boolean;
}

const ROSTER_ENTRY_PATTERN = /^(❯| ) (?:(?:(?:│ {3}| {4})*)(?:├── |└── ))?(\S+) (\S+)/u;
function rosterEntryMatch(cell: string | undefined): RegExpExecArray | null {
	if (!cell) return null;
	const match = ROSTER_ENTRY_PATTERN.exec(cell);
	return match?.[2] === "│" ? null : match;
}

function rosterCell(raw: string): string | undefined {
	const line = Bun.stripANSI(raw);
	if (!line.startsWith("│ ")) return undefined;
	const divider = line.indexOf("│", Math.max(2, Math.floor(line.length / 3)));
	if (divider < 0) return undefined;
	return line.slice(2, Math.max(2, divider - 1));
}

function renderedAgentRows(hub: AgentHubOverlayComponent, width = 120): RenderedAgentRow[] {
	// `<cursor> <status-glyph> [tree-prefix] <id> …`; continuation rows may
	// carry `│` in the status column and are rejected by rosterEntryMatch.
	const rows: RenderedAgentRow[] = [];
	for (const raw of hub.render(width)) {
		const match = rosterEntryMatch(rosterCell(raw));
		if (match) rows.push({ id: match[3]!, selected: match[1] === "❯" });
	}
	return rows;
}

function renderedAgentIds(hub: AgentHubOverlayComponent): string[] {
	return renderedAgentRows(hub).map(row => row.id);
}

function selectedAgentId(hub: AgentHubOverlayComponent): string | undefined {
	return renderedAgentRows(hub).find(row => row.selected)?.id;
}

function renderedRosterEntry(hub: AgentHubOverlayComponent, id: string, width: number): string {
	const cells = hub.render(width).map(rosterCell);
	const start = cells.findIndex(cell => rosterEntryMatch(cell)?.[3] === id);
	expect(start).toBeGreaterThanOrEqual(0);
	const entry: string[] = [];
	for (let i = start; i < cells.length; i++) {
		const cell = cells[i];
		if (cell === undefined || cell.trim().length === 0) break;
		if (i > start && rosterEntryMatch(cell)) break;
		entry.push(cell.trimEnd());
	}
	return entry.join("\n");
}
function renderedRosterHeaderLineRaw(hub: AgentHubOverlayComponent, id: string, width: number): string {
	const line = hub.render(width).find(raw => rosterEntryMatch(rosterCell(raw))?.[3] === id);
	if (!line) throw new Error(`No rendered roster header for ${id}`);
	return line;
}

function leftClick(row1Based: number): string {
	return `\x1b[<0;4;${row1Based}M`;
}

function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};4;4M`;
}

describe("Agent hub row ordering", () => {
	let geometry: GeometryStub | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("renders a useful empty state before any task agents exist", () => {
		geometry = stubStdoutGeometry(120);
		const hub = makeHub(new AgentRegistry());

		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("No agents in this session");
			expect(rendered).toContain("Finished, parked, and killed subagents remain with the session");
			expect(rendered).toContain("Resume that session with omp-dev --continue, or spawn a task here.");
		} finally {
			hub.dispose();
		}
	});

	it("keeps section navigation visible in Agents and moves right to Activity", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: null });
		const hub = makeHub(agents);

		try {
			const agentsFrame = Bun.stripANSI(hub.render(120).join("\n"));
			expect(agentsFrame).toContain("1 Agents");
			expect(agentsFrame).toContain("2 Activity");
			expect(agentsFrame).toContain("3 Messages");

			hub.handleInput("\x1b[C");
			const activityFrame = Bun.stripANSI(hub.render(120).join("\n"));
			expect(activityFrame).toContain("No agent activity recorded yet");
		} finally {
			hub.dispose();
		}
	});

	it("re-sorts rows by most-recent activity while the hub is open", () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			geometry = stubStdoutGeometry(120);
			const agents = new AgentRegistry();
			setSystemTime(1000);
			const sessionA = {} as AgentSession;
			agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: sessionA });

			setSystemTime(2000);
			const sessionB = {} as AgentSession;
			agents.register({ id: "B", displayName: "Beta", kind: "sub", session: sessionB });

			setSystemTime(3000);
			const sessionC = {} as AgentSession;
			agents.register({ id: "C", displayName: "Gamma", kind: "sub", session: sessionC });

			hub = makeHub(agents);
			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);
			// Bump A's lastActivity far ahead of the others; recency wins live.
			setSystemTime(4000);
			agents.setActivity("A", "still running");

			// A parked agent sorts below live ones by status order.
			setSystemTime(5000);
			const sessionD = {} as AgentSession;
			agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD, status: "parked" });
			// Renders coalesce: the immediate frame still shows the captured order.
			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);
			vi.advanceTimersByTime(100);
			expect(renderedAgentIds(hub)).toEqual(["A", "C", "B", "D"]);
		} finally {
			hub?.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("filters agents with a fuzzy query and clears on Escape", () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			geometry = stubStdoutGeometry(120);
			const agents = new AgentRegistry();
			const sessionA = {} as AgentSession;
			agents.register({ id: "alpha-one", displayName: "Alpha", kind: "sub", session: sessionA });
			const sessionB = {} as AgentSession;
			agents.register({ id: "beta-two", displayName: "Beta", kind: "sub", session: sessionB });

			hub = makeHub(agents);
			expect(renderedAgentIds(hub)).toEqual(["alpha-one", "beta-two"]);
			hub.handleInput("/");
			hub.handleInput("a");
			hub.handleInput("p");
			expect(renderedAgentIds(hub)).toEqual(["alpha-one"]);
			hub.handleInput("\u001b");
			expect(renderedAgentIds(hub)).toEqual(["alpha-one", "beta-two"]);
		} finally {
			hub?.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("bounds observer lookups and entry rendering to the viewport on large rosters", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(12);
		const agents = new AgentRegistry();
		for (let i = 0; i < 10_000; i++) {
			const id = `Agent-${i.toString().padStart(5, "0")}`;
			agents.register({ id, displayName: id, kind: "sub", session: null, status: "parked" });
		}

		const observers = new SessionObserverRegistry();
		const getSessions = vi.spyOn(observers, "getSessions");
		const getSession = vi.spyOn(observers, "getSession");
		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			getSessions.mockClear();
			getSession.mockClear();
			const visibleIds = renderedAgentIds(hub);
			// rows=12 → line budget 5; unknown usage is an explicit second line,
			// so two complete entries fit while rendering remains viewport-bounded.
			expect(visibleIds).toHaveLength(2);
			expect(getSessions).not.toHaveBeenCalled();
			expect(getSession.mock.calls.length).toBeLessThanOrEqual(8);

			const text = Bun.stripANSI(hub.render(120).join("\n"));
			expect(text).toContain("10000 parked");
			expect(text).toMatch(/… \d+ more/);

			// Moving selection re-renders only the new viewport, not the whole roster.
			getSessions.mockClear();
			getSession.mockClear();
			hub.handleInput("j");
			const afterMove = renderedAgentIds(hub);
			expect(afterMove.length).toBeLessThanOrEqual(2);
			expect(afterMove).toContain(visibleIds[1]!);
			expect(getSessions).not.toHaveBeenCalled();
			expect(getSession.mock.calls.length).toBeLessThanOrEqual(8);
		} finally {
			hub.dispose();
		}
	});

	it("sizes the lazy viewport by real entry height when rows have a task line", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(12);
		const agents = new AgentRegistry();
		for (let i = 0; i < 100; i++) {
			const id = `TaskAgent-${i.toString().padStart(3, "0")}`;
			agents.register({
				id,
				displayName: id,
				kind: "sub",
				session: null,
				status: "parked",
			});
		}

		const observers = new SessionObserverRegistry();
		const getSession = vi.spyOn(observers, "getSession");
		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			// Force a second task line via observer metadata so entry height is 2.
			getSession.mockImplementation((id: string) => ({
				id,
				kind: "subagent",
				label: "Subagent",
				status: "active",
				description: `task for ${id}`,
				lastUpdate: Date.now(),
			}));
			getSession.mockClear();
			const visibleIds = renderedAgentIds(hub);
			// Each entry is 2 lines; budget 5 → at most 2 full entries + probes.
			expect(visibleIds.length).toBeGreaterThan(0);
			expect(visibleIds.length).toBeLessThanOrEqual(3);
			expect(getSession.mock.calls.length).toBeLessThanOrEqual(6);
			const text = Bun.stripANSI(hub.render(120).join("\n"));
			expect(text).toContain("task for");
		} finally {
			hub.dispose();
		}
	});

	it("truncates lines and sanitizes newlines to prevent terminal wrapping", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		const sessionA = {} as AgentSession;
		agents.register({
			id: "RevAgentStream",
			displayName: "Agent runtime + compaction reviewer\u0007",
			kind: "sub",
			session: sessionA,
		});

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "RevAgentStream",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				description: "Complete the assignment below, thoroughly:\n- check performance\n- check leaks",
				lastUpdate: Date.now(),
				progress: {
					currentTool: "bash",
					currentToolArgs: "\x1b[2Jdangerous args",
				} as never,
			},
		]);

		const hub = makeHub(agents, { observers });

		const lines = hub.render(80);
		expect(lines.join("\n")).not.toContain("\u0007");
		for (const line of lines) {
			const cleanLine = Bun.stripANSI(line);
			expect(cleanLine.includes("\n")).toBe(false);
			expect(cleanLine.includes("\r")).toBe(false);
			const width = visibleWidth(line);
			expect(width).toBeLessThanOrEqual(80);
		}
		hub.handleInput("\t");
		const details = hub.render(80).join("\n");
		expect(details).not.toContain("\x1b[2J");
		expect(details).toContain("dangerous args");

		hub.dispose();
	});
	it("fits the fullscreen table to short terminals and windows large registries", () => {
		geometry = stubStdoutGeometry(80);
		geometry.setRows(10);
		const agents = new AgentRegistry();
		for (let i = 0; i < 50; i++) {
			agents.register({
				id: `Agent${i}`,
				displayName: `Agent ${i}`,
				kind: "sub",
				session: {} as AgentSession,
			});
		}

		const observers = new SessionObserverRegistry();
		const sessions = vi.spyOn(observers, "getSessions").mockReturnValue([]);
		const hub = makeHub(agents, { observers });

		try {
			const lines = hub.render(80);
			expect(lines.length).toBe(10);
			expect(sessions.mock.calls.length).toBeLessThan(agents.list().length);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("…");
		} finally {
			hub.dispose();
		}
	});
	it("matches fullscreen menu mouse selection, wheel, and activation", async () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({ id: "Alpha", displayName: "Alpha", kind: "sub", session: {} as AgentSession });
		setSystemTime(2_000);
		agents.register({ id: "Beta", displayName: "Beta", kind: "sub", session: {} as AgentSession });
		setSystemTime(3_000);
		agents.register({ id: "Gamma", displayName: "Gamma", kind: "sub", session: {} as AgentSession });

		const focused: string[] = [];
		const done = vi.fn();
		const hub = makeHub(agents, {
			onDone: done,
			focusAgent: async id => {
				focused.push(id);
			},
		});

		try {
			expect(selectedAgentId(hub)).toBe("Gamma");
			hub.handleInput(wheel("down"));
			expect(selectedAgentId(hub)).toBe("Beta");

			const frame = hub.render(120);
			const alphaRow = frame.findIndex(line => /^│ {3}\S+ Alpha/u.test(Bun.stripANSI(line)));
			expect(alphaRow).toBeGreaterThanOrEqual(0);
			hub.handleInput(`\x1b[<0;110;${alphaRow + 1}M`);
			expect(selectedAgentId(hub)).toBe("Beta");
			expect(focused).toEqual([]);
			hub.handleInput(leftClick(alphaRow + 1));
			await Promise.resolve();
			expect(selectedAgentId(hub)).toBe("Alpha");
			expect(focused).toEqual(["Alpha"]);
			expect(done).toHaveBeenCalledTimes(1);
		} finally {
			hub.dispose();
		}
	});

	it("routes wheel and hover by pane: lists select, detail scrolls, hover highlights", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(30);
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({ id: "Alpha", displayName: "Alpha", kind: "sub", session: null });
		setSystemTime(2_000);
		agents.register({ id: "Beta", displayName: "Beta", kind: "sub", session: null });
		const irc = new IrcBus(agents);
		irc.history.recordMessage({ id: "a1", from: "Alpha", to: "Main", body: "alpha says hi", ts: 5_000 });
		irc.history.recordDelivery("a1", { to: "Main", outcome: "injected" });
		const hub = makeHub(agents, { irc });
		try {
			// Agents: wheel over the left roster pane moves the selection...
			expect(selectedAgentId(hub)).toBe("Beta");
			hub.handleInput(wheel("down"));
			expect(selectedAgentId(hub)).toBe("Alpha");
			// ...while wheel over the right detail pane scrolls content only.
			hub.handleInput("\x1b[<65;110;10M");
			expect(selectedAgentId(hub)).toBe("Alpha");
			// Hovering a detail line highlights it; re-hovering the same line is
			// stable; a roster hover replaces it (roster rows hover-highlight too).
			const baseline = hub.render(120).join("\n");
			hub.handleInput("\x1b[<35;110;9M");
			const hovered = hub.render(120).join("\n");
			expect(hovered).not.toBe(baseline);
			hub.handleInput("\x1b[<35;110;9M");
			expect(hub.render(120).join("\n")).toBe(hovered);
			hub.handleInput("\x1b[<35;10;9M");
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toBe(Bun.stripANSI(baseline));

			// Messages: wheel over the conversation list changes conversations;
			// wheel over the thread pane transfers focus to the selected card.
			hub.handleInput("3");
			const frame = hub.render(120).map(Bun.stripANSI);
			const alphaRow = frame.findIndex(line => line.includes("❯") && line.includes("Main ⇄ Alpha"));
			expect(alphaRow).toBeGreaterThanOrEqual(0);
			hub.handleInput(`\x1b[<65;10;${alphaRow + 1}M`);
			const afterListWheel = Bun.stripANSI(hub.render(120).join("\n"));
			expect(afterListWheel).toContain("Main ⇄ Beta");
			expect(afterListWheel).toMatch(/Main ⇄ Beta.*0.*new/u);
			hub.handleInput(`\x1b[<64;10;${alphaRow + 1}M`);
			const alphaThread = Bun.stripANSI(hub.render(120).join("\n"));
			expect(alphaThread).toContain("Main ⇄ Alpha");
			// Expanded cards are the default even while the conversation pane owns focus.
			expect(alphaThread).toContain("id a1 · injected");
			hub.handleInput(`\x1b[<65;110;${alphaRow + 1}M`);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("❯ ┌ Alpha → Main");
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for observer-only rows with no live session", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// A collab guest / observer-only row carries no live AgentSession, so the
		// badge must come from the executor-reported progress instead.
		agents.register({ id: "GuestAgent", displayName: "Guest Agent", kind: "sub", session: null });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "GuestAgent",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			progress: {
				resolvedModel: "openai/gpt-4o",
				resolvedModelIsFallback: true,
			} as never,
		});

		const hub = makeHub(agents, { observers });

		try {
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → openai/gpt-4o");
		} finally {
			hub.dispose();
		}
	});

	it("reads a live row's model off the session's served attribution, not its current pointer", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// The main session has no executor progress and no persisted history, so
		// its row comes straight off the live session. With a fallback armed but
		// unproven, `model` already points at the candidate that has produced
		// nothing — reporting it credits the run to a model that never spoke.
		const session = {
			model: { id: "gpt-5.6-sol", thinking: true },
			thinkingLevel: "high",
			servingModel: { selector: "anthropic/claude-sonnet-5", isFallback: false },
		} as unknown as AgentSession;
		agents.register({ id: "MainAgent", displayName: "Main Agent", kind: "sub", session });

		const hub = makeHub(agents, { observers: new SessionObserverRegistry() });

		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("claude-sonnet-5");
			expect(rendered).not.toContain("gpt-5.6-sol");
			expect(rendered).not.toContain("fallback →");
		} finally {
			hub.dispose();
		}
	});

	it("marks an armed fallback that has served nothing yet", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// Nothing has served in this session, so there is no earlier work to
		// miscredit — but the row must still say the model was reached by a
		// fallback rather than presenting it as the plain configured model.
		const session = {
			model: { id: "gpt-5.6-sol", thinking: true },
			thinkingLevel: "high",
			// Nothing served, so the session names what it currently points at —
			// still flagged as fallback-routed.
			servingModel: { selector: "openai-codex/gpt-5.6-sol", isFallback: true },
		} as unknown as AgentSession;
		agents.register({ id: "UnprovenAgent", displayName: "Unproven Agent", kind: "sub", session });

		const hub = makeHub(agents, { observers: new SessionObserverRegistry() });

		try {
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → openai-codex/gpt-5.6-sol");
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for a live row whose fallback armed no session retry state", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// Live session with a resolved model but no served fallback — the
		// Fireworks Fast → base degrade emits `retry_fallback_applied` without
		// arming `#activeRetryFallback`, so the badge must fall back to the
		// executor-reported progress flag.
		const session = { model: { id: "kimi-k2" }, servingModel: undefined } as unknown as AgentSession;
		agents.register({ id: "FastAgent", displayName: "Fast Agent", kind: "sub", session });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "FastAgent",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			progress: {
				resolvedModel: "fireworks/kimi-k2",
				resolvedModelIsFallback: true,
			} as never,
		});

		const hub = makeHub(agents, { observers });

		try {
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → fireworks/kimi-k2");
		} finally {
			hub.dispose();
		}
	});

	it("retains the live thinking level unless progress has an explicit suffix", () => {
		geometry = stubStdoutGeometry(140);
		const agents = new AgentRegistry();
		const inheritedSession = { thinkingLevel: ThinkingLevel.High } as unknown as AgentSession;
		const explicitSession = { thinkingLevel: ThinkingLevel.High } as unknown as AgentSession;
		agents.register({
			id: "InheritedLevel",
			displayName: "Inherited level",
			kind: "sub",
			session: inheritedSession,
		});
		agents.register({
			id: "ExplicitLevel",
			displayName: "Explicit level",
			kind: "sub",
			session: explicitSession,
		});
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "InheritedLevel",
				kind: "subagent",
				label: "Inherited level",
				status: "active",
				lastUpdate: Date.now(),
				progress: { resolvedModel: "openai/gpt-5.4" } as never,
			},
			{
				id: "ExplicitLevel",
				kind: "subagent",
				label: "Explicit level",
				status: "active",
				lastUpdate: Date.now(),
				progress: { resolvedModel: "openai/gpt-5.4:low" } as never,
			},
		]);
		const hub = makeHub(agents, { observers });

		try {
			const inherited = renderedRosterEntry(hub, "InheritedLevel", 140);
			expect(inherited).toContain("gpt-5.4");
			expect(inherited).toContain(theme.thinking.high);

			const explicit = renderedRosterEntry(hub, "ExplicitLevel", 140);
			expect(explicit).toContain("gpt-5.4");
			expect(explicit).toContain(theme.thinking.low);
			expect(explicit).not.toContain(theme.thinking.high);
		} finally {
			hub.dispose();
		}
	});

	it("renders aggregate usage and a selected-agent inspector without inventing change attribution", () => {
		geometry = stubStdoutGeometry(140);
		geometry.setRows(28);
		const createdAt = Date.parse("2026-08-09T20:15:00Z");
		const agents = new AgentRegistry();
		agents.register({
			id: "Reviewer",
			displayName: "Security Reviewer",
			kind: "sub",
			parentId: "Main",
			session: null,
			history: {
				outputPath: "/tmp/Reviewer.md",
				patchPath: "/tmp/Reviewer.patch",
				branchName: "omp/task/Reviewer",
			},
			createdAt,
		});
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "Reviewer",
				kind: "subagent",
				label: "Reviewer",
				description: "Review the session lifecycle and produce actionable findings",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "Reviewer",
					index: 0,
					agent: "reviewer",
					agentSource: "bundled",
					status: "running",
					task: "Review the session lifecycle",
					currentTool: "read",
					currentToolArgs: "src/session/agent-session.ts",
					recentTools: [],
					recentOutput: [],
					toolCount: 27,
					requests: 12,
					tokens: 18_400,
					contextTokens: 31_000,
					contextWindow: 128_000,
					cost: 0.2134,
					durationMs: 134_000,
					resolvedModel: "openai/gpt-5.4:high",
				} as never,
			},
		]);
		const hub = makeHub(agents, { observers });

		try {
			const rendered = Bun.stripANSI(hub.render(140).join("\n"));
			expect(rendered).toContain("1 running");
			expect(rendered).toContain("Flat");
			expect(rendered).toContain("By parent");
			expect(rendered).toContain("$0.213 · 2m14s active · 12 req · 27 tools · 18K tok");
			expect(rendered).toContain("read · src/session/agent-session.ts");
			expect(rendered).toContain("31K/128K 24%");
			const createdDate = new Date(createdAt);
			const localDateTime = createdDate.toLocaleString("sv-SE", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			});
			const offsetMinutes = -createdDate.getTimezoneOffset();
			const offsetSign = offsetMinutes >= 0 ? "+" : "-";
			const absoluteOffset = Math.abs(offsetMinutes);
			const offset = `${offsetSign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(
				absoluteOffset % 60,
			).padStart(2, "0")}`;
			const registeredLine = `Registered ${localDateTime} ${offset}`;
			expect(rendered).toContain(registeredLine);
			expect(rendered).not.toMatch(/Registered \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/u);
			expect(Bun.stripANSI(hub.render(96).join("\n"))).toContain(registeredLine);
			expect(rendered).toContain("Shared workspace · per-agent LoC not attributable");
			expect(rendered).toContain("Output /tmp/Reviewer.md");
			expect(rendered).toContain("Patch /tmp/Reviewer.patch");
			hub.handleInput("\x1b[6~");
			expect(Bun.stripANSI(hub.render(140).join("\n"))).toContain("Worktree branch omp/task/Reviewer");
		} finally {
			hub.dispose();
		}
	});
	it("shows dense measured usage for running and completed progress with aggregate coverage", () => {
		geometry = stubStdoutGeometry(160);
		geometry.setRows(32);
		const agents = new AgentRegistry();
		agents.register({ id: "Running", displayName: "Running", kind: "sub", session: null, status: "running" });
		agents.register({ id: "Completed", displayName: "Completed", kind: "sub", session: null, status: "idle" });
		agents.register({
			id: "Historical",
			displayName: "Historical",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "Restored task",
		});
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "Running",
				kind: "subagent",
				label: "Running",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "Running",
					index: 0,
					agent: "worker",
					agentSource: "bundled",
					status: "running",
					task: "Run checks",
					recentTools: [],
					recentOutput: [],
					toolCount: 4,
					requests: 3,
					tokens: 1_200,
					cost: 0.1234,
					durationMs: 6_500,
				} as never,
			},
			{
				id: "Completed",
				kind: "subagent",
				label: "Completed",
				status: "completed",
				lastUpdate: Date.now(),
				progress: {
					id: "Completed",
					index: 1,
					agent: "worker",
					agentSource: "bundled",
					status: "completed",
					task: "Finish checks",
					recentTools: [],
					recentOutput: [],
					toolCount: 8,
					requests: 5,
					tokens: 2_500,
					cost: 0.4567,
					durationMs: 125_000,
				} as never,
			},
		]);
		const hub = makeHub(agents, { observers });

		try {
			const rendered = Bun.stripANSI(hub.render(160).join("\n"));
			expect(rendered).toContain("2/3 measured");
			expect(rendered).toContain("$0.580");
			expect(rendered).toContain("3.7K tok");
			expect(rendered).toContain("8 req");
			expect(rendered).toContain("12 tools");
			expect(rendered).toContain("2m11s active agent time");

			const running = renderedRosterEntry(hub, "Running", 160);
			expect(running).toContain("$0.123");
			expect(running).toContain("6.5s");
			expect(running).toContain("3 req");
			expect(running).toContain("4 tools");
			expect(running).toContain("1.2K tok");

			const completed = renderedRosterEntry(hub, "Completed", 160);
			expect(completed).toContain("$0.457");
			expect(completed).toContain("2m5s");
			expect(completed).toContain("5 req");
			expect(completed).toContain("8 tools");
			expect(completed).toContain("2.5K tok");

			const historical = renderedRosterEntry(hub, "Historical", 160);
			expect(historical).toContain("Restored task");
			expect(historical).toMatch(/usage\s+·/);
			expect(historical).not.toContain("$0.000");
		} finally {
			hub.dispose();
		}
	});
	it("treats incomplete and non-finite progress usage as unknown", () => {
		geometry = stubStdoutGeometry(160);
		const agents = new AgentRegistry();
		const getSessionStats = vi.fn(() => ({
			sessionFile: undefined,
			sessionId: "incomplete",
			userMessages: 1,
			assistantMessages: 9,
			toolCalls: 4,
			toolResults: 4,
			totalMessages: 18,
			tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
			premiumRequests: 0,
			cost: 0.25,
		}));
		agents.register({
			id: "Incomplete",
			displayName: "Incomplete",
			kind: "sub",
			session: { getSessionStats } as unknown as AgentSession,
		});
		agents.register({ id: "NonFinite", displayName: "Non-finite", kind: "sub", session: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "Incomplete",
				kind: "subagent",
				label: "Incomplete",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					tokens: 100,
					toolCount: 2,
					cost: 0.1,
					durationMs: 1_000,
				} as never,
			},
			{
				id: "NonFinite",
				kind: "subagent",
				label: "Non-finite",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					tokens: Number.NaN,
					requests: 2,
					toolCount: 2,
					cost: 0.1,
					durationMs: 1_000,
				} as never,
			},
		]);
		const hub = makeHub(agents, { observers });

		try {
			const rendered = Bun.stripANSI(hub.render(160).join("\n"));
			expect(rendered).toContain("0/2 measured");
			expect(renderedRosterEntry(hub, "Incomplete", 160)).toMatch(/usage\s+·/);
			expect(renderedRosterEntry(hub, "NonFinite", 160)).toMatch(/usage\s+·/);
			expect(getSessionStats).not.toHaveBeenCalled();
		} finally {
			hub.dispose();
		}
	});
	it("shows configured role text beside a resolved model but not for an explicit selector", () => {
		geometry = stubStdoutGeometry(160);
		const agents = new AgentRegistry();
		agents.register({ id: "RoleAgent", displayName: "Role Agent", kind: "sub", session: null });
		agents.register({ id: "ExplicitAgent", displayName: "Explicit Agent", kind: "sub", session: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "RoleAgent",
				kind: "subagent",
				label: "Role Agent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "RoleAgent",
					index: 0,
					agent: "worker",
					agentSource: "bundled",
					status: "running",
					task: "Run with the configured role",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 1,
					tokens: 10,
					cost: 0,
					durationMs: 100,
					modelRole: "rapid",
					resolvedModel: "openai/gpt-4o",
				} as never,
			},
			{
				id: "ExplicitAgent",
				kind: "subagent",
				label: "Explicit Agent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "ExplicitAgent",
					index: 1,
					agent: "worker",
					agentSource: "bundled",
					status: "running",
					task: "Run with an explicit selector",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 1,
					tokens: 10,
					cost: 0,
					durationMs: 100,
					resolvedModel: "openai/gpt-4o",
				} as never,
			},
		]);
		const hub = makeHub(agents, {
			observers,
			settings: Settings.isolated({
				modelRoles: { rapid: "openai/gpt-4o" },
				modelTags: { rapid: { name: "Quick", color: "warning" } },
			}),
		});

		try {
			const roleBlock = renderedRosterEntry(hub, "RoleAgent", 160);
			expect(roleBlock).toContain("Quick");
			expect(roleBlock).toContain("gpt-4o");
			expect(roleBlock.indexOf("Quick")).toBeLessThan(roleBlock.indexOf("gpt-4o"));

			const explicitBlock = renderedRosterEntry(hub, "ExplicitAgent", 160);
			expect(explicitBlock).toContain("gpt-4o");
			expect(explicitBlock).not.toContain("Quick");
		} finally {
			hub.dispose();
		}
	});
	it("switches between inline Flat and By parent projections with selection preserved", () => {
		vi.useFakeTimers();
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({ id: "Parent", displayName: "Parent", kind: "sub", parentId: "Main", session: null });
		setSystemTime(2_000);
		agents.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		setSystemTime(3_000);
		agents.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Parent", session: null });
		const hub = makeHub(agents);

		try {
			expect(renderedAgentIds(hub)).toEqual(["Child", "Peer", "Parent"]);
			expect(selectedAgentId(hub)).toBe("Child");
			const flat = Bun.stripANSI(hub.render(120).join("\n"));
			expect(flat).toContain("Flat");
			expect(flat).toContain("By parent");

			hub.setHoverIndex(0);
			expect(renderedRosterHeaderLineRaw(hub, "Child", 120)).toContain(theme.getBgAnsi("selectedBg"));
			hub.handleInput("t");
			const byParentIds = renderedAgentIds(hub);
			expect(byParentIds).toEqual(["Parent", "Child", "Peer"]);
			expect(selectedAgentId(hub)).toBe("Child");
			const byParent = Bun.stripANSI(hub.render(120).join("\n"));
			expect(byParent).toContain("Flat");
			expect(byParent).toContain("By parent");
			expect(byParentIds.indexOf("Parent")).toBeLessThan(byParentIds.indexOf("Child"));
			expect(renderedRosterHeaderLineRaw(hub, "Parent", 120)).not.toContain(theme.getBgAnsi("selectedBg"));
			expect(renderedRosterHeaderLineRaw(hub, "Child", 120)).not.toContain(theme.getBgAnsi("selectedBg"));

			hub.handleInput("t");
			expect(renderedAgentIds(hub)).toEqual(["Child", "Peer", "Parent"]);
			expect(selectedAgentId(hub)).toBe("Child");
		} finally {
			hub.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("renders parent lineage with bash-style tree connectors", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(32);
		const agents = new AgentRegistry();
		agents.register({ id: "Parent", displayName: "Parent", kind: "sub", parentId: "Main", session: null });
		agents.register({ id: "First", displayName: "First", kind: "sub", parentId: "Parent", session: null });
		agents.register({ id: "Grandchild", displayName: "Grandchild", kind: "sub", parentId: "First", session: null });
		agents.register({ id: "Last", displayName: "Last", kind: "sub", parentId: "Parent", session: null });
		const hub = makeHub(agents);

		try {
			hub.handleInput("t");
			expect(Bun.stripANSI(renderedRosterHeaderLineRaw(hub, "First", 120))).toContain("├── ⟳ First");
			expect(Bun.stripANSI(renderedRosterHeaderLineRaw(hub, "Grandchild", 120))).toContain("│   └── ⟳ Grandchild");
			expect(Bun.stripANSI(renderedRosterHeaderLineRaw(hub, "Last", 120))).toContain("└── ⟳ Last");
		} finally {
			hub.dispose();
		}
	});
	it("keeps tree rails continuous across task and metrics rows", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(32);
		const agents = new AgentRegistry();
		agents.register({ id: "Parent", displayName: "Parent", kind: "sub", parentId: "Main", session: null });
		agents.setActivity("Parent", "Parent task");
		agents.register({ id: "First", displayName: "First", kind: "sub", parentId: "Parent", session: null });
		agents.setActivity("First", "First task");
		agents.register({ id: "Grandchild", displayName: "Grandchild", kind: "sub", parentId: "First", session: null });
		agents.setActivity("Grandchild", "Grandchild task");
		agents.register({ id: "Last", displayName: "Last", kind: "sub", parentId: "Parent", session: null });
		agents.setActivity("Last", "Last task");
		const hub = makeHub(agents);

		try {
			hub.handleInput("t");
			const parentDetails = renderedRosterEntry(hub, "Parent", 120).split("\n").slice(1);
			const firstDetails = renderedRosterEntry(hub, "First", 120).split("\n").slice(1);
			const grandchildDetails = renderedRosterEntry(hub, "Grandchild", 120).split("\n").slice(1);
			const lastDetails = renderedRosterEntry(hub, "Last", 120).split("\n").slice(1);
			expect(parentDetails).toHaveLength(2);
			expect(firstDetails).toHaveLength(2);
			expect(grandchildDetails).toHaveLength(2);
			expect(lastDetails).toHaveLength(2);
			expect(parentDetails.every(line => line.startsWith("  │ "))).toBe(true);
			expect(firstDetails.every(line => line.startsWith("  │   │ "))).toBe(true);
			expect(grandchildDetails.every(line => line.startsWith("  │         "))).toBe(true);
			expect(lastDetails.every(line => line.startsWith("        ") && !line.includes("│"))).toBe(true);
			const metadataOrigins = [parentDetails, firstDetails, grandchildDetails, lastDetails].map(lines =>
				lines[1]!.indexOf("usage"),
			);
			expect(new Set(metadataOrigins)).toEqual(new Set([metadataOrigins[0]]));
			expect(metadataOrigins[0]).toBeGreaterThan(0);
		} finally {
			hub.dispose();
		}
	});

	it("keeps cyclic parent links renderable in tree mode", () => {
		const agents = new AgentRegistry();
		agents.register({ id: "CycleA", displayName: "Cycle A", kind: "sub", parentId: "CycleB", session: null });
		agents.register({ id: "CycleB", displayName: "Cycle B", kind: "sub", parentId: "CycleA", session: null });
		const hub = makeHub(agents);

		try {
			hub.handleInput("t");
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("CycleA");
			expect(rendered).toContain("CycleB");
		} finally {
			hub.dispose();
		}
	});

	it("opens the selected-agent inspector as a narrow-terminal fallback", () => {
		geometry = stubStdoutGeometry(80);
		geometry.setRows(12);
		const agents = new AgentRegistry();
		agents.register({ id: "NarrowAgent", displayName: "Narrow Agent", kind: "sub", session: null });
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "NarrowAgent",
				kind: "subagent",
				label: "Narrow Agent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					id: "NarrowAgent",
					status: "running",
					task: "Inspect responsive behavior",
					recentTools: [],
					recentOutput: [],
					toolCount: 3,
					requests: 2,
					tokens: 900,
					cost: 0,
					durationMs: 2_000,
				} as never,
			},
		]);
		const hub = makeHub(agents, { observers });

		try {
			const roster = Bun.stripANSI(hub.render(80).join("\n"));
			expect(roster).toContain("Tab:details");
			expect(roster).not.toContain("Registered ");

			hub.handleInput("\t");
			const details = Bun.stripANSI(hub.render(80).join("\n"));
			expect(details).toContain("Agent Hub · NarrowAgent");
			expect(details).toContain("Usage");
			expect(details).toContain("$0.0000 · 2.0s active · 2 req · 3 tools · 900 tok");
			expect(details).toContain("Tab:roster");
			hub.handleInput("\x1b[6~");
			expect(Bun.stripANSI(hub.render(80).join("\n"))).toContain("Changes");
			for (const line of hub.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);

			hub.handleInput("\x1b");
			expect(Bun.stripANSI(hub.render(80).join("\n"))).toContain("Roster");
		} finally {
			hub.dispose();
		}
	});

	it("renders and operates the unified Activity view with transcript deep-links", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(28);
		const agents = new AgentRegistry();
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		const activity = new AgentActivityIndex();
		activity.setLive("Worker", [
			{
				id: "tool-error",
				agentId: "Worker",
				timestamp: 1_000,
				kind: "tool",
				title: "read",
				summary: "src/auth.ts",
				status: "error",
				toolName: "read",
				source: "live",
			},
			{
				id: "response",
				agentId: "Worker",
				timestamp: 2_000,
				kind: "response",
				title: "Response",
				summary: "Reviewed the authentication boundary",
				status: "success",
				entryId: "entry-42",
				source: "transcript",
			},
		] satisfies AgentActivityRow[]);
		const hub = makeHub(agents, { activity, initialSection: "activity" });

		try {
			const initial = Bun.stripANSI(hub.render(120).join("\n"));
			expect(initial).toContain("2 Activity");
			expect(initial).toContain("src/auth.ts");
			expect(initial).toContain("Reviewed the authentication boundary");

			hub.handleInput("f");
			const errors = Bun.stripANSI(hub.render(120).join("\n"));
			expect(errors).toContain("errors");
			expect(errors).toContain("src/auth.ts");
			expect(errors).not.toContain("Reviewed the authentication boundary");

			hub.handleInput("f");
			hub.handleInput("/");
			for (const key of "authentication") hub.handleInput(key);
			hub.handleInput("\r");
			const searched = Bun.stripANSI(hub.render(120).join("\n"));
			expect(searched).toContain("responses");
			expect(searched).toContain("authentication");
			expect(searched).not.toContain("src/auth.ts");

			const open = vi.spyOn(hub, "openChat");
			hub.handleInput("\r");
			expect(open).toHaveBeenCalledWith("Worker", "entry-42");
			hub.handleInput(" ");
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("paused");
			hub.handleInput("1");
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Roster");
		} finally {
			hub.dispose();
		}
	});

	it("loads the resumed session's durable IRC journal when the Hub opens", async () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(28);
		using tempDir = TempDir.createSync("@omp-agent-hub-irc-resume-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "resumed-main",
				timestamp: "2026-08-27T23:45:00.000Z",
				cwd: tempDir.path(),
			})}\n`,
		);
		await Bun.write(
			`${sessionFile}.irc`,
			[
				JSON.stringify({
					type: "irc",
					v: 1,
					event: "message",
					message: {
						id: "resumed-message",
						from: "Worker",
						to: "Main",
						body: "Loaded from the resumed journal",
						ts: 1_000,
					},
				}),
				JSON.stringify({
					type: "irc",
					v: 1,
					event: "delivery",
					messageId: "resumed-message",
					outcome: "injected",
					ts: 1_001,
				}),
			].join("\n"),
		);
		const agents = new AgentRegistry();
		const irc = new IrcBus(agents);
		const hub = makeHub(agents, { irc, initialSection: "messages", sessionFile });

		try {
			await irc.history.ready();
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("Loaded from the resumed journal");
		} finally {
			hub.dispose();
		}
	});

	it("renders durable IRC conversations and sends replies from the Messages view", async () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(28);
		const agents = new AgentRegistry();
		const delivered: Array<{ body: string; replyTo?: string }> = [];
		const { promise: deliveryObserved, resolve: resolveDelivery } = Promise.withResolvers<void>();
		const session = {
			deliverIrcMessage: async (message: { body: string; replyTo?: string }) => {
				delivered.push(message);
				resolveDelivery();
				return "injected" as const;
			},
			emitIrcRelayObservation() {},
		} as unknown as AgentSession;
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session });
		const irc = new IrcBus(agents);
		irc.history.recordMessage({ id: "m1", from: "Main", to: "Worker", body: "Inspect auth", ts: 1_000 });
		irc.history.recordDelivery("m1", { to: "Worker", outcome: "injected" });
		irc.history.recordMessage({
			id: "m2",
			from: "Worker",
			to: "Main",
			body: "Found one issue\n- auth bypass",
			ts: 2_000,
			replyTo: "m1",
		});
		irc.history.recordDelivery("m2", { to: "Main", outcome: "injected" });
		const hub = makeHub(agents, { irc, initialSection: "messages" });

		try {
			const wide = Bun.stripANSI(hub.render(120).join("\n"));
			expect(wide).toContain("3 Messages");
			expect(wide).toContain("Conversations");
			expect(wide).toContain("Main ⇄ Worker");
			expect(wide).toContain("2 messages");
			expect(wide).toContain("2 delivered");
			expect(wide).toContain("Found one issue");
			expect(wide).toContain("↳ m1");
			expect(wide).toContain("Expanded / Compact");
			expect(wide).toContain("id m1 · injected");
			expect(wide).toContain("id m2 · injected");
			const wideLines = wide.split("\n");
			const workerConversationRow = wideLines.findIndex(
				line => line.includes("❯") && line.includes("Main ⇄ Worker"),
			);
			expect(workerConversationRow).toBeGreaterThanOrEqual(0);
			expect(wideLines[workerConversationRow + 1]).toContain("2 messages");

			const narrowList = Bun.stripANSI(hub.render(80).join("\n"));
			expect(narrowList).toContain("Conversations");
			hub.handleInput("\r");
			const narrowThread = Bun.stripANSI(hub.render(80).join("\n"));
			expect(narrowThread).toContain("Inspect auth");
			expect(narrowThread).toContain("Found one issue");
			expect(narrowThread).toContain("│ - auth bypass");
			expect(narrowThread).toContain("id m2 · injected · ↳ m1");
			hub.handleInput(" ");
			expect(Bun.stripANSI(hub.render(80).join("\n"))).not.toContain("id m2 · injected");
			expect(Bun.stripANSI(hub.render(80).join("\n"))).toContain("Space:expanded");
			hub.handleInput(" ");
			expect(Bun.stripANSI(hub.render(80).join("\n"))).toContain("Space:compact");
			const open = vi.spyOn(hub, "openChat");
			hub.handleInput("o");
			expect(open).toHaveBeenCalledWith("Worker");

			hub.handleInput("R");
			for (const key of "Please patch it") hub.handleInput(key);
			hub.handleInput("\r");
			await deliveryObserved;
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toMatchObject({ body: "Please patch it", replyTo: "m2" });
			expect(Bun.stripANSI(hub.render(80).join("\n"))).toContain("Please patch it");
		} finally {
			hub.dispose();
		}
	});

	it("keeps scrolled Messages selections visible and mouse hit targets aligned", () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(14);
		const agents = new AgentRegistry();
		agents.register({ id: "Target", displayName: "Target", kind: "sub", parentId: "Main", session: null });
		const irc = new IrcBus(agents);
		for (let index = 0; index < 30; index++) {
			irc.history.recordMessage({
				id: `target-${index}`,
				from: "Target",
				to: "Main",
				body: `Target update ${index}`,
				ts: 10_000 + index,
			});
		}
		for (let index = 0; index < 20; index++) {
			const id = `Other-${index.toString().padStart(2, "0")}`;
			agents.register({
				id,
				displayName: `Other ${index.toString().padStart(2, "0")}`,
				kind: "sub",
				parentId: "Main",
				session: null,
			});
			irc.history.recordMessage({
				id: `other-${index}`,
				from: id,
				to: "Main",
				body: `Other update ${index}`,
				ts: 2_000 + index,
			});
		}
		const hub = makeHub(agents, { irc, initialSection: "messages" });

		try {
			hub.handleInput("\t");
			for (let index = 0; index < 20; index++) hub.handleInput("k");
			const scrolledThread = Bun.stripANSI(hub.render(120).join("\n"));
			expect(scrolledThread).toContain("Target update 9");

			hub.handleInput("\t");
			for (let index = 0; index < 10; index++) hub.handleInput("j");
			const frame = hub.render(120).map(Bun.stripANSI);
			const visible = frame
				.map((line, index) => ({ line, index, match: / (Other \d{2}) /u.exec(line) }))
				.find(entry => entry.match);
			expect(visible).toBeDefined();
			hub.handleInput(leftClick(visible!.index + 2));
			const selected = Bun.stripANSI(hub.render(120).join("\n"));
			expect(selected).toContain(`⇄ ${visible!.match![1]}`);
		} finally {
			hub.dispose();
		}
	});
	it("loads and sends Messages through the collab Agent Hub remote", async () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(28);
		const agents = new AgentRegistry();
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		const records = [
			{
				message: { id: "m1", from: "Main", to: "Worker", body: "Inspect auth", ts: 1_000 },
				outcome: "injected" as const,
				updatedAt: 1_000,
			},
			{
				message: { id: "m2", from: "Worker", to: "Main", body: "Found one issue", ts: 2_000, replyTo: "m1" },
				outcome: "injected" as const,
				updatedAt: 2_000,
			},
		];
		const sent: Array<{ to: string; body: string; replyTo?: string }> = [];
		const firstRender = Promise.withResolvers<void>();
		const sendObserved = Promise.withResolvers<void>();
		const refreshObserved = Promise.withResolvers<void>();
		let readCount = 0;
		const hub = makeHub(agents, {
			initialSection: "messages",
			requestRender: () => firstRender.resolve(),
			remote: {
				chat: () => {},
				kill: () => {},
				revive: () => {},
				readTranscript: async () => null,
				readMessages: async () => {
					readCount++;
					if (readCount === 2) refreshObserved.resolve();
					return records;
				},
				sendMessage: async (to, body, replyTo) => {
					sent.push({ to, body, replyTo });
					sendObserved.resolve();
					return undefined;
				},
			},
		});

		try {
			await firstRender.promise;
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("Main ⇄ Worker");
			expect(rendered).toContain("2 messages");
			expect(rendered).toContain("2 delivered");
			expect(rendered).toContain("Found one issue");

			records.push({
				message: { id: "m3", from: "Worker", to: "Main", body: "New remote update", ts: 3_000 },
				outcome: "injected",
				updatedAt: 3_000,
			});
			hub.handleInput("1");
			hub.handleInput("3");
			await refreshObserved.promise;
			await Promise.resolve();
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("New remote update");

			hub.handleInput("R");
			for (const key of "Please patch it remotely") hub.handleInput(key);
			hub.handleInput("\r");
			await sendObserved.promise;
			expect(sent).toEqual([{ to: "Worker", body: "Please patch it remotely", replyTo: "m2" }]);
		} finally {
			hub.dispose();
		}
	});

	it("preserves unread on narrow conversation list until the thread is opened", () => {
		geometry = stubStdoutGeometry(80);
		geometry.setRows(28);
		const agents = new AgentRegistry();
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		const irc = new IrcBus(agents);
		irc.history.recordMessage({
			id: "m1",
			from: "Worker",
			to: "Main",
			body: "Needs attention",
			ts: 2_000,
		});
		irc.history.recordDelivery("m1", { to: "Main", outcome: "injected" });
		const hub = makeHub(agents, { irc, initialSection: "messages" });
		try {
			const list = Bun.stripANSI(hub.render(80).join("\n"));
			expect(list).toContain("Conversations");
			expect(list).toContain("Main ⇄ Worker");
			// The list shows participant pairs only — bodies live in the thread pane.
			expect(list).not.toContain("Needs attention");
			expect(list).toMatch(/Worker.*●1/u);
			// Periodic/history refresh and list navigation must not clear unread while only the list is visible.
			hub.handleInput("k"); // up to the pinned All-agents row
			hub.handleInput("j"); // back down to the Worker thread
			const stillUnread = Bun.stripANSI(hub.render(80).join("\n"));
			expect(stillUnread).toMatch(/Worker.*●1/u);
			hub.handleInput("\r");
			const thread = Bun.stripANSI(hub.render(80).join("\n"));
			expect(thread).toContain("Needs attention");
			expect(thread).not.toMatch(/Worker.*●1/u);
		} finally {
			hub.dispose();
		}
	});

	it("lets compose start a fresh direct or broadcast conversation with no prior history", async () => {
		geometry = stubStdoutGeometry(120);
		geometry.setRows(28);
		const agents = new AgentRegistry();
		const delivered: string[] = [];
		const { promise: deliveryObserved, resolve: resolveDelivery } = Promise.withResolvers<void>();
		const session = {
			deliverIrcMessage: async (message: { body: string }) => {
				delivered.push(message.body);
				resolveDelivery();
				return "injected" as const;
			},
			emitIrcRelayObservation() {},
		} as unknown as AgentSession;
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session, status: "idle" });
		const irc = new IrcBus(agents);
		const hub = makeHub(agents, { irc, initialSection: "messages" });
		try {
			const empty = Bun.stripANSI(hub.render(120).join("\n"));
			expect(empty).toContain("All agents");
			expect(empty).toContain("Worker");
			hub.handleInput("j"); // move from All agents to Worker if needed
			// Ensure Worker direct conversation is selected
			for (let i = 0; i < 3; i++) {
				const frame = Bun.stripANSI(hub.render(120).join("\n"));
				if (frame.includes("❯ Worker") || frame.includes("Worker · 0 messages") || frame.includes("Message")) break;
				hub.handleInput("j");
			}
			hub.handleInput("c");
			for (const key of "Hello fresh") hub.handleInput(key);
			hub.handleInput("\r");
			await deliveryObserved;
			expect(delivered).toEqual(["Hello fresh"]);
		} finally {
			hub.dispose();
		}
	});
});
