import { describe, expect, it } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
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
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function connect(
	bridge: RelayBridge,
	socket: FakeExtSocket,
	tabs: TabSnapshot[],
	options: { attachedTabIds?: number[]; recoverableTabIds?: number[] } = {},
): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs,
			attachedTabIds: options.attachedTabIds ?? [],
			recoverableTabIds: options.recoverableTabIds ?? [],
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

/** Flush the rpc .then() microtask chains (no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Drain microtasks until `predicate` holds. The recovery chain (attach →
 * subscription replay → root Runtime cycle) resolves purely on the microtask
 * queue, but its depth varies with the scheduler, so a fixed {@link flush}
 * count is racy. Poll the observable condition instead of guessing a tick count.
 */
async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`waitFor timed out waiting for ${label}`);
}

let msgSeq = 100;

/** Attach to a tab's page target and return the minted page session id. */
async function attachPage(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${tabId}`, flatten: true },
		}),
	);
	await waitFor(
		() => ext.pending("attach").length > 0 || cdp.sessionFor(attachId) !== undefined,
		`attach RPC or reply for tab ${tabId}`,
	);
	if (ext.pending("attach").length > 0) ack(bridge, ext, "attach");
	await waitFor(() => cdp.sessionFor(attachId) !== undefined, `attachToTarget reply for tab ${tabId}`);
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

/** Attach to a tab's TAB target and return the minted tab pseudo-session id. */
async function attachTab(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `TAB${tabId}`, flatten: true },
		}),
	);
	await waitFor(
		() => ext.pending("attach").length > 0 || cdp.sessionFor(attachId) !== undefined,
		`attach RPC or reply for TAB ${tabId}`,
	);
	if (ext.pending("attach").length > 0) ack(bridge, ext, "attach");
	await waitFor(() => cdp.sessionFor(attachId) !== undefined, `attachToTarget reply for TAB ${tabId}`);
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for TAB ${tabId} did not produce a session`);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { attachedTabIds: [1] });
		const groups = ext2.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
	});

	it("re-attaches a claimed tab after the orphan sweep detached it before extension reconnect", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const oldPageSession = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets" }));
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: oldPageSession, method: "OMP.claimTarget" }));
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();

		bridge.extClosed(ext);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		const staleCommandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: staleCommandId, sessionId: oldPageSession, method: "Runtime.evaluate" }),
		);
		await flush();

		const attaches = ext2.rpcs("attach");
		expect(attaches).toHaveLength(1);
		expect(attaches[0]!.tabId).toBe(1);
		expect(ext2.rpcs("send")).toHaveLength(0);
		expect(cdp.messages.find(message => message.id === staleCommandId)?.error).toEqual({
			code: -32000,
			message: `Unknown session id ${oldPageSession}`,
		});

		ack(bridge, ext2, "attach");
		await flush();
		expect(cdp.messages.filter(message => message.method === "Target.attachedToTarget")).toHaveLength(3);
	});

	it("preserves a user's debugger detach while disconnected", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })]);
		await flush();

		expect(ext2.rpcs("attach")).toHaveLength(0);
		expect(cdp.messages.some(message => message.method === "Target.detachedFromTarget")).toBe(true);
	});

	it("detaches an inherited debugger attachment when no downstream session holds it", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();

		// A fresh relay process can inherit a debugger attachment from a previous
		// process during the extension's recovery grace window, but no downstream
		// client in this process owns it.
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1], recoverableTabIds: [1] });
		await flush();

		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("detaches a legacy inherited debugger attachment with no downstream holders", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();

		// A newer relay can reconnect to an older extension that reports an
		// already-attached tab but has no orphan-guard metadata. The legacy hello
		// still needs cleanup when this relay process has zero downstream holders.
		bridge.extConnected(ext);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/120.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [1],
				// no recoverableTabIds field
			}),
		);
		await flush();

		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("retries inherited debugger attachment cleanup after detach RPC failure", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();

		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1], recoverableTabIds: [1] });
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);

		nack(bridge, ext, "detach", "detach failed");
		await flush();

		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1], recoverableTabIds: [1] });
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1, 1]);
	});

	it("retracts the recovery target when the guard-authorized reattach fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 1);
		// Discover + auto-attach so the reconnect path announces and re-attaches.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets" }));
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		await flush();

		bridge.extClosed(ext);

		// The tab survived the outage recoverably, but reattachment fails (e.g.
		// DevTools claimed the tab). The bridge must retract the just-announced
		// target instead of leaving puppeteer holding a target it cannot drive.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		const created = cdp.messages.filter(m => m.method === "Target.targetCreated").length;
		const attach = ext2.pending("attach");
		expect(attach).toHaveLength(1);
		bridge.extMessage(ext2, JSON.stringify({ t: "rpcResult", id: attach[0]!.id, ok: false, error: "busy" }));
		ext2.markAcked(attach[0]!.id);
		await flush();

		// The failed reattach retracts the re-announced target.
		const destroyed = cdp.messages.filter(m => m.method === "Target.targetDestroyed").length;
		expect(destroyed).toBeGreaterThan(0);
		expect(created).toBeGreaterThan(0);
	});

	it("does not launch a second recovery attach when a hello races an in-flight one", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets" }));
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		await flush();

		bridge.extClosed(ext);

		// The reconnect hello arms a recovery attach that is still in flight.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.pending("attach")).toHaveLength(1);
		const destroyedBeforeRace = cdp.messages.filter(m => m.method === "Target.targetDestroyed").length;

		// A guard detach-refresh delivers a second hello for the same socket while
		// that attach is unresolved. It must not clear `attaching` and start a
		// competing attach whose "already attached" failure would retract the tab.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);

		// The original attach succeeds and the recovered target survives: the
		// racing hello added no retract of its own.
		ack(bridge, ext2, "attach");
		await flush();
		expect(cdp.messages.filter(m => m.method === "Target.targetDestroyed")).toHaveLength(destroyedBeforeRace);
		expect(cdp.messages.filter(m => m.method === "Target.attachedToTarget").length).toBeGreaterThan(0);
	});

	it("reattaches a recoverable tab for a session holder that never enabled auto-attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// The holder drives the tab through Target.attachToTarget only — no
		// setDiscoverTargets / setAutoAttach, so autoAttachConns stays empty.
		await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// The tab survived the outage recoverably (guard detach). Recovery must
		// restore the Chrome attachment even though no connection auto-attaches,
		// or the holder's next command lands on a detached tab.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();

		const attaches = ext2.rpcs("attach");
		expect(attaches).toHaveLength(1);
		expect(attaches[0]!.tabId).toBe(1);
	});

	it("keeps a bare attachToTarget holder's page session usable across recovery and detaches on close", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare holder: only Target.attachToTarget, no setDiscoverTargets/setAutoAttach.
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// Reconnect: the tab is recoverable (guard detach), so the bridge re-attaches.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();

		// The holder's original page session survived the root swap: its next
		// command routes to the freshly attached tab instead of "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		ack(bridge, ext2, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		expect(ext2.rpcs("send")).toHaveLength(1);
		expect(ext2.rpcs("send")[0]!.tabId).toBe(1);

		// Closing the sole holder now detaches the debugger — the session was never
		// orphaned, so the attachment is reclaimable and the infobar clears.
		bridge.cdpClosed(connId);
		await flush();
		expect(ext2.rpcs("detach")).toHaveLength(1);
		expect(ext2.rpcs("detach")[0]!.tabId).toBe(1);
	});

	it("keeps a bare TAB-target holder's tab pseudo-session usable across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare holder that attached to the TAB<n> target rather than PAGE<n>, and
		// never called setAutoAttach — so it owns only a tab pseudo-session routed
		// by tabId. Chrome mints no replacement for it on recovery.
		const tabSession = await attachTab(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// Reconnect: the tab is recoverable (guard detach), so the bridge re-attaches.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();

		// The tab pseudo-session survived the root swap: a supported command on it
		// (setAutoAttach mints a page child) routes instead of "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: tabSession, method: "Target.setAutoAttach" }));
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		// setAutoAttach on a live tab session mints and announces a page child.
		const pageChild = cdp.messages.find(
			m =>
				m.method === "Target.attachedToTarget" &&
				(m.params as { targetInfo?: { type?: string } })?.targetInfo?.type === "page",
		);
		expect(pageChild).toBeDefined();

		// Closing the sole holder detaches the debugger — the session was never
		// orphaned, so the attachment is reclaimable and the infobar clears.
		bridge.cdpClosed(connId);
		await flush();
		expect(ext2.rpcs("detach")).toHaveLength(1);
		expect(ext2.rpcs("detach")[0]!.tabId).toBe(1);
	});

	it("preserves a page session for a holder that enabled setDiscoverTargets but not auto-attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Discovery + manual attachToTarget, but no setAutoAttach: the holder still
		// owns a long-lived page pseudo-session routed by tabId, and Chrome mints no
		// replacement on recovery. Preservation must not be gated on `discover`.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets" }));
		await flush();
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();

		// The preserved page session survives the root swap: its next command routes
		// to the reattached tab instead of failing "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		ack(bridge, ext2, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		expect(ext2.rpcs("send")).toHaveLength(1);
		expect(ext2.rpcs("send")[0]!.tabId).toBe(1);
	});

	it("does not destroy/recreate a preserved page target for a discovering holder on recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Discovery + manual attachToTarget without auto-attach: the page session is
		// preserved across the guard-detach root swap. A CDP client treats
		// Target.targetDestroyed as the page closing, so preserving the raw session
		// while still firing destroy/recreate for the same page breaks the
		// consumer-visible page lifecycle. The recovery must suppress both the
		// targetDestroyed and the paired targetCreated for the preserved connection.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets" }));
		await flush();
		await attachPage(bridge, ext, cdp, connId, 1);

		const destroyedBefore = cdp.messages.filter(m => m.method === "Target.targetDestroyed").length;
		const createdBefore = cdp.messages.filter(m => m.method === "Target.targetCreated").length;

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		ack(bridge, ext2, "attach");
		await flush();

		// No lifecycle churn for the preserved page target on this connection.
		expect(cdp.messages.filter(m => m.method === "Target.targetDestroyed")).toHaveLength(destroyedBefore);
		expect(cdp.messages.filter(m => m.method === "Target.targetCreated")).toHaveLength(createdBefore);
	});

	it("holds a preserved session's command until the recovery attach acknowledges", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// Recovery arms a debugger reattach that has NOT been acknowledged yet, so
		// `tab.attaching` is still pending when the holder's next command arrives.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);

		// Command sent while the attach is in flight: the bridge must not forward the
		// send RPC concurrently with chrome.debugger.attach(), or Chrome may reject it
		// as unattached. No send should be issued until the attach acknowledges.
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);

		// Once the attach acknowledges, the held command drains to the live tab.
		ack(bridge, ext2, "attach");
		await flush();
		ack(bridge, ext2, "send", { ok: true });
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(1);
		expect(ext2.rpcs("send")[0]!.tabId).toBe(1);
		expect(cdp.messages.find(m => m.id === cmdId)?.error).toBeUndefined();
	});

	it("replays preserved domain subscriptions and invalidates child sessions before forwarding", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const sendRootCommand = async (method: string, params?: Record<string, unknown>): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId: pageSession, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
			expect(cdp.messages.filter(message => message.id === id && "result" in message)).toHaveLength(1);
		};
		await sendRootCommand("Network.enable", { maxTotalBufferSize: 4096 });
		await sendRootCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
		await sendRootCommand("Fetch.disable");
		await sendRootCommand("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});

		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "child-before-recovery", targetInfo: { targetId: "worker-1", type: "worker" } },
			}),
		);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(
			cdp.messages.some(
				message =>
					message.sessionId === pageSession &&
					message.method === "Target.detachedFromTarget" &&
					typeof message.params === "object" &&
					message.params !== null &&
					"sessionId" in message.params &&
					message.params.sessionId === "child-before-recovery",
			),
		).toBe(true);

		ack(bridge, ext2, "attach");
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ maxTotalBufferSize: 4096 });

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: commandId, sessionId: pageSession, method: "Network.getCookies" }),
		);
		await flush();
		// Fetch.enable was followed by a successful Fetch.disable, so only the
		// still-active Network and Target subscriptions replay. The new command is
		// held until both acknowledgements arrive.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);
		ack(bridge, ext2, "send");
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable", "Target.setAutoAttach"]);
		ack(bridge, ext2, "send");
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.enable",
			"Target.setAutoAttach",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("cleans up replayed auto-attach state when its owner disconnects during recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Target.setAutoAttach",
				params: {
					autoAttach: true,
					waitForDebuggerOnStart: true,
					flatten: true,
					filter: [{ type: "page", exclude: true }],
				},
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "owner auto-attach replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Target.setAutoAttach"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
			filter: [{ type: "page", exclude: true }],
		});

		// The owner disconnects after the replayed enable was sent to the fresh root
		// but before recovery observes completion. Cleanup must issue a valid
		// Target.setAutoAttach disable instead of erroring and retracting survivors.
		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned auto-attach cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Target.setAutoAttach", "Target.setAutoAttach"]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({
			autoAttach: false,
			waitForDebuggerOnStart: true,
			flatten: true,
			filter: [{ type: "page", exclude: true }],
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({ id: commandId, sessionId: holderSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Target.setAutoAttach",
			"Target.setAutoAttach",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("keeps the shared root disabled when another preserved session issued the latest disable", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);

		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Network.enable" }));
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Network.disable" }),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "shared-root recovery attach");
		ack(bridge, ext2, "attach");
		await flush();

		// Network.disable changed the one shared Chrome root, so recovery must not
		// replay the stale Network.enable journaled by the other pseudo-session.
		expect(ext2.rpcs("send")).toHaveLength(0);
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({ id: commandId, sessionId: firstSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.getCookies"]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(first.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("drops stale tab-wide toggles when another preserved session disables them before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);

		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstSession,
				method: "Network.setCacheDisabled",
				params: { cacheDisabled: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			secondConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondSession,
				method: "Network.setCacheDisabled",
				params: { cacheDisabled: false },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({ id: commandId, sessionId: firstSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.getCookies"]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(first.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("drops root subscriptions owned by retracted auto-attach sessions during recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const manual = new FakeCdpSocket();
		const manualConn = bridge.cdpConnected(manual);
		const manualSession = await attachPage(bridge, ext, manual, manualConn, 1);
		const auto = new FakeCdpSocket();
		const autoConn = bridge.cdpConnected(auto);
		const autoAttachId = ++msgSeq;
		bridge.cdpMessage(autoConn, JSON.stringify({ id: autoAttachId, method: "Target.setAutoAttach" }));
		await waitFor(() => auto.messages.some(message => message.id === autoAttachId), "browser auto-attach reply");
		const autoTabSession = auto.attachedSessions().find(sessionId => sessionId.startsWith("ST"));
		if (!autoTabSession) throw new Error("setAutoAttach did not mint a tab session");
		bridge.cdpMessage(
			autoConn,
			JSON.stringify({ id: ++msgSeq, sessionId: autoTabSession, method: "Target.setAutoAttach" }),
		);
		await flush();
		const autoSession = auto.attachedSessions().find(sessionId => sessionId.startsWith("SP"));
		if (!autoSession) throw new Error("setAutoAttach did not mint a page session");

		bridge.cdpMessage(
			manualConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: manualSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://manual.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(
			autoConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: autoSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://auto.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "manual subscription replay");

		// Recovery keeps the manual page session and retracts auto-attach sessions,
		// so only state owned by the preserved session may replay on the fresh root.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ patterns: [{ urlPattern: "https://manual.example/*" }] });
		ack(bridge, ext2, "send");
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			manualConn,
			JSON.stringify({ id: commandId, sessionId: manualSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Network.getCookies"]);
	});

	it("clears a replayed root subscription when its preserved owner disconnects during recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://owner.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "owner subscription replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);

		// The owner disconnects after its subscription has been sent to the fresh
		// Chrome root but before replay observes completion. Another holder keeps
		// the tab attached, so recovery must clear the orphaned Fetch state instead
		// of leaving request interception enabled with no owning client.
		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned subscription cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.disable"]);
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({ id: commandId, sessionId: holderSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.disable", "Network.getCookies"]);
	});

	it("restores the browser user agent when a replayed override loses its owner during recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Network.setUserAgentOverride",
				params: { userAgent: "Mozilla/5.0 stealth", platform: "Win32" },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "owner UA replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setUserAgentOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ userAgent: "Mozilla/5.0 stealth", platform: "Win32" });

		// The owner disconnects after the override has been replayed to the fresh
		// root but before replay observes completion. Another holder keeps the tab
		// attached, so recovery must restore the browser's default UA instead of
		// leaving the stealth override orphaned on the shared root.
		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned user-agent cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setUserAgentOverride",
			"Network.setUserAgentOverride",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ userAgent: "test" });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({ id: commandId, sessionId: holderSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setUserAgentOverride",
			"Network.setUserAgentOverride",
			"Network.getCookies",
		]);
	});

	it("replays persistent user-agent overrides for a preserved session across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const sendRootCommand = async (method: string, params?: Record<string, unknown>): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId: pageSession, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
			expect(cdp.messages.filter(message => message.id === id && "result" in message)).toHaveLength(1);
		};

		// The browser tool applies the stealth UA through both CDP setters (see
		// launch.ts sendUserAgentOverride). A later re-issue must win.
		const staleUa = { userAgent: "stale-agent", platform: "Linux" };
		const stealthUa = { userAgent: "Mozilla/5.0 stealth", platform: "Win32" };
		await sendRootCommand("Network.setUserAgentOverride", staleUa);
		await sendRootCommand("Emulation.setUserAgentOverride", staleUa);
		await sendRootCommand("Network.setUserAgentOverride", stealthUa);
		await sendRootCommand("Emulation.setUserAgentOverride", stealthUa);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		// Recovery replays each UA setter serially, in original order, with the
		// latest override params — so the fresh Chrome root keeps the stealth
		// fingerprint instead of reverting after the guard-authorized swap.
		await waitFor(() => ext2.rpcs("send").length === 1, "first UA override replayed");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setUserAgentOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(stealthUa);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "second UA override replayed");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setUserAgentOverride",
			"Emulation.setUserAgentOverride",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual(stealthUa);
		ack(bridge, ext2, "send");
		await flush();
		// Exactly the two UA setters replay — no duplicate from the superseded
		// stale override, and no disable/enable churn for a stateless setter.
		expect(ext2.rpcs("send")).toHaveLength(2);
	});

	it("replays non-UA persistent root setters for a preserved session across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const sendRootCommand = async (method: string, params?: Record<string, unknown>): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId: pageSession, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
			expect(cdp.messages.filter(message => message.id === id && "result" in message)).toHaveLength(1);
		};

		const staleHeaders = { headers: { "x-stale": "1" } };
		const finalHeaders = { headers: { "x-omp-session": "alive" } };
		const metrics = { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false };
		await sendRootCommand("Network.setExtraHTTPHeaders", staleHeaders);
		await sendRootCommand("Network.setExtraHTTPHeaders", finalHeaders);
		await sendRootCommand("Emulation.setDeviceMetricsOverride", metrics);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "header replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setExtraHTTPHeaders"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(finalHeaders);
		ack(bridge, ext2, "send");

		await waitFor(() => ext2.rpcs("send").length === 2, "device metrics replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setExtraHTTPHeaders",
			"Emulation.setDeviceMetricsOverride",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual(metrics);
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(2);
	});

	it("does not replay a cleared persistent root setter after recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const sendRootCommand = async (method: string, params?: Record<string, unknown>): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId: pageSession, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
			expect(cdp.messages.filter(message => message.id === id && "result" in message)).toHaveLength(1);
		};

		const metrics = { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false };
		await sendRootCommand("Emulation.setDeviceMetricsOverride", metrics);
		await sendRootCommand("Emulation.clearDeviceMetricsOverride");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("clears replayed extra headers when the replay owner disconnects during recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Network.setExtraHTTPHeaders",
				params: { headers: { "x-omp-session": "alive" } },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "owner header replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setExtraHTTPHeaders"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ headers: { "x-omp-session": "alive" } });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned header cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setExtraHTTPHeaders",
			"Network.setExtraHTTPHeaders",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ headers: {} });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({ id: commandId, sessionId: holderSession, method: "Network.getCookies" }),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setExtraHTTPHeaders",
			"Network.setExtraHTTPHeaders",
			"Network.getCookies",
		]);
	});

	it("restarts subscription replay when the extension socket is replaced mid-restore", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		for (const method of ["Network.enable", "Page.enable"]) {
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		}

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "first recovery attach");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "first interrupted replay command");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);

		// Replace the socket without acknowledging Network.enable. Chrome still
		// reports the debugger attached, so only restorePending can trigger a retry.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1 })], { attachedTabIds: [1], recoverableTabIds: [1] });
		await waitFor(() => ext3.rpcs("send").length === 1, "restarted Network replay");
		expect(ext3.rpcs("attach")).toHaveLength(0);
		expect(ext3.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);
		ack(bridge, ext3, "send");
		await waitFor(() => ext3.rpcs("send").length === 2, "restarted Page replay");
		expect(ext3.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable", "Page.enable"]);
		ack(bridge, ext3, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: commandId, sessionId: pageSession, method: "Page.getFrameTree" }));
		await flush();
		expect(ext3.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable", "Page.enable", "Page.getFrameTree"]);
		ack(bridge, ext3, "send", { frameTree: {} });
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("holds a preserved session's command until the reconnect hello arrives", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// The replacement socket has opened but its hello has NOT been delivered yet,
		// so recovery bookkeeping has not run and `tab.attaching` is still null.
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);

		// A surviving session's command arrives in this gap. It must not be forwarded
		// to the (still detached) target: no send RPC until the hello lands.
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);
		expect(ext2.rpcs("attach")).toHaveLength(0);

		// The hello arrives: recovery re-announces the tab, arms the reattach, and the
		// held command proceeds only after both the hello and the attach complete.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();
		ack(bridge, ext2, "send", { ok: true });
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(1);
		expect(ext2.rpcs("send")[0]!.tabId).toBe(1);
		expect(cdp.messages.find(m => m.id === cmdId)?.error).toBeUndefined();
	});

	it("rejects a queued command when recovery replaces its auto-attach page session", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const oldPageSession = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: oldPageSession,
				method: "Page.navigate",
				params: { url: "https://example.com/side-effect" },
			}),
		);
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);

		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await waitFor(() => ext2.rpcs("attach").length === 1, "auto-attach recovery RPC");
		ack(bridge, ext2, "attach");
		await waitFor(
			() => cdp.messages.some(message => message.id === commandId && message.error !== undefined),
			"queued command error",
		);

		// The hello retracted oldPageSession and minted replacement auto-attach
		// state. The queued Page.navigate must not execute against the fresh root.
		expect(ext2.rpcs("send")).toHaveLength(0);
		expect(cdp.messages.find(message => message.id === commandId)?.error).toEqual({
			code: -32000,
			message: `Unknown session id ${oldPageSession}`,
		});
	});

	it("holds repeated browser auto-attach until the reconnect hello reconciles the old root", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const firstAutoAttachId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: firstAutoAttachId, method: "Target.setAutoAttach" }));
		await waitFor(() => ext.rpcs("attach").length === 1, "initial auto-attach RPC");
		ack(bridge, ext, "attach");
		await waitFor(() => cdp.messages.some(message => message.id === firstAutoAttachId), "initial auto-attach reply");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);
		const reconnectAutoAttachId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: reconnectAutoAttachId, method: "Target.setAutoAttach" }));
		expect(ext2.rpcs("attach")).toHaveLength(0);
		expect(cdp.messages.some(message => message.id === reconnectAutoAttachId)).toBeFalse();

		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(
			() => cdp.messages.some(message => message.id === reconnectAutoAttachId),
			"reconnect auto-attach reply",
		);
		expect(ext2.rpcs("attach")).toHaveLength(1);
	});

	it("holds browser attachToTarget until the reconnect hello restores a held tab", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);
		const attachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: attachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1", flatten: true },
			}),
		);
		expect(ext2.rpcs("attach")).toHaveLength(0);
		expect(cdp.messages.some(message => message.id === attachId)).toBeFalse();

		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await waitFor(() => ext2.rpcs("attach").length === 1, "held-tab recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => cdp.messages.some(message => message.id === attachId), "attachToTarget reply");
		expect(ext2.rpcs("attach")).toHaveLength(1);
		expect(cdp.sessionFor(attachId)).toBeDefined();
	});

	it("re-arms the hello gate when a replacement socket connects before the old close is delivered", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// A replacement extension socket reaches the relay before Bun delivers the
		// old socket's close callback. `extConnected` swaps `#ext`; the later
		// `extClosed(ext)` will be ignored because `#ext !== ext`. If the swap kept
		// the old socket's `#extInfo`, `#forwardToTab`'s hello gate
		// (`this.#ext && !this.#extInfo`) would be skipped and a surviving session's
		// command would be forwarded onto the not-yet-recovered target.
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);
		bridge.extClosed(ext); // out-of-order close for the replaced socket: ignored

		// Command arrives in the gap before the replacement's hello lands. It must be
		// held: no send RPC until recovery bookkeeping runs on the new hello.
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);
		expect(ext2.rpcs("attach")).toHaveLength(0);

		// The replacement's hello arrives: recovery re-announces and re-attaches the
		// tab, and only then does the held command drain to the live tab.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();
		ack(bridge, ext2, "send", { ok: true });
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(1);
		expect(ext2.rpcs("send")[0]!.tabId).toBe(1);
		expect(cdp.messages.find(m => m.id === cmdId)?.error).toBeUndefined();
	});

	it("re-cycles Runtime for a preserved session that re-enables before the reconnect hello", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Enable Runtime on the live session so `ref.runtimeState` becomes "enabled".
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Runtime.enable" }));
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);
		ack(bridge, ext, "send");
		await flush();

		// Extension drops, replacement socket opens, but its hello has NOT landed —
		// recovery bookkeeping has not run, so `ref.runtimeState` is still "enabled".
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);

		// The preserved holder repeats Runtime.enable in this window. The stale
		// "enabled" state must NOT short-circuit into an early ack: the fresh root
		// will come up with Runtime disabled, so the bridge must gate on the hello,
		// observe the recovery reset to "default", and re-cycle the root.
		const enableId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enableId, sessionId: pageSession, method: "Runtime.enable" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);
		expect(cdp.messages.find(m => m.id === enableId)).toBeUndefined();

		// Hello arrives: recovery retracts/re-announces the preserved session (resetting
		// its runtime state) and arms the reattach.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await flush();
		ack(bridge, ext2, "attach");
		await flush();

		// The held enable now drives a real disable+enable cycle on the fresh root
		// instead of a spurious early success.
		expect(ext2.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext2, "send");
		await flush();
		expect(ext2.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);
		ack(bridge, ext2, "send");
		await flush();
		expect(cdp.messages.find(m => m.id === enableId)?.error).toBeUndefined();
		expect(cdp.messages.find(m => m.id === enableId)?.result).toEqual({});
	});

	it("holds a preserved command across a second reconnect until the latest attach settles", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// First reconnect arms attach A (in flight, not yet acknowledged).
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);

		// A surviving-session command arrives while attach A is pending.
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);

		// A SECOND reconnect replaces the socket before attach A settles. This rejects
		// the in-flight attach A (ExtensionReplacedError) so `tab.attaching` clears —
		// but forwarding now would race attach B on the new socket. The command must
		// keep waiting for the new hello + attach B, not fire on the stale settle.
		const ext3 = new FakeExtSocket();
		bridge.extConnected(ext3);
		await flush();
		expect(ext3.rpcs("send")).toHaveLength(0);
		expect(ext3.rpcs("attach")).toHaveLength(0);

		// New hello arms attach B; still no forward until B acknowledges.
		bridge.extMessage(
			ext3,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await flush();
		expect(ext3.rpcs("attach")).toHaveLength(1);
		expect(ext3.rpcs("send")).toHaveLength(0);

		ack(bridge, ext3, "attach");
		await flush();
		ack(bridge, ext3, "send", { ok: true });
		await flush();
		expect(ext3.rpcs("send")).toHaveLength(1);
		expect(ext3.rpcs("send")[0]!.tabId).toBe(1);
		expect(cdp.messages.find(m => m.id === cmdId)?.error).toBeUndefined();
	});

	it("does not mint auto-attach sessions when the user cancels the debugger mid-replay", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		// Auto-attach holder: recovery mints a replacement session for it once the
		// replay finishes. A journaled subscription gives the replay an RPC to gate on.
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Target.setAutoAttach" }),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Network.enable" }));
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		// The replay's Network.enable is now in flight (unacknowledged).
		await waitFor(() => ext2.pending("send").length === 1, "in-flight replay command");
		const attachedBefore = cdp.attachedSessions().length;

		// The user dismisses the debugger infobar while the replay RPC is in flight:
		// the extension reports a user-initiated detach. This bans the tab and
		// retracts its sessions.
		bridge.extMessage(ext2, JSON.stringify({ t: "detached", tabId: 1, reason: "canceled_by_user" }));
		await flush();

		// The replay RPC now resolves. The continuation must revalidate and NOT mint
		// fresh auto-attach sessions for the now-detached, banned tab.
		ack(bridge, ext2, "send");
		await flush();
		expect(cdp.attachedSessions().length).toBe(attachedBefore);
	});

	it("does not mint auto-attach sessions when the tab closes mid-replay", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		// Auto-attach holder: recovery would normally emit a replacement session
		// after replay. Keep a subscription in the journal so we can close the tab
		// while the final replay command is unresolved.
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Target.setAutoAttach" }),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Network.enable" }));
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").length === 1, "in-flight replay command");
		const attachedBefore = cdp.attachedSessions().length;

		bridge.extMessage(ext2, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		await flush();

		ack(bridge, ext2, "send");
		await flush();
		expect(cdp.attachedSessions().length).toBe(attachedBefore);
	});

	it("serializes replay across repeated same-socket hellos instead of racing a second", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		for (const method of ["Network.enable", "Page.enable"]) {
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		}

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		// Replay of the first journaled subscription is now in flight on ext2.
		await waitFor(() => ext2.pending("send").length === 1, "first replay command in flight");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);

		// Another tab's delayed guard detach fires a second hello on the SAME socket
		// while this tab's replay is still in flight and reports it attached. It must
		// not launch a competing replay: the send count stays put until the active
		// replay is acknowledged and advances one command at a time.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [1],
				recoverableTabIds: [1],
			}),
		);
		await flush();
		// No duplicate Network.enable — still exactly one send in flight.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);

		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "second replay command");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable", "Page.enable"]);
		ack(bridge, ext2, "send");
		await flush();
		// Exactly the two journaled subscriptions replayed once each — no concurrent
		// second task doubled them.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable", "Page.enable"]);
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
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await waitFor(() => ext.pending("attach").length === 1, "clean reattach RPC");
		ack(bridge, ext, "attach");
		await waitFor(() => cdp.sessionFor(reattachId) !== undefined, "clean reattach reply");
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
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
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
		connect(bridge, replacement, [tab({ tabId: 1 })], { recoverableTabIds: [1] });
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
		connect(bridge, replacement, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
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
			JSON.stringify({ id: ++msgSeq, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await waitFor(() => ext.pending("attach").length === 1, "interrupted attach RPC");

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		await flush();

		const retryId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: retryId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
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
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
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

	it("rechecks holders after a forced recovery attach when the sole holder disconnected mid-attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare attachToTarget holder: no setAutoAttach, so recovery uses the forced
		// attach path (autoAttachConns empty, forceAttach true).
		await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// Reconnect: the tab is recoverable, so onHello arms a forced recovery attach.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.pending("attach")).toHaveLength(1);

		// The sole preserved holder disconnects while the recovery attach is still in
		// flight. detachIfUnheld runs now, but tab.attached is still false, so it
		// returns without detaching — leaving the attach to complete unheld.
		bridge.cdpClosed(connId);
		await flush();
		expect(ext2.rpcs("detach")).toHaveLength(0);

		// The attach succeeds. With no holder left, the recovery continuation must
		// recheck and detach immediately so the debugger attachment (and its infobar)
		// is not orphaned until a later relay outage.
		ack(bridge, ext2, "attach");
		await flush();
		expect(ext2.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("gates a preserved session's Runtime.enable on the reconnect hello and recovery attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// Replacement socket opened but its hello has NOT landed yet: recovery
		// bookkeeping (retract/reattach, tab.attaching) has not run.
		const ext2 = new FakeExtSocket();
		bridge.extConnected(ext2);

		// A preserved page session drives Runtime.enable in this gap. The root
		// disable/enable cycle issues direct `send` RPCs; without the hello gate they
		// would hit a still-detached target and Chrome would reject the init.
		const enableId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enableId, sessionId: pageSession, method: "Runtime.enable" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(0);
		expect(ext2.rpcs("attach")).toHaveLength(0);

		// The hello lands: recovery re-announces the tab and arms the reattach. The
		// Runtime cycle must still wait on the attach before sending disable/enable.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		expect(ext2.rpcs("attach")).toHaveLength(1);
		expect(ext2.rpcs("send")).toHaveLength(0);

		// Attach acknowledges: only now does the root Runtime cycle proceed.
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "Runtime.disable leg");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext2, "send"); // Runtime.disable leg
		await waitFor(() => ext2.rpcs("send").length === 2, "Runtime.enable leg");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable", "Runtime.enable"]);
		ack(bridge, ext2, "send"); // Runtime.enable leg
		await waitFor(
			() => cdp.messages.some(message => message.id === enableId && "result" in message),
			"Runtime.enable ack to client",
		);
		expect(cdp.messages.filter(message => message.id === enableId && "result" in message)).toHaveLength(1);
	});

	it("re-cycles Runtime for a preserved session that had it enabled before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare attachToTarget holder: routes by tabId, so its page session is
		// preserved across a guard-detach root swap.
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Enable Runtime before recovery: the root cycles and a live context replays.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Runtime.enable" }));
		await flush();
		ack(bridge, ext, "send"); // Runtime.disable leg
		await flush();
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
		ack(bridge, ext, "send"); // Runtime.enable leg
		await flush();
		expect(
			cdp.messages.filter(m => m.sessionId === pageSession && m.method === "Runtime.executionContextCreated"),
		).toHaveLength(1);

		// Recovery: the socket drops and a replacement reconnects. The tab is
		// recoverable, so the page session is preserved across the fresh Chrome
		// root and its prior Runtime subscription must be restored automatically.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "Runtime.disable leg");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext2, "send"); // Runtime.disable leg
		await waitFor(() => ext2.rpcs("send").length === 2, "Runtime.enable leg");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable", "Runtime.enable"]);

		// Runtime.enable on the fresh root re-announces contexts without requiring
		// the preserved client to repeat its original subscription command.
		bridge.extMessage(
			ext2,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext2, "send"); // Runtime.enable leg
		await flush();
		expect(
			cdp.messages.filter(m => m.sessionId === pageSession && m.method === "Runtime.executionContextCreated"),
		).toHaveLength(2);

		// A repeated enable now observes the restored state and acknowledges without
		// driving a redundant third root command.
		const reEnableId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: reEnableId, sessionId: pageSession, method: "Runtime.enable" }));
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(2);
		expect(cdp.messages.filter(m => m.id === reEnableId && "result" in m)).toHaveLength(1);
	});

	it("keeps a preserved session's Runtime.disable opt-out across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		// A preserved bare holder that explicitly disabled Runtime.
		const disabled = new FakeCdpSocket();
		const disabledConn = bridge.cdpConnected(disabled);
		const disabledSession = await attachPage(bridge, ext, disabled, disabledConn, 1);
		bridge.cdpMessage(
			disabledConn,
			JSON.stringify({ id: ++msgSeq, sessionId: disabledSession, method: "Runtime.disable" }),
		);
		await flush();

		// A second holder that keeps Runtime enabled, so root Runtime events keep flowing.
		const active = new FakeCdpSocket();
		const activeConn = bridge.cdpConnected(active);
		const activeSession = await attachPage(bridge, ext, active, activeConn, 1);

		// Recovery: socket drops, replacement reconnects, both page sessions preserved.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		ack(bridge, ext2, "attach");
		await flush();

		// The active holder re-enables Runtime after recovery; the root cycles and a
		// context is announced.
		bridge.cdpMessage(
			activeConn,
			JSON.stringify({ id: ++msgSeq, sessionId: activeSession, method: "Runtime.enable" }),
		);
		await flush();
		ack(bridge, ext2, "send"); // Runtime.disable leg
		await flush();
		const context = {
			context: {
				id: 42,
				origin: "https://example.com",
				name: "",
				uniqueId: "context-42",
				auxData: { isDefault: true, type: "default", frameId: "frame-1" },
			},
		};
		bridge.extMessage(
			ext2,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext2, "send"); // Runtime.enable leg
		await flush();

		// The disabled session's opt-out survived recovery: it must NOT receive the
		// root context event, while the active session does.
		expect(
			disabled.messages.filter(
				m => m.sessionId === disabledSession && m.method === "Runtime.executionContextCreated",
			),
		).toHaveLength(0);
		expect(
			active.messages.filter(m => m.sessionId === activeSession && m.method === "Runtime.executionContextCreated"),
		).toHaveLength(1);
	});

	it("restores root Runtime for a preserved default session across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const defaultHolder = new FakeCdpSocket();
		const defaultConn = bridge.cdpConnected(defaultHolder);
		const defaultSession = await attachPage(bridge, ext, defaultHolder, defaultConn, 1);

		const disabledHolder = new FakeCdpSocket();
		const disabledConn = bridge.cdpConnected(disabledHolder);
		const disabledSession = await attachPage(bridge, ext, disabledHolder, disabledConn, 1);
		bridge.cdpMessage(
			disabledConn,
			JSON.stringify({ id: ++msgSeq, sessionId: disabledSession, method: "Runtime.enable" }),
		);
		await waitFor(() => ext.rpcs("send").length === 1, "Runtime.disable leg");
		ack(bridge, ext, "send");
		await waitFor(() => ext.rpcs("send").length === 2, "Runtime.enable leg");
		ack(bridge, ext, "send");
		await waitFor(
			() => disabledHolder.messages.some(message => "result" in message && message.id === msgSeq),
			"Runtime.enable ack",
		);
		bridge.cdpMessage(
			disabledConn,
			JSON.stringify({ id: ++msgSeq, sessionId: disabledSession, method: "Runtime.disable" }),
		);
		await flush();

		// Recovery preserves both sessions. The explicit disable remains a per-session
		// opt-out, but the default session still depended on the pre-detach root
		// Runtime fan-out and needs the fresh root re-enabled.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "Runtime.disable recovery leg");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "Runtime.enable recovery leg");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable", "Runtime.enable"]);

		const context = {
			context: {
				id: 42,
				origin: "https://example.com",
				name: "",
				uniqueId: "context-42",
				auxData: { isDefault: true, type: "default", frameId: "frame-1" },
			},
		};
		bridge.extMessage(
			ext2,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext2, "send");
		await flush();

		expect(
			defaultHolder.messages.filter(
				message => message.sessionId === defaultSession && message.method === "Runtime.executionContextCreated",
			),
		).toHaveLength(1);
		expect(
			disabledHolder.messages.filter(
				message => message.sessionId === disabledSession && message.method === "Runtime.executionContextCreated",
			),
		).toHaveLength(0);
	});

	it("keeps a preserved page session across a second reconnect racing a recovery attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare holder: only Target.attachToTarget, so its page session must survive.
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// First reconnect arms a forced recovery attach that is still in flight.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();
		expect(ext2.pending("attach")).toHaveLength(1);

		// A second extension reconnect replaces ext2 before its attach resolves.
		// extConnected rejects the in-flight attach with ExtensionReplacedError, so
		// #ensureAttached resolves false — but this is a transport swap, not a real
		// attach failure, so the recovery continuation must NOT retract the
		// preserved page session.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await flush();

		// ext3's hello re-runs reconciliation and re-attaches the still-held tab.
		expect(ext3.pending("attach")).toHaveLength(1);
		ack(bridge, ext3, "attach");
		await flush();

		// The holder's original page session survived both reconnects: its command
		// routes to the freshly attached tab instead of "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		ack(bridge, ext3, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		expect(ext3.rpcs("send").some(rpc => rpc.tabId === 1)).toBe(true);
	});

	it("falls back to best-effort reattach when a legacy hello omits recovery metadata", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// A legacy extension (pre-orphan-guard) reconnects: its hello reports the
		// tab as no longer attached and omits `recoverableTabIds` entirely. Absent
		// metadata must be treated as the legacy restart case (best-effort
		// reattach), not as a user detach that bans the tab and drops the session.
		const legacy = new FakeExtSocket();
		bridge.extConnected(legacy);
		bridge.extMessage(
			legacy,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/120.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				// no recoverableTabIds field
			}),
		);
		await flush();

		// The bridge re-attaches best-effort instead of tearing down the session.
		expect(legacy.pending("attach")).toHaveLength(1);
		ack(bridge, legacy, "attach");
		await flush();

		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		ack(bridge, legacy, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
	});
});
