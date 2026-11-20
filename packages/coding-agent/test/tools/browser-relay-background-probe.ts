/**
 * Probe entry for browser-relay-background-bootstrap.test.ts, run in a fresh process per scenario (a failed top-level
 * evaluation stays cached in a module registry, and the worker keeps module state). It loads the stubs, then the
 * worker, opens the dialed socket, runs one scenario through the worker's own listeners, and prints what the relay,
 * the panel and the tabs saw. Scenario from the environment: `PROBE_DOWNLOADS`, `PROBE_FIND_DOWNLOAD`,
 * `PROBE_SCENARIO` (`storage`, `panel`, `overlay`).
 */
import { FakePort, FakeWebSocket, probe, stubLocalStorage } from "./browser-relay-background-stubs";

/**
 * The worker, loaded after the stubs. A non-literal specifier keeps it out of this package's type program: it is
 * typed against Chrome's and the DOM's types in `browser-relay`'s own.
 */
const WORKER: string = "../../../browser-relay/extension/background";
await import(WORKER);

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await Promise.resolve();
	await Bun.sleep(0);
	for (let tick = 0; tick < 50; tick++) await Promise.resolve();
}

function fire(name: string, ...args: unknown[]): void {
	for (const listener of probe.listeners[name] ?? []) (listener as (...values: unknown[]) => unknown)(...args);
}

function relaySays(message: Record<string, unknown>): void {
	probe.sockets.at(-1)?.onmessage?.({ data: JSON.stringify(message) });
}

await settle();
const socket = probe.sockets[0];
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
await settle();

const report: Record<string, unknown> = {};

switch (Bun.env.PROBE_SCENARIO) {
	case "storage": {
		// Writes that are not the connection settings: the worker's identity, another area, panel state.
		fire("storageChanged", { relayInstanceId: { newValue: "x" } }, "local");
		fire("storageChanged", { port: { newValue: 9300 } }, "session");
		fire("storageChanged", { "omp.settings": { newValue: {} } }, "local");
		await settle();
		report.socketsAfterOtherWrites = probe.sockets.length;
		await stubLocalStorage.set({ token: "secret" });
		fire("storageChanged", { token: { newValue: "secret" } }, "local");
		await settle();
		break;
	}
	case "panel": {
		const port = new FakePort("omp-panel");
		fire("runtimeOnConnect", port);
		port.deliver({ kind: "hello", windowId: 1 });
		port.deliver({ kind: "request", id: 1, request: { op: "collabHosts" } });
		await settle();
		const call = probe.sent.find(frame => frame.t === "call");
		relaySays({
			t: "callResult",
			id: call?.id,
			ok: true,
			result: [{ instanceId: "host-1", cwd: "/work" }],
		});
		// An answer for an id nobody asked about is dropped.
		relaySays({ t: "callResult", id: 999, ok: true, result: [] });
		port.deliver({ kind: "request", id: 2, request: { op: "collabLink", instanceId: "host-1" } });
		probe.tabs.set(5, {
			id: 5,
			windowId: 1,
			url: "https://example.com/a",
			title: "A",
			active: true,
			pinned: false,
			groupId: -1,
			width: 1280,
			height: 800,
		});
		probe.zoom = 1.25;
		port.deliver({ kind: "request", id: 3, request: { op: "tabContext", tabId: 5 } });
		await settle();
		// The socket closes with the collabLink call unanswered.
		probe.sockets[0].onclose?.();
		await settle();
		report.panelReceived = port.received;
		break;
	}
	case "overlay": {
		relaySays({ t: "rpc", id: 1, op: "overlay", tabId: 5, action: "mount" });
		await settle();
		relaySays({ t: "input", tabId: 5, input: { kind: "move", x: 10, y: 20 } });
		// Input for a tab the relay never mounted is not drawn.
		relaySays({ t: "input", tabId: 6, input: { kind: "move", x: 1, y: 2 } });
		relaySays({ t: "rpc", id: 2, op: "overlay", tabId: 6, action: "hide" });
		await settle();
		report.tabMessages = probe.tabMessages;
		report.injected = probe.injected;
		break;
	}
	default: {
		fire("tabsCreated", { id: 5, url: "https://example.com/", title: "Example", active: true });
		fire("debuggerOnEvent", { tabId: 5 }, "Page.loadEventFired", {});
		if (Bun.env.PROBE_FIND_DOWNLOAD === "1") {
			fire("debuggerOnEvent", { tabId: 1 }, "Page.downloadWillBegin", {
				guid: "g",
				url: "https://example.com/report.pdf",
			});
			relaySays({ t: "rpc", id: 1, op: "findDownload", guid: "g" });
			await settle();
		}
	}
}

console.log(
	JSON.stringify({
		urls: probe.sockets.map(candidate => candidate.url),
		sent: probe.sent,
		searchCalls: probe.searchCalls,
		...report,
	}),
);
