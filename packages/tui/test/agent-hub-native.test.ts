import { afterEach, beforeAll, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspKind, TspPickerProps, TspText } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { AgentHubOverlayComponent } from "../src/overlays/agent-hub";
import type { AgentRecordLike } from "../src/overlays/agent-hub-types";
import { boundedModelMetadata } from "../src/overlays/agent-hub-renderer";
import {
	type EventBusLike,
	SessionObserverRegistry,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../src/overlays/session-observer-registry";
import { initTheme, theme } from "../src/theme";

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
/** A terminal without the data-first kinds keeps the generic overlay composition. */
const genericCx: DescribeContext = {
	...pickerCx,
	supports: (kind: TspKind) => kind !== "picker" && kind !== "meter",
};

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function agent(id: string, lastActivity: number, extra?: Partial<AgentRecordLike>): AgentRecordLike {
	return {
		id,
		displayName: id,
		kind: "sub",
		status: "idle",
		session: null,
		sessionFile: null,
		createdAt: 0,
		lastActivity,
		...extra,
	};
}

function createHub(
	agents: AgentRecordLike[],
	focused: string[] = [],
	observers = new SessionObserverRegistry(),
): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers,
		transcript: { fs, parseEntries: () => [] },
		getRoleInfo: role => ({ tag: role }),
		loadPersisted: async () => {},
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: {
			list: () => agents,
			get: id => agents.find(ref => ref.id === id),
			onChange: () => () => {},
		},
		lifecycle: () => {
			throw new Error("lifecycle is not used by selection");
		},
		irc: { unreadCount: () => 0 },
		activity: { setLive() {}, sync: async () => {}, query: () => [], recent: () => [] },
		focusAgent: async id => {
			focused.push(id);
		},
	});
}

function selectedRosterId(hub: AgentHubOverlayComponent): string | null | undefined {
	const pending: NativeChild[] = [hub.describe(genericCx)];
	for (let child = pending.pop(); child; child = pending.pop()) {
		if (!("k" in child)) continue;
		const described: NativeNode = child;
		if (described.k === "list" && described.key === "agents") return described.p?.selected;
		pending.push(...(described.c ?? []));
	}
	return undefined;
}

