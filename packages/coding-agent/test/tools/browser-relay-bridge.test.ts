import { describe, expect, it, jest } from "bun:test";
import { createHash } from "node:crypto";
import { closeRelayTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import type { CDPSession } from "puppeteer-core";

/** Same derivation as the bridge: target ids embed this per-instance code. */
function instanceCode(instanceId: string): string {
	return createHash("sha256").update(instanceId).digest("base64url").slice(0, 8);
}

const ANON = instanceCode("anon");

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	closed = false;
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {
		this.closed = true;
	}
	rpcs<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter((msg): msg is ExtRpc<Op> => msg.t === "rpc" && msg.op === op);
	}
	/** RPC requests of `op` not yet answered through {@link ack}. */
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.rpcs(op).filter(msg => !this.#acked.has(msg.id));
	}
	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

/** Downstream puppeteer-side socket capturing bridge emissions. */
class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
	sessionFor(commandId: number): string | undefined {
		const msg = this.messages.find(m => m.id === commandId);
		const result = msg && "result" in msg && msg.result && typeof msg.result === "object" ? msg.result : undefined;
		return result && "sessionId" in result && typeof result.sessionId === "string" ? result.sessionId : undefined;
	}
	/** Session ids the bridge announced through `Target.attachedToTarget`. */
	attachedSessions(): string[] {
		const out: string[] = [];
		for (const msg of this.messages) {
			if (msg.method !== "Target.attachedToTarget") continue;
			const params = msg.params;
			if (params && typeof params === "object" && "sessionId" in params && typeof params.sessionId === "string") {
				out.push(params.sessionId);
			}
		}
		return out;
	}
}

function tab(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		discarded: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function connect(bridge: RelayBridge, socket: FakeExtSocket, tabs: TabSnapshot[], attachedTabIds: number[] = []): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			discardedTabsProtocol: 1,
			tabs,
			attachedTabIds,
		}),
	);
}

function connectInstance(
	bridge: RelayBridge,
	socket: FakeExtSocket,
	instanceId: string,
	tabs: TabSnapshot[],
	attachedTabIds: number[] = [],
	browserSession?: string,
): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			instanceId,
			browserSession,
			userAgent: "test",
			browserVersion: instanceId === "edge" ? "Edg/151.0.0.0" : "Chrome/151.0.0.0",
			discardedTabsProtocol: 1,
			tabs,
			attachedTabIds,
		}),
	);
}

/** Answer every unanswered extension RPC of `op` with `ok: true` and `result`. */
function ack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

/** Fail every unanswered extension RPC of `op` with `ok: false`. */
function nack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], error = "rpc failed"): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: false, error }));
	}
}

