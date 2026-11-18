import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { JobWidgetRegistry } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { asyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/async-job-views";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { Component } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

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
	const agentIds = ["TrayScan", "TrayReview", "TrayOld"];
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
			displayName: "TrayScan",
			kind: "sub",
			parentId: "Main",
			session: null,
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
			["done", "done"],
			["job", "bg_1"],
			["job", "bg_2"],
		]);
		const [scan, review, done, widgetJob, bareJob] = cards;

		expect(scan!.p).toMatchObject({ role: "omp.tray.card", status: "running", tone: "accent", acted: callStart });
		expect(children(scan).map(role)).toEqual(["omp.tray.head", "omp.tray.doing", "omp.tray.meta"]);
		expect(children(children(scan)[0]).map(role)).toEqual(["omp.tray.dot", "omp.tray.name", "omp.tray.time"]);
		expect(children(scan)[1]!.p).toMatchObject({
			spans: [{ t: "read", s: "dim" }, { t: " · ", s: "dim" }, { t: "Reading the config" }],
		});
		expect(children(children(scan)[2]).map(node => node.p && Reflect.get(node.p, "text"))).toEqual([
			"claude-sonnet-4-5 · low",
			"3 tools · 22%",
		]);

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
			text: "claude-sonnet-4-5 · low · 3 tools · 22%",
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
});