function pickerProps(hub: AgentHubOverlayComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

test("without the picker kind, a native select on the roster moves the selection Enter opens", () => {
	const focused: string[] = [];
	const hub = createHub([agent("alpha", 3_000), agent("beta", 2_000), agent("gamma", 1_000)], focused);
	try {
		expect(hub.nativeSheet(genericCx)).toBe(false);
		expect(selectedRosterId(hub)).toBe("alpha");

		hub.handleNativeEvent({ type: "select", key: "body/agents", item: "gamma" });
		expect(selectedRosterId(hub)).toBe("gamma");

		hub.handleInput("\r");
		expect(focused).toEqual(["gamma"]);
	} finally {
		hub.dispose();
	}
});

test("picker select and the Open transcript action take Enter's path on the chosen agent", () => {
	const focused: string[] = [];
	const hub = createHub([agent("alpha", 3_000), agent("beta", 2_000), agent("gamma", 1_000)], focused);
	try {
		expect(hub.nativeSheet(pickerCx)).toBe(true);
		expect(pickerProps(hub).selected).toBe("alpha");

		hub.handleNativeEvent({ type: "select", key: "", item: "beta" });
		expect(pickerProps(hub).selected).toBe("beta");

		hub.handleNativeEvent({ type: "action", key: "", act: "open", mods: [] });
		expect(focused).toEqual(["beta"]);
		hub.handleNativeEvent({ type: "activate", key: "", item: "gamma" });
		expect(focused).toEqual(["beta", "gamma"]);
	} finally {
		hub.dispose();
	}
});

test("the By parent action and the t key both switch the picker to the parent tree", () => {
	const hub = createHub([agent("Lead", 3_000), agent("Worker", 2_000, { parentId: "Lead" }), agent("Solo", 1_000)]);
	try {
		expect(pickerProps(hub).layout).toBe("rows");

		hub.handleNativeEvent({ type: "action", key: "", act: "view", mods: [] });
		const tree = pickerProps(hub);
		expect(tree.layout).toBe("tree");
		expect(tree.actions?.find(action => action.id === "view")?.on).toBe(true);
		expect(tree.items?.map(item => [item.id, item.depth])).toEqual([
			["Lead", 0],
			["Worker", 1],
			["Solo", 0],
		]);

		hub.handleInput("t");
		expect(pickerProps(hub).layout).toBe("rows");
	} finally {
		hub.dispose();
	}
});

/** An observer registry fed by a fake bus, with one running `Worker` progress frame of `durationMs` at t=1_000_000. */
function observedWorker(durationMs: number) {
	const listeners = new Map<string, (data: unknown) => void>();
	const bus: EventBusLike = {
		on(channel, listener) {
			listeners.set(channel, listener);
			return () => listeners.delete(channel);
		},
	};
	const observers = new SessionObserverRegistry();
	observers.subscribeToEventBus(bus, bus);
	const now = spyOn(Date, "now").mockReturnValue(1_000_000);
	listeners.get(TASK_SUBAGENT_PROGRESS_CHANNEL)?.({
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "work",
		progress: {
			id: "Worker",
			index: 0,
			status: "running",
			tokens: 10,
			requests: 1,
			toolCount: 1,
			cost: 0,
			durationMs,
		},
	});
	const hub = createHub([agent("Worker", 1_000_000, { status: "running" }), agent("Idle", 900_000)], [], observers);
	return { hub, now, observers, emit: (channel: string, data: unknown) => listeners.get(channel)?.(data) };
}

// 0 ms is a first frame emitted in the spawn's start millisecond; it must still clock rather than freeze as text.
test.each([60_000, 0])(
	"a running row's Time (last frame %p ms) is the age at send, not re-based to the frame",
	durationMs => {
		const { hub, now } = observedWorker(durationMs);
		try {
			expect(pickerProps(hub).items?.find(item => item.id === "Worker")?.facts?.time).toBe(durationMs);
			// A long tool call emits no progress; an unrelated repaint (here a selection change) re-sends
			// the row and must keep the terminal clock moving forward instead of rewinding it.
			now.mockReturnValue(1_045_000);
			hub.handleNativeEvent({ type: "select", key: "", item: "Idle" });
			expect(pickerProps(hub).items?.find(item => item.id === "Worker")?.facts?.time).toBe(durationMs + 45_000);
		} finally {
			hub.dispose();
		}
	},
);

test("a follow-up turn does not age the previous turn's snapshot across the idle gap", () => {
	const { hub, now, emit } = observedWorker(60_000);
	const lifecycle = { id: "Worker", agent: "task", agentSource: "bundled", index: 0 };
	try {
		emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...lifecycle, status: "completed" });
		// Parked for an hour, then revived for another turn before its first progress frame.
		now.mockReturnValue(4_600_000);
		emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...lifecycle, status: "started" });
		hub.handleNativeEvent({ type: "select", key: "", item: "Idle" });
		expect(pickerProps(hub).items?.find(item => item.id === "Worker")?.facts?.time).toBe(60_000);
	} finally {
		hub.dispose();
	}
});

function nativeTexts(root: NativeNode): string[] {
	const plain = (value: TspText | undefined): string =>
		typeof value === "string" ? value : (value?.map(part => part.t).join("") ?? "");
	const texts: string[] = [];
	const pending: NativeChild[] = [root];
	for (let child = pending.pop(); child; child = pending.pop()) {
		if (!("k" in child)) continue;
		if (child.k === "text") texts.push(child.p?.text ?? plain(child.p?.spans));
		if (child.k === "item") texts.push(plain(child.p?.value));
		if (child.k === "tree") texts.push(...(child.p?.nodes.map(entry => plain(entry.label)) ?? []));
		if (child.k === "kv") texts.push(...(child.p?.items.map(item => plain(item.v)) ?? []));
		pending.push(...(child.c ?? []));
	}
	return texts;
}