/** Drain chained extension RPC, auto-attach, and response continuations without timers. */
async function flush(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

let msgSeq = 100;

/** Attach to a tab's page target and return the minted page session id. */
async function attachPage(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
	instanceId = "anon",
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${instanceCode(instanceId)}.${tabId}`, flatten: true },
		}),
	);
	ack(bridge, ext, "attach");
	await flush();
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

/**
 * Emulate the omp tab worker adopting a tab: attach to its page target, then
 * claim it as this connection's drive target.
 */
async function claimTab(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<void> {
	const sessionId = await attachPage(bridge, ext, cdp, connId, tabId);
	bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "OMP.claimTarget" }));
	await flush();
}

describe("RelayBridge target discovery", () => {
	it("enumerates current eligible pages without attaching or claiming tabs", () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [
			tab({ tabId: 1 }),
			tab({ tabId: 2, url: "about:blank" }),
			tab({ tabId: 3, url: "chrome://extensions/" }),
		]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: "Target.getTargets" }));
		const first = cdp.messages.find(message => message.id === 1)?.result as
			| { targetInfos: Array<{ targetId: string; type: string }> }
			| undefined;
		expect(first?.targetInfos.map(info => [info.targetId, info.type]).sort()).toEqual([
			[`PAGE${ANON}.1`, "page"],
			[`PAGE${ANON}.2`, "page"],
		]);
		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 2 }));
		bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: "Target.getTargets" }));
		const second = cdp.messages.find(message => message.id === 2)?.result as
			| { targetInfos: Array<{ targetId: string }> }
			| undefined;
		expect(second?.targetInfos.map(info => info.targetId)).toEqual([`PAGE${ANON}.1`]);
		expect(ext.messages.filter(message => message.t === "rpc")).toEqual([]);
	});
});

describe("RelayBridge tab grouping", () => {
	it("groups nothing on hello or tab lifecycle events — only claimed tabs join the omp group", () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const socket = new FakeExtSocket();
		connect(bridge, socket, [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3, url: "about:blank" })]);
		bridge.extMessage(socket, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 9 }) }));
		expect(socket.rpcs("group")).toHaveLength(0);
	});

	it("never groups from command traffic: a discovery scan sending page commands to every tab is not driving", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// pickElectronTarget materializes every discovered page, which makes
		// puppeteer send Page.enable/Page.getFrameTree to all of them.
		for (const tabId of [1, 2]) {
			const sessionId = await attachPage(bridge, ext, cdp, connId, tabId);
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.enable" }));
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.getFrameTree" }));
		}
		await flush();
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("groups exactly the tab a client claims", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
		expect(groups[0]!.title).toBe("omp");
		expect(groups[0]!.color).toBe("cyan");
	});

	it("never groups pinned tabs or tabs in a user group, even when claimed", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 3, pinned: true }), tab({ tabId: 4, groupId: 77 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 3);
		await claimTab(bridge, ext, cdp, connId, 4);
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("does not issue group RPCs when grouping is disabled", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("closes a tab Target.createTarget made for a client that disconnected before it opened", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: { url: "https://example.com/" } }),
		);
		bridge.cdpClosed(connId);
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
		await flush();
		expect(ext.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([9]);
	});

	it("auto-claims a tab created through Target.createTarget", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: { url: "https://example.com/" } }),
		);
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
		await flush();
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([9]);
	});

	it("fails Target.createTarget with Chrome's refusal and closes the tab when the new tab cannot be attached", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: {} }));
		await flush();
		const createId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: createId, method: "Target.createTarget", params: { url: "about:blank" } }),
		);
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 9, url: "about:blank" }) });
		await flush();
		// Chrome 155+ under an ExtensionSettings runtime_blocked_hosts policy refuses every chrome.debugger.attach.
		nack(bridge, ext, "attach", "Host access is restricted by policy.");
		await flush();
		expect(ext.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([9]);
		ack(bridge, ext, "removeTab");
		await flush();
		const reply = cdp.messages.find(m => m.id === createId);
		expect(reply).toMatchObject({
			error: { message: expect.stringContaining("Host access is restricted by policy.") },
		});
	});

	it("creates a Target.createTarget background tab without selecting it", () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.createTarget",
				params: { url: "https://example.com/", background: true },
			}),
		);
		const [create] = ext.rpcs("createTab");
		expect(create).toMatchObject({ url: "https://example.com/", active: false });
	});

	it.each([
		{ params: { url: "https://example.com/" } },
		{ params: { url: "https://example.com/", background: false } },
	])("leaves createTab selection to Chrome for Target.createTarget $params", ({ params }) => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params }));
		const [create] = ext.rpcs("createTab");
		expect(create).toMatchObject({ url: "https://example.com/" });
		expect(create).not.toHaveProperty("active");
	});

	it("never re-groups a tab the user pulled out of the omp group", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		// Chrome reports the grouping we just made — no opt-out.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: 42 }) }));
		// The user drags the tab out of the group.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1 }) }));
		// A later navigation on the still-claimed tab must not re-group it.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1, url: "https://example.com/other" }) }),
		);
		expect(ext.rpcs("group")).toHaveLength(1);
	});

	it("ungroups when the claiming client disconnects, even while another connection still holds sessions", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab, never claims it.
		const registry = new FakeCdpSocket();
		const registryConn = bridge.cdpConnected(registry);
		await attachPage(bridge, ext, registry, registryConn, 1);
		// Worker connection: claims the tab.
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		await claimTab(bridge, ext, worker, workerConn, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		bridge.cdpClosed(workerConn);
		const ungroups = ext.rpcs("ungroup");
		expect(ungroups).toHaveLength(1);
		expect(ungroups[0]!.tabIds).toEqual([1]);
	});

	it("never overlaps group RPCs: a tab claimed mid-flight waits for the pending group", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		expect(ext.rpcs("group")).toHaveLength(1);
		// Concurrent group RPCs race Chrome's non-atomic query→create→set-title
		// and mint duplicate "omp" groups; the second request must queue.
		await claimTab(bridge, ext, cdp, connId, 2);
		expect(ext.rpcs("group")).toHaveLength(1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(2);
		expect(groups[1]!.tabIds).toEqual([2]);
	});

	it("regroups claimed tabs after an extension reconnect instead of treating the dissolve as user opt-out", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		// Relay/extension link drops: the extension dissolves the omp group on
		// disconnect, so the next hello reports groupId -1 for every tab.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })]);
		const groups = ext2.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
	});
});

describe("RelayBridge child targets", () => {
	async function armAutoAttach(
		bridge: RelayBridge,
		ext: FakeExtSocket,
		connId: number,
		sessionId: string,
		outcome: "ok" | "fail" = "ok",
	): Promise<void> {
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			}),
		);
		if (outcome === "ok") ack(bridge, ext, "send");
		else nack(bridge, ext, "send", "Target.setAutoAttach failed");
		await flush();
	}

	const ATTACH = {
		method: "Target.attachedToTarget",
		params: { sessionId: "CHILD1", targetInfo: { targetId: "FRAME1", type: "iframe" } },
	};
	const NAVIGATE = { sessionId: "CHILD1", method: "Page.frameNavigated", params: {} };
	const DETACH = { method: "Target.detachedFromTarget", params: { sessionId: "CHILD1" } };

	function emit(bridge: RelayBridge, ext: FakeExtSocket, ...events: object[]): void {
		for (const event of events) bridge.extMessage(ext, JSON.stringify({ t: "cdpEvent", tabId: 1, ...event }));
	}

	function childTraffic(socket: FakeCdpSocket): Array<[unknown, unknown]> {
		return socket.messages
			.filter(
				m => m.sessionId === "CHILD1" || (m.params as { sessionId?: string } | undefined)?.sessionId === "CHILD1",
			)
			.map(m => [m.method, m.sessionId]);
	}

	const lifecycleOn = (sessionId: string): Array<[string, string]> => [
		["Target.attachedToTarget", sessionId],
		["Page.frameNavigated", "CHILD1"],
		["Target.detachedFromTarget", sessionId],
	];

	it("announces a real child target only to the page session that armed auto-attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const armed = await attachPage(bridge, ext, cdp, conn, 1);
		await armAutoAttach(bridge, ext, conn, armed);
		await attachPage(bridge, ext, cdp, conn, 1);
		const otherCdp = new FakeCdpSocket();
		await attachPage(bridge, ext, otherCdp, bridge.cdpConnected(otherCdp), 1);

		emit(bridge, ext, ATTACH, NAVIGATE, DETACH);

		expect(childTraffic(cdp)).toEqual(lifecycleOn(armed));
		expect(childTraffic(otherCdp)).toEqual([]);
	});

	it("keeps a child on the first armed session of its connection, even after that session is released", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const first = await attachPage(bridge, ext, cdp, conn, 1);
		await armAutoAttach(bridge, ext, conn, first);
		const second = await attachPage(bridge, ext, cdp, conn, 1);
		await armAutoAttach(bridge, ext, conn, second);

		emit(bridge, ext, ATTACH);
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: first } }),
		);
		await flush();
		emit(bridge, ext, NAVIGATE, DETACH);

		expect(childTraffic(cdp)).toEqual(lifecycleOn(first));
	});

	it("does not report children to a session whose Target.setAutoAttach failed", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Another connection already armed the tab, so Chrome will report children.
		const otherCdp = new FakeCdpSocket();
		const other = bridge.cdpConnected(otherCdp);
		const otherSession = await attachPage(bridge, ext, otherCdp, other, 1);
		await armAutoAttach(bridge, ext, other, otherSession);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const failed = await attachPage(bridge, ext, cdp, conn, 1);
		await armAutoAttach(bridge, ext, conn, failed, "fail");

		emit(bridge, ext, ATTACH, NAVIGATE, DETACH);

		expect(childTraffic(cdp)).toEqual([]);
		expect(childTraffic(otherCdp)).toEqual(lifecycleOn(otherSession));
	});

	const NESTED_ATTACH = {
		sessionId: "CHILD1",
		method: "Target.attachedToTarget",
		params: { sessionId: "CHILD2", targetInfo: { targetId: "FRAME2", type: "iframe" } },
	};

	/** Bridge output from `start` on, as [method or "reply", session, announced child]. */
	function trafficSince(socket: FakeCdpSocket, start: number): Array<[unknown, unknown, unknown]> {
		return socket.messages
			.slice(start)
			.map(m => [m.method ?? "reply", m.sessionId, (m.params as { sessionId?: string } | undefined)?.sessionId]);
	}

	it("tells a connection that arms auto-attach late about the children Chrome already reported", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const firstCdp = new FakeCdpSocket();
		const first = bridge.cdpConnected(firstCdp);
		await armAutoAttach(bridge, ext, first, await attachPage(bridge, ext, firstCdp, first, 1));
		emit(bridge, ext, ATTACH);
		await armAutoAttach(bridge, ext, first, "CHILD1");
		emit(bridge, ext, NESTED_ATTACH);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const late = await attachPage(bridge, ext, cdp, conn, 1);
		const start = cdp.messages.length;

		await armAutoAttach(bridge, ext, conn, late);
		await armAutoAttach(bridge, ext, conn, "CHILD1");
		emit(bridge, ext, NAVIGATE, DETACH);

		// Each child arrives before the reply to the arm that covers it, as Chrome sends it.
		expect(trafficSince(cdp, start)).toEqual([
			["Target.attachedToTarget", late, "CHILD1"],
			["reply", late, undefined],
			["Target.attachedToTarget", "CHILD1", "CHILD2"],
			["reply", "CHILD1", undefined],
			["Page.frameNavigated", "CHILD1", undefined],
			["Target.detachedFromTarget", late, "CHILD1"],
		]);
	});

	it("does not tell a later connection about children that ended with the debugger attachment", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const firstCdp = new FakeCdpSocket();
		const first = bridge.cdpConnected(firstCdp);
		const firstSession = await attachPage(bridge, ext, firstCdp, first, 1);
		await armAutoAttach(bridge, ext, first, firstSession);
		emit(bridge, ext, ATTACH);
		// Releasing the only session drops the attachment, and Chrome ends its children with it.
		bridge.cdpMessage(
			first,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: firstSession } }),
		);
		ack(bridge, ext, "detach");
		await flush();
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const late = await attachPage(bridge, ext, cdp, conn, 1);

		await armAutoAttach(bridge, ext, conn, late);

		expect(childTraffic(cdp)).toEqual([]);
	});

	it("detaches children from connections still holding the tab when the extension lost its attachment", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const session = await attachPage(bridge, ext, cdp, conn, 1);
		await armAutoAttach(bridge, ext, conn, session);
		emit(bridge, ext, ATTACH);
		await armAutoAttach(bridge, ext, conn, "CHILD1");
		emit(bridge, ext, NESTED_ATTACH);
		const start = cdp.messages.length;

		// A service-worker restart reconnects without the tab's debugger attachment.
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1 })]);
		await flush();

		expect(trafficSince(cdp, start).filter(([method]) => method === "Target.detachedFromTarget")).toEqual([
			["Target.detachedFromTarget", "CHILD1", "CHILD2"],
			["Target.detachedFromTarget", session, "CHILD1"],
		]);
	});
});

describe("RelayBridge Runtime sessions", () => {
	it("virtualizes Runtime enable state for each pseudo-session", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Runtime.enable" }));
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const context = {
			context: {
				id: 17,
				origin: "https://example.com",
				name: "",
				uniqueId: "context-17",
				auxData: { isDefault: true, type: "default", frameId: "frame-1" },
			},
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext, "send");
		await flush();

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);
		const runtimeSendCount = ext.rpcs("send").length;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.enable" }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([context]);

		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.disable" }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const nextContext = {
			context: { ...context.context, id: 18, uniqueId: "context-18" },
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: nextContext }),
		);
		const firstContexts = first.messages.filter(
			message => message.sessionId === firstSession && message.method === "Runtime.executionContextCreated",
		);
		expect(firstContexts.map(message => message.params)).toEqual([context, nextContext]);
		expect(
			second.messages.filter(
				message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(contexts);
	});

	it("keeps a pipelined Runtime.disable authoritative while root enable completes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await flush();

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const context = { context: { id: 19 } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext, "send");
		await flush();

		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual([]);
	});
	it("refreshes Runtime contexts after the extension reconnects", async () => {
		const bridge = new RelayBridge({});
		const firstExt = new FakeExtSocket();
		connect(bridge, firstExt, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, firstExt, first, firstConn, 1);
		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Runtime.enable" }));
		await flush();
		ack(bridge, firstExt, "send");
		await flush();
		const staleContext = { context: { id: 17 } };
		bridge.extMessage(
			firstExt,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: staleContext,
			}),
		);
		ack(bridge, firstExt, "send");
		await flush();

		bridge.extClosed(firstExt);
		const nextExt = new FakeExtSocket();
		bridge.extConnected(nextExt);
		bridge.extMessage(
			nextExt,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				discardedTabsProtocol: 1,
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [1],
			}),
		);

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, nextExt, second, secondConn, 1);
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.enable" }),
		);
		await flush();
		expect(nextExt.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, nextExt, "send");
		await flush();
		expect(nextExt.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const currentContext = { context: { id: 18 } };
		bridge.extMessage(
			nextExt,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: currentContext,
			}),
		);
		ack(bridge, nextExt, "send");
		await flush();

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([currentContext]);
	});
});

describe("RelayBridge attachment release", () => {
	it("keeps a tab Chrome detached on its own adoptable, but bans it after the user cancels the debugging bar", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: {} }));
		await flush();
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		const created = () =>
			cdp.messages.filter(
				m => m.method === "Target.targetCreated" && JSON.stringify(m.params).includes(`"PAGE${ANON}.1"`),
			).length;
		expect(created()).toBe(1);

		// Another extension's frame started loading in the tab: Chrome drops the debugger on its own.
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		await flush();
		expect(
			cdp.messages.some(
				m =>
					m.method === "Target.detachedFromTarget" &&
					m.params !== null &&
					typeof m.params === "object" &&
					"sessionId" in m.params &&
					m.params.sessionId === sessionId,
			),
		).toBe(true);
		// Announced again at once and still listed, so an open can adopt the same tab.
		expect(created()).toBe(2);
		expect(bridge.listTargets().map(t => t.id)).toEqual([`PAGE${ANON}.1`]);
		const readopted = await attachPage(bridge, ext, cdp, connId, 1);
		expect(readopted).not.toBe(sessionId);

		// The user pressing Cancel on the debugging bar is a refusal: the tab is hidden until it navigates.
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "canceled_by_user" }));
		await flush();
		expect(created()).toBe(2);
		expect(bridge.listTargets()).toEqual([]);
		const refusedId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: refusedId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		expect(ext.pending("attach")).toEqual([]);
		expect(cdp.messages.some(m => m.id === refusedId && "error" in m)).toBe(true);
	});

	it("tells the driving session why Chrome detached before failing its command in flight", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		const clickId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: clickId,
				sessionId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mousePressed" },
			}),
		);
		await flush();

		// Chrome answers the command in flight before it reports the detach.
		nack(bridge, ext, "send", "Detached while handling command.");
		await flush();
		expect(cdp.messages.some(m => m.id === clickId)).toBe(false);
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		await flush();
		const told = cdp.messages.findIndex(m => m.method === "OMP.debuggerDetached" && m.sessionId === sessionId);
		expect(told).toBeGreaterThanOrEqual(0);
		expect(cdp.messages.findIndex(m => m.id === clickId && "error" in m)).toBeGreaterThan(told);
	});

	it("neither reports nor re-announces the detach of a tab the relay is closing", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: {} }));
		await flush();
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		const created = () =>
			cdp.messages.filter(
				m => m.method === "Target.targetCreated" && JSON.stringify(m.params).includes(`"PAGE${ANON}.1"`),
			).length;
		const closeId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: closeId,
				sessionId,
				method: "Target.closeTarget",
				params: { targetId: `PAGE${ANON}.1` },
			}),
		);
		await flush();
		expect(ext.pending("removeTab").map(r => r.tabId)).toEqual([1]);

		// Chrome reports the debugger detach of the closing tab before its removal.
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		await flush();
		expect(cdp.messages.some(m => m.method === "OMP.debuggerDetached")).toBe(false);
		expect(created()).toBe(1);
		ack(bridge, ext, "removeTab");
		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		await flush();
		expect(cdp.messages.some(m => m.id === closeId && "result" in m)).toBe(true);
		expect(bridge.listTargets()).toEqual([]);
	});

	it("detaches cleanly on explicit last-session release and permits reattachment", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);

		// Mirror Chrome: onDetach reaches the bridge before detach's RPC result.
		// This echo is expected and must not ban/retract the live target.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
		expect(cdp.messages.some(message => message.method === "Target.targetDestroyed")).toBe(false);
	});

	it("serializes immediate reattachment behind the detach RPC and its echo", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		// Only the initial attach has reached the extension while detach is pending.
		expect(ext.rpcs("attach")).toHaveLength(1);

		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();
		expect(ext.rpcs("attach")).toHaveLength(2);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("reuses an existing debugger attachment for a second connection", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const registry = new FakeCdpSocket();
		await attachPage(bridge, ext, registry, bridge.cdpConnected(registry), 1);
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		const attachId = ++msgSeq;
		bridge.cdpMessage(
			workerConn,
			JSON.stringify({ id: attachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		// Chrome rejects debugger.attach on an already attached tab; the bridge must not ask again.
		nack(bridge, ext, "attach", "Another debugger is already attached to the tab with id: 1.");
		await flush();
		expect(ext.rpcs("attach")).toHaveLength(1);
		expect(worker.sessionFor(attachId)).toBeDefined();
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.1`]);
	});

	it("keeps the attachment while another connection still holds a session on the tab", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab throughout.
		const registry = new FakeCdpSocket();
		const registryConn = bridge.cdpConnected(registry);
		await attachPage(bridge, ext, registry, registryConn, 1);
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		const sessionId = await attachPage(bridge, ext, worker, workerConn, 1);
		bridge.cdpMessage(
			workerConn,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach")).toHaveLength(0);
	});

	it("detaches once the tab session released alongside the page session leaves no holder", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// setAutoAttach mints a tab session; attachToTarget adds a page session.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		ack(bridge, ext, "attach");
		await flush();
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		const tabSession = cdp.attachedSessions().find(id => id !== pageSession);
		if (!tabSession) throw new Error("setAutoAttach did not mint a tab session");
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: pageSession } }),
		);
		await flush();
		// The tab session still holds the attachment.
		expect(ext.rpcs("detach")).toHaveLength(0);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: tabSession } }),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("retracts held sessions when reconnect reattachment fails", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		expect(replacement.pending("attach")).toHaveLength(1);
		nack(bridge, replacement, "attach", "debugger unavailable");
		await flush();

		const detached = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === sessionId,
		);
		expect(detached).toBeDefined();
	});

	it("reconciles a delayed detach after replacement hello still reports the old attachment", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], [1]);
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("does not ban a tab when its in-flight attach is interrupted by extension replacement", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		expect(ext.pending("attach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		await flush();

		const retryId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: retryId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(retryId)).toBeDefined();
	});

	it("clears an in-flight detach immediately when the extension socket is replaced", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.pending("detach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();

		// Reattachment reaches the replacement immediately; it does not wait
		// for the old socket's unreachable detach result or its 20s timeout.
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		const replacementSession = cdp.sessionFor(reattachId);
		expect(replacementSession).toBeDefined();

		// The old chrome.debugger.detach finishes after replacement attach and
		// sends its callback through the new global extension socket. Correlation
		// must survive the rejected RPC so this cannot retract the new session.
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();
		const replacementDetach = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === replacementSession,
		);
		expect(replacementDetach).toBeUndefined();

		// A later genuine user cancellation has no relay attribution and must
		// still retract the replacement session.
		bridge.extMessage(replacement, JSON.stringify({ t: "detached", tabId: 1, reason: "canceled_by_user" }));
		await flush();
		const userDetach = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === replacementSession,
		);
		expect(userDetach).toBeDefined();
	});

	it("still fans root Runtime events out to a session that never enabled the domain", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// omp's own patched-puppeteer client pull-acquires contexts and never
		// sends Runtime.enable, yet still waits on executionContextCreated.
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const context = { context: { id: 42, uniqueId: "context-42" } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);

		const received = cdp.messages.filter(
			message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
		);
		expect(received.map(message => message.params)).toEqual([context]);

		// An explicit disable silences the same session — a later re-emit is dropped.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		await flush();
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(received);
	});

	it("holds a pipelined duplicate Runtime.enable until the in-flight enable settles", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const enable1 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable1, sessionId, method: "Runtime.enable" }));
		await flush();
		const enable2 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable2, sessionId, method: "Runtime.enable" }));
		await flush();

		// Root disable/enable cycle still pending: neither caller may be acked.
		expect(cdp.messages.filter(message => message.id === enable1 || message.id === enable2)).toEqual([]);

		ack(bridge, ext, "send"); // Runtime.disable leg
		await flush();
		ack(bridge, ext, "send"); // Runtime.enable leg
		await flush();

		expect(cdp.messages.filter(message => message.id === enable1 && "result" in message)).toHaveLength(1);
		expect(cdp.messages.filter(message => message.id === enable2 && "result" in message)).toHaveLength(1);
	});

	it("fails a pipelined duplicate Runtime.enable when the root enable fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const enable1 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable1, sessionId, method: "Runtime.enable" }));
		await flush();
		const enable2 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable2, sessionId, method: "Runtime.enable" }));
		await flush();

		// The first leg of the root cycle fails: both callers must observe it.
		nack(bridge, ext, "send");
		await flush();

		expect(cdp.messages.filter(message => message.id === enable1 && "error" in message)).toHaveLength(1);
		expect(cdp.messages.filter(message => message.id === enable2 && "error" in message)).toHaveLength(1);
		expect(
			cdp.messages.filter(message => (message.id === enable1 || message.id === enable2) && "result" in message),
		).toEqual([]);
	});

	it("preserves the latest disable when an older and newer enable both fail", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		const latestEnable = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: latestEnable, sessionId, method: "Runtime.enable" }));
		await flush();

		nack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === latestEnable && "error" in message)).toHaveLength(1);

		const context = { context: { id: 91, uniqueId: "context-91" } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual([]);
	});
});
describe("RelayBridge multiple extension instances", () => {
	it("keeps each browser's tabs listed when two instances connect", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		expect(
			bridge
				.listTargets()
				.map(t => [t.title, t.id])
				.sort(),
		).toEqual([
			["Chrome tab", `PAGE${instanceCode("chrome")}.1`],
			["Edge tab", `PAGE${instanceCode("edge")}.1`],
		]);
	});

	it("scopes the hello GC to the reconnecting instance", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		const edge = new FakeExtSocket();
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		// Edge reconnects without its tab: its own tab goes, Chrome's tab stays.
		bridge.extClosed(edge);
		const edge2 = new FakeExtSocket();
		connectInstance(bridge, edge2, "edge", []);
		expect(bridge.listTargets().map(t => t.title)).toEqual(["Chrome tab"]);
	});

	it("replaces the socket, resets runtime state, and keeps the registry when the same instance reconnects", async () => {
		const bridge = new RelayBridge({});
		const first = new FakeExtSocket();
		connectInstance(bridge, first, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const session = await attachPage(bridge, first, cdp, connId, 1, "chrome");
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: session, method: "Runtime.enable" }));
		await flush();
		ack(bridge, first, "send");
		await flush();
		ack(bridge, first, "send");
		await flush();
		expect(first.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable", "Runtime.enable"]);
		// Service-worker restart: a new socket helloes for the same instance.
		const second = new FakeExtSocket();
		connectInstance(bridge, second, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		expect(first.closed).toBe(true);
		// One listing per physical tab, not one per connection.
		expect(bridge.listTargets()).toHaveLength(1);
		// The runtime reset must reach the replacement socket: a fresh
		// Runtime.enable has to re-run the disable/enable cycle instead of
		// short-circuiting on stale rootRuntimeEnabled state.
		const newSession = await attachPage(bridge, second, cdp, connId, 1, "chrome");
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: newSession, method: "Runtime.enable" }));
		await flush();
		expect(second.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, second, "send");
		await flush();
		expect(second.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);
	});

	it("routes rpcs to the browser instance that owns the tab", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		const chromeCdp = new FakeCdpSocket();
		const chromeConn = bridge.cdpConnected(chromeCdp);
		const edgeCdp = new FakeCdpSocket();
		const edgeConn = bridge.cdpConnected(edgeCdp);
		// Same chrome tabId (1) in both browsers: routing must disambiguate by instance.
		const chromeSession = await attachPage(bridge, chrome, chromeCdp, chromeConn, 1, "chrome");
		const edgeSession = await attachPage(bridge, edge, edgeCdp, edgeConn, 1, "edge");
		bridge.cdpMessage(
			chromeConn,
			JSON.stringify({ id: ++msgSeq, sessionId: chromeSession, method: "Runtime.enable" }),
		);
		bridge.cdpMessage(edgeConn, JSON.stringify({ id: ++msgSeq, sessionId: edgeSession, method: "Runtime.enable" }));
		await flush();
		const chromeSends = chrome.rpcs("send").map(rpc => rpc.tabId);
		const edgeSends = edge.rpcs("send").map(rpc => rpc.tabId);
		expect(chromeSends).toEqual([1]);
		expect(edgeSends).toEqual([1]);
	});

	it("opens new tabs in the browser showing the first selected tab, not the one that reconnected last", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1, active: true })]);
		connectInstance(bridge, new FakeExtSocket(), "edge", [tab({ tabId: 1, active: true })]);
		// Edge's service worker restarts and says hello again.
		const edge = new FakeExtSocket();
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, active: true })]);
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: {} }));
		expect(chrome.rpcs("createTab")).toHaveLength(1);
		expect(edge.rpcs("createTab")).toHaveLength(0);
	});

	it("opens new tabs in the browser of a tab the client already drives", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
		// Chrome both shows the selected tab and said hello last.
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1, active: true })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, edge, cdp, connId, 1, "edge");
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "OMP.claimTarget" }));
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: {} }));
		expect(edge.rpcs("createTab")).toHaveLength(1);
		expect(chrome.rpcs("createTab")).toHaveLength(0);
	});

	it("opens a new tab in the browser of nearTargetId after the user closed that tab", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1, active: true })]);
		bridge.extMessage(edge, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.createTarget",
				params: { url: "about:blank", nearTargetId: `PAGE${instanceCode("edge")}.1` },
			}),
		);
		expect(edge.rpcs("createTab")).toHaveLength(1);
		expect(chrome.rpcs("createTab")).toHaveLength(0);
	});

	it("waits for the browser of nearTargetId to reconnect instead of opening the tab in another browser", async () => {
		const bridge = new RelayBridge({});
		const edge = new FakeExtSocket();
		const chrome = new FakeExtSocket();
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1, active: true })]);
		bridge.extClosed(edge);
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.createTarget",
				params: { url: "about:blank", nearTargetId: `PAGE${instanceCode("edge")}.1` },
			}),
		);
		await flush();
		expect(chrome.rpcs("createTab")).toHaveLength(0);
		const back = new FakeExtSocket();
		connectInstance(bridge, back, "edge", [tab({ tabId: 1 })]);
		await flush();
		expect(back.rpcs("createTab")).toHaveLength(1);
		expect(chrome.rpcs("createTab")).toHaveLength(0);
	});

	it("opens the tab in another browser once the browser of nearTargetId stays offline past its reconnect window", async () => {
		jest.useFakeTimers();
		try {
			const bridge = new RelayBridge({});
			const edge = new FakeExtSocket();
			const chrome = new FakeExtSocket();
			connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
			connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1, active: true })]);
			bridge.extClosed(edge);
			const connId = bridge.cdpConnected(new FakeCdpSocket());
			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: ++msgSeq,
					method: "Target.createTarget",
					params: { url: "about:blank", nearTargetId: `PAGE${instanceCode("edge")}.1` },
				}),
			);
			await flush();
			jest.advanceTimersByTime(12_000);
			await flush();
			expect(chrome.rpcs("createTab")).toHaveLength(1);
		} finally {
			jest.useRealTimers();
		}
	});

	it("retires a browser's targets once it restarted, so an old target id never names a tab that reuses its id", async () => {
		const bridge = new RelayBridge({});
		const before = new FakeExtSocket();
		connectInstance(bridge, before, "chrome", [tab({ tabId: 7 })], [], "run-1");
		const oldTarget = bridge.listTargets()[0]?.id;
		// A service-worker restart keeps the browser run, and with it the target id.
		const reconnected = new FakeExtSocket();
		connectInstance(bridge, reconnected, "chrome", [tab({ tabId: 7 })], [], "run-1");
		expect(bridge.listTargets().map(target => target.id)).toEqual([oldTarget]);
		// Chrome restarted: tab 7 is now a page the user opened.
		const restarted = new FakeExtSocket();
		connectInstance(bridge, restarted, "chrome", [tab({ tabId: 7, url: "https://mail.example/" })], [], "run-2");
		expect(bridge.listTargets().map(target => target.id)).not.toContain(oldTarget);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const closeId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: closeId, method: "Target.closeTarget", params: { targetId: oldTarget } }),
		);
		await flush();
		expect(cdp.messages.find(message => message.id === closeId)).toHaveProperty("error");
		expect(restarted.rpcs("removeTab")).toHaveLength(0);
	});

	it("closes a tab Chrome creates after the createTab RPC timed out", async () => {
		jest.useFakeTimers();
		try {
			const bridge = new RelayBridge({});
			const ext = new FakeExtSocket();
			connect(bridge, ext, []);
			const cdp = new FakeCdpSocket();
			const connId = bridge.cdpConnected(cdp);
			const createId = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id: createId, method: "Target.createTarget", params: {} }));
			await flush();
			jest.advanceTimersByTime(20_000);
			await flush();
			expect(cdp.messages.find(message => message.id === createId)).toHaveProperty("error");
			// Chrome answers late: nobody learned the tab's id, so the relay closes it.
			ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
			await flush();
			expect(ext.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([9]);
		} finally {
			jest.useRealTimers();
		}
	});

	it("forgets a timed-out createTab once its late window passes, so a wedged extension cannot grow the relay", async () => {
		jest.useFakeTimers();
		try {
			const bridge = new RelayBridge({});
			const ext = new FakeExtSocket();
			connect(bridge, ext, []);
			const connId = bridge.cdpConnected(new FakeCdpSocket());
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: {} }));
			await flush();
			jest.advanceTimersByTime(20_000 + 60_000);
			await flush();
			// The relay no longer tracks the request, so an answer this late changes nothing.
			ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
			await flush();
			expect(ext.rpcs("removeTab")).toHaveLength(0);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("closeRelayTarget", () => {
	/** A browser-level channel onto one bridge connection, as the tab supervisor's root connection is. */
	function channel(bridge: RelayBridge): Pick<CDPSession, "send"> {
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const send = async (method: string, params: object = {}): Promise<unknown> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, method, params }));
			await flush();
			const reply = cdp.messages.find(msg => msg.id === id);
			if (!reply) throw new Error(`no reply to ${method}`);
			if ("error" in reply) throw new Error(JSON.stringify(reply.error));
			return reply.result;
		};
		return { send } as unknown as Pick<CDPSession, "send">;
	}

	it("does not report a tab closed while its browser's extension is offline, and closes it once that browser reconnects", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 7 }), tab({ tabId: 8 })]);
		bridge.extClosed(chrome);
		expect(await closeRelayTarget(channel(bridge), `PAGE${instanceCode("chrome")}.7`)).toBeFalse();
		const back = new FakeExtSocket();
		connectInstance(bridge, back, "chrome", [tab({ tabId: 7 }), tab({ tabId: 8 })]);
		expect(back.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([7]);
		// It drops again before closing the tab: the next reconnect closes it.
		bridge.extClosed(back);
		await flush();
		const again = new FakeExtSocket();
		connectInstance(bridge, again, "chrome", [tab({ tabId: 7 }), tab({ tabId: 8 })]);
		expect(again.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([7]);
	});

	it("closes a tab whose close its browser dropped mid-call once that browser reconnects", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 7 })]);
		const connId = bridge.cdpConnected(new FakeCdpSocket());
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.closeTarget",
				params: { targetId: `PAGE${instanceCode("chrome")}.7` },
			}),
		);
		await flush();
		expect(chrome.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([7]);
		bridge.extClosed(chrome);
		await flush();
		const back = new FakeExtSocket();
		connectInstance(bridge, back, "chrome", [tab({ tabId: 7 })]);
		expect(back.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([7]);
	});

	it("does not close a tab whose id now shows another page when its browser reconnects", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 7 })]);
		bridge.extClosed(chrome);
		expect(await closeRelayTarget(channel(bridge), `PAGE${instanceCode("chrome")}.7`)).toBeFalse();
		// Chrome restarted meanwhile: tab 7 is a page the user opened.
		const back = new FakeExtSocket();
		connectInstance(bridge, back, "chrome", [tab({ tabId: 7, url: "https://mail.example/" })]);
		expect(back.rpcs("removeTab")).toHaveLength(0);
	});

	it("reports a tab the relay no longer knows as closed", async () => {
		const bridge = new RelayBridge({});
		connectInstance(bridge, new FakeExtSocket(), "chrome", [tab({ tabId: 7 })]);
		expect(await closeRelayTarget(channel(bridge), `PAGE${instanceCode("chrome")}.8`)).toBeTrue();
	});
});

