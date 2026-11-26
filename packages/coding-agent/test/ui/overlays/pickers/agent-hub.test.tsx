/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { nativeShell } from "../../../helpers/native-shell";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import type { AgentActivityRow } from "../../../../src/modes/view-model/overlays/agent-activity";
import type { AgentRecordLike } from "../../../../src/registry/agent-hub-types";
import type { ObservableSession } from "../../../../src/task/session-observer-registry";
import { AgentHub, type AgentHubHandle } from "../../../../src/ui/overlays/pickers/agent-hub";
import { agentSlot, resetAgentIdentities } from "../../../../src/ui/tools/agent-identity";
import { type Driver, pickerSuite } from "./harness";

const NOW = CORPUS_NOW;

function agent(id: string, extra: Partial<AgentRecordLike> = {}): AgentRecordLike {
	return {
		id,
		displayName: id,
		kind: "sub",
		status: "idle",
		session: null,
		sessionFile: null,
		createdAt: NOW - 3_600_000,
		lastActivity: NOW - 42_000,
		...extra,
	};
}

function roster(): AgentRecordLike[] {
	return [
		agent("Main", { kind: "main" }),
		agent("Alpha", {
			status: "running",
			lastActivity: NOW - 1_000,
			activity: "Reading src/index.ts",
			history: {
				modelRole: "smol",
				resolvedModel: "anthropic/claude-haiku",
				metrics: {
					tokens: 12_345,
					requests: 4,
					tools: 9,
					cost: 0.0421,
					durationMs: 65_000,
					contextTokens: 40_000,
					contextWindow: 200_000,
				},
			},
		}),
		agent("Beta", {
			parentId: "Alpha",
			status: "parked",
			displayName: "Beta the builder 日本語",
			lastActivity: NOW - 600_000,
			history: {
				outputPath: "/tmp/out/beta.md",
				patchPath: "/tmp/out/beta.patch",
				nestedPatchPaths: ["/tmp/out/n1.patch"],
				branchName: "omp/beta",
				resolvedModel: "openai/gpt-5",
				resolvedModelIsFallback: true,
			},
		}),
		agent("Gamma", { parentId: "Beta", status: "aborted", lastActivity: NOW - 7_200_000 }),
		agent("Main/advisor", {
			kind: "advisor",
			parentId: "Main",
			status: "parked",
			displayName: "advisor",
			history: { readOnly: true },
		}),
		agent("Delta-with-a-very-long-identifier-that-overflows", {
			parentId: "Alpha",
			status: "running",
			lastActivity: NOW - 5_000,
			activity: "Searching\nfor things\twith tabs",
		}),
	];
}

/** The capture's activity rows; `message` is not an activity kind the hub knows. */
function activityRows(): AgentActivityRow[] {
	return Array.from({ length: 14 }, (_, i) => ({
		id: `act-${i}`,
		agentId: ["Alpha", "Beta", "Delta-with-a-very-long-identifier-that-overflows"][i % 3]!,
		timestamp: NOW - (14 - i) * 60_000,
		kind: (["tool", "response", "message", "tool"] as const)[i % 4] as AgentActivityRow["kind"],
		title: i % 4 === 0 ? "read" : `Title ${i}`,
		toolName: i % 4 === 0 ? "read" : undefined,
		summary: `summary ${i} ${"x".repeat(i * 3)}`,
		status: i === 5 ? "error" : i === 7 ? "aborted" : i === 13 ? "pending" : "success",
		entryId: `e${i}`,
		source: "transcript",
	}));
}

interface Variant {
	empty?: boolean;
	loading?: boolean;
	rows?: number;
	noActivity?: boolean;
	section?: "agents" | "activity";
}

const VARIANTS: Record<string, Variant> = {
	"roster-wide": {},
	"roster-short": { rows: 9 },
	"tiny-terminal": { rows: 4 },
	empty: { empty: true },
	loading: { empty: true, loading: true },
	"activity-first": { section: "activity", noActivity: true },
	mouse: { rows: 24 },
};

const ev = (event: Record<string, unknown>) => (d: Driver) => void d.emit({ key: "", mods: [], ...event } as never);

test("Clear search restores the roster and activity results on their respective tabs", async () => {
	await using ui = await nativeShell();
	const agents = roster();
	const activity = activityRows();
	ui.shell.overlays.show(() => (
		<AgentHub
			registry={{ list: () => agents, get: id => agents.find(agent => agent.id === id), onChange: () => () => {} }}
			observers={{ getSessions: () => [], getSession: () => undefined, onChange: () => () => {} }}
			activity={{
				setLive: () => {},
				sync: async () => {},
				query: ({ search }) => activity.filter(row => !search || row.title.includes(search)),
				recent: () => [],
			}}
			irc={{ unreadCount: () => 0 }}
			lifecycle={() => ({ ensureLive: async () => {}, release: async () => false })}
			loadPersisted={async () => {}}
			hubKeys={[]}
			rows={() => 30}
			onDone={() => {}}
		/>
	));
	const picker = ui.node("picker");
	const shown = (): TspPickerProps => ui.node("picker").p;
	for (const tab of ["agents", "activity"]) {
		ui.send({ ev: "action", sf: ui.sf, id: picker.id, act: "tab", value: tab });
		const initial = shown().items!.map(item => item.id);
		expect(initial.length).toBeGreaterThan(0);
		const filter = shown().actions!.find(action => action.keys?.includes("/"))!;
		ui.send({ ev: "action", sf: ui.sf, id: picker.id, act: filter.id });
		ui.type("zzzz");
		expect(shown().items).toEqual([]);
		ui.send({ ev: "action", sf: ui.sf, id: picker.id, act: "clear" });
		expect(shown().items!.map(item => item.id)).toEqual(initial);
	}
});

