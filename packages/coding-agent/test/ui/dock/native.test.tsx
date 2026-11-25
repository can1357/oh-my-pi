/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Native trees of the dock HUDs against what the old interactive mode
 * described for the same inputs (`native-fixtures.json`, captured from the
 * pi-tui describers before their removal), and against the old shapes for
 * the HUDs whose describers were private to the interactive mode (todo,
 * pills), written out here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, type JSXNode, resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree, firstDiff } from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import {
	BackgroundCompactionModel,
	HudPills,
	HudPillsModel,
	ModelCycleModel,
	ModelCycleTrack,
	ProgressHud,
	ProgressHudModel,
	QueuedMessages,
	QueueModel,
	RetryHint,
	StatusHud,
	StatusHudModel,
	TodoHud,
	TodoHudModel,
	Tray,
	type TrayAgentItem,
	type TrayDoneItem,
	type TrayJobItem,
	TrayModel,
	WorkingRow,
	type WorkingSpec,
} from "../../../src/ui/dock";
import fixtures from "./native-fixtures.json";

const NOW = 1_700_000_000_000;
const env = staticEnvironment(loadThemeSync("dark"));
const realNow = Date.now;

beforeAll(() => {
	Date.now = () => NOW;
});
afterAll(() => {
	Date.now = realNow;
});

/** A described node in the corpus form. */
interface DescribedNode {
	readonly k: string;
	readonly key?: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly DescribedNode[];
}

/** Build `factory` in a root, describe its first node (or the node `pick` selects), dispose. */
function described(factory: () => JSXNode, pick?: (root: UiNode) => UiNode): DescribedNode {
	return createRoot(dispose => {
		try {
			const [root] = resolveChildren(factory())();
			if (!root) throw new Error("built nothing");
			// describeTree returns the `{ k, key?, p?, c? }` form.
			const tree = describeTree(pick ? pick(root) : root, env) as DescribedNode;
			return tree;
		} finally {
			dispose();
		}
	});
}

function expectTree(expected: unknown, actual: unknown): void {
	expect(firstDiff(expected, actual)).toBeNull();
}

const working: WorkingSpec = {
	label: "Working…",
	startedAt: NOW - 1500,
	interruptKey: "escape",
};

describe("working row", () => {
	test("turn", () =>
		expectTree(
			fixtures.working,
			described(() => <WorkingRow spec={working} now={() => NOW} />),
		));
	test("session accent", () =>
		expectTree(
			fixtures.workingAccent,
			described(() => (
				<WorkingRow spec={{ ...working, accent: { main: "#00b4ff", dim: "#0082b3" } }} now={() => NOW} />
			)),
		));
	test("compaction", () =>
		expectTree(
			fixtures.compaction,
			described(() => (
				<WorkingRow
					spec={{
						label: "Compacting context…",
						startedAt: NOW - 3000,
						variant: { kind: "compaction" },
						interruptKey: "escape",
					}}
					now={() => NOW}
				/>
			)),
		));
	test("retry countdown", () =>
		expectTree(
			fixtures.retry,
			described(() => (
				<WorkingRow
					spec={{
						label: "",
						startedAt: NOW - 1000,
						variant: {
							kind: "retry",
							attempt: 1,
							max: 3,
							delayMs: 4000,
							reason: "529 Overloaded",
						},
						interruptKey: "escape",
					}}
					now={() => NOW}
				/>
			)),
		));
	test("no stop control", () =>
		expectTree(
			fixtures.noInterrupt,
			described(() => (
				<WorkingRow
					spec={{
						label: "Compacting context…",
						startedAt: NOW,
						variant: { kind: "compaction" },
					}}
					now={() => NOW}
				/>
			)),
		));
	test("retry hint", () =>
		expectTree(
			fixtures.retryHint,
			described(() => <RetryHint retryKey="f5" />),
		));
});