test.each(["roster", "tree"])("fast model placement matches both panes in %s views and updates off", view => {
	const history = { resolvedModel: "openai/gpt-worker:high", fastMode: true };
	const ref = agent("Worker", 1_000, { history });
	const hub = createHub([ref]);
	try {
		if (view === "tree") hub.handleInput("t");
		const model = `gpt-worker ${theme.icon.fast}`;
		const badge = `${model} ${theme.thinking.high}`;
		const rendered = hub.render(180).map(line => Bun.stripANSI(line));
		expect(rendered.filter(line => line.includes(badge)).length).toBe(2);
		expect(nativeTexts(hub.describe(genericCx)).filter(line => line.includes(badge)).length).toBe(2);
		const label = pickerProps(hub).items?.[0]?.label;
		expect(Array.isArray(label) && label.some(part => part.t === ` ${theme.icon.fast}` && part.s === "warning")).toBe(
			true,
		);
		expect(nativeTexts(hub.describe(pickerCx))).toContain(`${model}${theme.sep.dot}high`);
		for (const width of [40, 80]) {
			expect(hub.render(width).every(line => Bun.stringWidth(line) <= width)).toBe(true);
		}

		history.fastMode = false;
		const standard = `gpt-worker ${theme.thinking.high}`;
		expect(
			hub
				.render(180)
				.map(line => Bun.stripANSI(line))
				.filter(line => line.includes(standard)).length,
		).toBe(2);
		expect(nativeTexts(hub.describe(genericCx)).filter(line => line.includes(standard)).length).toBe(2);
		expect(nativeTexts(hub.describe(pickerCx))).toContain(`gpt-worker${theme.sep.dot}high`);
	} finally {
		hub.dispose();
	}
});

test.each([true, false, undefined])("a non-thinking model only shows a trustworthy fast glyph (%p)", fastMode => {
	const hub = createHub([agent("Worker", 1_000, { history: { resolvedModel: "openai/gpt-worker", fastMode } })]);
	try {
		const label = fastMode ? `gpt-worker ${theme.icon.fast}` : "gpt-worker";
		const pickerLabel = pickerProps(hub).items?.[0]?.label;
		expect(Array.isArray(pickerLabel) && pickerLabel.map(part => part.t).join("")).toBe(
			`Worker${theme.sep.dot}${label}`,
		);
		expect(nativeTexts(hub.describe(pickerCx))).toContain(label);
		expect(nativeTexts(hub.describe(genericCx)).filter(line => line === label).length).toBe(2);
		expect(
			hub
				.render(180)
				.map(line => Bun.stripANSI(line))
				.filter(line => line.includes(label)).length,
		).toBe(2);
	} finally {
		hub.dispose();
	}
});

test("ASCII theme fast glyph is used in both panes without a thinking level", async () => {
	await initTheme(false, "ascii");
	const hub = createHub([agent("Worker", 1_000, { history: { resolvedModel: "openai/gpt-worker", fastMode: true } })]);
	try {
		const label = `gpt-worker ${theme.icon.fast}`;
		const pickerLabel = pickerProps(hub).items?.[0]?.label;
		expect(Array.isArray(pickerLabel) && pickerLabel.map(part => part.t).join("")).toBe(
			`Worker${theme.sep.dot}${label}`,
		);
		expect(nativeTexts(hub.describe(pickerCx))).toContain(label);
		expect(nativeTexts(hub.describe(genericCx)).filter(line => line === label).length).toBe(2);
		expect(
			hub
				.render(180)
				.map(line => Bun.stripANSI(line))
				.filter(line => line.includes(label)).length,
		).toBe(2);
	} finally {
		hub.dispose();
		await initTheme(false);
	}
});

