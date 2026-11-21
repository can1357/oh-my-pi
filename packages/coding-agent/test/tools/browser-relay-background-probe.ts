/**
 * Probe entry for browser-relay-background-bootstrap.test.ts, run in a fresh process per scenario (a failed top-level
 * evaluation stays cached in a module registry, and the worker keeps module state). It loads the stubs, then the
 * worker, links the native port it opened, runs one scenario through the worker's own listeners, and prints what the
 * host, the relay, the panel and the tabs saw. Scenario from the environment: `PROBE_DOWNLOADS`, `PROBE_FIND_DOWNLOAD`,
 * `PROBE_SCENARIO` (`panel`, `overlay`, `epoch`, `chunk`, `reconnect`).
 */
import { FakePort, probe } from "./browser-relay-background-stubs";

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

/** The worker's current port to the native host. */
function host() {
	const port = probe.nativePorts.at(-1);
	if (!port) throw new Error("the worker opened no native port");
	return port;
}

function relaySays(message: Record<string, unknown>): void {
	host().hostSays({ t: "relay", line: JSON.stringify(message) });
}

await settle();
const report: Record<string, unknown> = {};
// Nothing but the link request goes out before a relay listens.
report.postedBeforeLinked = [...host().posted];
host().hostSays({ t: "linked" });
await settle();

switch (Bun.env.PROBE_SCENARIO) {
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
		// The relay goes away with the collabLink call unanswered.
		host().hostSays({ t: "unlinked", reason: "omp relay went away" });
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
	case "epoch": {
		relaySays({ t: "rpc", id: 1, op: "findDownload", guid: "g" });
		// The relay goes away and the next one links before the RPC settles: its answer must not reach the new relay.
		host().hostSays({ t: "unlinked", reason: "omp relay went away" });
		host().hostSays({ t: "linked" });
		await settle();
		relaySays({ t: "rpc", id: 2, op: "findDownload", guid: "g" });
		await settle();
		break;
	}
	case "chunk": {
		const line = JSON.stringify({ t: "rpc", id: 1, op: "findDownload", guid: "g" });
		const third = Math.ceil(line.length / 3);
		host().hostSays({ t: "chunk", id: 9, index: 0, last: false, data: line.slice(0, third) });
		// A whole line between the pieces is its own message.
		relaySays({ t: "rpc", id: 2, op: "findDownload", guid: "g" });
		host().hostSays({ t: "chunk", id: 9, index: 1, last: false, data: line.slice(third, 2 * third) });
		host().hostSays({ t: "chunk", id: 9, index: 2, last: true, data: line.slice(2 * third) });
		await settle();
		break;
	}
	case "reconnect": {
		// Hold reconnect timers for the probe to fire. Anything else runs as usual but unref'd: the alarm's connect
		// arms a 15s link deadline that never comes due here and would hold the probe open long after it reported.
		const timers: Array<{ delay: number; run: () => void }> = [];
		const realSetTimeout = globalThis.setTimeout;
		const holdReconnects = (run: () => void, delay?: number): NodeJS.Timeout => {
			if (delay !== undefined && delay >= 1_000 && delay <= 10_000) {
				timers.push({ delay, run });
				return 0 as unknown as NodeJS.Timeout;
			}
			return realSetTimeout(run, delay).unref();
		};
		globalThis.setTimeout = holdReconnects as unknown as typeof setTimeout;
		const panel = new FakePort("omp-panel");
		fire("runtimeOnConnect", panel);
		panel.deliver({ kind: "hello", windowId: 1 });
		await settle();
		// The host exits six times in a row without linking, then links once and exits again.
		for (let exit = 0; exit < 7; exit++) {
			if (exit === 6) {
				host().hostSays({ t: "linked" });
				await settle();
			}
			host().hostExits();
			await settle();
			if (exit < 6) timers.at(-1)?.run();
		}
		// The keepalive alarm reconnects at once, without waiting out the backoff.
		const portsBeforeAlarm = probe.nativePorts.length;
		fire("alarm", { name: "omp-relay-keepalive" });
		await settle();
		report.reconnectDelays = timers.map(timer => timer.delay);
		report.portsBeforeAlarm = portsBeforeAlarm;
		report.panelReceived = panel.received;
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
		linkRequests: probe.nativePorts.map(port => ({ host: port.host, first: port.posted[0] })),
		sent: probe.sent,
		searchCalls: probe.searchCalls,
		...report,
	}),
);