describe("queued messages", () => {
	test("two groups", () => {
		const model = new QueueModel();
		model.groups.set([
			{ label: "Steering", messages: ["also update the README"] },
			{ label: "After yield", messages: ["then summarize\nthe diff"] },
		]);
		expectTree(
			fixtures.queue,
			described(() => <QueuedMessages model={model} />),
		);
	});
	test("one message", () => {
		const model = new QueueModel();
		model.groups.set([{ label: "Steering", messages: ["one"] }]);
		expectTree(
			fixtures.queueOne,
			described(() => <QueuedMessages model={model} />),
		);
	});
});

test("model cycle track", () => {
	const model = new ModelCycleModel();
	model.track.set({ segments: ["smol", "default", "slow"], active: 2 });
	expectTree(
		fixtures.track,
		described(() => <ModelCycleTrack model={model} />),
	);
});

describe("progress HUDs", () => {
	test("judgment batches", () => {
		const model = new ProgressHudModel(new BackgroundCompactionModel(), () => false);
		model.judgments.update({
			id: "b1",
			intent: "Grade answers",
			done: 3,
			total: 10,
			failed: 1,
			cost: 0.0312,
			running: true,
		});
		model.judgments.update({
			id: "b2",
			intent: "Rank",
			done: 0,
			total: 4,
			failed: 0,
			cost: 0,
			running: false,
		});
		expectTree(
			fixtures.judge,
			described(
				() => <ProgressHud model={model} />,
				root => root.children()[0]!,
			),
		);
	});
	test("downloads", async () => {
		const model = new ProgressHudModel(new BackgroundCompactionModel(), () => false);
		const downloads = model.downloads;
		downloads.update(
			{
				id: 1,
				label: "SmolLM2-135M",
				detail: "model.safetensors",
				loaded: 1_000_000,
				total: 4_000_000,
				state: "running",
			},
			NOW,
		);
		downloads.update({ id: 2, label: "yt-dlp", state: "running", unit: "steps" }, NOW);
		downloads.update({ id: 3, label: "mlx", state: "running" }, NOW);
		downloads.update({ id: 3, label: "mlx", state: "failed", error: "network  down" }, NOW + 200);
		await Bun.sleep(200);
		expectTree(
			fixtures.downloads,
			described(
				() => <ProgressHud model={model} />,
				root => root.children()[1]!,
			),
		);
		downloads.dispose();
	});
	test("background compaction beside a turn", () => {
		const background = new BackgroundCompactionModel();
		background.run.set({
			label: "Compacting context in the background",
			startedAt: NOW - 2000,
			interruptKey: "escape",
		});
		const model = new ProgressHudModel(background, () => true);
		expectTree(
			fixtures.compactionBeside,
			described(
				() => <ProgressHud model={model} />,
				root => root.children()[2]!,
			),
		);
	});
});

const agent: TrayAgentItem = {
	item: "agent",
	key: "agent:Anna",
	ref: "Anna",
	name: "Anna",
	status: "running",
	aria: "Anna, running",
	look: true,
	acted: NOW - 100,
	waiting: false,
	unread: 2,
	tool: "Edit",
	text: "greet.ts",
	added: 42,
	removed: 12,
	callFailed: false,
	type: "explore",
	model: "opus-4.5",
	tools: 6,
	stats: "22%",
	start: NOW - 65_000,
	duration: undefined,
	openable: true,
};
const job: TrayJobItem = {
	item: "job",
	key: "job:j1",
	ref: "j1",
	name: "bun test",
	status: "failed",
	aria: "bun test, failed",
	look: false,
	start: NOW - 10_000,
	duration: 9000,
	view: undefined,
	output: "a\nb\nc",
	command: "bun test --watch",
};
const done: TrayDoneItem = {
	item: "done",
	key: "done",
	ref: "done",
	name: "2 done",
	status: "done",
	aria: "2 finished agents",
	look: true,
	count: 3,
	names: "Bob, Cy",
	entries: [
		{
			id: "Bob",
			name: "Bob",
			status: "done",
			meta: "opus · 4m",
			line: "All good",
			openable: true,
		},
		{
			id: "Cy",
			name: "Cy",
			status: "failed",
			meta: "",
			line: "",
			openable: false,
		},
	],
};

