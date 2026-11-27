import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { JobWidgetRegistry } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { cfgDisplayPinnedAgents } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { asyncJobSnapshot, asyncJobTree } from "@oh-my-pi/pi-coding-agent/session/async-job-views";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createRoot, isUiNode, resolveChildren, type Signal, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { JobWidgetView } from "@oh-my-pi/pi-coding-agent/tools/details/job-widget";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { TempDir } from "@oh-my-pi/pi-utils";
import { NATIVE_DOCK } from "../src/ui/shell/dock";
import { initTheme } from "../src/ui/theme/service";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

/** A node as the native backend describes it. */
interface NativeNode {
	readonly k: string;
	readonly key?: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeNode[];
}

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(nodes)];
}

function role(node: NativeNode | undefined): unknown {
	return node?.p?.role;
}

function children(node: NativeNode | undefined): NativeNode[] {
	return [...(node?.c ?? [])];
}

/** The mode's tray rebuilds coalesce over this real-time window (`SUBAGENT_OBSERVER_UI_COALESCE_MS`). */
const TRAY_SYNC_MS = 100;

/** Let a coalesced tray rebuild run (real timers: the mode schedules it on the wall clock). */
async function traySynced(): Promise<void> {
	await Bun.sleep(TRAY_SYNC_MS + 20);
}

/**
 * The interactive mode as a Tern host draws it: native rendering on (the `native` signal) and the
 * host advertising the `tray` feature. Started before the mode so it adopts the frame.
 */
async function trayHost(
	session: AgentSession,
	eventBus: EventBus | undefined,
	native: Signal<boolean>,
): Promise<{ mode: InteractiveMode; term: ModeTerminal }> {
	const term = createModeTerminal({ columns: 120, rows: 40 });
	await term.start();
	vi.spyOn(term.frame.shell.host!, "feature").mockImplementation(name => name === "tray");
	vi.spyOn(term.frame.shell, "native").mockImplementation(() => native());
	const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus, term.frame);
	await mode.init({ suppressWelcomeIntro: true });
	return { mode, term };
}

/** The mode's dock in Tern's order, described as a Tern host receives it. */
function describeDock(mode: InteractiveMode): NativeNode[] {
	const env = staticEnvironment(currentTheme());
	return createRoot(dispose => {
		try {
			return NATIVE_DOCK.flatMap(name =>
				resolveChildren(mode.shell.dock.slot(name).view)().map(node => describeTree(node, env, 120) as NativeNode),
			);
		} finally {
			dispose();
		}
	});
}

const decode: JobWidgetView = {
	title: "loadtest · decode",
	headline: { text: "186 tok/s", label: "decode" },
	stage: "warming up",
	blocks: [
		{
			kind: "spark",
			label: "tok/s",
			values: Array.from({ length: 24 }, (_, i) => 150 + i),
			min: 0,
			max: 220,
			last: "186 tok/s",
		},
	],
	state: "live",
	updatedAt: 2_000,
};

function progress(id: string, overrides: Partial<AgentProgress>): SubagentProgressPayload {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: id,
		parentToolCallId: "tool-call",
		detached: true,
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: id,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 15_000,
			...overrides,
		},
	};
}

function lifecycle(
	id: string,
	index: number,
	status: "started" | "completed",
	description: string,
): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status,
		parentToolCallId: "tool-call",
		detached: true,
	};
}