describe("RelayBridge last-hello fallback and offline instance pruning", () => {
	it("falls back to a live instance for browser-wide requests when the last hello goes offline", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		bridge.extClosed(edge);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.createTarget",
				params: { url: "https://example.com/" },
			}),
		);
		expect(chrome.rpcs("createTab")).toHaveLength(1);
		expect(edge.rpcs("createTab")).toHaveLength(0);
		ack(bridge, chrome, "createTab", {
			tab: tab({ tabId: 9, title: "Created", url: "https://example.com/9" }),
		});
		await flush();
		expect(bridge.versionInfo("ws://relay").Browser).toBe("Chrome/151.0.0.0");
		expect(bridge.listTargets().map(t => t.title)).toContain("Created");
	});

	it("hides tabs of an instance whose socket went offline", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		bridge.extClosed(edge);
		expect(bridge.listTargets().map(t => t.title)).toEqual(["Chrome tab"]);
		// The registry survives for the reconnect; the hello re-adds the tab.
		const edge2 = new FakeExtSocket();
		connectInstance(bridge, edge2, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		expect(bridge.listTargets().map(t => t.title)).toEqual(["Chrome tab", "Edge tab"]);
	});
});

describe("RelayBridge page-session target lifecycle", () => {
	it("opens, activates and closes targets a page session asks for in that page's browser", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		// Edge helloes last, so browser-wide creates go there.
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, chrome, cdp, connId, 1, "chrome");
		const send = async (method: string, params: Record<string, unknown>) => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			return id;
		};
		const reply = (id: number) => cdp.messages.find(message => message.id === id);
		const created = `PAGE${instanceCode("chrome")}.9`;

		const createId = await send("Target.createTarget", { url: "https://example.com/", newWindow: true });
		ack(bridge, chrome, "createTab", { tab: tab({ tabId: 9, title: "Created", url: "https://example.com/" }) });
		await flush();
		const activateId = await send("Target.activateTarget", { targetId: created });
		ack(bridge, chrome, "activateTab");
		await flush();
		const closeId = await send("Target.closeTarget", { targetId: created });
		ack(bridge, chrome, "removeTab");
		await flush();

		// Sent raw, Chrome would open its own window and answer with an id the relay cannot resolve.
		expect(chrome.rpcs("send").map(rpc => rpc.method)).toEqual([]);
		expect(edge.rpcs("createTab")).toHaveLength(0);
		expect(chrome.rpcs("createTab").map(rpc => rpc.url)).toEqual(["https://example.com/"]);
		expect(reply(createId)).toMatchObject({ sessionId, result: { targetId: created } });
		expect(chrome.rpcs("activateTab").map(rpc => rpc.tabId)).toEqual([9]);
		expect(reply(activateId)?.result).toEqual({});
		expect(chrome.rpcs("removeTab").map(rpc => rpc.tabId)).toEqual([9]);
		expect(reply(closeId)?.result).toEqual({ success: true });
	});

	it("fails a page session's activate or close of a target the relay does not know", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		const ids: number[] = [];
		for (const [method, params] of [
			["Target.activateTarget", { targetId: "2E08A730A7A82AC514A041D202746564" }],
			["Target.activateTarget", { targetId: `PAGE${ANON}.9` }],
			["Target.activateTarget", {}],
			["Target.closeTarget", { targetId: "2E08A730A7A82AC514A041D202746564" }],
		] as const) {
			const id = ++msgSeq;
			ids.push(id);
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
		}
		await flush();

		for (const id of ids) {
			expect(cdp.messages.find(message => message.id === id)).toMatchObject({
				sessionId,
				error: { message: expect.stringContaining("No target with id") },
			});
		}
		expect(ext.rpcs("send")).toHaveLength(0);
		expect(ext.rpcs("activateTab")).toHaveLength(0);
		expect(ext.rpcs("removeTab")).toHaveLength(0);
	});
});
describe("RelayBridge auto-attach gating", () => {
	function destroyedIds(cdp: FakeCdpSocket): string[] {
		const ids: string[] = [];
		for (const m of cdp.messages) {
			if (m.method !== "Target.targetDestroyed") continue;
			const params = m.params;
			if (params && typeof params === "object" && "targetId" in params && typeof params.targetId === "string") {
				ids.push(params.targetId);
			}
		}
		return ids;
	}

	function attachedIds(cdp: FakeCdpSocket): string[] {
		const ids: string[] = [];
		for (const m of cdp.messages) {
			if (m.method !== "Target.attachedToTarget") continue;
			const params = m.params;
			if (!(params && typeof params === "object" && "targetInfo" in params)) continue;
			const info = params.targetInfo;
			if (info && typeof info === "object" && "targetId" in info && typeof info.targetId === "string") {
				ids.push(info.targetId);
			}
		}
		return ids;
	}

	it("hides tabs from legacy extensions while allowing supported browsers through the relay", () => {
		const bridge = new RelayBridge();
		const legacy = new FakeExtSocket();
		bridge.extConnected(legacy);
		bridge.extMessage(
			legacy,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/150.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [],
			}),
		);
		const supported = new FakeExtSocket();
		connectInstance(bridge, supported, "supported", [tab({ tabId: 2 })]);

		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${instanceCode("supported")}.2`]);
		expect(bridge.versionInfo("ws://relay/cdp").ompExtensionDiscardedTabsProtocol).toBe("1");
	});

	it("eagerly attaches live tabs and retracts discarded tabs", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, discarded: true }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
			}),
		);
		ack(bridge, ext, "attach");
		await flush();

		expect(ext.rpcs("attach").map(r => r.tabId)).toEqual([2]);
		const attached = attachedIds(cdp);
		expect(attached).toContain(`TAB${ANON}.2`);
		expect(attached).not.toContain(`TAB${ANON}.1`);
		// The discarded tab was announced by setDiscoverTargets. Retract it
		// so Puppeteer's connect() can finish.
		expect(destroyedIds(cdp)).toContain(`PAGE${ANON}.1`);
	});

	it("announces revived tabs and retracts discarded tabs", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, discarded: true }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		ack(bridge, ext, "attach");
		await flush();

		// Chrome reloads the discarded tab when the user activates it.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: false }) }));
		ack(bridge, ext, "attach");
		await flush();
		expect(attachedIds(cdp)).toContain(`TAB${ANON}.1`);

		// A previously attached tab becomes discarded.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 2, discarded: true }) }));
		await flush();
		expect(destroyedIds(cdp)).toContain(`PAGE${ANON}.2`);
		expect(ext.rpcs("detach").map(r => r.tabId)).toContain(2);
		ack(bridge, ext, "detach");
	});

	it("announces and attaches a tab again once its URL changes after Chrome refused its reattach", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		// Tab 2 is another relay tab in use, so the auto-attaching connection stays open throughout.
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		ack(bridge, ext, "attach");
		await flush();
		const attachedTab1 = () => attachedIds(cdp).filter(id => id === `TAB${ANON}.1`).length;
		expect(attachedTab1()).toBe(1);

		// Another extension's frame loads in tab 1: Chrome detaches, and refuses the reattach while the frame is there.
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		await flush();
		nack(bridge, ext, "attach", "Cannot access a chrome-extension:// URL of different extension");
		await flush();
		expect(bridge.listTargets().map(t => t.id)).toEqual([`PAGE${ANON}.2`]);

		// The frame is gone and the user navigates: the tab is announced and attached on the open connection again.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, url: "https://example.com/next" }) }),
		);
		await flush();
		expect(ext.pending("attach").map(r => r.tabId)).toEqual([1]);
		ack(bridge, ext, "attach");
		await flush();
		expect(attachedTab1()).toBe(2);
	});

	it("does not reattach an initially discovered tab discarded during attach", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));
		ack(bridge, ext, "attach");
		await flush();
		expect(destroyedIds(cdp)).toContain(`PAGE${ANON}.1`);
		expect(attachedIds(cdp)).not.toContain(`TAB${ANON}.1`);
		expect(ext.rpcs("detach").map(r => r.tabId)).toEqual([1]);
	});

	it("does not reattach a newly announced tab discarded during attach", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		await flush();
		bridge.extMessage(ext, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 1 }) }));
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));
		ack(bridge, ext, "attach");
		await flush();
		expect(destroyedIds(cdp)).toContain(`PAGE${ANON}.1`);
		expect(attachedIds(cdp)).not.toContain(`TAB${ANON}.1`);
		expect(ext.rpcs("detach").map(r => r.tabId)).toEqual([1]);
	});

	it("releases auto-attach promptly and retries after an in-flight attach fails on discard", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		const setAutoAttachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: setAutoAttachId, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		expect(ext.pending("attach")).toHaveLength(1);

		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));
		try {
			await flush();
			expect(cdp.messages.some(message => message.id === setAutoAttachId && "result" in message)).toBe(true);
		} finally {
			nack(bridge, ext, "attach", "discarded tab");
			await flush();
		}

		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		await flush();
		ack(bridge, ext, "attach");
		await flush();
		expect(bridge.listTargets().map(target => target.id)).toContain(`PAGE${ANON}.1`);
		expect(attachedIds(cdp)).toContain(`TAB${ANON}.1`);
	});

	it("rejects stale explicit attachment requests for discarded targets without an extension RPC", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));
		const attachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: attachId,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${ANON}.1`, flatten: true },
			}),
		);
		await flush();
		const reply = cdp.messages.find(message => message.id === attachId);
		expect(reply && "error" in reply).toBe(true);
		expect(ext.rpcs("attach")).toHaveLength(0);
	});

	it("announces to discovering clients the tabs a browser brings in its hello", async () => {
		const bridge = new RelayBridge();
		connectInstance(bridge, new FakeExtSocket(), "first", [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		await flush();
		// A second browser connects with a tab the client has never seen, as one does whose extension says
		// hello after its tabs already exist.
		connectInstance(bridge, new FakeExtSocket(), "second", [tab({ tabId: 5, title: "First" })]);
		await flush();
		const second = `PAGE${instanceCode("second")}.5`;
		expect(bridge.listTargets().map(target => target.id)).toContain(second);
		const created = cdp.messages.filter(
			m => m.method === "Target.targetCreated" && JSON.stringify(m.params).includes(`"${second}"`),
		);
		expect(created).toHaveLength(1);
	});

	it("reannounces a held tab on revival without attaching it while discarded", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		ack(bridge, ext, "attach");
		await flush();
		expect(attachedIds(cdp)).toContain(`TAB${ANON}.1`);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1, discarded: true })]);
		const discardedAttempts = replacement.rpcs("attach").length;
		nack(bridge, replacement, "attach");
		await flush();

		bridge.extMessage(replacement, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		ack(bridge, replacement, "attach");
		await flush();

		expect(discardedAttempts).toBe(0);
		expect(bridge.listTargets().map(target => target.id)).toContain(`PAGE${ANON}.1`);
		expect(replacement.rpcs("attach").map(rpc => rpc.tabId)).toEqual([1]);
		expect(attachedIds(cdp).filter(id => id === `TAB${ANON}.1`)).toHaveLength(2);
	});
	it("clears cancelled attach state when a discarded extension reconnects", async () => {
		const bridge = new RelayBridge();
		const firstExtension = new FakeExtSocket();
		connect(bridge, firstExtension, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
		);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		await flush();
		expect(firstExtension.pending("attach")).toHaveLength(1);
		bridge.extMessage(firstExtension, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1, discarded: true })]);
		await flush();
		expect(replacement.rpcs("attach")).toHaveLength(0);

		bridge.extMessage(replacement, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		bridge.extMessage(replacement, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));
		nack(bridge, replacement, "attach", "discarded tab again");
		await flush();

		bridge.extMessage(replacement, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		await flush();
		ack(bridge, replacement, "attach");
		await flush();
		expect(attachedIds(cdp)).toContain(`TAB${ANON}.1`);
	});
});

