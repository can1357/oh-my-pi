import { afterEach, beforeAll, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import type { TspKind, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { AgentHubOverlayComponent } from "../src/overlays/agent-hub";
import type { AgentRecordLike } from "../src/overlays/agent-hub-types";
import {
	type EventBusLike,
	SessionObserverRegistry,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../src/overlays/session-observer-registry";
import { initTheme } from "../src/theme";

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
	return { hub, now, emit: (channel: string, data: unknown) => listeners.get(channel)?.(data) };
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
