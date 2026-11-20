import { expect, it } from "bun:test";
import { type RelaySocket, RelayBridge } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";

const PROBE = `${import.meta.dir}/browser-relay-background-probe.ts`;

interface Frame {
	t: string;
	[key: string]: unknown;
}

/** A worker → panel frame as the probe's panel port received it. */
interface PanelFrame {
	kind: string;
	id?: number;
	result?: unknown;
	[key: string]: unknown;
}

interface ProbeReport {
	/** Each native port the worker opened: the host it named and its first frame. */
	linkRequests: Array<{ host: string; first: Frame | undefined }>;
	/** What the first port carried before the host said `linked`. */
	postedBeforeLinked: Frame[];
	sent: Frame[];
	searchCalls: unknown[];
	panelReceived?: PanelFrame[];
	reconnectDelays?: number[];
	portsBeforeAlarm?: number;
	tabMessages?: Array<{ tabId: number; message: Record<string, unknown> }>;
	injected?: Array<{ tabId: number; files: string[] }>;
}

function runProbe(env: { downloads?: boolean; findDownload?: boolean; scenario?: string } = {}): ProbeReport {
	const proc = Bun.spawnSync([process.execPath, PROBE], {
		env: {
			...Bun.env,
			PROBE_DOWNLOADS: env.downloads ? "1" : "0",
			PROBE_FIND_DOWNLOAD: env.findDownload ? "1" : "0",
			PROBE_SCENARIO: env.scenario ?? "",
		},
	});
	expect(proc.exitCode, proc.stderr.toString()).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

/** The relay replies in the probe's sent frames, after the hello. */
function rpcResults(sent: Frame[]): Frame[] {
	return sent.filter(frame => frame.t === "rpcResult");
}

/** The relay statuses the panel heard, in order. */
function relayStatuses(received: PanelFrame[]): unknown[] {
	return received.flatMap(frame => {
		const event = frame.event;
		return frame.kind === "event" &&
			typeof event === "object" &&
			event !== null &&
			"event" in event &&
			event.event === "relay" &&
			"status" in event
			? [event.status]
			: [];
	});
}

const EXTENSION_ID = "a".repeat(32);

it("links the native host with its extension id and says hello only once linked", () => {
	const { linkRequests, postedBeforeLinked, sent } = runProbe({ downloads: true });
	expect(linkRequests).toEqual([{ host: "sh.omp.browser", first: { t: "link", extensionId: EXTENSION_ID } }]);
	expect(postedBeforeLinked).toEqual([{ t: "link", extensionId: EXTENSION_ID }]);
	expect(sent[0]?.t).toBe("hello");
});

it("survives a browser that never exposed chrome.downloads: still links the relay and forwards tab and debugger events", () => {
	const { sent } = runProbe();
	// The degraded hello omits the downloads capability, so the relay tells the agent to reinstall
	// instead of failing lookups with a generic not-found.
	const hello = sent.find(frame => frame.t === "hello");
	expect(hello).toBeDefined();
	expect("downloadsProtocol" in hello!).toBe(false);
	// The tab and debugger listeners register after the downloads block that used to throw.
	expect(sent.find(frame => frame.t === "tabCreated")).toMatchObject({ tab: { tabId: 5 } });
	expect(sent.find(frame => frame.t === "cdpEvent")).toMatchObject({ tabId: 5, method: "Page.loadEventFired" });
});

it("advertises the downloads, overlay and panel capabilities", () => {
	const { sent } = runProbe({ downloads: true });
	expect(sent.find(frame => frame.t === "hello")).toMatchObject({
		downloadsProtocol: 1,
		overlayProtocol: 1,
		panelProtocol: 1,
	});
});

it("answers a findDownload RPC without touching the missing downloads API", () => {
	const { sent, searchCalls } = runProbe({ findDownload: true });
	// The search-call assertion is the guard's own: the null result alone also holds without it, since
	// nothing can pair a download id while the API (and its onCreated listener) is absent.
	expect(searchCalls).toEqual([]);
	expect(rpcResults(sent)).toEqual([{ t: "rpcResult", id: 1, ok: true, result: null }]);
});

it("forwards panel calls to the relay, answers them by id, and fails them when the relay unlinks", () => {
	const { sent, panelReceived, linkRequests } = runProbe({ scenario: "panel" });
	const calls = sent.filter(frame => frame.t === "call");
	expect(calls.map(frame => frame.call)).toEqual([{ op: "collabHosts" }, { op: "collabLink", instanceId: "host-1" }]);
	const responses = panelReceived!.filter(frame => frame.kind === "response");
	expect(responses.find(frame => frame.id === 1)).toEqual({
		kind: "response",
		id: 1,
		ok: true,
		result: [{ instanceId: "host-1", cwd: "/work" }],
	});
	expect(responses.find(frame => frame.id === 2)).toEqual({
		kind: "response",
		id: 2,
		ok: false,
		error: "omp relay went away",
	});
	// Each request is answered once; the stray callResult answered nothing.
	expect(responses.map(frame => frame.id).sort()).toEqual([1, 2, 3]);
	// The panel hears the relay drop.
	expect(relayStatuses(panelReceived!).at(-1)).toEqual({ connected: false, extensionVersion: undefined });
	// The host relinks by itself; the worker keeps its port.
	expect(linkRequests).toHaveLength(1);
});

it("drops an RPC's answer once the link epoch it came in on ended", () => {
	const { sent } = runProbe({ scenario: "epoch" });
	expect(sent.filter(frame => frame.t === "hello")).toHaveLength(2);
	expect(rpcResults(sent)).toEqual([{ t: "rpcResult", id: 2, ok: true, result: null }]);
});

it("reassembles relay lines the host split into chunks", () => {
	const { sent } = runProbe({ scenario: "chunk" });
	expect(rpcResults(sent).sort((a, b) => Number(a.id) - Number(b.id))).toEqual([
		{ t: "rpcResult", id: 1, ok: true, result: null },
		{ t: "rpcResult", id: 2, ok: true, result: null },
	]);
});

it("reconnects a lost native port with backoff, reset by a link, and at once on the keepalive alarm", () => {
	const { reconnectDelays, portsBeforeAlarm, linkRequests, panelReceived } = runProbe({ scenario: "reconnect" });
	expect(reconnectDelays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 1_000]);
	expect(portsBeforeAlarm).toBe(7);
	expect(linkRequests).toHaveLength(8);
	for (const request of linkRequests) expect(request.first).toEqual({ t: "link", extensionId: EXTENSION_ID });
	// Only exits that ended a link reach the panel; failed reconnects are already disconnected.
	const linked = { connected: true, extensionVersion: undefined };
	const unlinked = { connected: false, extensionVersion: undefined };
	expect(relayStatuses(panelReceived!)).toEqual([linked, unlinked, linked, unlinked]);
});