describe("InteractiveMode tray", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let manager: AsyncJobManager;
	let term: ModeTerminal;
	/** Whether the shell renders natively (on a tray host). */
	const native = signal(true);
	const pending: Array<() => void> = [];
	const agentIds = ["TrayScan", "TrayReview", "TrayOld", "TrayNext"];
	/** When TrayScan's current call started: 12s before {@link seed}, so the closer look times it. */
	let callStart = 0;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		native.set(true);
		tempDir = TempDir.createSync("@pi-tray-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		manager = new AsyncJobManager({});
		Object.defineProperty(session, "asyncJobManager", { get: () => manager, configurable: true });
		spyOn(session, "getAsyncJobSnapshot").mockImplementation(options =>
			asyncJobSnapshot(manager, undefined, options),
		);
		({ mode, term } = await trayHost(session, eventBus, native));
	});

	afterEach(async () => {
		for (const release of pending.splice(0)) release();
		for (const id of agentIds) AgentRegistry.global().unregister(id);
		vi.restoreAllMocks();
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await manager.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	/** Agent `id`'s transcript, in this session's artifacts tree. */
	const transcript = (id: string): string => path.join(session.sessionManager.getArtifactsDir()!, `${id}.jsonl`);

	/** A job body that runs until the test ends. */
	const hold = (): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		pending.push(() => resolve("done"));
		return promise;
	};

	/**
	 * A running agent mid-call, an agent that settled with its job's result
	 * still undelivered, a finished agent with no card of its own, a job with a
	 * widget and a job without one.
	 */
	async function seed(): Promise<void> {
		callStart = Date.now() - 12_000;
		const registry = AgentRegistry.global();
		registry.register({
			id: "TrayScan",
			// A task subagent's display name is its agent type.
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			// Its transcript, so focusing can open it.
			sessionFile: transcript("TrayScan"),
			status: "running",
		});
		registry.register({
			id: "TrayReview",
			displayName: "TrayReview",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "TrayOld",
			displayName: "TrayOld",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("TrayScan", 0, "started", "Scan the configs"));
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			progress("TrayScan", {
				currentTool: "read",
				currentToolArgs: "config/app.toml",
				currentToolArgsKey: "path",
				currentToolIntent: "Reading the config",
				currentToolStartMs: callStart,
				toolCount: 3,
				resolvedModel: "anthropic/claude-sonnet-4-5",
				resolvedThinkingLevel: ThinkingLevel.Low,
				contextTokens: 22_000,
				contextWindow: 100_000,
			}),
		);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("TrayReview", 1, "started", "Cross-check regressions"));
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			lifecycle("TrayReview", 1, "completed", "Cross-check regressions"),
		);
		manager.register("task", "review", async () => "reviewed", { id: "TrayReview", agentId: "TrayReview" });
		await manager.getJob("TrayReview")?.promise;
		manager.widgets = {
			view: job => (job.id === "bg_1" ? decode : undefined),
			caption: () => undefined,
			requestCaption: () => {},
			subscribe: () => () => {},
			forget: () => {},
			dispose: () => {},
		} satisfies JobWidgetRegistry;
		manager.register("bash", "loadtest", hold, { id: "bg_1" });
		manager.register(
			"bash",
			"npm test",
			async ctx => {
				await ctx.reportProgress("one\ntwo\nthree");
				return hold();
			},
			{ id: "bg_2" },
		);
	}

	/** An action Tern raises on `node` (a card's click, a peek, a composer control), routed as the host routes it. */
	function hostAction(node: UiNode, act: string, value?: string): void {
		node.handlers.onAction?.(act, { type: "action", key: "", act, value, mods: [] } as never);
	}

	/** An action Tern raises on the tray. */
	function trayAction(act: string, value: string): void {
		const node = mode.shell.dock.slot("tray").view();
		if (!isUiNode(node)) throw new Error("no tray in the dock");
		hostAction(node, act, value);
	}

	/** The tray node the dock sends. */
	function trayOf(): NativeNode {
		const tray = describeDock(mode)
			.flatMap(nodes)
			.find(node => role(node) === "omp.tray");
		if (!tray) throw new Error("no tray in the dock");
		return tray;
	}

	it("describes the activity row then the tray, with each card's role, props and children in wire order", async () => {
		await seed();
		await traySynced();
		const described = describeDock(mode).flatMap(nodes);
		const roles = described.map(node => role(node));
		const activity = roles.indexOf("omp.hud.activity");
		expect(activity).toBeGreaterThanOrEqual(0);
		const trayAt = roles.indexOf("omp.tray");
		expect(trayAt).toBeGreaterThan(activity);
		// The pill gives way to the tray.
		expect(mode.hud.pills.trayHost()).toBe(true);
		// Idle main agent: the caption stands in for the status rows.
		const caption = children(described[activity]).find(node => role(node) === "omp.tray.caption");
		expect(caption?.p).toMatchObject({ text: "1 agent, 2 jobs in the background" });

		const cards = children(described[trayAt]);
		expect(cards.map(card => [card.p?.item, card.p?.ref])).toEqual([
			["agent", "TrayScan"],
			["job", "bg_1"],
			["job", "bg_2"],
			["agent", "TrayReview"],
			["done", "done"],
		]);
		const [scan, widgetJob, bareJob, review, done] = cards;

		expect(scan!.p).toMatchObject({
			role: "omp.tray.card",
			status: "running",
			tone: "accent",
			acted: callStart,
			aria: "TrayScan, m2, running, Read app.toml, 3 tools",
		});
		expect(children(scan).map(role)).toEqual(["omp.tray.head", "omp.tray.doing", "omp.tray.meta"]);
		const scanHead = children(children(scan)[0]);
		// Its own name, not its type; the tool count beside the clock.
		expect(scanHead.map(role)).toEqual(["omp.tray.dot", "omp.tray.name", "omp.tray.time", "omp.tray.tools"]);
		expect(scanHead[1]!.p).toMatchObject({ text: "TrayScan" });
		expect(scanHead[3]).toEqual({
			k: "row",
			p: { role: "omp.tray.tools", align: "center" },
			c: [
				{ k: "text", p: { spans: [{ t: "/", s: "dim" }, { t: "3" }], wrap: "none" }, key: "count" },
				{ k: "icon", p: { name: "gear", tone: "muted" }, key: "icon" },
			],
			key: "tools",
		});
		// The call's verb and file name, no intent; nothing changed yet.
		expect(children(children(scan)[1]).map(node => [role(node), node.p?.spans])).toEqual([
			["omp.tray.call", [{ t: "Read", s: "strong" }, { t: " app.toml" }]],
		]);
		expect(children(children(scan)[2]).map(node => node.p?.text)).toEqual(["claude-sonnet-4-5 · low", "22%"]);
		// The status row carries only the caption: no counts.
		expect(children(described[activity]).map(role)).toEqual(["omp.tray.caption"]);

		expect(review!.p).toMatchObject({ status: "done", tone: "success" });
		expect(children(children(review)[1])[0]!.p).toMatchObject({ spans: [{ t: "Cross-check regressions" }] });

		expect(done!.p).toMatchObject({ status: "done" });
		expect(JSON.stringify(children(done)[1]!.p)).toContain("TrayOld");

		expect(children(widgetJob).map(role)).toEqual(["omp.tray.head", "omp.tray.glance"]);
		expect(children(children(widgetJob)[0]).map(role)).toEqual([
			"omp.tray.dot",
			"omp.tray.name",
			"omp.tray.id",
			"omp.tray.time",
		]);
		expect(children(children(widgetJob)[1]).map(node => role(node) ?? node.k)).toEqual([
			"omp.hud.glance",
			"omp.hud.spark",
			"omp.tray.stage",
		]);

		expect(children(bareJob).map(role)).toEqual(["omp.tray.head", "omp.tray.out"]);
		expect(children(bareJob)[1]!.p).toMatchObject({ text: "two\nthree", wrap: "none" });
	});

	it("keeps an aboveEditor hook widget off the status row the tray hangs from, with no spacer row", async () => {
		await seed();
		mode.setHookWidget("usage", ["usage: 42%"], { placement: "aboveEditor" });
		await traySynced();
		const described = describeDock(mode);
		const holding = (test: (node: NativeNode) => boolean) => described.findIndex(top => nodes(top).some(test));
		const activity = holding(node => role(node) === "omp.hud.activity");
		const tray = holding(node => role(node) === "omp.tray");
		expect(tray).toBeGreaterThanOrEqual(activity);
		const widget = holding(node => JSON.stringify(node.p ?? {}).includes("usage: 42%"));
		expect(widget).toBeGreaterThanOrEqual(0);
		expect(widget).toBeLessThanOrEqual(activity);
		const editor = holding(node => role(node) === "omp.editor" || String(role(node)).startsWith("omp.editor."));
		expect(editor).toBeGreaterThanOrEqual(tray);
		const between = described.slice(widget, editor + 1);
		expect(between.some(top => nodes(top).some(node => node.k === "spacer"))).toBe(false);
	});

	it("opens the jobs sheet on the job a tray card stands for, taking the keyboard", async () => {
		await seed();
		await traySynced();
		spyOn(session, "getAsyncJobTree").mockImplementation(options => asyncJobTree(manager, undefined, options));
		const show = spyOn(mode, "showJobsSheet");
		trayAction("tray.open", "bg_2");
		expect(show).toHaveBeenLastCalledWith("bg_2");
		const sheet = mode.shell.overlays.top();
		expect(sheet).toBeDefined();
		const list = nodes(describeTree(sheet!.node, staticEnvironment(currentTheme())) as NativeNode).find(
			node => node.k === "list",
		);
		expect(list?.p?.selected).toBe("bg_2");
		const focused = mode.shell.focused();
		expect(focused !== null && nodesOf(sheet!.node).includes(focused)).toBe(true);
	});

	it("shows the closer look only for the card asked for, and drops it on an empty peek", async () => {
		await seed();
		await traySynced();
		const peek = (value: string): NativeNode => {
			trayAction("tray.peek", value);
			return trayOf();
		};

		const open = peek("TrayScan");
		expect(open.p).toMatchObject({ peek: "TrayScan" });
		const look = children(open).at(-1)!;
		expect(look.p).toMatchObject({ role: "omp.tray.peek", ref: "TrayScan" });
		const head = children(look)[0]!;
		// Dot, name, meta, then the free space (the meta takes it), then the clock and the buttons.
		expect(children(head).map(node => role(node) ?? node.k)).toEqual([
			"omp.tray.dot",
			"omp.tray.name",
			"omp.tray.peek.meta",
			"omp.tray.time",
			"button",
			"button",
			"button",
		]);
		expect(children(head)[1]!.p).toEqual({
			role: "omp.tray.name",
			text: "TrayScan",
			wrap: "none",
			truncate: "end",
			shrink: 1,
		});
		expect(children(head)[2]!.p).toEqual({
			role: "omp.tray.peek.meta",
			text: "m2 · claude-sonnet-4-5 · low · 3 tools · 22%",
			wrap: "none",
			truncate: "end",
			grow: 1,
			shrink: 1,
		});
		expect(
			nodes(head)
				.filter(node => node.k === "button")
				.map(node => node.p?.actions),
		).toEqual([{ click: "tray.open=TrayScan" }, { click: "tray.stop=TrayScan" }, { click: "tray.peek=" }]);
		const tail = children(look).find(node => role(node) === "omp.tray.tail");
		expect(children(tail).map(node => node.p?.state)).toEqual(["run"]);

		const closed = peek("");
		expect(closed.p?.peek).toBeUndefined();
		expect(nodes(closed).some(node => role(node) === "omp.tray.peek")).toBe(false);
	});

	it("keeps unchanged cards and moves `acted` only when a new call starts", async () => {
		await seed();
		await traySynced();
		const first = children(trayOf());

		// Progress that starts no call: the agent's card does not move its `acted`.
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			progress("TrayScan", {
				currentTool: "read",
				currentToolIntent: "Reading the config",
				currentToolStartMs: callStart,
				toolCount: 3,
				contextTokens: 30_000,
				contextWindow: 100_000,
			}),
		);
		await traySynced();
		// The other cards are described exactly as before (same keys and props: the host changes
		// nothing), up to the clock their elapsed times read.
		const timeless = (cards: NativeNode[]) =>
			JSON.stringify(cards, (key, value) => (key === "age" ? undefined : value));
		expect(timeless(children(trayOf()).slice(1))).toBe(timeless(first.slice(1)));
		expect(children(trayOf())[0]!.p).toMatchObject({ acted: callStart });

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			progress("TrayScan", {
				currentTool: "grep",
				currentToolArgs: "TODO",
				currentToolStartMs: callStart + 4_000,
				toolCount: 4,
			}),
		);
		await traySynced();
		expect(children(trayOf())[0]!.p).toMatchObject({ acted: callStart + 4_000 });
	});

	it("names the model a live agent's session runs on now, so a /switch shows on the next frame", async () => {
		authStorage.keys.setRuntime("anthropic", "test-key");
		const models = new ModelRegistry(authStorage);
		const from = models.find("anthropic", "claude-sonnet-4-5");
		const to = models.find("anthropic", "claude-sonnet-4-6");
		if (!from || !to) throw new Error("Expected claude-sonnet-4-5 and claude-sonnet-4-6 in the registry");
		const agent = new AgentSession({
			agent: new Agent({
				initialState: { model: from, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: models,
			thinkingLevel: ThinkingLevel.Low,
		});
		try {
			AgentRegistry.global().register({
				id: "TrayNext",
				displayName: "TrayNext",
				kind: "sub",
				parentId: "Main",
				session: agent,
				status: "running",
			});
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("TrayNext", 0, "started", "Write the norm test"));
			// Its run so far was answered by the model it started on.
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				progress("TrayNext", {
					currentTool: "edit",
					resolvedModel: "anthropic/claude-sonnet-4-5",
					resolvedThinkingLevel: ThinkingLevel.Low,
				}),
			);
			await traySynced();
			const model = (): unknown => {
				const card = children(trayOf()).find(node => node.p?.ref === "TrayNext");
				const label = nodes(card!).find(node => role(node) === "omp.tray.model");
				return label?.p?.text;
			};
			expect(model()).toBe("claude-sonnet-4-5 · low");

			// The viewed agent switches before its new model has answered anything.
			await agent.setModelTemporary(to, ThinkingLevel.High);
			await traySynced();
			expect(model()).toBe("claude-sonnet-4-6 · high");
		} finally {
			await agent.dispose();
		}
	});

	it("names the viewed agent, its lineage and the way back in the composer's viewing header, which the host's tray reads", async () => {
		const models = new ModelRegistry(authStorage);
		const model = models.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in the registry");
		const agent = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: models,
		});
		/** The header as the host receives it: Tern marks the card whose `ref` its agent names, and goes back by its exit. */
		const header = (): NativeNode | undefined =>
			describeDock(mode)
				.flatMap(nodes)
				.find(node => role(node) === "omp.composer.focus");
		const part = (name: string): NativeNode | undefined => {
			const shown = header();
			return shown && nodes(shown).find(node => role(node) === name);
		};
		try {
			const registry = AgentRegistry.global();
			registry.register({
				id: "TrayOld",
				displayName: "TrayOld",
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "idle",
			});
			registry.register({
				id: "TrayNext",
				displayName: "TrayNext",
				kind: "sub",
				parentId: "TrayOld",
				session: agent,
				status: "running",
			});
			// The main session shows no header: the tray's MAIN bar is where the user is.
			expect(header()).toBeUndefined();

			await mode.focusAgentSession("TrayNext");
			expect(part("omp.composer.agent")?.p).toMatchObject({ text: "TrayNext" });
			// The level between the agent and the main session is a link to it.
			expect(part("omp.composer.crumb")?.p).toMatchObject({ text: "TrayOld", actions: { click: "focus:TrayOld" } });
			const exit = part("omp.composer.exit")?.p?.actions;
			expect(exit).toEqual({ click: "focus:Main" });

			// The exit's click, as the tray's MAIN bar runs it: back on the main session, the header goes.
			const unfocus = spyOn(SessionFocusController.prototype, "unfocus");
			hostAction(mode.composer.node, "focus:Main");
			await unfocus.mock.results[0]?.value;
			expect(mode.focusedAgentId).toBeUndefined();
			expect(header()).toBeUndefined();
		} finally {
			await mode.unfocusSession();
			await agent.dispose();
		}
	});

	it("sends no tray cards, and keeps the pill, on a host without the feature", async () => {
		native.set(false);
		await seed();
		await traySynced();
		const all = describeDock(mode).flatMap(nodes);
		expect(all.some(node => String(role(node)).startsWith("omp.tray.") && node.p?.hidden !== true)).toBe(false);
		expect(mode.hud.tray.items()).toEqual([]);
		expect(mode.hud.pills.trayHost()).toBe(false);
	});

	it("moves focus into the tray on the agents-hub key only on a native tray host showing cards", async () => {
		native.set(false);
		await seed();
		const hub = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});

		mode.showAgentHub({ trayFirst: true });
		expect(hub).toHaveBeenCalledTimes(1);

		native.set(true);
		await traySynced();
		mode.showAgentHub({ trayFirst: true });
		expect(hub).toHaveBeenCalledTimes(1);
		expect(trayOf().p).toMatchObject({ focus: 1 });
	});

	it("turns the tray quiet and ungrouped once everything has finished, still reachable on the hub key", async () => {
		const hub = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});
		const registry = AgentRegistry.global();
		registry.register({
			id: "TrayScan",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "TrayOld",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		await traySynced();
		// Live: the agent's card and the done card.
		const live = children(trayOf());
		expect(live.map(card => card.p?.item)).toEqual(["agent", "done"]);
		expect(trayOf().p?.quiet).toBeUndefined();
		const scanKey = live[0]!.key;

		// It finishes without a background job: nothing live is left.
		registry.setStatus("TrayScan", "idle");
		await traySynced();
		const quiet = trayOf();
		expect(quiet.p).toEqual({ role: "omp.tray", quiet: true, main: "idle" });
		// Nothing grouped: each finished agent is its own card, in spawn order, no done card.
		const cards = children(quiet);
		expect(cards.map(card => [card.p?.item, card.p?.ref])).toEqual([
			["agent", "TrayScan"],
			["agent", "TrayOld"],
		]);
		// The same agent keeps its card's key across the regrouping.
		expect(cards[0]!.key).toBe(scanKey);
		// The idle status row stays, empty (no caption over a quiet tray): the host's seat for the tray.
		const activity = describeDock(mode)
			.flatMap(nodes)
			.find(node => role(node) === "omp.hud.activity");
		expect(activity).toEqual({ k: "row", p: { role: "omp.hud.activity", align: "center", gap: "sm" } });

		// The hub key asks Tern to show it: a focus bump, not the hub.
		mode.showAgentHub({ trayFirst: true });
		expect(hub).not.toHaveBeenCalled();
		expect(trayOf().p).toMatchObject({ quiet: true, focus: 1 });

		// The next agent starting groups the finished ones into the done card again.
		registry.register({
			id: "TrayNext",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		await traySynced();
		const back = trayOf();
		expect(back.p?.quiet).toBeUndefined();
		// The new agent appends after the others' place; the done card is last.
		expect(children(back).map(card => card.p?.ref)).toEqual(["TrayNext", "done"]);
		trayAction("tray.peek", "done");
		const rows = children(children(children(trayOf()).at(-1))[1]);
		expect(rows.map(row => row.p?.ref)).toEqual(["TrayOld", "TrayScan"]);
	});

	it("keeps every card in place and the tray quiet while the user opens finished agents, reviving them to view", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "TrayOld",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: transcript("TrayOld"),
			status: "parked",
			createdAt: 1_000,
		});
		registry.register({
			id: "TrayScan",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: transcript("TrayScan"),
			status: "aborted",
			createdAt: 2_000,
		});
		await traySynced();
		const shape = (): unknown => {
			const node = trayOf();
			return {
				quiet: node.p?.quiet,
				cards: children(node).map(card => [card.p?.ref, card.p?.status]),
			};
		};
		const before = shape();
		expect(before).toEqual({
			quiet: true,
			cards: [
				["TrayOld", "done"],
				["TrayScan", "stopped"],
			],
		});

		// Viewing revives the agent: a killed one comes back `parked`, and every revival passes
		// through `running` before it settles `idle`, bumping its last activity each time.
		let during: unknown;
		spyOn(SessionFocusController.prototype, "focusAgent").mockImplementation(async (id: string) => {
			registry.setStatus(id, "parked");
			registry.setStatus(id, "running");
			await traySynced();
			during = shape();
			registry.setStatus(id, "idle");
		});
		for (const ref of ["TrayScan", "TrayOld"]) {
			trayAction("tray.peek", ref);
			trayAction("tray.open", ref);
			await traySynced();
			await traySynced();
			expect(during).toEqual(before);
			expect(shape()).toEqual(before);
		}

		// Real work wakes it: a message runs the agent again.
		registry.setStatus("TrayOld", "running");
		await traySynced();
		expect(shape()).toEqual({
			quiet: undefined,
			cards: [
				["TrayOld", "running"],
				["done", "done"],
			],
		});
	});

	it("leaves out the agents of a session resumed earlier, which the process-global registry keeps", async () => {
		const registry = AgentRegistry.global();
		// Restored from the transcripts of the session `/resume` left.
		registry.register({
			id: "TrayOld",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: path.join(tempDir.path(), "earlier-session", "TrayOld.jsonl"),
			status: "parked",
		});
		registry.register({
			id: "TrayScan",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: transcript("TrayScan"),
			status: "parked",
		});
		await traySynced();
		expect(children(trayOf()).map(card => card.p?.ref)).toEqual(["TrayScan"]);
	});

	it("keeps the status row as the tray's seat while it has cards, one row from working to idle and back", async () => {
		const registry = AgentRegistry.global();
		const statusRow = (): NativeNode | undefined =>
			describeDock(mode)
				.flatMap(nodes)
				.find(node => role(node) === "omp.hud.activity");
		// No items: no row.
		expect(statusRow()).toBeUndefined();

		registry.register({
			id: "TrayOld",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		await traySynced();
		const rows: (NativeNode | undefined)[] = [];
		mode.ensureWorkingRow();
		rows.push(statusRow());
		mode.clearWorking();
		rows.push(statusRow());
		mode.ensureWorkingRow();
		rows.push(statusRow());
		mode.clearWorking();
		// One row throughout (same kind and role, so the host keeps it); idle over a quiet tray it is empty.
		expect(rows.map(node => [node?.k, role(node)])).toEqual([
			["row", "omp.hud.activity"],
			["row", "omp.hud.activity"],
			["row", "omp.hud.activity"],
		]);
		expect(rows[1]!.c).toBeUndefined();
	});

	it("leaves the agents-hub key inert on a tray host with no cards, unless the tray's agents are turned off", () => {
		const hub = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});
		expect(trayOf().p).toMatchObject({ hidden: true });
		mode.showAgentHub({ trayFirst: true });
		expect(hub).not.toHaveBeenCalled();

		cfgDisplayPinnedAgents.override(Settings.instance, "off");
		mode.showAgentHub({ trayFirst: true });
		expect(hub).toHaveBeenCalledTimes(1);
	});
});