test("literal thinking suffixes in model IDs preserve authoritative live fast state", () => {
	let fastMode = true;
	const identity = "custom/coding-router:max";
	const model = buildModel({
		id: "coding-router:max",
		provider: "custom",
		api: "openai-responses",
		name: "Literal suffix",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	const ref = agent("Worker", 1_000, {
		session: {
			model,
			thinkingLevel: undefined,
			servingModel: { selector: identity, modelIdentity: identity, isFallback: false },
			isFastModeActive: () => fastMode,
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheWrite: 0 },
				assistantMessages: 0,
				toolCalls: 0,
				cost: 0,
			}),
			abort: async () => {},
		},
	});
	const hub = createHub([ref]);
	try {
		expect(hub.render(180).filter(line => line.includes(theme.icon.fast)).length).toBe(2);
		expect(
			hub
				.render(180)
				.map(line => Bun.stripANSI(line))
				.some(line => line.includes("coding-router:max")),
		).toBe(true);
		ref.history = { resolvedModel: identity, fastMode: true };
		fastMode = false;
		expect(hub.render(180).some(line => line.includes(theme.icon.fast))).toBe(false);
	} finally {
		hub.dispose();
	}
});

test.each([true, false])("parked policy supersedes completed progress in both directions (%p)", previous => {
	const { hub: unused, emit, observers } = observedWorker(10);
	unused.dispose();
	const ref = agent("Worker", 1_000, {
		status: "running",
		history: { resolvedModel: "openai/gpt-worker", fastMode: !previous },
	});
	const hub = createHub([ref], [], observers);
	const frame = {
		id: "Worker",
		index: 0,
		status: "running",
		resolvedModel: "openai/gpt-worker:high",
		resolvedModelIdentity: "openai/gpt-worker",
		fastMode: previous,
		tokens: 10,
		requests: 1,
		toolCount: 0,
		cost: 0,
		durationMs: 10,
	};
	try {
		emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "work",
			progress: frame,
		});
		expect(hub.render(180).some(line => line.includes(theme.icon.fast))).toBe(previous);
		emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Worker",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
		});
		ref.status = "parked";
		expect(hub.render(180).some(line => line.includes(theme.icon.fast))).toBe(!previous);
		ref.history = { resolvedModel: "openai/other-model" };
		expect(hub.render(180).some(line => line.includes(theme.icon.fast))).toBe(false);
	} finally {
		hub.dispose();
		observers.dispose();
	}
});

test.each(["default", "ascii"])(
	"RuntimeProtocolAudit keeps complete fast and xhigh suffix on one bounded line (%s)",
	async preset => {
		if (preset === "ascii") await initTheme(false, "ascii");
		const role = "subagent:RuntimeProtocolAudit";
		const ref = agent("RuntimeProtocolAudit", 1_000, {
			history: { modelRole: role, resolvedModel: "openai-codex/gpt-6.1-sol:xhigh", fastMode: true },
		});
		const hub = createHub([ref]);
		try {
			const suffix = `${theme.icon.fast} ${theme.thinking.xhigh}`;
			for (const width of [8, 12, 18, 24, 32, 45, 64]) {
				const metadata = boundedModelMetadata(ref, undefined, role, width);
				expect(Bun.stringWidth(metadata)).toBeLessThanOrEqual(width);
				if (width >= Bun.stringWidth(suffix)) expect(Bun.stripANSI(metadata)).toEndWith(suffix);
			}
			for (const width of [100, 120, 180]) {
				const lines = hub.render(width);
				expect(lines.every(line => Bun.stringWidth(line) <= width)).toBe(true);
				expect(lines.map(line => Bun.stripANSI(line)).filter(line => line.includes(suffix)).length).toBe(2);
			}
			const narrowRoster = hub.render(80);
			expect(narrowRoster.every(line => Bun.stringWidth(line) <= 80)).toBe(true);
			expect(narrowRoster.map(line => Bun.stripANSI(line)).filter(line => line.includes(suffix)).length).toBe(1);
			hub.handleInput("\t");
			const narrowInspector = hub.render(80);
			expect(narrowInspector.every(line => Bun.stringWidth(line) <= 80)).toBe(true);
			expect(narrowInspector.map(line => Bun.stripANSI(line)).filter(line => line.includes(suffix)).length).toBe(1);
		} finally {
			hub.dispose();
			await initTheme(false);
		}
	},
);