it("gives the panel the relay's own page target id and the tab's CSS viewport", () => {
	const { sent, panelReceived } = runProbe({ scenario: "panel" });
	const response = panelReceived!.find(frame => frame.kind === "response" && frame.id === 3);
	expect(response).toMatchObject({
		ok: true,
		result: { tabId: 5, windowId: 1, url: "https://example.com/a", title: "A", groupId: -1, viewport: { width: 1024, height: 640 } },
	});
	const result = response?.result;
	const targetId =
		typeof result === "object" && result !== null && "targetId" in result && typeof result.targetId === "string"
			? result.targetId
			: "";
	expect(targetId).toMatch(/^PAGE[\w-]{8}\.5$/);

	// The relay lists the same tab under that id once this worker's hello reaches it.
	const hello = sent.find(frame => frame.t === "hello")!;
	const bridge = new RelayBridge({});
	const ext: RelaySocket = { send() {}, close() {} };
	bridge.extConnected(ext);
	bridge.extMessage(
		ext,
		JSON.stringify({
			...hello,
			tabs: [
				{
					tabId: 5,
					url: "https://example.com/a",
					title: "A",
					active: true,
					discarded: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			],
		}),
	);
	const cdpMessages: Array<{ id?: number; result?: { targetInfos?: Array<{ targetId: string }> } }> = [];
	const connId = bridge.cdpConnected({
		send(text) {
			cdpMessages.push(JSON.parse(text));
		},
		close() {},
	});
	bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: "Target.getTargets" }));
	const listed = cdpMessages.find(message => message.id === 1)?.result?.targetInfos?.map(info => info.targetId);
	expect(listed).toEqual([targetId]);
});

it("injects the overlay for a relay mount, draws input only where mounted, and hides nothing where none runs", () => {
	const { sent, tabMessages, injected } = runProbe({ scenario: "overlay" });
	expect(injected).toEqual([{ tabId: 5, files: ["overlay.js"] }]);
	expect(rpcResults(sent)).toEqual([
		{ t: "rpcResult", id: 1, ok: true, result: {} },
		{ t: "rpcResult", id: 2, ok: true, result: {} },
	]);
	expect(tabMessages!.filter(sent => sent.tabId === 5).map(sent => sent.message)).toEqual([
		{ omp: "overlay", op: "mount" },
		{ omp: "overlay", op: "mount" },
		{ omp: "overlay", op: "input", input: { kind: "move", x: 10, y: 20 } },
	]);
	expect(tabMessages!.filter(sent => sent.tabId === 6).map(sent => sent.message)).toEqual([
		{ omp: "overlay", op: "hide" },
	]);
});
