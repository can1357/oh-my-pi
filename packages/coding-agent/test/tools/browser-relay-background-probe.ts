/**
 * Probe entry for browser-relay-background-bootstrap.test.ts, run in a fresh process per scenario
 * (a failed top-level evaluation stays cached in a module registry). It loads the stubs, then the
 * worker, opens the dialed socket, forwards a tab and a debugger event through the worker's own
 * listeners, optionally asks for a reported download, and prints what the relay saw.
 * Scenario comes from the environment: `PROBE_DOWNLOADS`, `PROBE_FIND_DOWNLOAD`.
 */
import { FakeWebSocket, probe } from "./browser-relay-background-stubs";
import "../../../browser-relay/extension/background";

async function settle(): Promise<void> {
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

await settle();
const socket = probe.sockets[0];
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
await settle();

probe.listeners.tabsCreated[0]({ id: 5, url: "https://example.com/", title: "Example", active: true });
probe.listeners.debuggerOnEvent[0]({ tabId: 5 }, "Page.loadEventFired", {});

if (Bun.env.PROBE_FIND_DOWNLOAD === "1") {
	probe.listeners.debuggerOnEvent[0]({ tabId: 1 }, "Page.downloadWillBegin", {
		guid: "g",
		url: "https://example.com/report.pdf",
	});
	socket.onmessage?.({ data: JSON.stringify({ t: "rpc", id: 1, op: "findDownload", guid: "g" }) });
	await settle();
}

console.log(
	JSON.stringify({
		urls: probe.sockets.map(candidate => candidate.url),
		sent: probe.sent,
		searchCalls: probe.searchCalls,
	}),
);