test("picker warning span updates within the same variant after a progress event", () => {
	vi.useFakeTimers();
	const { hub, emit } = observedWorker(10);
	const frame = {
		id: "Worker",
		index: 0,
		status: "running",
		resolvedModel: "openai/gpt-worker:high",
		resolvedModelIdentity: "openai/gpt-worker",
		fastMode: true,
		tokens: 10,
		requests: 1,
		toolCount: 0,
		cost: 0,
		durationMs: 10,
	};
	try {
		pickerProps(hub);
		emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "work",
			progress: frame,
		});
		vi.advanceTimersByTime(100);
		const label = pickerProps(hub).items?.find(item => item.id === "Worker")?.label;
		expect(Array.isArray(label) && label.some(part => part.t === ` ${theme.icon.fast}` && part.s === "warning")).toBe(
			true,
		);
		emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "work",
			progress: { ...frame, fastMode: false },
		});
		vi.advanceTimersByTime(100);
		const updated = pickerProps(hub).items?.find(item => item.id === "Worker")?.label;
		expect(Array.isArray(updated) && updated.some(part => part.t.includes(theme.icon.fast))).toBe(false);
	} finally {
		hub.dispose();
		vi.useRealTimers();
	}
});

test("model metadata does not borrow fast policy across explicit routed identities", () => {
	const ref = agent("Worker", 1_000, {
		history: { resolvedModel: "openai/gpt-worker@route-a", fastMode: true },
	});
	const observed = {
		id: "Worker",
		kind: "subagent" as const,
		label: "Worker",
		status: "active" as const,
		lastUpdate: 1_000,
		progress: {
			id: "Worker",
			index: 0,
			status: "running" as const,
			resolvedModel: "openai/gpt-worker:high",
			resolvedModelIdentity: "openai/gpt-worker@route-b",
			agent: "task",
			agentSource: "bundled" as const,
			task: "work",
			recentTools: [],
			recentOutput: [],
			tokens: 0,
			requests: 0,
			toolCount: 0,
			cost: 0,
			durationMs: 0,
		},
	};
	expect(boundedModelMetadata(ref, observed, undefined, 120)).not.toContain(theme.icon.fast);
});

