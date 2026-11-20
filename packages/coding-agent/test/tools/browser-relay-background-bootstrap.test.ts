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
	urls: string[];
	sent: Frame[];
	searchCalls: unknown[];
	socketsAfterOtherWrites?: number;
	panelReceived?: PanelFrame[];
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

it("survives a browser that never exposed chrome.downloads: still dials the relay and forwards tab and debugger events", () => {
	const { urls, sent } = runProbe();
	expect(urls).toEqual(["ws://127.0.0.1:9224/ext"]);
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
	const { urls, sent } = runProbe({ downloads: true });
	expect(urls).toEqual(["ws://127.0.0.1:9224/ext"]);
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

it("re-dials the relay only when the local port or token changes", () => {
	const { urls, socketsAfterOtherWrites } = runProbe({ scenario: "storage" });
	expect(socketsAfterOtherWrites).toBe(1);
	expect(urls).toEqual(["ws://127.0.0.1:9224/ext", "ws://127.0.0.1:9224/ext?token=secret"]);
});

it("forwards panel calls to the relay, answers them by id, and fails them when the socket closes", () => {
	const { sent, panelReceived } = runProbe({ scenario: "panel" });
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
		error: "omp relay disconnected",
	});
	// Each request is answered once; the stray callResult answered nothing.
	expect(responses.map(frame => frame.id).sort()).toEqual([1, 2, 3]);
	// The panel hears the relay drop.
	expect(panelReceived).toContainEqual({
		kind: "event",
		event: { event: "relay", status: { connected: false, port: 9224, extensionVersion: undefined } },
	});
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