/** `root` and every node under it. */
function nodesOf(root: UiNode): UiNode[] {
	return [root, ...root.children().flatMap(nodesOf)];
}

describe("InteractiveMode tray: the main agent across a real turn", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal | undefined;
	const release: Array<() => void> = [];

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		for (const done of release.splice(0)) done();
		AgentRegistry.global().unregister("TrayLive");
		vi.restoreAllMocks();
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		auth?.close();
		tempDir?.removeSync();
	});

	/** A gate the test opens: `wait()` blocks until `open()`, `reached` resolves once something waits on it. */
	function gate() {
		const reached = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		release.push(opened.resolve);
		return {
			reached: reached.promise,
			open: opened.resolve,
			wait: async (): Promise<void> => {
				reached.resolve();
				await opened.promise;
			},
		};
	}

	it("sends working while the model streams, waiting from the wait call until another call starts, then idle", async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-tray-main-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		const firstCall = gate();
		const waitCall = gate();
		const secondCall = gate();
		const bashCall = gate();
		const thirdCall = gate();
		const mock = createMockModel({
			responses: [
				async () => {
					await firstCall.wait();
					return { content: [{ type: "toolCall", id: "call-wait", name: "wait", arguments: {} }] };
				},
				async () => {
					await secondCall.wait();
					return { content: [{ type: "toolCall", id: "call-bash", name: "bash", arguments: {} }] };
				},
				async () => {
					await thirdCall.wait();
					return { content: ["done"] };
				},
			],
		});
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Runs a command",
			parameters: type({}),
			execute: async () => {
				await bashCall.wait();
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Blocks on background work",
			parameters: type({}),
			execute: async () => {
				await waitCall.wait();
				return { content: [{ type: "text", text: "settled" }], details: {} };
			},
		};
		auth = createInMemoryAuthStorage();
		await auth.credentials.set(mock.model.provider, { type: "api_key", key: "test-key" });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: [], tools: [waitTool, bashTool] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(auth, path.join(tempDir.path(), "models.yml")),
		});
		({ mode, term } = await trayHost(session, undefined, signal(true)));
		// A card, so the tray node is sent: a running agent only the registry knows.
		AgentRegistry.global().register({
			id: "TrayLive",
			displayName: "TrayLive",
			kind: "sub",
			session: null,
			status: "running",
		});
		await traySynced();
		const tray = (): NativeNode => {
			const node = describeDock(mode)
				.flatMap(nodes)
				.find(candidate => role(candidate) === "omp.tray");
			if (!node) throw new Error("no tray in the dock");
			return node;
		};
		const main = (): unknown => tray().p?.main;
		/** The session hands its events to subscribers asynchronously: let them through. */
		const delivered = async (): Promise<void> => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};
		expect(main()).toBe("idle");

		const prompt = session.prompt("go");
		await firstCall.reached;
		await delivered();
		expect(main()).toBe("working");

		firstCall.open();
		await waitCall.reached;
		await delivered();
		// The flip reaches the model at once; no coalesced rebuild is needed to send it.
		expect(main()).toBe("waiting");

		// The wait returns and the model thinks again: still waiting, as it mostly waits again.
		waitCall.open();
		await secondCall.reached;
		await delivered();
		expect(main()).toBe("waiting");

		// Another kind of call ends it.
		secondCall.open();
		await bashCall.reached;
		await delivered();
		expect(main()).toBe("working");

		bashCall.open();
		await thirdCall.reached;
		thirdCall.open();
		await prompt;
		await session.waitForIdle();
		await delivered();
		expect(main()).toBe("idle");
	});
});
