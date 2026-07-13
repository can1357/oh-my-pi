/**
 * Regression: the agent hub renders non-Main agents as a Main→children parent
 * tree — depth-ordered with ├─/└─ branch connectors and │ ancestor columns,
 * Main as the non-selectable root header, and agents whose parent is missing
 * hoisted directly under Main. Each agent's sibling position is frozen on first
 * open so keyboard selection does not jump as agents heartbeat; new agents
 * appear at the end of their sibling group. cwd is surfaced inline only when it
 * diverges from the parent's.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { IrcBus } from "@pk-nerdsaver-ai/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { visibleWidth } from "@pk-nerdsaver-ai/pi-tui/utils";

interface GeometryStub {
	setRows(n: number): void;
	restore(): void;
}

function stubStdoutGeometry(cols: number): GeometryStub {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols });
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

function makeHub(
	agents: AgentRegistry,
	cwd?: string,
	opts?: { focusAgent?: (id: string) => Promise<void>; onDone?: () => void },
) {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: opts?.onDone ?? (() => {}),
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: opts?.focusAgent ?? (async () => {}),
		cwd,
	});
}

function renderedAgentIds(hub: AgentHubOverlayComponent): string[] {
	return hub
		.render(120)
		.map(line => Bun.stripANSI(line))
		.map(line => line.split(" · "))
		.filter(
			parts =>
				parts.length >= 4 && ["working", "idle", "parked", "failed"].some(status => parts[0].endsWith(status)),
		)
		.map(parts => parts[1]!);
}

describe("Agent hub row ordering", () => {
	let geometry: GeometryStub | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("freezes the initial lastActivity order while the hub is open", () => {
		geometry = stubStdoutGeometry(120);
		const now = vi.spyOn(Date, "now");
		const agents = new AgentRegistry();
		const sessions = new Map<string, AgentSession>();

		now.mockReturnValue(1000);
		const sessionA = {} as AgentSession;
		sessions.set("A", sessionA);
		agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: sessionA });

		now.mockReturnValue(2000);
		const sessionB = {} as AgentSession;
		sessions.set("B", sessionB);
		agents.register({ id: "B", displayName: "Beta", kind: "sub", session: sessionB });

		now.mockReturnValue(3000);
		const sessionC = {} as AgentSession;
		sessions.set("C", sessionC);
		agents.register({ id: "C", displayName: "Gamma", kind: "sub", session: sessionC });

		const hub = makeHub(agents);
		expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);

		// Bump A's lastActivity far ahead of the others. The hub is already open,
		// so the captured order must not change.
		now.mockReturnValue(4000);
		agents.setActivity("A", "still running");

		// Force a refresh by registering a new agent; the existing rows must stay put.
		now.mockReturnValue(5000);
		const sessionD = {} as AgentSession;
		agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD });

		expect(renderedAgentIds(hub)).toEqual(["C", "B", "A", "D"]);

		hub.dispose();
	});

	it("renders agents as a Main→children tree with connectors, depth, hoisted orphans, and divergent cwd inline", async () => {
		geometry = stubStdoutGeometry(120);
		const now = vi.spyOn(Date, "now");
		const agents = new AgentRegistry();

		// Parent is Main's child; Child/Child2 sit one level deeper under Parent;
		// Orphan's parentId points at a missing agent, so it must be hoisted
		// directly under Main rather than vanish.
		now.mockReturnValue(4000);
		agents.register({
			id: "Parent",
			displayName: "parent",
			kind: "sub",
			session: {} as AgentSession,
			status: "running",
			cwd: "alpha-repo",
		});
		now.mockReturnValue(3000);
		agents.register({
			id: "Child",
			displayName: "child one",
			kind: "sub",
			session: {} as AgentSession,
			status: "running",
			parentId: "Parent",
			cwd: "alpha-repo",
		});
		now.mockReturnValue(2000);
		agents.register({
			id: "Child2",
			displayName: "child two",
			kind: "sub",
			session: {} as AgentSession,
			status: "running",
			parentId: "Parent",
			cwd: "beta-repo",
		});
		now.mockReturnValue(1000);
		agents.register({
			id: "Orphan",
			displayName: "orphan",
			kind: "sub",
			session: {} as AgentSession,
			status: "running",
			parentId: "Ghost",
		});

		const focusAgent = vi.fn(async (_id: string) => {});
		const onDone = vi.fn();
		const hub = makeHub(agents, "alpha-repo", { focusAgent, onDone });
		const cleanLines = hub.render(120).map(line => Bun.stripANSI(line));
		const rowFor = (id: string) => cleanLines.find(line => line.includes(`${theme.sep.dot}${id}${theme.sep.dot}`));

		// The current session renders as a selectable lane (the friendly "current
		// session" label, not the raw "Main" id) under its folder; subagents nest beneath.
		expect(cleanLines.some(line => line.includes("current session"))).toBe(true);
		expect(renderedAgentIds(hub)).toEqual(["Parent", "Child", "Child2", "Orphan"]);

		const parentRow = rowFor("Parent");
		const childRow = rowFor("Child");
		const child2Row = rowFor("Child2");
		const orphanRow = rowFor("Orphan");

		// Depth + connectors: Parent/Orphan are Main's direct children (branch/last,
		// no ancestor column); Child/Child2 are one level deeper under Parent, so
		// each carries the │ continuation column.
		expect(parentRow).toContain(`${theme.tree.branch} `);
		expect(parentRow).not.toContain(theme.tree.vertical);
		expect(orphanRow).toContain(`${theme.tree.last} `);
		expect(orphanRow).not.toContain(theme.tree.vertical);
		expect(childRow).toContain(theme.tree.vertical);
		expect(childRow).toContain(`${theme.tree.branch} `);
		expect(child2Row).toContain(theme.tree.vertical);
		expect(child2Row).toContain(`${theme.tree.last} `);

		// cwd is inlined only when it diverges from the parent's cwd.
		expect(parentRow).toContain("cwd alpha-repo"); // diverges from Main (no cwd)
		expect(childRow).not.toContain("cwd"); // identical to Parent's cwd
		expect(child2Row).toContain("cwd beta-repo"); // diverges from Parent

		// Enter focuses the selected agent's session and closes the hub; the old
		// cwd-group collapse/expand toggle is gone.
		hub.handleInput("j");
		hub.handleInput("j");
		hub.handleInput("\r");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(focusAgent).toHaveBeenCalledWith("Parent");
		expect(onDone).toHaveBeenCalled();

		hub.dispose();
	});

	it("truncates lines and sanitizes newlines to prevent terminal wrapping", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		const sessionA = {} as AgentSession;
		agents.register({
			id: "RevAgentStream",
			displayName: "Agent runtime + compaction reviewer",
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
			},
		]);

		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		const lines = hub.render(80);
		for (const line of lines) {
			const cleanLine = Bun.stripANSI(line);
			expect(cleanLine.includes("\n")).toBe(false);
			expect(cleanLine.includes("\r")).toBe(false);
			const width = visibleWidth(line);
			expect(width).toBeLessThanOrEqual(78);
		}

		hub.dispose();
	});
});