describe("tray", () => {
	const model = new TrayModel();
	model.items.set([agent, job, done]);
	const child = (index: number) => (root: UiNode) => root.children()[index]!;
	const tray = () => <Tray model={model} now={() => NOW} />;
	test("agent card", () => expectTree(fixtures.trayAgent, described(tray, child(0))));
	test("job card", () => expectTree(fixtures.trayJob, described(tray, child(1))));
	test("done card", () => expectTree(fixtures.trayDone, described(tray, child(2))));
	test("peek at an agent", () => {
		model.peek.set("Anna");
		model.peekDetail.set({
			task: "Audit callers",
			tail: [
				{ tool: "read", text: "src/a.ts", state: "ok", age: undefined },
				{ tool: "grep", text: "greet(", state: "run", age: 6200 },
			],
		});
		expectTree(fixtures.peekAgent, described(tray, child(3)));
	});
	test("peek at a job", () => {
		model.peek.set("j1");
		model.peekDetail.set(undefined);
		expectTree(fixtures.peekJob, described(tray, child(3)));
	});
	test("peek at the done card", () => {
		model.peek.set("done");
		expectTree(fixtures.peekDone, described(tray, child(3)));
	});
	test("a waiting agent's card says so and its dot holds still", () => {
		const waiting = new TrayModel();
		waiting.items.set([{ ...agent, waiting: true }, agent]);
		const tree = () => <Tray model={waiting} now={() => NOW} />;
		const [card, working] = [0, 1].map(index => described(tree, child(index)));
		const dot = (node: DescribedNode | undefined): unknown => node?.c?.[0]?.c?.[0]?.p?.spans;
		expect(card?.p).toMatchObject({ status: "running", waiting: true });
		expect(working?.p?.waiting).toBeUndefined();
		expect(dot(card)).toEqual([{ t: "●", s: "accent" }]);
		expect(dot(working)).toEqual([{ t: "●", s: "accent", fx: "pulse" }]);
	});
	test("root props", () => {
		model.peek.set(undefined);
		model.main.set("working");
		model.quiet.set(false);
		expect(described(tray).p).toEqual({ main: "working", role: "omp.tray" });
		model.items.set([]);
		expect(described(tray).p).toEqual({ hidden: true, role: "omp.tray" });
	});
});

describe("todo", () => {
	const todo = new TodoHudModel();
	todo.phases.set([
		{
			name: "Investigate",
			tasks: [
				{ content: "Read greet.ts", status: "completed" },
				{ content: "List callers", status: "in_progress", notes: ["n1", "n2"] },
			],
		},
		{ name: "Change", tasks: [{ content: "Rename", status: "pending" }] },
	]);
	test("activity line with the checklist pill", () => {
		const status = new StatusHudModel(todo);
		status.row.set({ kind: "working", spec: working });
		const tree = described(() => <StatusHud model={status} />);
		const children = tree.c ?? [];
		expect(tree.k).toBe("row");
		expect(tree.p).toEqual({
			align: "center",
			gap: "sm",
			role: "omp.hud.activity",
		});
		expect(children.map(child => `${child.k}:${child.key}`)).toEqual(["col:status", "checklist:todo"]);
		expect(children[1]?.p).toEqual({
			mode: "hud",
			role: "omp.hud.todo",
			phases: [
				{
					id: "0",
					title: "I. Investigate",
					items: [
						{ id: "0.0", text: "Read greet.ts", status: "done" },
						{ id: "0.1", text: "List callers", status: "active", note: "n2" },
					],
				},
				{
					id: "1",
					title: "II. Change",
					items: [{ id: "1.0", text: "Rename", status: "pending" }],
				},
			],
		});
	});
	test("idle without a todo is the line emptied, without its role, and the same node once it shows", () => {
		const model = new StatusHudModel();
		const root = createRoot(dispose => ({ dispose, node: resolveChildren(<StatusHud model={model} />)()[0]! }));
		try {
			expect(describeTree(root.node, env)).toEqual({ k: "row", p: { align: "center", gap: "sm" } });
			model.row.set({ kind: "working", spec: working });
			// The node built idle is the line: the host keeps one element, and what it drew into it, as the line comes and goes.
			expect(describeTree(root.node, env)).toMatchObject({ k: "row", p: { role: "omp.hud.activity" } });
		} finally {
			root.dispose();
		}
	});
	test("fallback tree and bar", () => {
		expectTree(
			{
				k: "col",
				key: "todo",
				p: { role: "omp.hud.todo" },
				c: [
					{
						k: "row",
						p: { align: "center", gap: "sm" },
						c: [
							{ k: "text", p: { spans: [{ s: "accent strong", t: "TODO" }] } },
							{ k: "progress", p: { label: "1/3", value: 1 / 3 } },
						],
					},
					{
						k: "tree",
						p: {
							nodes: [
								{
									id: "0",
									label: [
										{ s: "accent strong", t: "I. Investigate" },
										{ s: "dim", t: " · 1/2" },
									],
									open: true,
									children: [
										{
											id: "0.0",
											label: [{ s: "success del", t: "Read greet.ts" }],
											icon: "check",
										},
										{
											id: "0.1",
											label: [
												{ s: "accent", t: "List callers" },
												{ s: "dim em", t: " +2" },
											],
											icon: "circle",
										},
									],
								},
								{
									id: "1",
									label: [
										{ s: "muted", t: "II. Change" },
										{ s: "dim", t: " · 0/1" },
									],
									open: false,
								},
							],
						},
					},
				],
			},
			described(() => <TodoHud model={todo} />),
		);
	});
});

