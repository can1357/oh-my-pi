import { beforeAll, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import type { TspKind, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { type AgentHubDeps, AgentHubOverlayComponent } from "../src/overlays/agent-hub";
import type { AgentRecordLike } from "../src/overlays/agent-hub-types";
import { SessionObserverRegistry } from "../src/overlays/session-observer-registry";
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
	overrides: Partial<AgentHubDeps> = {},
): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
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
		...overrides,
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

test("peer rows offer Send, reject forged local actions, and never pretend to be spawned by Main", async () => {
	const focused: string[] = [];
	const sendPeer = vi.fn(async () => "Delivered.");
	const showPeerEditor = vi.fn(async () => undefined);
	const lifecycle = vi.fn(() => {
		throw new Error("peer must not use local lifecycle");
	});
	const remote = { chat: vi.fn(), revive: vi.fn(), kill: vi.fn(), readTranscript: vi.fn(async () => null) };
	const peer = agent("project-deadbeef", 0, {
		kind: "peer",
		displayName: "reviewer",
		peer: { cwd: "C:/project\x1b]52;c;payload\x07\ninjected", title: "Review\nworkspace" },
	});
	const hub = createHub([], focused, {
		listPeers: async () => [peer],
		sendPeer,
		showPeerEditor,
		lifecycle,
		remote,
	});
	try {
		await hub.initialRowsReady;
		const props = pickerProps(hub);
		expect(props.items?.map(item => [item.id, item.label])).toEqual([["project-deadbeef", "reviewer"]]);
		expect(props.actions?.find(action => action.id === "send")?.disabled).toBeUndefined();
		for (const action of ["open", "focus", "revive", "kill"]) {
			expect(props.actions?.find(item => item.id === action)?.disabled).toBeTruthy();
			hub.handleNativeEvent({ type: "action", key: "", act: action, mods: [] });
		}
		hub.openChat(peer.id);
		hub.handleInput("r");
		hub.handleInput("x");
		expect(showPeerEditor).not.toHaveBeenCalled();
		expect(lifecycle).not.toHaveBeenCalled();
		expect(focused).toEqual([]);
		expect(remote.chat).not.toHaveBeenCalled();
		expect(remote.revive).not.toHaveBeenCalled();
		expect(remote.kill).not.toHaveBeenCalled();
		expect(remote.readTranscript).not.toHaveBeenCalled();
		const raw = hub.render(160).join("\n");
		const rendered = Bun.stripANSI(raw);
		expect(rendered).not.toContain("Spawned by Main");
		expect(rendered).not.toContain("Shared workspace");
		expect(raw).not.toContain("\x1b]52");
		expect(rendered).not.toContain(":revive");
		expect(rendered).not.toContain("only parked agents can be revived");
		expect(rendered).toContain(":send");
		hub.handleNativeEvent({ type: "action", key: "", act: "send", mods: [] });
		await Promise.resolve();
		expect(showPeerEditor).toHaveBeenCalledWith("Message reviewer", expect.any(AbortSignal));
		expect(sendPeer).not.toHaveBeenCalled();
	} finally {
		hub.dispose();
	}
});