pickerSuite({
	dir: "overlays/agent-hub",
	mount(caseName) {
		// Agent colours follow arrival slots, which the capture's cases shared in one process: the
		// first case (roster wide) gave them out in this order, and every later case kept them.
		resetAgentIdentities();
		for (const id of [
			"Delta-with-a-very-long-identifier-that-overflows",
			"Main/advisor",
			"Beta",
			"Gamma",
			"Epsilon",
			"Alpha",
		])
			agentSlot(id);
		const variant = VARIANTS[caseName] ?? {};
		const agents = variant.empty ? [agent("Main", { kind: "main" })] : roster();
		const activity = variant.noActivity ? [] : activityRows();
		const listeners = new Set<() => void>();
		const notify = async () => {
			for (const fn of listeners) fn();
			await Bun.sleep(150);
		};
		const sessions: ObservableSession[] = [
			{
				id: "Alpha",
				kind: "subagent",
				label: "Alpha",
				status: "active",
				lastUpdate: NOW,
				description: "Implement the parser",
				progressAt: NOW - 2_000,
				progress: {
					index: 0,
					id: "Alpha",
					agent: "task",
					status: "running",
					task: "Implement the parser",
					currentTool: "grep",
					currentToolArgs: "pattern foo",
					recentTools: [],
					recentOutput: [],
					toolCount: 9,
					tokens: 12_345,
					durationMs: 65_000,
					cost: 0.0421,
					contextTokens: 40_000,
					contextWindow: 200_000,
					modelRole: "smol",
					retryState: { attempt: 2, maxAttempts: 5 },
				} as never,
			},
		];
		let hub: AgentHubHandle | undefined;
		return {
			view: () => (
				<AgentHub
					ref={handle => {
						hub = handle;
					}}
					registry={{
						list: () => agents,
						get: id => agents.find(ref => ref.id === id),
						onChange: fn => {
							listeners.add(fn);
							return () => listeners.delete(fn);
						},
					}}
					observers={{
						getSessions: () => sessions,
						getSession: id => sessions.find(session => session.id === id),
						onChange: () => () => {},
					}}
					getRoleInfo={role => ({ name: role, tag: role.toUpperCase(), color: "accent" })}
					loadPersisted={() => (variant.loading ? new Promise<void>(() => {}) : Promise.resolve())}
					sessionFile={variant.loading ? "/tmp/never.jsonl" : undefined}
					hubKeys={["ctrl+s"]}
					onDone={() => {}}
					lifecycle={() => ({
						ensureLive: async () => {
							throw new Error("revive failed: 日本語");
						},
						release: async () => true,
					})}
					irc={{ unreadCount: id => (id === "Beta" ? 3 : 0) }}
					activity={{
						setLive() {},
						sync: async () => {},
						query: q =>
							activity.filter(
								row =>
									(!q.search || row.summary.includes(q.search)) &&
									(!q.agentIds || q.agentIds.has(row.agentId)),
							),
						recent: (id, n) => activity.filter(row => row.agentId === id).slice(-n),
					}}
					manageActivityLive={false}
					initialSection={variant.section}
					rows={() => variant.rows ?? 30}
					now={() => NOW}
				/>
			),
			steps: {
				"status change + notify": async () => {
					agents.find(ref => ref.id === "Beta")!.status = "idle";
					await notify();
				},
				"spawn + notify": async () => {
					agents.push(agent("Epsilon", { status: "running", parentId: "Gamma" }));
					await notify();
				},
				// The old API pair (hover a row, wheel down, clear the hover) is one wheel notch on the sheet.
				"hover/click api": d => d.mouse(5, 4, { button: "wheel-down", action: "press" }),
				"native view tree": ev({ type: "action", act: "view" }),
				"native select agent": ev({ type: "select", item: "Gamma" }),
				"native section": ev({ type: "action", act: "tab", value: "activity" }),
				"native activity select": ev({ type: "select", item: "act-3" }),
				"picker filter scope": ev({ type: "action", act: "scope", value: "errors" }),
				"picker follow": ev({ type: "action", act: "follow" }),
				"picker agents": ev({ type: "action", act: "agents" }),
				"picker filter": ev({ type: "action", act: "filter" }),
				"picker tab agents": d => {
					d.press("\x1b");
					ev({ type: "action", act: "tab", value: "agents" })(d);
				},
				"picker status scope": ev({ type: "action", act: "scope", value: "running" }),
				"picker scope all": ev({ type: "action", act: "scope", value: "all" }),
				"picker select": ev({ type: "select", item: "Beta" }),
				"picker view": ev({ type: "action", act: "view" }),
				"picker revive": async d => {
					ev({ type: "action", act: "revive" })(d);
					await Bun.sleep(5);
				},
				"picker kill advisor": d => {
					ev({ type: "select", item: "Main/advisor" })(d);
					ev({ type: "action", act: "kill" })(d);
				},
				"show section activity": () => hub!.showSection("activity"),
				"show section agents": () => hub!.showSection("agents"),
			},
		};
	},
});