test("live model labels stay single-line in wide and narrow Hub rendering", () => {
	const hub = createHub([
		agent("Worker", 1_000, {
			session: {
				model: buildModel({
					id: `unsafe\n\u0007model-${"long-".repeat(20)}`,
					name: "Unsafe model",
					provider: "custom",
					api: "openai-completions",
					baseUrl: "https://example.com",
					reasoning: true,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 8_192,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
				thinkingLevel: ThinkingLevel.High,
				getSessionStats: () => ({
					tokens: { input: 0, output: 0, cacheWrite: 0 },
					assistantMessages: 0,
					toolCalls: 0,
					cost: 0,
				}),
				abort: async () => {},
			},
		}),
	]);
	try {
		for (const width of [400, 80]) {
			const lines = hub.render(width).map(line => Bun.stripANSI(line));
			expect(lines.some(line => line.includes("unsafe"))).toBe(true);
			expect(lines.every(line => !/[\n\u0007]/.test(line))).toBe(true);
			expect(lines.some(line => line.includes(`model-${"long-".repeat(20)}`))).toBe(width === 400);
		}
	} finally {
		hub.dispose();
	}
});

test("an agent without model metadata remains renderable", () => {
	const ref = agent("Unknown", 1_000);
	const hub = createHub([ref]);
	try {
		expect(
			hub
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("Unknown");
		expect(pickerProps(hub).items?.[0]?.label).toBe("Unknown");
	} finally {
		hub.dispose();
	}
});

test.each([undefined, false])(
	"cold response fast evidence survives an unserved follow-up unless runtime overrides it (%p)",
	fastMode => {
		const { hub: unused, emit, observers } = observedWorker(10);
		unused.dispose();
		const ref = agent("Worker", 1_000, {
			status: "running",
			history: { resolvedModel: "openai/retained-model", responseFastMode: true },
			session: {
				model: buildModel({
					id: "unserved-primary",
					provider: "openai",
					api: "openai-responses",
					name: "Unserved primary",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				}),
				thinkingLevel: undefined,
				servingModel: {
					selector: "openai/unserved-primary",
					modelIdentity: "openai/unserved-primary",
					isFallback: false,
					served: false,
				},
				isFastModeActive: () => false,
				getSessionStats: () => ({
					tokens: { input: 0, output: 0, cacheWrite: 0 },
					assistantMessages: 0,
					toolCalls: 0,
					cost: 0,
				}),
				abort: async () => {},
			},
		});
		const hub = createHub([ref], [], observers);
		const lifecycle = { id: "Worker", index: 0, agent: "task", agentSource: "bundled" };
		try {
			emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				...lifecycle,
				task: "follow-up",
				progress: {
					id: "Worker",
					index: 0,
					status: "running",
					resolvedModel: "openai/retained-model",
					resolvedModelIdentity: "openai/retained-model",
					resolvedModelIsFallback: true,
					fastMode,
					tokens: 0,
					requests: 0,
					toolCount: 0,
					cost: 0,
					durationMs: 0,
				},
			});
			expect(hub.render(180).filter(line => line.includes(theme.icon.fast))).toHaveLength(
				fastMode === false ? 0 : 2,
			);
			ref.history = { resolvedModel: "openai/other-model", responseFastMode: true };
			expect(hub.render(180).some(line => line.includes(theme.icon.fast))).toBe(false);
			ref.history = { resolvedModel: "openai/retained-model", responseFastMode: true };
			emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...lifecycle, status: "failed" });
			expect(hub.render(180).some(line => line.includes(theme.icon.fast))).toBe(fastMode !== false);
			ref.history.fastMode = fastMode;
			ref.session = null;
			ref.status = "parked";
			expect(hub.render(180).filter(line => line.includes(theme.icon.fast))).toHaveLength(
				fastMode === false ? 0 : 2,
			);
		} finally {
			hub.dispose();
			observers.dispose();
		}
	},
);

test("an unserved revived fallback does not replace retained model attribution", () => {
	const ref = agent("Worker", 1_000, {
		history: { resolvedModel: "openai/retained-model", fastMode: false },
		session: {
			model: undefined,
			thinkingLevel: undefined,
			servingModel: {
				selector: "openai/unserved-fallback",
				modelIdentity: "openai/unserved-fallback",
				isFallback: true,
				served: false,
			},
			isFastModeActive: () => true,
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheWrite: 0 },
				assistantMessages: 0,
				toolCalls: 0,
				cost: 0,
			}),
			abort: async () => {},
		},
	});
	const badge = Bun.stripANSI(boundedModelMetadata(ref, undefined, undefined, 120));
	expect(badge).toBe("retained-model");
});

test.each(["roster", "tree"])("adaptive metadata keeps agents identifiable in narrow %s rows", view => {
	const history = { resolvedModel: `openai/${"long-model-name-".repeat(8)}:xhigh`, fastMode: true };
	const hub = createHub([
		agent("WorkerAlpha", 2_000, { history }),
		agent("WorkerBeta", 1_000, { parentId: "WorkerAlpha", history }),
	]);
	try {
		if (view === "tree") hub.handleInput("t");
		const suffix = `${theme.icon.fast} ${theme.thinking.xhigh}`;
		for (const width of [80, 100, 120]) {
			const headers = hub
				.render(width)
				.map(line => Bun.stripANSI(line))
				.filter(line => line.includes(suffix));
			expect(headers.some(line => line.includes("WorkerAlpha"))).toBe(true);
			expect(headers.some(line => line.includes("WorkerBeta"))).toBe(true);
		}
	} finally {
		hub.dispose();
	}
});
