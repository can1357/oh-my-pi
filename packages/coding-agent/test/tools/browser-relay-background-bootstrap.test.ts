import { expect, it } from "bun:test";

const PROBE = `${import.meta.dir}/browser-relay-background-probe.ts`;

interface Frame {
	t: string;
	[key: string]: unknown;
}

interface ProbeReport {
	urls: string[];
	sent: Frame[];
	searchCalls: unknown[];
}

function runProbe(
	downloads: boolean,
	rpcs: Array<{ id: number; guid: string; forget?: boolean; interrupted?: boolean }> = [],
): ProbeReport {
	const proc = Bun.spawnSync([process.execPath, PROBE], {
		env: { ...Bun.env, PROBE_DOWNLOADS: downloads ? "1" : "0", PROBE_RPCS: JSON.stringify(rpcs) },
	});
	expect(proc.exitCode, proc.stderr.toString()).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

/** The relay replies in the probe's sent frames, after the hello. */
function rpcResults(sent: Frame[]): Frame[] {
	return sent.filter(frame => frame.t === "rpcResult");
}

it("survives a browser that never exposed chrome.downloads: still dials the relay and forwards tab and debugger events", () => {
	const { urls, sent } = runProbe(false);
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

it("advertises the downloads capability when the downloads API exists", () => {
	const { urls, sent } = runProbe(true);
	expect(urls).toEqual(["ws://127.0.0.1:9224/ext"]);
	expect(sent.find(frame => frame.t === "hello")).toMatchObject({ downloadsProtocol: 1 });
});

it("answers a findDownload RPC without touching the missing downloads API", () => {
	const { sent, searchCalls } = runProbe(false, [{ id: 1, guid: "g" }]);
	// The search-call assertion is the guard's own: the null result alone also holds without it, since
	// nothing can pair a download id while the API (and its onCreated listener) is absent.
	expect(searchCalls).toEqual([]);
	expect(rpcResults(sent)).toEqual([{ t: "rpcResult", id: 1, ok: true, result: null }]);
});

it("pairs a CDP download report with the downloads item and forgets it once the item completes", () => {
	const { sent, searchCalls } = runProbe(true, [
		{ id: 1, guid: "g" },
		{ id: 2, guid: "g", forget: true },
		{ id: 3, guid: "g" },
	]);
	expect(searchCalls).toEqual([{ id: 7 }, { id: 7 }]);
	expect(rpcResults(sent)).toEqual([
		{ t: "rpcResult", id: 1, ok: true, result: { filename: "/tmp/report.pdf", state: "in_progress" } },
		{ t: "rpcResult", id: 2, ok: true, result: { filename: "/tmp/report.pdf", state: "complete" } },
		{ t: "rpcResult", id: 3, ok: true, result: null },
	]);
});

it("drops a running pair the moment its download reports interrupted over onChanged", () => {
	const { sent, searchCalls } = runProbe(true, [
		{ id: 1, guid: "g", interrupted: true },
		{ id: 2, guid: "g" },
	]);
	// The onChanged listener forgets the pair before the second lookup: no search, null result.
	expect(searchCalls).toEqual([{ id: 7 }]);
	expect(rpcResults(sent)).toEqual([
		{ t: "rpcResult", id: 1, ok: true, result: { filename: "/tmp/report.pdf", state: "in_progress" } },
		{ t: "rpcResult", id: 2, ok: true, result: null },
	]);
});