describe("RelayBridge active tab metadata", () => {
	it("keeps only the newly activated tab active in its window", () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [
			tab({ tabId: 1, title: "First", active: true }),
			tab({ tabId: 2, title: "Second" }),
			tab({ tabId: 3, title: "Other window", active: true, windowId: 2 }),
		]);
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 2, title: "Second", active: true }) }),
		);
		expect(bridge.listTargets().map(t => [t.title, t.active])).toEqual([
			["First", "false"],
			["Second", "true"],
			["Other window", "true"],
		]);
	});
});

describe("RelayBridge file chooser interception", () => {
	async function intercept(
		bridge: RelayBridge,
		ext: FakeExtSocket,
		connId: number,
		sessionId: string,
		enabled: boolean,
	): Promise<void> {
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.setInterceptFileChooserDialog", params: { enabled } }),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
	}

	/** The `enabled` value of every interception command the tab received. */
	function sent(ext: FakeExtSocket): unknown[] {
		return ext
			.rpcs("send")
			.filter(rpc => rpc.method === "Page.setInterceptFileChooserDialog")
			.map(rpc => rpc.params?.enabled);
	}

	it("keeps interception on while another session on the tab still waits for a chooser", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// A page's own `waitForFileChooser()` and an upload's chooser session share the tab's one attachment.
		const waiting = await attachPage(bridge, ext, cdp, connId, 1);
		const uploading = await attachPage(bridge, ext, cdp, connId, 1);
		await intercept(bridge, ext, connId, waiting, true);
		await intercept(bridge, ext, connId, uploading, true);
		await intercept(bridge, ext, connId, uploading, false);
		await intercept(bridge, ext, connId, waiting, false);
		expect(sent(ext)).toEqual([true, true, true, false]);
	});

	it("switches interception off when its last owner detaches or disconnects without disabling it", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// The holder keeps the tab's attachment alive, as the registry connection does.
		const holderCdp = new FakeCdpSocket();
		const holderId = bridge.cdpConnected(holderCdp);
		await attachPage(bridge, ext, holderCdp, holderId, 1);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);

		const detached = await attachPage(bridge, ext, cdp, connId, 1);
		await intercept(bridge, ext, connId, detached, true);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: detached } }),
		);
		await flush();
		ack(bridge, ext, "send");
		expect(sent(ext)).toEqual([true, false]);

		const killed = await attachPage(bridge, ext, cdp, connId, 1);
		await intercept(bridge, ext, connId, killed, true);
		bridge.cdpClosed(connId);
		await flush();
		expect(sent(ext)).toEqual([true, false, true, false]);
	});

	/** Send an interception command without answering it; returns its CDP id. */
	function request(bridge: RelayBridge, connId: number, sessionId: string, enabled: boolean): number {
		const id = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id, sessionId, method: "Page.setInterceptFileChooserDialog", params: { enabled } }),
		);
		return id;
	}

	/** Answer the oldest unanswered interception RPC: the extension settles RPCs in any order. */
	async function settleOldest(bridge: RelayBridge, ext: FakeExtSocket, ok: boolean): Promise<void> {
		const rpc = ext.pending("send").find(pending => pending.method === "Page.setInterceptFileChooserDialog");
		if (!rpc) throw new Error("no interception RPC pending");
		ext.markAcked(rpc.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: rpc.id, ok, error: ok ? undefined : "rpc failed" }));
		await flush();
	}

	it("keeps a later enable when an earlier overlapping enable on the session fails", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const holderCdp = new FakeCdpSocket();
		const holderId = bridge.cdpConnected(holderCdp);
		await attachPage(bridge, ext, holderCdp, holderId, 1);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		request(bridge, connId, sessionId, true);
		const later = request(bridge, connId, sessionId, true);
		await flush();
		await settleOldest(bridge, ext, false);
		await settleOldest(bridge, ext, true);
		expect(cdp.messages.find(message => message.id === later)).toMatchObject({ result: {} });
		// The later enable succeeded, so the session still owns interception and its detach must switch it off.
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(sent(ext).at(-1)).toBe(false);
	});

	it("keeps interception on for an owner whose disable failed while another owner's disable succeeded", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const first = await attachPage(bridge, ext, cdp, connId, 1);
		const second = await attachPage(bridge, ext, cdp, connId, 1);
		await intercept(bridge, ext, connId, first, true);
		await intercept(bridge, ext, connId, second, true);

		const failed = request(bridge, connId, first, false);
		request(bridge, connId, second, false);
		await flush();
		await settleOldest(bridge, ext, false);
		await settleOldest(bridge, ext, true);
		expect(cdp.messages.find(message => message.id === failed)).toHaveProperty("error");
		// `first` still asks for interception, so the tab must be left intercepting.
		expect(sent(ext).at(-1)).toBe(true);
		await intercept(bridge, ext, connId, first, false);
		expect(sent(ext).at(-1)).toBe(false);
	});
});
