/**
 * Probe entry for browser-relay-background-bootstrap.test.ts, run in a fresh process per scenario
 * (a failed top-level evaluation stays cached in a module registry). It loads the stubs, then the
 * worker, opens the dialed socket, forwards a tab and a debugger event through the worker's own
 * listeners, plays any `findDownload` RPCs the scenario asks for, and prints what the relay saw.
 * Scenario comes from the environment: `PROBE_DOWNLOADS`, `PROBE_RPCS`.
 */
import { FakeWebSocket, probe } from "./browser-relay-background-stubs";
import "../../../browser-relay/extension/background";

interface Rpc {
	id: number;
	guid: string;
	forget?: boolean;
	interrupted?: boolean;
}

const rpcs: Rpc[] = JSON.parse(Bun.env.PROBE_RPCS ?? "[]");
if (rpcs.length > 0) probe.downloadItemState = "in_progress";

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

if (rpcs.length > 0) {
	const downloadUrl = "https://example.com/report.pdf";
	probe.listeners.debuggerOnEvent[0]({ tabId: 1 }, "Page.downloadWillBegin", { guid: "g", url: downloadUrl });
	probe.listeners.downloadsOnCreated?.[0]({ id: 7, finalUrl: downloadUrl });
}
for (const rpc of rpcs) {
	if (rpc.forget) probe.downloadItemState = "complete";
	socket.onmessage?.({ data: JSON.stringify({ t: "rpc", id: rpc.id, op: "findDownload", guid: rpc.guid }) });
	await settle();
	if (rpc.interrupted) probe.listeners.downloadsOnChanged[0]({ id: 7, state: { current: "interrupted" } });
	await settle();
}

console.log(
	JSON.stringify({
		urls: probe.sockets.map(candidate => candidate.url),
		sent: probe.sent,
		searchCalls: probe.searchCalls,
	}),
);
