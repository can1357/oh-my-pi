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
import { type Component, Text } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const context = (tray: boolean): DescribeContext => ({
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: name => tray && name === "tray",
});

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if ("k" in child) out.push(...nodes(child));
	return out;
}

function role(node: NativeNode | undefined): unknown {
	return node?.p ? Reflect.get(node.p, "role") : undefined;
}

function children(node: NativeNode | undefined): NativeNode[] {
	return (node?.c ?? []).filter((child): child is NativeNode => "k" in child);
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
	const pending: Array<() => void> = [];
	const agentIds = ["TrayScan", "TrayReview", "TrayOld", "TrayNext"];
	/** When TrayScan's current call started: 12s before {@link seed}, so the closer look times it. */
	let callStart = 0;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
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
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		for (const release of pending.splice(0)) release();
		for (const id of agentIds) AgentRegistry.global().unregister(id);
		setNativeRendering(false);
		vi.restoreAllMocks();
		mode?.stop();
		await manager.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

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
			sessionFile: "/tmp/TrayScan.jsonl",
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

	/** Each dock component with what it describes for `cx`. */
	function dock(cx: DescribeContext): Array<{ component: Component; node: NativeNode | null | undefined }> {
		return mode.composer.describeSurface(cx).dock.map(child => {
			const component = child as Component;
			return { component, node: component.describe?.(cx) };
		});
	}

	function trayOf(cx: DescribeContext): { component: Component; node: NativeNode } {
		const entry = dock(cx).find(entry => role(entry.node ?? undefined) === "omp.tray");
		if (!entry?.node) throw new Error("no tray in the dock");
		return { component: entry.component, node: entry.node };
	}

	it("describes the activity row then the tray, with each card's role, props and children in wire order", async () => {
		await seed();
		const cx = context(true);
		const described = dock(cx);
		const roles = described.map(entry => role(entry.node ?? undefined));
		const activity = roles.indexOf("omp.hud.activity");
		expect(activity).toBeGreaterThanOrEqual(0);
		expect(roles[activity + 1]).toBe("omp.tray");
		// The pill gives way to the tray.
		const pill = described.find(entry => role(entry.node ?? undefined) === "omp.hud");
		expect(pill?.node?.p?.hidden).toBe(true);
		// Idle main agent: the caption stands in for the status rows.
		const caption = children(described[activity]!.node!).find(node => role(node) === "omp.tray.caption");
		expect(caption?.p).toMatchObject({ text: "1 agent, 2 jobs in the background" });

		const cards = children(described[activity + 1]!.node!);
		expect(cards.map(card => [card.p && Reflect.get(card.p, "item"), card.p && Reflect.get(card.p, "ref")])).toEqual([
			["agent", "TrayScan"],
			["agent", "TrayReview"],
			["job", "bg_1"],
			["job", "bg_2"],
			["done", "done"],
		]);
		const [scan, review, widgetJob, bareJob, done] = cards;

		expect(scan!.p).toMatchObject({
			role: "omp.tray.card",
			status: "running",
			tone: "accent",
			acted: callStart,
			aria: "TrayScan, m2, running, read · Reading the config, 3 tools",
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
		expect(children(scan)[1]!.p).toMatchObject({
			spans: [{ t: "read", s: "dim" }, { t: " · ", s: "dim" }, { t: "Reading the config" }],
		});
		expect(children(children(scan)[2]).map(node => node.p && Reflect.get(node.p, "text"))).toEqual([
			"claude-sonnet-4-5 · low",
			"22%",
		]);
		// The status row carries only the caption: no counts.
		expect(children(described[activity]!.node!).map(role)).toEqual(["omp.tray.caption"]);

		expect(review!.p).toMatchObject({ status: "done", tone: "success" });
		expect(children(review)[1]!.p).toMatchObject({ spans: [{ t: "Cross-check regressions" }] });

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
		const cx = context(true);
		const described = dock(cx);
		const roles = described.map(entry => role(entry.node ?? undefined));
		const activity = roles.indexOf("omp.hud.activity");
		expect(roles[activity + 1]).toBe("omp.tray");
		const widget = described.findIndex(entry => entry.component === mode.hookWidgetContainerAbove);
		expect(widget).toBeGreaterThanOrEqual(0);
		expect(widget).toBeLessThan(activity);
		expect(described.some(entry => nodes(entry.node ?? { k: "col" }).some(node => node.k === "spacer"))).toBe(false);
	});

	it("opens the jobs sheet on the job a tray card stands for, taking the keyboard", async () => {
		await seed();
		const cx = context(true);
		spyOn(session, "getAsyncJobTree").mockImplementation(options => asyncJobTree(manager, undefined, options));
		const shown = spyOn(mode.ui, "showOverlay");
		const focus = spyOn(mode.ui, "setFocus");
		const tray = trayOf(cx);
		tray.component.handleNativeEvent?.({ type: "action", key: "", act: "tray.open", value: "bg_2", mods: [] });
		const sheet = shown.mock.calls.at(-1)?.[0];
		expect(sheet).toBeInstanceOf(JobsSheet);
		const list = nodes(sheet!.describe!(cx)!).find(node => node.k === "list");
		expect(list?.p && Reflect.get(list.p, "selected")).toBe("bg_2");
		expect(focus).toHaveBeenLastCalledWith(sheet);
	});

	it("shows the closer look only for the card asked for, and drops it on an empty peek", async () => {
		await seed();
		const cx = context(true);
		const tray = trayOf(cx);
		const peek = (value: string): NativeNode => {
			tray.component.handleNativeEvent?.({ type: "action", key: "", act: "tray.peek", value, mods: [] });
			return trayOf(cx).node;
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
				.map(node => node.p && Reflect.get(node.p, "actions")),
		).toEqual([{ click: "tray.open=TrayScan" }, { click: "tray.stop=TrayScan" }, { click: "tray.peek=" }]);
		const tail = children(look).find(node => role(node) === "omp.tray.tail");
		expect(children(tail).map(node => node.p && Reflect.get(node.p, "state"))).toEqual(["run"]);

		const closed = peek("");
		expect(closed.p && Reflect.get(closed.p, "peek")).toBeUndefined();
		expect(nodes(closed).some(node => role(node) === "omp.tray.peek")).toBe(false);
	});

	it("keeps an unchanged card's node and moves `acted` only when a new call starts", async () => {
		await seed();
		const cx = context(true);
		const first = children(trayOf(cx).node);

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
		const second = children(trayOf(cx).node);
		expect(second[1]).toBe(first[1]!);
		expect(second[0]!.p).toMatchObject({ acted: callStart });

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			progress("TrayScan", {
				currentTool: "grep",
				currentToolArgs: "TODO",
				currentToolStartMs: callStart + 4_000,
				toolCount: 4,
			}),
		);
		expect(children(trayOf(cx).node)[0]!.p).toMatchObject({ acted: callStart + 4_000 });
	});

	it("describes no tray node, and the pill as before, on a host without the feature", async () => {
		await seed();
		const cx = context(false);
		const described = dock(cx);
		const all = described.flatMap(entry => (entry.node ? nodes(entry.node) : []));
		expect(all.some(node => String(role(node)).startsWith("omp.tray"))).toBe(false);
		const pill = described.find(entry => role(entry.node ?? undefined) === "omp.hud");
		expect(pill?.node).toBe(mode.describeHudPills());
	});

	it("moves focus into the tray on the agents-hub key only on a native tray host showing cards", async () => {
		await seed();
		const hub = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});
		const cx = context(true);
		trayOf(cx);

		mode.showAgentHub({ trayFirst: true });
		expect(hub).toHaveBeenCalledTimes(1);

		setNativeRendering(true);
		trayOf(cx);
		mode.showAgentHub({ trayFirst: true });
		expect(hub).toHaveBeenCalledTimes(1);
		expect(trayOf(cx).node.p).toMatchObject({ focus: 1 });
	});

	it("turns the tray quiet and ungrouped once everything has finished, still reachable on the hub key", () => {
		vi.useFakeTimers();
		try {
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
			setNativeRendering(true);
			const cx = context(true);
			// Live: the agent's card and the done card.
			const live = children(trayOf(cx).node);
			expect(live.map(card => card.p && Reflect.get(card.p, "item"))).toEqual(["agent", "done"]);
			expect(trayOf(cx).node.p && Reflect.get(trayOf(cx).node.p!, "quiet")).toBeUndefined();
			const scanKey = live[0]!.key;

			const renders = spyOn(mode.ui, "requestRender");
			// It finishes without a background job: nothing live is left.
			registry.setStatus("TrayScan", "idle");
			vi.advanceTimersByTime(100);
			expect(renders).toHaveBeenCalled();
			const quiet = trayOf(cx).node;
			expect(quiet.p).toEqual({ role: "omp.tray", quiet: true, main: "idle" });
			// Nothing grouped: each finished agent is its own card, in spawn order, no done card.
			const cards = children(quiet);
			expect(
				cards.map(card => [card.p && Reflect.get(card.p, "item"), card.p && Reflect.get(card.p, "ref")]),
			).toEqual([
				["agent", "TrayScan"],
				["agent", "TrayOld"],
			]);
			// The same agent keeps its card's key across the regrouping.
			expect(cards[0]!.key).toBe(scanKey);
			// The idle status row stays, empty (no caption over a quiet tray): the host's seat for the tray.
			expect(dock(cx).find(entry => role(entry.node ?? undefined) === "omp.hud.activity")?.node).toEqual({
				k: "row",
				p: { role: "omp.hud.activity", align: "center", gap: "sm" },
				c: [],
			});

			// The hub key asks Tern to show it: a focus bump, not the hub.
			mode.showAgentHub({ trayFirst: true });
			expect(hub).not.toHaveBeenCalled();
			expect(trayOf(cx).node.p).toMatchObject({ quiet: true, focus: 1 });

			// The next agent starting groups the finished ones into the done card again.
			renders.mockClear();
			registry.register({
				id: "TrayNext",
				displayName: "m2",
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "running",
			});
			vi.advanceTimersByTime(100);
			expect(renders).toHaveBeenCalled();
			const back = trayOf(cx).node;
			expect(back.p && Reflect.get(back.p, "quiet")).toBeUndefined();
			// The new agent appends after the others' place; the done card is last.
			expect(children(back).map(card => card.p && Reflect.get(card.p, "ref"))).toEqual(["TrayNext", "done"]);
			const tray = trayOf(cx);
			tray.component.handleNativeEvent?.({ type: "action", key: "", act: "tray.peek", value: "done", mods: [] });
			const rows = children(children(children(trayOf(cx).node).at(-1))[1]);
			expect(rows.map(row => row.p && Reflect.get(row.p, "ref"))).toEqual(["TrayOld", "TrayScan"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps every card in place and the tray quiet while the user opens finished agents, reviving them to view", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "TrayOld",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/TrayOld.jsonl",
			status: "parked",
			createdAt: 1_000,
		});
		registry.register({
			id: "TrayScan",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/TrayScan.jsonl",
			status: "aborted",
			createdAt: 2_000,
		});
		setNativeRendering(true);
		const cx = context(true);
		const shape = (): unknown => {
			const node = trayOf(cx).node;
			return {
				quiet: node.p && Reflect.get(node.p, "quiet"),
				cards: children(node).map(card => [
					card.p && Reflect.get(card.p, "ref"),
					card.p && Reflect.get(card.p, "status"),
				]),
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
			during = shape();
			registry.setStatus(id, "idle");
		});
		const tray = trayOf(cx).component;
		for (const ref of ["TrayScan", "TrayOld"]) {
			tray.handleNativeEvent?.({ type: "action", key: "", act: "tray.peek", value: ref, mods: [] });
			tray.handleNativeEvent?.({ type: "action", key: "", act: "tray.open", value: ref, mods: [] });
			await Promise.resolve();
			await Promise.resolve();
			expect(during).toEqual(before);
			expect(shape()).toEqual(before);
		}

		// Real work wakes it: a message runs the agent again.
		registry.setStatus("TrayOld", "running");
		expect(shape()).toEqual({
			quiet: undefined,
			cards: [
				["TrayOld", "running"],
				["done", "done"],
			],
		});
	});

	it("keeps the status row as the tray's seat while it has cards, one row from working to idle and back", () => {
		const registry = AgentRegistry.global();
		const cx = context(true);
		const working = [new Text("Working", 0, 0)];
		// No items: no row.
		expect(
			mode.describeStatusHud([], cx).p && Reflect.get(mode.describeStatusHud([], cx).p!, "role"),
		).toBeUndefined();

		registry.register({
			id: "TrayOld",
			displayName: "m2",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const rows = [
			mode.describeStatusHud(working, cx),
			mode.describeStatusHud([], cx),
			mode.describeStatusHud(working, cx),
		];
		// One row throughout (same kind and role, so the host keeps it); idle over a quiet tray it is empty.
		expect(rows.map(node => [node.k, node.p && Reflect.get(node.p, "role")])).toEqual([
			["row", "omp.hud.activity"],
			["row", "omp.hud.activity"],
			["row", "omp.hud.activity"],
		]);
		expect(rows[1]!.c).toEqual([]);
	});

	it("leaves the agents-hub key inert on a tray host with no cards, unless the tray's agents are turned off", () => {
		const hub = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});
		setNativeRendering(true);
		const cx = context(true);
		expect(trayOf(cx).node.p).toMatchObject({ hidden: true });
		mode.showAgentHub({ trayFirst: true });
		expect(hub).not.toHaveBeenCalled();

		cfgDisplayPinnedAgents.override(Settings.instance, "off");
		mode.showAgentHub({ trayFirst: true });
		expect(hub).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode tray: the main agent across a real turn", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	const release: Array<() => void> = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(async () => {
		for (const done of release.splice(0)) done();
		AgentRegistry.global().unregister("TrayLive");
		setNativeRendering(false);
		vi.restoreAllMocks();
		mode?.stop();
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
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
		// A card, so the tray node is sent: a running agent only the registry knows.
		AgentRegistry.global().register({
			id: "TrayLive",
			displayName: "TrayLive",
			kind: "sub",
			session: null,
			status: "running",
		});
		setNativeRendering(true);
		const cx = context(true);
		const tray = (): NativeNode => {
			for (const child of mode.composer.describeSurface(cx).dock) {
				const described = (child as Component).describe?.(cx);
				if (role(described ?? undefined) === "omp.tray") return described!;
			}
			throw new Error("no tray in the dock");
		};
		const main = (): unknown => tray().p && Reflect.get(tray().p!, "main");
		const renders = spyOn(mode.ui, "requestRender");
		/** The session hands its events to subscribers asynchronously: let them through. */
		const delivered = async (): Promise<void> => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};
		expect(main()).toBe("idle");

		const prompt = session.prompt("go");
		await firstCall.reached;
		await delivered();
		expect(main()).toBe("working");

		renders.mockClear();
		firstCall.open();
		await waitCall.reached;
		await delivered();
		// The flip asks for a frame itself; no unrelated repaint is needed to send it.
		expect(renders).toHaveBeenCalled();
		expect(main()).toBe("waiting");

		// The wait returns and the model thinks again: still waiting, as it mostly waits again.
		waitCall.open();
		await secondCall.reached;
		await delivered();
		expect(main()).toBe("waiting");

		// Another kind of call ends it.
		renders.mockClear();
		secondCall.open();
		await bashCall.reached;
		await delivered();
		expect(renders).toHaveBeenCalled();
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