describe("HUD pills", () => {
	test("agents and jobs counters", () => {
		const model = new HudPillsModel();
		model.agentsRunning.set(2);
		model.agentsInSession.set(3);
		model.jobsRunning.set(1);
		expectTree(
			{
				k: "row",
				p: { justify: "end", role: "omp.hud" },
				c: [
					{
						k: "row",
						key: "running",
						p: { align: "center", role: "omp.hud.pill" },
						c: [
							{
								k: "row",
								key: "agents",
								p: {
									actions: { click: "agents.open" },
									align: "center",
									aria: "2 agents running",
									gap: "xs",
									role: "omp.hud.seg",
									title: "2 agents running  ←←",
								},
								c: [
									{
										k: "icon",
										key: "icon",
										p: { name: "users", tone: "accent" },
									},
									{
										k: "text",
										key: "count",
										p: { spans: [{ s: "num", t: "2" }], wrap: "none" },
									},
								],
							},
							{
								k: "row",
								key: "jobs",
								p: {
									actions: { click: "jobs.open" },
									align: "center",
									aria: "1 job running",
									gap: "xs",
									role: "omp.hud.seg",
									title: "1 job running  /jobs",
								},
								c: [
									{
										k: "icon",
										key: "icon",
										p: { name: "job", tone: "warning" },
									},
									{
										k: "text",
										key: "count",
										p: { spans: [{ s: "num", t: "1" }], wrap: "none" },
									},
								],
							},
						],
					},
				],
			},
			described(() => <HudPills model={model} />),
		);
	});
	test("idle agents keep a muted icon; nothing running hides the row; a tray host hides it", () => {
		const model = new HudPillsModel();
		model.agentsInSession.set(3);
		const segment = described(() => <HudPills model={model} />).c?.[0]?.c?.[0];
		expect(segment?.p).toEqual({
			actions: { click: "agents.open" },
			align: "center",
			aria: "No agents running · 3 in this session",
			gap: "xs",
			role: "omp.hud.seg",
			title: "No agents running · 3 in this session  ←←",
		});
		expect(segment?.c).toEqual([{ k: "icon", key: "icon", p: { name: "users", tone: "muted" } }]);
		model.agentsInSession.set(0);
		expect(described(() => <HudPills model={model} />)).toEqual({
			k: "row",
			p: { hidden: true, justify: "end", role: "omp.hud" },
		});
		model.trayHost.set(true);
		model.agentsRunning.set(1);
		expect(described(() => <HudPills model={model} />)).toEqual({
			k: "row",
			p: { hidden: true, justify: "end", role: "omp.hud" },
		});
	});
});
