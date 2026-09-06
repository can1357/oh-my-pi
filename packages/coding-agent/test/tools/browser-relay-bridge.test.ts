import { describe, expect, it, vi } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import * as vm from "node:vm";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = {
	t: "rpc";
	id: number;
} & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	closeCount = 0;
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {
		this.closeCount++;
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
	options: {
		attachedTabIds?: number[];
		recoverableTabIds?: number[];
		relayDetachedTabIds?: number[];
		recoveryLoaderIds?: Record<string, string>;
		freshRootRequiredTabIds?: number[];
		hardwareConcurrency?: number;
	} = {},
): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			hardwareConcurrency: options.hardwareConcurrency ?? 8,
			tabs,
			attachedTabIds: options.attachedTabIds ?? [],
			recoverableTabIds: options.recoverableTabIds ?? [],
			relayDetachedTabIds: options.relayDetachedTabIds,
			recoveryLoaderIds: options.recoveryLoaderIds,
			freshRootRequiredTabIds: options.freshRootRequiredTabIds,
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
			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: ++msgSeq,
					sessionId,
					method: "Page.getFrameTree",
				}),
			);
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.createTarget",
				params: { url: "https://example.com/" },
			}),
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
			JSON.stringify({
				t: "tabUpdated",
				tab: tab({ tabId: 1, groupId: -1, url: "https://example.com/other" }),
			}),
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
		});
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: oldPageSession,
				method: "OMP.claimTarget",
			}),
		);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();

		bridge.extClosed(ext);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		const staleCommandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: staleCommandId,
				sessionId: oldPageSession,
				method: "Runtime.evaluate",
			}),
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
		connect(bridge, ext, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
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

	it("releases an unattached recovery marker with no downstream holders", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();

		connect(bridge, ext, [tab({ tabId: 1 })], {
			attachedTabIds: [],
			recoverableTabIds: [1],
		});
		await flush();

		expect(ext.rpcs("forgetRecovery").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("retries inherited debugger attachment cleanup after detach RPC failure", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();

		connect(bridge, ext, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);

		nack(bridge, ext, "detach", "detach failed");
		await flush();

		// Cleanup reconnects immediately so the extension guard can retry the
		// surviving orphan instead of waiting indefinitely for another hello.
		expect(ext.closeCount).toBe(1);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		const created = cdp.messages.filter(m => m.method === "Target.targetCreated").length;
		const attach = ext2.pending("attach");
		expect(attach).toHaveLength(1);
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "rpcResult",
				id: attach[0]!.id,
				ok: false,
				error: "busy",
			}),
		);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();

		// The holder's original page session survived the root swap: its next
		// command routes to the freshly attached tab instead of "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();

		// The tab pseudo-session survived the root swap: a supported command on it
		// (setAutoAttach mints a page child) routes instead of "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: tabSession,
				method: "Target.setAutoAttach",
			}),
		);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);
		ack(bridge, ext2, "attach");
		await flush();

		// The preserved page session survives the root swap: its next command routes
		// to the reattached tab instead of failing "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);

		// Command sent while the attach is in flight: the bridge must not forward the
		// send RPC concurrently with chrome.debugger.attach(), or Chrome may reject it
		// as unattached. No send should be issued until the attach acknowledges.
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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
				params: {
					sessionId: "child-before-recovery",
					targetInfo: { targetId: "worker-1", type: "worker" },
				},
			}),
		);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Network.getCookies",
			}),
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

	it("reconnects if cleanup after a subscription replay failure also fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Network.enable",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1, "subscription recovery attach");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Network.enable"), "subscription replay RPC");
		nack(bridge, ext2, "send", "replay denied");
		await waitFor(() => ext2.pending("detach").length === 1, "cleanup detach after replay failure");
		nack(bridge, ext2, "detach", "cleanup detach denied");
		await flush();

		expect(ext2.closeCount).toBe(1);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
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

	it("treats an auto-attach disable as a tab-wide clear so a stale enable is not revived", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);

		// Session A enables auto-attach on the shared root.
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstSession,
				method: "Target.setAutoAttach",
				params: {
					autoAttach: true,
					waitForDebuggerOnStart: false,
					flatten: true,
				},
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		// Session B disables it. Chrome turns auto-attach off on the shared root, so
		// A's earlier enable must not survive to be replayed after recovery.
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondSession,
				method: "Target.setAutoAttach",
				params: {
					autoAttach: false,
					waitForDebuggerOnStart: false,
					flatten: true,
				},
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		// No auto-attach replay: the disable cleared the shared root state tab-wide.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([]);

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: commandId,
				sessionId: firstSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.getCookies"]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(first.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats a neutral network-conditions reset as a tab-wide clear so stale throttling is not revived", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);

		// Session A throttles / goes offline on the shared root.
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstSession,
				method: "Network.emulateNetworkConditions",
				params: {
					offline: true,
					latency: 250,
					downloadThroughput: 128 * 1024,
					uploadThroughput: 64 * 1024,
					connectionType: "cellular3g",
				},
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		// Session B restores neutral networking. Chrome resets the shared root, so
		// A's obsolete offline/throttled state must not survive for replay.
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondSession,
				method: "Network.emulateNetworkConditions",
				params: {
					offline: false,
					latency: 0,
					downloadThroughput: -1,
					uploadThroughput: -1,
				},
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		// No network-conditions replay: the neutral reset cleared the shared state.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([]);

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: commandId,
				sessionId: firstSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.getCookies"]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(first.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it('treats `connectionType: "none"` as a neutral network-conditions reset', async () => {
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
				method: "Network.emulateNetworkConditions",
				params: {
					offline: true,
					latency: 250,
					downloadThroughput: 128 * 1024,
					uploadThroughput: 64 * 1024,
					connectionType: "cellular3g",
				},
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
				method: "Network.emulateNetworkConditions",
				params: {
					offline: false,
					latency: 0,
					downloadThroughput: -1,
					uploadThroughput: -1,
					connectionType: "none",
				},
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, 'connectionType "none" recovery attach RPC');
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([]);
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

		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstSession,
				method: "Network.enable",
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
				method: "Network.disable",
			}),
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
			JSON.stringify({
				id: commandId,
				sessionId: firstSession,
				method: "Network.getCookies",
			}),
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
			JSON.stringify({
				id: commandId,
				sessionId: firstSession,
				method: "Network.getCookies",
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: autoTabSession,
				method: "Target.setAutoAttach",
			}),
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "manual subscription replay");

		// Recovery keeps the manual page session and retracts auto-attach sessions,
		// so only state owned by the preserved session may replay on the fresh root.
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({
			patterns: [{ urlPattern: "https://manual.example/*" }],
		});
		ack(bridge, ext2, "send");
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			manualConn,
			JSON.stringify({
				id: commandId,
				sessionId: manualSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Network.getCookies"]);
	});

	it("retries detach when preserved subscription replay and cleanup fail", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Fetch.enable",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").length === 1, "subscription replay RPC");
		nack(bridge, ext2, "send", "replay denied");
		await waitFor(() => ext2.pending("detach").length === 1, "failed-replay cleanup detach");
		nack(bridge, ext2, "detach", "cleanup detach denied");
		await flush();

		expect(ext2.closeCount).toBe(1);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.disable", "Network.getCookies"]);
	});

	it("retries orphaned subscription cleanup after an extension replacement", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
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
		bridge.cdpClosed(ownerConn);
		ack(bridge, ext, "send");
		await waitFor(() => ext.pending("send").length === 1, "orphaned subscription cleanup on old socket");
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => replacement.pending("send").length === 1, "retried orphaned cleanup on replacement socket");
		expect(replacement.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);
		ack(bridge, replacement, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(replacement.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.disable", "Network.getCookies"]);
		ack(bridge, replacement, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("reapplies the surviving subscription instead of disabling first when a replay owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const originalOwner = new FakeCdpSocket();
		const originalOwnerConn = bridge.cdpConnected(originalOwner);
		const originalOwnerSession = await attachPage(bridge, ext, originalOwner, originalOwnerConn, 1);
		const replayOwner = new FakeCdpSocket();
		const replayOwnerConn = bridge.cdpConnected(replayOwner);
		const replayOwnerSession = await attachPage(bridge, ext, replayOwner, replayOwnerConn, 1);

		bridge.cdpMessage(
			originalOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: originalOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://original.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			replayOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: replayOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://replacement.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "surviving fetch replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Fetch.enable",
			params: { patterns: [{ urlPattern: "https://replacement.example/*" }] },
		});

		bridge.cdpClosed(replayOwnerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "surviving fetch reapply");
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Fetch.enable",
			params: { patterns: [{ urlPattern: "https://original.example/*" }] },
		});
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.enable"]);
	});

	it("disables a live root subscription when its owner disconnects but another holder keeps the tab attached", async () => {
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

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext.rpcs("send").length === 2, "live orphaned Fetch cleanup");
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.disable"]);
		ack(bridge, ext, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.disable", "Network.getCookies"]);
		ack(bridge, ext, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("clears departed emulated-media dimensions during live owner cleanup", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const mediaOwner = new FakeCdpSocket();
		const mediaOwnerConn = bridge.cdpConnected(mediaOwner);
		const mediaOwnerSession = await attachPage(bridge, ext, mediaOwner, mediaOwnerConn, 1);
		const featuresOwner = new FakeCdpSocket();
		const featuresOwnerConn = bridge.cdpConnected(featuresOwner);
		const featuresOwnerSession = await attachPage(bridge, ext, featuresOwner, featuresOwnerConn, 1);

		bridge.cdpMessage(
			mediaOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: mediaOwnerSession,
				method: "Emulation.setEmulatedMedia",
				params: { media: "print" },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			featuresOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: featuresOwnerSession,
				method: "Emulation.setEmulatedMedia",
				params: { features: [{ name: "prefers-color-scheme", value: "dark" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpClosed(mediaOwnerConn);
		await waitFor(() => ext.rpcs("send").length === 3, "live emulated-media cleanup");
		expect(ext.rpcs("send")[2]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});
		ack(bridge, ext, "send");
		await flush();
	});

	it("retries live owner cleanup after an extension replacement", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
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

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext.pending("send").length === 1, "live cleanup send on the old socket");
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => replacement.pending("send").length === 1, "retried live cleanup on replacement socket");
		expect(replacement.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);
		ack(bridge, replacement, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(replacement.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.disable", "Network.getCookies"]);
		ack(bridge, replacement, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("resumes queued live cleanup after replacement recovery finishes", async () => {
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
		connect(bridge, ext2, [tab({ tabId: 1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "first recovery attach");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "first replayed owner subscription");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);

		// The owner disappears after recovery replay sent its Fetch.enable but before
		// replay finishes observing the ack. Cleanup is queued for the next socket.
		bridge.cdpClosed(ownerConn);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});

		// The replacement replay no longer includes the departed owner's Fetch.enable,
		// so recovery itself may finish without any send RPCs. The already-applied
		// Fetch state on Chrome still must be cleared after that recovery completes.
		await waitFor(() => replacement.rpcs("send").length === 1, "queued cleanup after replacement recovery");
		expect(replacement.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);
		ack(bridge, replacement, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(replacement.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.disable", "Network.getCookies"]);
		ack(bridge, replacement, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("retries live owner cleanup after an ordinary extension disconnect", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
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

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext.pending("send").length === 1, "live cleanup send before disconnect");
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);

		bridge.extClosed(ext);
		await flush();

		const reconnected = new FakeExtSocket();
		connect(bridge, reconnected, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => reconnected.pending("send").length === 1, "retried live cleanup after reconnect");
		expect(reconnected.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.disable"]);
		ack(bridge, reconnected, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(reconnected.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.disable", "Network.getCookies"]);
		ack(bridge, reconnected, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("drains reconciliation changes queued while an earlier cleanup RPC is in flight", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const survivingOwner = new FakeCdpSocket();
		const survivingOwnerConn = bridge.cdpConnected(survivingOwner);
		const survivingOwnerSession = await attachPage(bridge, ext, survivingOwner, survivingOwnerConn, 1);
		const orphanedOwner = new FakeCdpSocket();
		const orphanedOwnerConn = bridge.cdpConnected(orphanedOwner);
		const orphanedOwnerSession = await attachPage(bridge, ext, orphanedOwner, orphanedOwnerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			survivingOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: survivingOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://surviving.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			orphanedOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: orphanedOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://orphaned.example/*" }] },
			}),
		);
		await flush();
		bridge.cdpClosed(orphanedOwnerConn);
		ack(bridge, ext, "send");
		await waitFor(() => ext.pending("send").length === 1, "reapply second owner while cleanup is in flight");
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);
		expect(ext.pending("send")[0]!.params).toEqual({
			patterns: [{ urlPattern: "https://surviving.example/*" }],
		});

		bridge.cdpClosed(survivingOwnerConn);
		ack(bridge, ext, "send");
		await waitFor(() => ext.rpcs("send").length === 4, "queued disable after second owner disconnects");
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Fetch.enable",
			"Fetch.enable",
			"Fetch.enable",
			"Fetch.disable",
		]);
		ack(bridge, ext, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Fetch.enable",
			"Fetch.enable",
			"Fetch.enable",
			"Fetch.disable",
			"Network.getCookies",
		]);
		ack(bridge, ext, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("retains later live subscription cleanups after one RPC fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Fetch.enable",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Page.setInterceptFileChooserDialog",
				params: { enabled: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext.pending("send").length === 1, "first live cleanup");
		expect(ext.pending("send")[0]).toMatchObject({ method: "Fetch.disable" });
		nack(bridge, ext, "send", "Fetch cleanup rejected");

		await waitFor(() => ext.pending("send").length === 1, "later live cleanup after an earlier failure");
		expect(ext.pending("send")[0]).toMatchObject({
			method: "Page.setInterceptFileChooserDialog",
			params: { enabled: false },
		});
		ack(bridge, ext, "send");
		await flush();
	});

	it("reapplies the latest surviving live root subscription when an orphaned in-flight setter completes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const survivingOwner = new FakeCdpSocket();
		const survivingOwnerConn = bridge.cdpConnected(survivingOwner);
		const survivingOwnerSession = await attachPage(bridge, ext, survivingOwner, survivingOwnerConn, 1);
		const orphanedOwner = new FakeCdpSocket();
		const orphanedOwnerConn = bridge.cdpConnected(orphanedOwner);
		const orphanedOwnerSession = await attachPage(bridge, ext, orphanedOwner, orphanedOwnerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			survivingOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: survivingOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://surviving.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			orphanedOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: orphanedOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://orphaned.example/*" }] },
			}),
		);
		await flush();
		bridge.cdpClosed(orphanedOwnerConn);
		ack(bridge, ext, "send");
		await waitFor(() => ext.rpcs("send").length === 3, "reapply surviving Fetch.enable");
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Fetch.enable", "Fetch.enable"]);
		expect(ext.rpcs("send")[2]!.params).toEqual({
			patterns: [{ urlPattern: "https://surviving.example/*" }],
		});
		ack(bridge, ext, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Fetch.enable",
			"Fetch.enable",
			"Fetch.enable",
			"Network.getCookies",
		]);
		ack(bridge, ext, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("cleans up an earlier replayed subscription when its owner disconnects during a later replay await", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const firstOwner = new FakeCdpSocket();
		const firstOwnerConn = bridge.cdpConnected(firstOwner);
		const firstOwnerSession = await attachPage(bridge, ext, firstOwner, firstOwnerConn, 1);
		const secondOwner = new FakeCdpSocket();
		const secondOwnerConn = bridge.cdpConnected(secondOwner);
		const secondOwnerSession = await attachPage(bridge, ext, secondOwner, secondOwnerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		bridge.cdpMessage(
			firstOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstOwnerSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "https://first.example/*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(
			secondOwnerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondOwnerSession,
				method: "Network.enable",
				params: { maxTotalBufferSize: 4096 },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "first replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable"]);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "second replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Network.enable"]);

		// The first replay already succeeded, but its owner disconnects while the
		// second replay RPC is still in flight. Recovery must revisit earlier
		// replayed entries and clear the now-orphaned Fetch interception.
		bridge.cdpClosed(firstOwnerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 3, "cleanup of earlier replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Fetch.enable", "Network.enable", "Fetch.disable"]);
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Fetch.enable",
			"Network.enable",
			"Fetch.disable",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "owner UA replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setUserAgentOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({
			userAgent: "Mozilla/5.0 stealth",
			platform: "Win32",
		});

		// The owner disconnects after the override has been replayed to the fresh
		// root but before replay observes completion. Another holder keeps the tab
		// attached, so recovery must clear the override with CDP's empty-userAgent
		// sentinel instead of guessing browser defaults.
		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned user-agent cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setUserAgentOverride",
			"Network.setUserAgentOverride",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ userAgent: "" });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		// Recovery replays only the latest effective UA override once, even if the
		// browser tool previously issued both alias setters. The fresh Chrome root
		// should keep the winning stealth fingerprint without replaying a stale
		// duplicate alias command.
		await waitFor(() => ext2.rpcs("send").length === 1, "first UA override replayed");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setUserAgentOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(stealthUa);
		ack(bridge, ext2, "send");
		await flush();
		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("preserves the surviving user-agent override across Network/Emulation aliases", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const ownerA = new FakeCdpSocket();
		const ownerAConn = bridge.cdpConnected(ownerA);
		const ownerASession = await attachPage(bridge, ext, ownerA, ownerAConn, 1);
		const ownerB = new FakeCdpSocket();
		const ownerBConn = bridge.cdpConnected(ownerB);
		const ownerBSession = await attachPage(bridge, ext, ownerB, ownerBConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		const networkUa = {
			userAgent: "Mozilla/5.0 network-owner",
			platform: "Linux",
		};
		const emulationUa = {
			userAgent: "Mozilla/5.0 emulation-owner",
			platform: "Win32",
		};
		await sendRootCommand(ownerAConn, ownerASession, "Network.setUserAgentOverride", networkUa);
		await sendRootCommand(ownerBConn, ownerBSession, "Emulation.setUserAgentOverride", emulationUa);

		bridge.cdpClosed(ownerBConn);
		await waitFor(() => ext.rpcs("send").length === 3, "surviving UA replay after latest alias owner closes");
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setUserAgentOverride",
			"Emulation.setUserAgentOverride",
			"Network.setUserAgentOverride",
		]);
		expect(ext.rpcs("send")[2]!.params).toEqual(networkUa);
		ack(bridge, ext, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setUserAgentOverride",
			"Emulation.setUserAgentOverride",
			"Network.setUserAgentOverride",
			"Network.getCookies",
		]);
	});

	it("treats empty user-agent overrides as a tab-wide clear across aliases", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Network.setUserAgentOverride", {
			userAgent: "Mozilla/5.0 custom",
			platform: "Win32",
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setUserAgentOverride", { userAgent: "" });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
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
		const metrics = {
			width: 1280,
			height: 720,
			deviceScaleFactor: 1,
			mobile: false,
		};
		await sendRootCommand("Network.setExtraHTTPHeaders", staleHeaders);
		await sendRootCommand("Network.setExtraHTTPHeaders", finalHeaders);
		await sendRootCommand("Emulation.setDeviceMetricsOverride", metrics);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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

	it("replays the automation override for a preserved session across recovery", async () => {
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

		await sendRootCommand("Emulation.setAutomationOverride", {
			enabled: true,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "automation override replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setAutomationOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ enabled: true });
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("treats a disabled automation override as a tab-wide clear across recovery", async () => {
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

		await sendRootCommand("Emulation.setAutomationOverride", {
			enabled: true,
		});
		await sendRootCommand("Emulation.setAutomationOverride", {
			enabled: false,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();
		await flush();

		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Emulation.setAutomationOverride")).toHaveLength(0);
	});

	it("replays a Runtime.addBinding for a preserved session across recovery", async () => {
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

		await sendRootCommand("Runtime.addBinding", { name: "ompExposed" });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "binding replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.addBinding"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ name: "ompExposed" });
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("stops replaying a Runtime.addBinding after Runtime.removeBinding clears it", async () => {
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

		await sendRootCommand("Runtime.addBinding", { name: "ompExposed" });
		await sendRootCommand("Runtime.removeBinding", { name: "ompExposed" });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();
		await flush();

		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Runtime.addBinding")).toHaveLength(0);
	});

	it("replays preserved network throttling across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const throttling = {
			offline: false,
			latency: 250,
			downloadThroughput: 128 * 1024,
			uploadThroughput: 64 * 1024,
			connectionType: "cellular3g",
		};

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Network.emulateNetworkConditions",
				params: throttling,
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "network throttling replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.emulateNetworkConditions"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(throttling);
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("preserves packet-loss-only network profiles across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const throttling = {
			offline: false,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
			packetLoss: 10,
		};

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Network.emulateNetworkConditions",
				params: throttling,
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "packet-loss replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.emulateNetworkConditions"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(throttling);
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("preserves connection-type-only network profiles across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const throttling = {
			offline: false,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
			connectionType: "wifi",
		};

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Network.emulateNetworkConditions",
				params: throttling,
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "connection-type recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "connection-type replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.emulateNetworkConditions"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(throttling);
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("replays preserved CPU throttling across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const throttling = { rate: 4 };
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Emulation.setCPUThrottlingRate",
				params: throttling,
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "cpu throttling recovery attach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "CPU throttling replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setCPUThrottlingRate"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(throttling);
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("clears replayed CPU throttling when its owner disconnects during recovery", async () => {
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
				method: "Emulation.setCPUThrottlingRate",
				params: { rate: 4 },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "CPU throttling recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "CPU throttling replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setCPUThrottlingRate"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ rate: 4 });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned CPU throttling cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setCPUThrottlingRate",
			"Emulation.setCPUThrottlingRate",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ rate: 1 });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setCPUThrottlingRate",
			"Emulation.setCPUThrottlingRate",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("clears replayed network throttling when its owner disconnects during recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const throttling = {
			offline: true,
			latency: 250,
			downloadThroughput: 128 * 1024,
			uploadThroughput: 64 * 1024,
			connectionType: "cellular3g",
		};

		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Network.emulateNetworkConditions",
				params: throttling,
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "network throttling replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.emulateNetworkConditions"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(throttling);

		// The throttling owner disappears after the replayed state has been sent
		// to the fresh root but before replay observes completion. Another holder
		// keeps the tab attached, so recovery must reset the root back to neutral
		// network conditions instead of leaving the offline/throttled state orphaned.
		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned throttling cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.emulateNetworkConditions",
			"Network.emulateNetworkConditions",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({
			offline: false,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.emulateNetworkConditions",
			"Network.emulateNetworkConditions",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays preserved timezone overrides across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const timezone = { timezoneId: "Asia/Shanghai" };
		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Emulation.setTimezoneOverride",
				params: timezone,
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "timezone replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setTimezoneOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual(timezone);
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("replays preserved preload scripts across recovery and remaps their identifiers", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(1);
		expect(ext.rpcs("send")[0]!.method).toBe("Page.addScriptToEvaluateOnNewDocument");
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();
		const addReply = cdp.messages.find(message => message.id === addId);
		const clientIdentifier =
			addReply &&
			"result" in addReply &&
			addReply.result &&
			typeof addReply.result === "object" &&
			"identifier" in addReply.result &&
			typeof addReply.result.identifier === "string"
				? addReply.result.identifier
				: undefined;
		expect(clientIdentifier).toBeDefined();
		expect(clientIdentifier).not.toBe("root-script-before-recovery");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "preload-script recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(
			() => ext2.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"preload-script replay",
		);
		const replay = ext2.rpcs("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(replay?.params).toEqual({
			source: "window.__relayInjected = true;",
		});
		ack(bridge, ext2, "send", { identifier: "root-script-after-recovery" });
		await flush();

		const removeId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: removeId,
				sessionId: pageSession,
				method: "Page.removeScriptToEvaluateOnNewDocument",
				params: { identifier: clientIdentifier },
			}),
		);
		await waitFor(
			() => ext2.rpcs("send").filter(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument").length === 1,
			"preload-script remove after recovery",
		);
		const removeRpc = ext2.rpcs("send").find(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument");
		expect(removeRpc?.params).toEqual({
			identifier: "root-script-after-recovery",
		});
		ack(bridge, ext2, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === removeId && "result" in message)).toHaveLength(1);
	});

	it.each([
		{
			name: "after a hashbang",
			source:
				'#!/usr/bin/env node\n"use strict";\nconst Object = {}; const globalThis = {}; this.__preloadRan = true;',
			prefix: '#!/usr/bin/env node\n"use strict";\nthis[',
		},
		{
			name: "after a leading BOM",
			source: '\uFEFF"use strict";\nconst Object = {}; const globalThis = {}; this.__preloadRan = true;',
			prefix: '\uFEFF"use strict";\nthis[',
		},
	])(
		"does not rerun immediate preload scripts when guard recovery preserves contexts $name",
		async ({ source, prefix }) => {
			const bridge = new RelayBridge({});
			const ext = new FakeExtSocket();
			connect(bridge, ext, [tab({ tabId: 1 })]);
			const cdp = new FakeCdpSocket();
			const connId = bridge.cdpConnected(cdp);
			const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: ++msgSeq,
					sessionId: pageSession,
					method: "Page.addScriptToEvaluateOnNewDocument",
					params: {
						source,
						runImmediately: true,
					},
				}),
			);
			await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
			ack(bridge, ext, "send", {
				frameTree: { frame: { loaderId: "loader-before" } },
			});
			await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
			ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
			await flush();

			bridge.extClosed(ext);
			const ext2 = new FakeExtSocket();
			connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
				recoverableTabIds: [1],
			});
			await waitFor(() => ext2.rpcs("attach").length === 1, "preload-script runImmediately recovery attach RPC");
			ack(bridge, ext2, "attach");
			await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
			ack(bridge, ext2, "send", {
				frameTree: { frame: { loaderId: "loader-before" } },
			});
			await waitFor(
				() => ext2.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
				"preload-script runImmediately replay",
			);
			const replay = ext2.rpcs("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
			expect(replay?.params).toMatchObject({ runImmediately: false });
			const replaySource = (replay?.params as { source?: string } | undefined)?.source;
			expect(replaySource).toStartWith(prefix);
			const replayContext: Record<string, unknown> = {};
			vm.runInNewContext(replaySource!, replayContext);
			expect(replayContext.__preloadRan).toBe(true);
			expect(Object.keys(replayContext).some(key => key.startsWith("__ompRelayPreload"))).toBe(true);
		},
	);

	it("preserves an immediate preload whose leading string expression continues on the next line", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		const source = '"abc"\n.toUpperCase(); this.__preloadRan = true;';

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source, runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.rpcs("attach").length === 1, "continued-expression recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(
			() => ext2.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"continued-expression preload replay",
		);

		const replay = ext2.rpcs("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		const replaySource = (replay?.params as { source?: string } | undefined)?.source;
		expect(replaySource).toContain(source);
		const replayContext: Record<string, unknown> = {};
		vm.runInNewContext(replaySource!, replayContext);
		expect(replayContext.__preloadRan).toBe(true);
		expect(Object.keys(replayContext).some(key => key.startsWith("__ompRelayPreload"))).toBe(true);
	});

	it("reruns an immediate preload after a same-URL navigation during subscription recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, url: "https://example.test/same" })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: pageSession, method: "Page.enable" }));
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.enable"));
		ack(bridge, ext, "send");
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;", runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, url: "https://example.test/same", groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.enable"));
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.frameNavigated",
				params: { frame: { id: "main", loaderId: "loader-after-navigation" } },
			}),
		);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", { frameTree: { frame: { loaderId: "loader-after-navigation" } } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		const replay = ext2.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(replay?.params).toMatchObject({
			source: "window.__relayInjected = true;",
			runImmediately: true,
		});
	});

	it("runs a preload once when navigation lands during registration handoff", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		const source = "let relayValue = 1; class RelayValue {}; this.__preloadRuns = (this.__preloadRuns ?? 0) + 1;";

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source, runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		const marked = ext2.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		ack(bridge, ext2, "send", { identifier: "root-script-with-marker" });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: true } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		const guarded = ext2.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(guarded?.params).toMatchObject({ runImmediately: false });
		const markedSource = (marked?.params as { source?: string } | undefined)?.source;
		const guardedSource = (guarded?.params as { source?: string } | undefined)?.source;
		const overlapDocument: Record<string, unknown> = {};
		vm.runInNewContext(markedSource!, overlapDocument);
		let guardedException: unknown;
		try {
			vm.runInNewContext(guardedSource!, overlapDocument);
		} catch (error) {
			guardedException = error;
		}
		expect(typeof guardedException).toBe("string");
		expect(overlapDocument.__preloadRuns).toBe(1);
		expect(Object.keys(overlapDocument).some(key => key.startsWith("__ompRelayPreload"))).toBe(false);
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.exceptionThrown",
				params: { exceptionDetails: { exception: { value: guardedException } } },
			}),
		);
		expect(cdp.messages.some(message => message.method === "Runtime.exceptionThrown")).toBe(false);
		ack(bridge, ext2, "send", { identifier: "root-script-guarded" });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: false } });
		const laterDocument: Record<string, unknown> = {};
		laterDocument.window = laterDocument;
		vm.createContext(laterDocument);
		vm.runInContext(guardedSource ?? "", laterDocument);
		expect(laterDocument.__preloadRuns).toBe(1);
		expect(vm.runInContext("relayValue", laterDocument)).toBe(1);
		expect(vm.runInContext("typeof RelayValue", laterDocument)).toBe("function");
		expect(Object.keys(laterDocument).some(key => key.startsWith("__ompRelayPreload"))).toBe(false);
	});

	it.each(["remove", "retry"] as const)(
		"forces a fresh root when the navigation preload %s loses its result",
		async interruptedMutation => {
			const bridge = new RelayBridge({});
			const ext = new FakeExtSocket();
			connect(bridge, ext, [tab({ tabId: 1 })]);
			const cdp = new FakeCdpSocket();
			const connId = bridge.cdpConnected(cdp);
			const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: ++msgSeq,
					sessionId: pageSession,
					method: "Page.addScriptToEvaluateOnNewDocument",
					params: {
						source: "window.__relayInjected = true;",
						runImmediately: true,
					},
				}),
			);
			await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
			ack(bridge, ext, "send", {
				frameTree: { frame: { loaderId: "loader-before" } },
			});
			await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
			ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
			await flush();

			bridge.extClosed(ext);
			const ext2 = new FakeExtSocket();
			connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
				recoverableTabIds: [1],
			});
			await waitFor(() => ext2.pending("attach").length === 1);
			ack(bridge, ext2, "attach");
			await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
			ack(bridge, ext2, "send", {
				frameTree: { frame: { loaderId: "loader-before" } },
			});
			await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
			ack(bridge, ext2, "send", { identifier: "root-script-replayed" });
			await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
			ack(bridge, ext2, "send", {
				frameTree: { frame: { loaderId: "loader-after-navigation" } },
			});
			await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
			ack(bridge, ext2, "send", { result: { value: false } });
			await waitFor(() =>
				ext2.pending("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"),
			);
			if (interruptedMutation === "retry") {
				ack(bridge, ext2, "send");
				await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
				ack(bridge, ext2, "send", { result: { value: false } });
				await waitFor(() =>
					ext2
						.pending("send")
						.some(
							rpc =>
								rpc.method === "Page.addScriptToEvaluateOnNewDocument" &&
								(rpc.params as { runImmediately?: boolean } | undefined)?.runImmediately === true,
						),
				);
			}
			bridge.extClosed(ext2);
			await flush();

			const ext3 = new FakeExtSocket();
			connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
				attachedTabIds: [1],
				recoverableTabIds: [1],
			});
			await waitFor(
				() => ext3.pending("detach").length === 1,
				`fresh-root detach after interrupted navigation preload ${interruptedMutation}`,
			);
		},
	);

	it("does not rerun a preload for navigation after registration was acknowledged", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: {
					source: "window.__relayInjected = true;",
					runImmediately: true,
				},
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-replayed" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send", { identifier: "root-script-after-recovery" });

		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: { context: { id: 17 } },
			}),
		);
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-after-navigation" } },
		});
		await flush();

		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(
			0,
		);
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);
	});

	it("does not rerun a preload for navigation before registration was acknowledged", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: {
					source: "window.__relayInjected = true;",
					runImmediately: true,
				},
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-replayed" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.frameNavigated",
				params: {
					frame: { id: "main", loaderId: "loader-after-navigation" },
				},
			}),
		);
		ack(bridge, ext2, "send", { identifier: "root-script-after-recovery" });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-after-navigation" } },
		});
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: true } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: false } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		const cleanReplay = ext2.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(cleanReplay?.params).toMatchObject({ runImmediately: false });
		const cleanSource = (cleanReplay?.params as { source?: string } | undefined)?.source;
		const laterDocument: Record<string, unknown> = {};
		laterDocument.window = laterDocument;
		vm.runInNewContext(cleanSource!, laterDocument);
		expect(laterDocument.__relayInjected).toBe(true);
		ack(bridge, ext2, "send", { identifier: "root-script-guarded" });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: false } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.disable"));
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(
			1,
		);
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2);
	});

	it("rechecks a navigation preload after removal before invoking it immediately", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;", runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], { recoverableTabIds: [1] });
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send", { identifier: "root-script-ambiguous" });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.frameNavigated",
				params: { frame: { id: "main", loaderId: "loader-after-navigation" } },
			}),
		);
		ack(bridge, ext2, "send", { frameTree: { frame: { loaderId: "loader-after-navigation" } } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		const markerProbe = ext2.pending("send").find(rpc => rpc.method === "Runtime.evaluate");
		const markerExpression = (markerProbe?.params as { expression?: string } | undefined)?.expression;
		expect(markerExpression).toContain("this[");
		expect(markerExpression).not.toContain("globalThis");
		ack(bridge, ext2, "send", { result: { value: false } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: true } });
		await waitFor(() =>
			ext2
				.pending("send")
				.some(
					rpc =>
						rpc.method === "Page.addScriptToEvaluateOnNewDocument" &&
						(rpc.params as { runImmediately?: boolean } | undefined)?.runImmediately === false,
				),
		);
		expect(
			ext2
				.rpcs("send")
				.filter(
					rpc =>
						rpc.method === "Page.addScriptToEvaluateOnNewDocument" &&
						(rpc.params as { runImmediately?: boolean } | undefined)?.runImmediately === true,
				),
		).toHaveLength(0);
	});

	it("observes preload navigation without client Page or Runtime domains", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: {
					source: "window.__relayInjected = true;",
					runImmediately: true,
				},
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		expect(ext2.pending("send").some(rpc => rpc.method === "Page.enable")).toBe(true);
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send", { identifier: "root-script-after-recovery" });

		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.frameNavigated",
				params: {
					frame: { id: "main", loaderId: "loader-after-navigation" },
				},
			}),
		);
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-after-navigation" } },
		});
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: true } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: false } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		const cleanReplay = ext2.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(cleanReplay?.params).toMatchObject({ runImmediately: false });
		const cleanSource = (cleanReplay?.params as { source?: string } | undefined)?.source;
		const laterDocument: Record<string, unknown> = {};
		laterDocument.window = laterDocument;
		vm.runInNewContext(cleanSource!, laterDocument);
		expect(laterDocument.__relayInjected).toBe(true);
		ack(bridge, ext2, "send", { identifier: "root-script-guarded" });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"));
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));
		ack(bridge, ext2, "send", { result: { value: false } });
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.disable"));
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(
			1,
		);
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2);
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toContain("Page.disable");
	});

	it("reruns immediate preload scripts on a forced fresh root", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: {
					source: "window.__relayInjected = true;",
					runImmediately: true,
				},
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", {
			frameTree: { frame: { loaderId: "loader-before" } },
		});
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		// Lose a mutating result so recovery must detach and establish a fresh root.
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Fetch.enable",
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Fetch.enable"), "ambiguous root mutation");
		bridge.extClosed(ext);
		await flush();

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
			recoveryLoaderIds: { "1": "loader-before" },
		});
		await waitFor(() => ext2.pending("detach").length === 1);
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext2, "send", {
			frameTree: { frame: { loaderId: "loader-after-navigation" } },
		});
		await waitFor(
			() => ext2.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"immediate preload replay on fresh root",
		);
		const replay = ext2.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(replay?.params).toEqual({
			source: "window.__relayInjected = true;",
			runImmediately: true,
		});
	});

	it("replays preserved preload scripts on a fresh root after a replacement loses the replay result", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await flush();
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();
		const addReply = cdp.messages.find(message => message.id === addId);
		const clientIdentifier =
			addReply &&
			"result" in addReply &&
			addReply.result &&
			typeof addReply.result === "object" &&
			"identifier" in addReply.result &&
			typeof addReply.result.identifier === "string"
				? addReply.result.identifier
				: undefined;
		expect(clientIdentifier).toBeDefined();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "preload-script lost-result recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(
			() => ext2.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"preload-script lost-result first replay",
		);

		const replacement = new FakeExtSocket();
		bridge.extConnected(replacement);
		await flush();
		connect(bridge, replacement, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => replacement.rpcs("detach").length === 1, "fresh-root detach before retrying preload replay");
		ack(bridge, replacement, "detach");
		await waitFor(() => replacement.rpcs("attach").length === 1, "fresh-root attach before retrying preload replay");
		ack(bridge, replacement, "attach");
		await waitFor(
			() => replacement.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"preload-script replay after fresh root",
		);
		const replay = replacement.rpcs("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(replay?.params).toEqual({
			source: "window.__relayInjected = true;",
		});
		expect(
			replacement.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
		).toHaveLength(1);
		ack(bridge, replacement, "send", {
			identifier: "root-script-after-fresh-root",
		});
		await flush();

		const removeId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: removeId,
				sessionId: pageSession,
				method: "Page.removeScriptToEvaluateOnNewDocument",
				params: { identifier: clientIdentifier },
			}),
		);
		await waitFor(
			() => replacement.rpcs("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"),
			"preload-script remove after fresh-root replay",
		);
		const removeRpc = replacement.rpcs("send").find(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument");
		expect(removeRpc?.params).toEqual({
			identifier: "root-script-after-fresh-root",
		});
		ack(bridge, replacement, "send");
		await flush();
	});

	it("forces a fresh root when a replacement interrupts the post-registration loader probe", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;", runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const recovering = new FakeExtSocket();
		connect(bridge, recovering, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
			recoveryLoaderIds: { "1": "loader-before" },
		});
		await waitFor(() => recovering.pending("attach").length === 1);
		ack(bridge, recovering, "attach");
		await waitFor(() => recovering.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, recovering, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() =>
			recovering.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
		);
		ack(bridge, recovering, "send", { identifier: "root-script-replayed" });
		await waitFor(
			() => recovering.pending("send").filter(rpc => rpc.method === "Page.getFrameTree").length === 1,
			"post-registration loader probe",
		);

		const replacement = new FakeExtSocket();
		bridge.extConnected(replacement);
		await flush();
		connect(bridge, replacement, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => replacement.rpcs("detach").length === 1, "fresh-root detach after loader probe loss");
	});

	it("forces a fresh root when a replacement interrupts the preload marker probe", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;", runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		bridge.extClosed(ext);
		const recovering = new FakeExtSocket();
		connect(bridge, recovering, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
			recoveryLoaderIds: { "1": "loader-before" },
		});
		await waitFor(() => recovering.pending("attach").length === 1);
		ack(bridge, recovering, "attach");
		await waitFor(() => recovering.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, recovering, "send", { frameTree: { frame: { loaderId: "loader-before" } } });
		await waitFor(() =>
			recovering.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
		);
		ack(bridge, recovering, "send", { identifier: "root-script-replayed" });
		await waitFor(() => recovering.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, recovering, "send", { frameTree: { frame: { loaderId: "loader-after" } } });
		await waitFor(() => recovering.pending("send").some(rpc => rpc.method === "Runtime.evaluate"));

		const replacement = new FakeExtSocket();
		bridge.extConnected(replacement);
		await flush();
		connect(bridge, replacement, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => replacement.rpcs("detach").length === 1, "fresh-root detach after marker probe loss");
	});

	it("replays preserved preload scripts on a fresh root after an ordinary disconnect loses the replay result", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await flush();
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		// First recovery: the extension socket closes ordinarily (not a
		// replacement) after emitting the replay RPC but before its result is
		// acked, so the replay rejects with `relay extension disconnected`.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "ordinary-disconnect recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(
			() => ext2.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"ordinary-disconnect first replay",
		);
		// The socket closes normally: no replacement, just a lost result. Chrome
		// may already hold the additive registration, so the next replay must
		// happen on a fresh root instead of the surviving, still-attached one.
		bridge.extClosed(ext2);
		await flush();

		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext3.rpcs("detach").length === 1, "fresh-root detach after ordinary disconnect");
		ack(bridge, ext3, "detach");
		await waitFor(() => ext3.rpcs("attach").length === 1, "fresh-root attach after ordinary disconnect");
		ack(bridge, ext3, "attach");
		await waitFor(
			() => ext3.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"preload replay after fresh root following ordinary disconnect",
		);
		const replay = ext3.rpcs("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(replay?.params).toEqual({
			source: "window.__relayInjected = true;",
		});
		// Exactly one registration on the fresh root — no untracked duplicate that
		// would run on every future document.
		expect(ext3.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);
		ack(bridge, ext3, "send", { identifier: "root-script-after-fresh-root" });
		await flush();
	});

	it("removes preload scripts when their connection closes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		await attachPage(bridge, ext, holder, holderConn, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: addId,
				sessionId: ownerSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__ownerScript = true;" },
			}),
		);
		await waitFor(
			() =>
				ext
					.rpcs("send")
					.some(
						rpc => rpc.id === ext.rpcs("send")[0]?.id && rpc.method === "Page.addScriptToEvaluateOnNewDocument",
					),
			"preload-script install",
		);
		ack(bridge, ext, "send", { identifier: "root-script-before-close" });
		await flush();
		expect(owner.messages.filter(message => message.id === addId && "result" in message)).toHaveLength(1);

		bridge.cdpClosed(ownerConn);
		await waitFor(
			() =>
				ext
					.rpcs("send")
					.some(
						rpc =>
							rpc.method === "Page.removeScriptToEvaluateOnNewDocument" &&
							(rpc.params as { identifier?: string } | undefined)?.identifier === "root-script-before-close",
					),
			"preload-script cleanup after connection close",
		);
		ack(bridge, ext, "send");
		await flush();
		expect(ext.rpcs("detach")).toHaveLength(0);
	});

	it("retains later preload cleanups after a stale identifier fails to remove", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		await attachPage(bridge, ext, holder, holderConn, 1);

		// Register two preload scripts on the same owner so its disconnect queues
		// two cleanup entries back to back.
		const firstAddId = ++msgSeq;
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: firstAddId,
				sessionId: ownerSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__first = true;" },
			}),
		);
		await flush();
		ack(bridge, ext, "send", { identifier: "stale-old-root-script" });
		await flush();

		const secondAddId = ++msgSeq;
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: secondAddId,
				sessionId: ownerSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__second = true;" },
			}),
		);
		await flush();
		ack(bridge, ext, "send", { identifier: "valid-fresh-root-script" });
		await flush();

		// The owner disconnects, queuing cleanup for both identifiers.
		bridge.cdpClosed(ownerConn);
		await waitFor(
			() =>
				ext
					.rpcs("send")
					.some(
						rpc =>
							rpc.method === "Page.removeScriptToEvaluateOnNewDocument" &&
							(rpc.params as { identifier?: string } | undefined)?.identifier === "stale-old-root-script",
					),
			"first (stale) preload cleanup attempt",
		);

		// The stale old-root identifier fails to remove with an ordinary,
		// non-transport error. This must not clear the queue: the later valid
		// cleanup has to still be drained so the freshly replayed script does not
		// stay active without an owner.
		nack(bridge, ext, "send", "No script for given id");
		await waitFor(
			() =>
				ext
					.rpcs("send")
					.some(
						rpc =>
							rpc.method === "Page.removeScriptToEvaluateOnNewDocument" &&
							(rpc.params as { identifier?: string } | undefined)?.identifier === "valid-fresh-root-script",
					),
			"later valid preload cleanup after stale failure",
		);
		const removeMethods = ext
			.rpcs("send")
			.filter(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument")
			.map(rpc => (rpc.params as { identifier?: string } | undefined)?.identifier);
		expect(removeMethods).toEqual(["stale-old-root-script", "valid-fresh-root-script"]);
		ack(bridge, ext, "send");
		await flush();
	});

	it("forces a fresh root after an interrupted initial preload registration", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Issue the initial registration, then drop the socket ordinarily before
		// its result arrives. Chrome may already hold the (unjournaled)
		// registration, so the next recovery must not reuse the surviving root.
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();
		// The client sees the interrupted command fail.
		expect(cdp.messages.some(m => m.id === addId && "error" in m)).toBe(true);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		// forceFreshRootBeforeReplay must drive a detach → attach cycle so the
		// orphaned initial registration is dropped rather than left duplicated on
		// the surviving root.
		await waitFor(() => ext2.rpcs("detach").length === 1, "fresh-root detach after interrupted initial registration");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.rpcs("attach").length === 1, "fresh-root attach after interrupted initial registration");
		ack(bridge, ext2, "attach");
		await flush();
		// Nothing was journaled, so there is no preload replay on the fresh root.
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(0);
	});

	it("forces a fresh root after an initial preload registration times out", async () => {
		vi.useFakeTimers();
		try {
			const bridge = new RelayBridge({});
			const ext = new FakeExtSocket();
			connect(bridge, ext, [tab({ tabId: 1 })]);
			const cdp = new FakeCdpSocket();
			const connId = bridge.cdpConnected(cdp);
			const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

			const addId = ++msgSeq;
			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: addId,
					sessionId: pageSession,
					method: "Page.addScriptToEvaluateOnNewDocument",
					params: { source: "window.__relayTimedOut = true;" },
				}),
			);
			await waitFor(
				() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
				"initial preload registration RPC before timeout",
			);
			vi.advanceTimersByTime(20_000);
			await flush();
			expect(cdp.messages.some(m => m.id === addId && "error" in m)).toBe(true);
			expect(ext.closeCount).toBe(1);

			const ext2 = new FakeExtSocket();
			connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
				attachedTabIds: [1],
				recoverableTabIds: [1],
			});
			await waitFor(
				() => ext2.rpcs("detach").length === 1,
				"fresh-root detach after timed-out initial registration",
			);
			ack(bridge, ext2, "detach");
			await waitFor(
				() => ext2.rpcs("attach").length === 1,
				"fresh-root attach after timed-out initial registration",
			);
			ack(bridge, ext2, "attach");
			await flush();
			expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(
				0,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forgets and forces a fresh root after an interrupted preload removal", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await flush();
		ack(bridge, ext, "send", { identifier: "root-script" });
		await flush();
		const addReply = cdp.messages.find(message => message.id === addId);
		const clientIdentifier =
			addReply &&
			"result" in addReply &&
			addReply.result &&
			typeof addReply.result === "object" &&
			"identifier" in addReply.result &&
			typeof addReply.result.identifier === "string"
				? addReply.result.identifier
				: undefined;
		expect(clientIdentifier).toBeDefined();

		// Issue the removal, then drop the socket ordinarily before its result
		// arrives. Chrome may already have removed the script.
		const removeId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: removeId,
				sessionId: pageSession,
				method: "Page.removeScriptToEvaluateOnNewDocument",
				params: { identifier: clientIdentifier },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument"),
			"interrupted preload removal RPC",
		);
		bridge.extClosed(ext);
		await flush();
		expect(cdp.messages.some(m => m.id === removeId && "error" in m)).toBe(true);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		// The interrupted removal forces a fresh root: detach → attach.
		await waitFor(() => ext2.rpcs("detach").length === 1, "fresh-root detach after interrupted removal");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.rpcs("attach").length === 1, "fresh-root attach after interrupted removal");
		ack(bridge, ext2, "attach");
		await flush();
		// The journal entry was forgotten, so recovery must NOT resurrect the
		// explicitly removed script by replaying it onto the fresh root.
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(0);
	});

	it("forces a fresh root after an interrupted tracked shared-root setter", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Issue a tracked shared-root setter (Fetch.enable), then drop the socket
		// ordinarily before its result arrives. Chrome may already hold the enable,
		// but #recordSubscription never ran, so the journal has no record of it.
		const enableId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: enableId,
				sessionId: pageSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "*" }] },
			}),
		);
		await waitFor(() => ext.rpcs("send").some(rpc => rpc.method === "Fetch.enable"), "interrupted Fetch.enable RPC");
		bridge.extClosed(ext);
		await flush();
		// The client sees the interrupted command fail.
		expect(cdp.messages.some(m => m.id === enableId && "error" in m)).toBe(true);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		// The ambiguous tracked setter forces a fresh root: detach → attach, so a
		// reconnect cannot reuse a root carrying an untracked Fetch.enable that
		// owner cleanup can neither see nor disable.
		await waitFor(() => ext2.rpcs("detach").length === 1, "fresh-root detach after interrupted tracked setter");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.rpcs("attach").length === 1, "fresh-root attach after interrupted tracked setter");
		ack(bridge, ext2, "attach");
		await flush();
		// The enable was never journaled, so nothing replays it onto the fresh root.
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Fetch.enable")).toHaveLength(0);
	});

	it("forces a fresh root when the extension reports guard-only Page state", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
			freshRootRequiredTabIds: [1],
		});

		await waitFor(() => ext2.rpcs("detach").length === 1, "fresh-root detach after guard failure");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.rpcs("attach").length === 1, "fresh-root attach after guard failure");
		ack(bridge, ext2, "attach");
		await flush();

		expect(cdp.messages.some(message => message.method === "Target.detachedFromTarget")).toBe(false);
	});

	it("forgets and forces a fresh root after an interrupted Runtime.removeBinding", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Install a binding so the per-name journal entry exists.
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Runtime.addBinding",
				params: { name: "ompExposed" },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.some(m => m.id === addId && "result" in m)).toBe(true);

		// Issue the removal, then drop the socket ordinarily before its result
		// arrives. Chrome may already have removed the binding.
		const removeId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: removeId,
				sessionId: pageSession,
				method: "Runtime.removeBinding",
				params: { name: "ompExposed" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Runtime.removeBinding"),
			"interrupted removeBinding RPC",
		);
		bridge.extClosed(ext);
		await flush();
		expect(cdp.messages.some(m => m.id === removeId && "error" in m)).toBe(true);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		// The interrupted removal forces a fresh root: detach → attach.
		await waitFor(() => ext2.rpcs("detach").length === 1, "fresh-root detach after interrupted removeBinding");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.rpcs("attach").length === 1, "fresh-root attach after interrupted removeBinding");
		ack(bridge, ext2, "attach");
		await flush();
		// The journal entry was forgotten, so recovery must NOT resurrect the
		// explicitly removed binding by replaying it onto the fresh root.
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Runtime.addBinding")).toHaveLength(0);
	});

	it("forgets and forces a fresh root after an interrupted shared-root clear", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Establish a tracked shared-root subscription (Fetch.enable) so the
		// journal records an enable under the `Fetch.enable` key.
		const enableId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: enableId,
				sessionId: pageSession,
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "*" }] },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.some(m => m.id === enableId && "result" in m)).toBe(true);

		// Issue the tab-wide clear (Fetch.disable), then drop the socket
		// ordinarily before its result arrives. Chrome may already have disabled
		// interception, but #recordSubscription never ran to forget the journaled
		// enable.
		const disableId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: disableId,
				sessionId: pageSession,
				method: "Fetch.disable",
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Fetch.disable"),
			"interrupted Fetch.disable RPC",
		);
		bridge.extClosed(ext);
		await flush();
		expect(cdp.messages.some(m => m.id === disableId && "error" in m)).toBe(true);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		// The interrupted clear forces a fresh root: detach → attach.
		await waitFor(() => ext2.rpcs("detach").length === 1, "fresh-root detach after interrupted clear");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.rpcs("attach").length === 1, "fresh-root attach after interrupted clear");
		ack(bridge, ext2, "attach");
		await flush();
		// The journaled enable was forgotten, so recovery must NOT resurrect the
		// explicitly disabled interception by replaying Fetch.enable onto the
		// fresh root.
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Fetch.enable")).toHaveLength(0);
	});

	for (const [field, cleared, expectedReplay] of [
		["media", "", { features: [{ name: "prefers-color-scheme", value: "dark" }] }],
		["features", [], { media: "print" }],
	] as const) {
		it(`preserves an interrupted emulated-media ${field} clear`, async () => {
			const bridge = new RelayBridge({});
			const ext = new FakeExtSocket();
			connect(bridge, ext, [tab({ tabId: 1 })]);
			const cdp = new FakeCdpSocket();
			const connId = bridge.cdpConnected(cdp);
			const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

			const setId = ++msgSeq;
			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: setId,
					sessionId: pageSession,
					method: "Emulation.setEmulatedMedia",
					params: {
						media: "print",
						features: [{ name: "prefers-color-scheme", value: "dark" }],
					},
				}),
			);
			await flush();
			ack(bridge, ext, "send");
			await flush();

			const clearId = ++msgSeq;
			bridge.cdpMessage(
				connId,
				JSON.stringify({
					id: clearId,
					sessionId: pageSession,
					method: "Emulation.setEmulatedMedia",
					params: { [field]: cleared },
				}),
			);
			await waitFor(() => ext.rpcs("send").length === 2, `interrupted emulated-media ${field} clear`);
			bridge.extClosed(ext);
			await flush();

			const ext2 = new FakeExtSocket();
			connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
				attachedTabIds: [1],
				recoverableTabIds: [1],
			});
			await waitFor(() => ext2.rpcs("detach").length === 1, `fresh-root detach after interrupted ${field} clear`);
			ack(bridge, ext2, "detach");
			await waitFor(() => ext2.rpcs("attach").length === 1, `fresh-root attach after interrupted ${field} clear`);
			ack(bridge, ext2, "attach");
			await flush();
			const replays = ext2.rpcs("send").filter(rpc => rpc.method === "Emulation.setEmulatedMedia");
			expect(replays).toHaveLength(1);
			expect(replays[0]).toMatchObject({ params: expectedReplay });
		});
	}

	it("preserves recovery authorization when the forced-root detach outlives its socket", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare Target.attachToTarget holder: its page session must survive recovery.
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Interrupt an initial preload registration to arm forceFreshRootBeforeReplay.
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();
		expect(cdp.messages.some(m => m.id === addId && "error" in m)).toBe(true);

		// First reconnect drives the forced fresh-root detach; it goes in flight.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("detach").length === 1, "forced fresh-root detach in flight");
		// The extension executed the relay-initiated detach (dropping the tab from
		// recoverableTabIds) but the socket dies before its result returns.
		bridge.extClosed(ext2);
		await flush();

		// The replacement hello reports the tab NOT attached and NOT recoverable,
		// yet forceFreshRootBeforeReplay still records an in-progress recovery. The
		// bridge must preserve the recovery authorization and finish the reattach
		// instead of treating it as a user detach that strands the holder.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [],
			recoverableTabIds: [],
			relayDetachedTabIds: [1],
		});
		await waitFor(
			() => ext3.rpcs("attach").length === 1,
			"recovery reattach after forced-root detach lost its socket",
		);
		ack(bridge, ext3, "attach");
		await flush();

		// The preserved page session survived: its command routes to the reattached
		// tab instead of failing "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		ack(bridge, ext3, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		expect(ext3.rpcs("send").some(rpc => rpc.tabId === 1)).toBe(true);
	});

	it("honors a user revocation that interrupts a forced-root detach before reconnect", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(() => ext.pending("send").length === 1, "interrupted preload registration");
		bridge.extClosed(ext);
		await flush();

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("detach").length === 1, "forced-root detach");
		bridge.extClosed(ext2);
		await flush();

		// The extension observed a user Cancel / DevTools takeover, so its hello
		// explicitly omits a completed relay detach despite the bridge still having
		// an interrupted refresh RPC. User intent wins and the stale session dies.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [],
			recoverableTabIds: [],
			relayDetachedTabIds: [],
		});
		await flush();

		expect(ext3.rpcs("attach")).toHaveLength(0);
		const cmdId = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: cmdId, sessionId: pageSession, method: "Runtime.evaluate" }));
		await flush();
		expect(cdp.messages.find(message => message.id === cmdId)?.error).toBeDefined();
	});

	it("drops spent fresh-root recovery after the last holder disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const owner = new FakeCdpSocket();
		const ownerId = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerId, 1);

		bridge.cdpMessage(
			ownerId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: ownerSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		bridge.extClosed(ext);
		await flush();
		bridge.cdpClosed(ownerId);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })], {
			attachedTabIds: [],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("forgetRecovery").length === 1);
		ack(bridge, ext2, "forgetRecovery");

		const replacement = new FakeCdpSocket();
		const replacementId = bridge.cdpConnected(replacement);
		await attachPage(bridge, ext2, replacement, replacementId, 1);
		const detachesBeforeHello = ext2.rpcs("detach").length;
		connect(bridge, ext2, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await flush();

		expect(ext2.rpcs("detach")).toHaveLength(detachesBeforeHello);
	});

	it("retracts preserved sessions when a forced-root detach fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("detach").length === 1, "forced fresh-root detach issued");
		nack(bridge, ext2, "detach", "detach denied");
		await flush();

		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		await flush();
		expect(cdp.messages.find(message => message.id === cmdId)?.error).toBeDefined();
		expect(ext2.pending("detach")).toHaveLength(1);
		nack(bridge, ext2, "detach", "cleanup detach denied");
		await flush();
		expect(ext2.closeCount).toBe(1);
	});

	it("clears refresh authorization after a recovery reattach so a later user detach is honored", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Arm forceFreshRootBeforeReplay via an interrupted initial preload add.
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();

		// First reconnect drives the forced fresh-root detach in flight, then the
		// socket dies before its result returns (dropping the tab from
		// recoverableTabIds on the extension while refreshDetachInFlight stays set).
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("detach").length === 1, "forced fresh-root detach in flight");
		bridge.extClosed(ext2);
		await flush();

		// Replacement hello reports the tab unattached + non-recoverable, so recovery
		// reattaches under the still-live refresh authorization. This settling must
		// clear refreshDetachInFlight.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [],
			recoverableTabIds: [],
		});
		await waitFor(
			() => ext3.rpcs("attach").length === 1,
			"recovery reattach after forced-root detach lost its socket",
		);
		ack(bridge, ext3, "attach");
		await flush();

		// Now the socket drops again and the user clicks Cancel (or DevTools takes
		// over) while it is down, so the next hello omits the tab from
		// recoverableTabIds. With the stale authorization cleared, this is a genuine
		// user detach and must be honored — not reattached against the user's intent.
		bridge.extClosed(ext3);
		await flush();
		const ext4 = new FakeExtSocket();
		connect(bridge, ext4, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [],
			recoverableTabIds: [],
		});
		await flush();

		expect(ext4.rpcs("attach")).toHaveLength(0);
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		await flush();
		const reply2 = cdp.messages.find(m => m.id === cmdId);
		expect(reply2?.error).toBeDefined();
	});

	it("clears refresh authorization after a terminal reattach failure so a later user detach is honored", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Arm forceFreshRootBeforeReplay via an interrupted initial preload add.
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();

		// Reconnect drives the forced fresh-root detach; it settles cleanly, then the
		// follow-up reattach fails TERMINALLY on the same live socket (DevTools or
		// another debugger claimed the tab), returning ok:false rather than a
		// transport interruption. This is the branch that retracts the tab.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("detach").length === 1, "forced fresh-root detach issued");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.pending("attach").length === 1, "recovery reattach in flight after detach settled");
		nack(bridge, ext2, "attach", "busy");
		await flush();

		// A navigation clears the transient ban, then a fresh client successfully
		// attaches a new page session on the same live socket. This path never goes
		// through a refresh detach, so if the terminal-failure branch left
		// refreshDetachInFlight set, it now survives as stale authorization.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "tabUpdated",
				tab: tab({ tabId: 1, groupId: -1, url: "https://example.com/next" }),
			}),
		);
		await flush();
		const pageSession2 = await attachPage(bridge, ext2, cdp, connId, 1);

		// The socket drops and the user clicks Cancel (or DevTools takes over) while
		// it is down, so the reconnect hello omits the tab from recoverableTabIds.
		// With the stale authorization cleared, this is a genuine user detach and must
		// be honored — not reattached against the user's intent.
		bridge.extClosed(ext2);
		await flush();
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1, url: "https://example.com/next" })], {
			attachedTabIds: [],
			recoverableTabIds: [],
		});
		await flush();

		expect(ext3.rpcs("attach")).toHaveLength(0);
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession2,
				method: "Runtime.evaluate",
			}),
		);
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeDefined();
	});

	it("keeps refresh authorization when the forced detach settles but the reattach loses its socket", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Arm forceFreshRootBeforeReplay via an interrupted initial preload add.
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();

		// Reconnect drives the forced fresh-root detach. This time the detach RPC
		// SETTLES cleanly (tab.attached -> false), but the follow-up reattach is
		// interrupted by a socket drop before the extension persists a fresh
		// recovery marker. The relay-initiated detach already removed the tab from
		// recoverableTabIds, so the replacement hello lands unattached +
		// non-recoverable while recovery is still mid-reattach.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("detach").length === 1, "forced fresh-root detach issued");
		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.pending("attach").length === 1, "recovery reattach in flight after detach settled");
		bridge.extClosed(ext2);
		await flush();

		// refreshDetachInFlight must still be set: the reattach never confirmed a
		// new recovery marker, so this replacement hello is the in-flight refresh,
		// not a user detach. The bridge must reattach and preserve the session.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [],
			recoverableTabIds: [],
		});
		await waitFor(() => ext3.rpcs("attach").length === 1, "recovery reattach after the interrupted reattach");
		ack(bridge, ext3, "attach");
		await flush();

		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		ack(bridge, ext3, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		expect(ext3.rpcs("send").some(rpc => rpc.tabId === 1)).toBe(true);
	});

	it("honors a user detach that arrives while only a fresh-root replay is pending", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Interrupt an initial preload registration: this arms
		// forceFreshRootBeforeReplay, but no relay-initiated refresh detach has run
		// yet (the socket dropped before recovery started).
		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await waitFor(
			() => ext.rpcs("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
			"initial preload registration RPC",
		);
		bridge.extClosed(ext);
		await flush();
		expect(cdp.messages.some(m => m.id === addId && "error" in m)).toBe(true);

		// The user clicks Cancel (or DevTools takes over) while the socket is down,
		// so the reconnect hello omits the tab from recoverableTabIds. Because no
		// refresh detach was ever issued (refreshDetachInFlight is false), this is a
		// genuine user detach and must be honored — not overridden by the pending
		// fresh-root flag.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [],
			recoverableTabIds: [],
		});
		await flush();

		// The tab was not reattached, and the stale preserved session is invalidated.
		expect(ext2.rpcs("attach")).toHaveLength(0);
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeDefined();
	});

	it("clears the transient ban when an ordinary disconnect interrupts a recovery attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// Bare holder: only Target.attachToTarget, so its page session must survive.
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		// First reconnect arms a forced recovery attach that goes in flight.
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("attach").length === 1, "recovery attach in flight");

		// An ORDINARY disconnect (not a replacement) rejects the in-flight attach
		// with "relay extension disconnected": #ensureAttached bans the tab because
		// it only exempts ExtensionReplacedError. The recovery must clear that
		// transient ban so the replacement hello can re-attach the same-URL tab
		// instead of having its preserved session retracted.
		bridge.extClosed(ext2);
		await flush();

		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext3.pending("attach").length === 1, "replacement hello re-attaches the un-banned tab");
		ack(bridge, ext3, "attach");
		await flush();

		// The preserved page session survived: its command routes to the reattached
		// tab instead of failing "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		ack(bridge, ext3, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
		expect(ext3.rpcs("send").some(rpc => rpc.tabId === 1)).toBe(true);
	});

	it("clears replayed timezone overrides when their owner disconnects during recovery", async () => {
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
				method: "Emulation.setTimezoneOverride",
				params: { timezoneId: "Asia/Shanghai" },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "timezone replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setTimezoneOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({
			timezoneId: "Asia/Shanghai",
		});

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "orphaned timezone cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setTimezoneOverride",
			"Emulation.setTimezoneOverride",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ timezoneId: "" });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setTimezoneOverride",
			"Emulation.setTimezoneOverride",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats an empty timezone override as a tab-wide clear before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setTimezoneOverride", {
			timezoneId: "Asia/Shanghai",
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setTimezoneOverride", { timezoneId: "" });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("replays preserved script-execution disables across recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Emulation.setScriptExecutionDisabled",
				params: { value: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "script execution replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setScriptExecutionDisabled"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ value: true });
		ack(bridge, ext2, "send");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(1);
	});

	it("clears replayed script-execution disables when their owner disconnects during recovery", async () => {
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
				method: "Emulation.setScriptExecutionDisabled",
				params: { value: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "script execution replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setScriptExecutionDisabled"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ value: true });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "script execution cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setScriptExecutionDisabled",
			"Emulation.setScriptExecutionDisabled",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ value: false });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setScriptExecutionDisabled",
			"Emulation.setScriptExecutionDisabled",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats script-execution re-enables as a tab-wide clear before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setScriptExecutionDisabled", { value: true });
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setScriptExecutionDisabled", { value: false });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("replays preserved drag interception across recovery and clears orphaned owners", async () => {
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
				method: "Input.setInterceptDrags",
				params: { enabled: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "drag interception replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Input.setInterceptDrags"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ enabled: true });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "drag interception cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Input.setInterceptDrags", "Input.setInterceptDrags"]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ enabled: false });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Input.setInterceptDrags",
			"Input.setInterceptDrags",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats a drag-interception disable as a tab-wide clear so a stale enable is not revived", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		// Owner enables drag interception on the shared root; another session then
		// disables it. Chrome resets that root state, so the earlier enable must not
		// survive to be replayed after guard recovery.
		await sendRootCommand(ownerConn, ownerSession, "Input.setInterceptDrags", {
			enabled: true,
		});
		await sendRootCommand(clearerConn, clearerSession, "Input.setInterceptDrags", { enabled: false });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("replays preserved file-chooser interception across recovery and clears orphaned owners", async () => {
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
				method: "Page.setInterceptFileChooserDialog",
				params: { enabled: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "file chooser recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "file chooser replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Page.setInterceptFileChooserDialog"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ enabled: true });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "file chooser cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Page.setInterceptFileChooserDialog",
			"Page.setInterceptFileChooserDialog",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ enabled: false });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Page.setInterceptFileChooserDialog",
			"Page.setInterceptFileChooserDialog",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats a file-chooser disable as a tab-wide clear so a stale enable is not revived", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Page.setInterceptFileChooserDialog", { enabled: true });
		await sendRootCommand(clearerConn, clearerSession, "Page.setInterceptFileChooserDialog", { enabled: false });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "file chooser clear recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("replays preserved certificate-error overrides across recovery and clears orphaned owners", async () => {
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
				method: "Security.setIgnoreCertificateErrors",
				params: { ignore: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "certificate override replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Security.setIgnoreCertificateErrors"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ ignore: true });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "certificate override cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Security.setIgnoreCertificateErrors",
			"Security.setIgnoreCertificateErrors",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ ignore: false });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Security.setIgnoreCertificateErrors",
			"Security.setIgnoreCertificateErrors",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays preserved service-worker bypass across recovery and clears orphaned owners", async () => {
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
				method: "Network.setBypassServiceWorker",
				params: { bypass: true },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "service-worker bypass replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setBypassServiceWorker"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ bypass: true });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "service-worker bypass cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setBypassServiceWorker",
			"Network.setBypassServiceWorker",
		]);
		expect(ext2.rpcs("send")[1]!.params).toEqual({ bypass: false });
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setBypassServiceWorker",
			"Network.setBypassServiceWorker",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays default background overrides across recovery and clears orphaned owners", async () => {
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
				method: "Emulation.setDefaultBackgroundColorOverride",
				params: { color: { r: 0, g: 0, b: 0, a: 0 } },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "default background replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setDefaultBackgroundColorOverride"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({
			color: { r: 0, g: 0, b: 0, a: 0 },
		});

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "default background cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setDefaultBackgroundColorOverride",
			"Emulation.setDefaultBackgroundColorOverride",
		]);
		expect(ext2.rpcs("send")[1]!.params).toBeUndefined();
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setDefaultBackgroundColorOverride",
			"Emulation.setDefaultBackgroundColorOverride",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays page-scale overrides across recovery and clears orphaned owners", async () => {
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
				method: "Emulation.setPageScaleFactor",
				params: { pageScaleFactor: 1.5 },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "page scale replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setPageScaleFactor"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({ pageScaleFactor: 1.5 });

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "page scale cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setPageScaleFactor",
			"Emulation.resetPageScaleFactor",
		]);
		expect(ext2.rpcs("send")[1]!.params).toBeUndefined();
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setPageScaleFactor",
			"Emulation.resetPageScaleFactor",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats a page-scale reset as a tab-wide clear before recovery", async () => {
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
				method: "Emulation.setPageScaleFactor",
				params: { pageScaleFactor: 1.5 },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: holderSession,
				method: "Emulation.resetPageScaleFactor",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "page-scale reset recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("tracks a page-scale reset while it is in flight so owner cleanup wins", async () => {
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
				method: "Emulation.setPageScaleFactor",
				params: { pageScaleFactor: 1.5 },
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: holderSession,
				method: "Emulation.resetPageScaleFactor",
			}),
		);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setPageScaleFactor",
			"Emulation.resetPageScaleFactor",
		]);

		bridge.cdpClosed(holderConn);
		ack(bridge, ext, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id: commandId,
				sessionId: ownerSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setPageScaleFactor",
			"Emulation.resetPageScaleFactor",
			"Network.getCookies",
		]);
		ack(bridge, ext, "send", { cookies: [] });
		await flush();
		expect(owner.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "page-scale reset cleanup recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
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

		const metrics = {
			width: 1280,
			height: 720,
			deviceScaleFactor: 1,
			mobile: false,
		};
		await sendRootCommand("Emulation.setDeviceMetricsOverride", metrics);
		await sendRootCommand("Emulation.clearDeviceMetricsOverride");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("does not replay a persistent root setter after another session clears it", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		const metrics = {
			width: 1280,
			height: 720,
			deviceScaleFactor: 1,
			mobile: false,
		};
		await sendRootCommand(ownerConn, ownerSession, "Emulation.setDeviceMetricsOverride", metrics);
		await sendRootCommand(clearerConn, clearerSession, "Emulation.clearDeviceMetricsOverride");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("merges emulated media fields across same-session updates before recovery replay", async () => {
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

		await sendRootCommand("Emulation.setEmulatedMedia", { media: "print" });
		await sendRootCommand("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "emulated media replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "print",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});
	});

	it("replays emulated media using per-field freshness across interleaved owners", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const updater = new FakeCdpSocket();
		const updaterConn = bridge.cdpConnected(updater);
		const updaterSession = await attachPage(bridge, ext, updater, updaterConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setEmulatedMedia", { media: "print" });
		await sendRootCommand(updaterConn, updaterSession, "Emulation.setEmulatedMedia", { media: "screen" });
		await sendRootCommand(ownerConn, ownerSession, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "interleaved emulated media replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "screen",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});
	});

	it("preserves emulated media field clears across owner loss before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setEmulatedMedia", {
			media: "print",
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setEmulatedMedia", { media: "" });
		bridge.cdpClosed(clearerConn);

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "emulated media replay with media clear");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});
	});

	it("merges emulated media fields across session owners before recovery replay", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const updater = new FakeCdpSocket();
		const updaterConn = bridge.cdpConnected(updater);
		const updaterSession = await attachPage(bridge, ext, updater, updaterConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setEmulatedMedia", { media: "print" });
		await sendRootCommand(updaterConn, updaterSession, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");

		await waitFor(() => ext2.rpcs("send").length === 1, "cross-owner emulated media replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "print",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});
	});

	it("clears departed emulated-media dimensions when a replay owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const mediaOwner = new FakeCdpSocket();
		const mediaOwnerConn = bridge.cdpConnected(mediaOwner);
		const mediaOwnerSession = await attachPage(bridge, ext, mediaOwner, mediaOwnerConn, 1);
		const featuresOwner = new FakeCdpSocket();
		const featuresOwnerConn = bridge.cdpConnected(featuresOwner);
		const featuresOwnerSession = await attachPage(bridge, ext, featuresOwner, featuresOwnerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(mediaOwnerConn, mediaOwnerSession, "Emulation.setEmulatedMedia", { media: "print" });
		await sendRootCommand(featuresOwnerConn, featuresOwnerSession, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "emulated media replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "print",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});

		bridge.cdpClosed(mediaOwnerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "replayed emulated-media cleanup");
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});
	});

	it("preserves the earliest previous media state when coalescing queued cleanup changes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const mediaOwner = new FakeCdpSocket();
		const mediaOwnerConn = bridge.cdpConnected(mediaOwner);
		const mediaOwnerSession = await attachPage(bridge, ext, mediaOwner, mediaOwnerConn, 1);
		const featuresOwner = new FakeCdpSocket();
		const featuresOwnerConn = bridge.cdpConnected(featuresOwner);
		const featuresOwnerSession = await attachPage(bridge, ext, featuresOwner, featuresOwnerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		void (await attachPage(bridge, ext, holder, holderConn, 1));

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(mediaOwnerConn, mediaOwnerSession, "Emulation.setEmulatedMedia", { media: "print" });
		await sendRootCommand(featuresOwnerConn, featuresOwnerSession, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});

		bridge.cdpClosed(mediaOwnerConn);
		await waitFor(() => ext.pending("send").length === 1, "first queued emulated-media cleanup");
		expect(ext.pending("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "",
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			},
		});

		bridge.cdpClosed(featuresOwnerConn);
		ack(bridge, ext, "send");
		await waitFor(() => ext.rpcs("send").length === 4, "coalesced empty emulated-media cleanup");
		expect(ext.rpcs("send")[3]).toMatchObject({
			method: "Emulation.setEmulatedMedia",
			params: {
				media: "",
				features: [],
			},
		});
	});

	it("replays idle emulation after guard recovery and clears it when the owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setIdleOverride", {
			isUserActive: false,
			isScreenUnlocked: false,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "idle override replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setIdleOverride",
			params: { isUserActive: false, isScreenUnlocked: false },
		});
		ack(bridge, ext2, "send");
		await flush();

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext2.rpcs("send").length === 2, "idle override cleanup after owner loss");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setIdleOverride",
			"Emulation.clearIdleOverride",
		]);
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setIdleOverride",
			"Emulation.clearIdleOverride",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("waits for an in-flight idle override before live owner-loss cleanup", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		await attachPage(bridge, ext, holder, holderConn, 1);

		const id = ++msgSeq;
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id,
				sessionId: ownerSession,
				method: "Emulation.setIdleOverride",
				params: { isUserActive: false, isScreenUnlocked: false },
			}),
		);
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Emulation.setIdleOverride"]);

		bridge.cdpClosed(ownerConn);
		await flush();
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual(["Emulation.setIdleOverride"]);

		ack(bridge, ext, "send");
		await flush();
		await waitFor(() => ext.rpcs("send").length === 2, "idle cleanup after in-flight owner loss");
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setIdleOverride",
			"Emulation.clearIdleOverride",
		]);
	});

	it("waits for an in-flight file-chooser interception before live owner-loss cleanup", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		await attachPage(bridge, ext, holder, holderConn, 1);

		const id = ++msgSeq;
		bridge.cdpMessage(
			ownerConn,
			JSON.stringify({
				id,
				sessionId: ownerSession,
				method: "Page.setInterceptFileChooserDialog",
				params: { enabled: true },
			}),
		);
		await flush();
		// The enable is in flight (not yet acked) when its owner disconnects.
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Page.setInterceptFileChooserDialog"]);

		bridge.cdpClosed(ownerConn);
		await flush();
		// Owner-loss cleanup must wait for the in-flight enable rather than racing
		// ahead: no clear is issued while the enable is still outstanding.
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual(["Page.setInterceptFileChooserDialog"]);

		ack(bridge, ext, "send");
		await flush();
		await waitFor(() => ext.rpcs("send").length === 2, "file-chooser cleanup after in-flight owner loss");
		// The late success is reconciled: the now-orphaned interception is torn
		// down so it does not linger enabled on the shared root.
		expect(ext.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Page.setInterceptFileChooserDialog",
			"Page.setInterceptFileChooserDialog",
		]);
		expect(ext.rpcs("send")[1]!.params).toEqual({ enabled: false });
	});

	it("clears persistent root setters across Page and Emulation aliases before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Page.setDeviceMetricsOverride", {
			width: 1280,
			height: 720,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.clearDeviceMetricsOverride");

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setGeolocationOverride", {
			latitude: 37.7749,
			longitude: -122.4194,
			accuracy: 10,
		});
		await sendRootCommand(clearerConn, clearerSession, "Page.clearGeolocationOverride");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("keeps tab-wide clear commands after the issuing session disconnects before the reply", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

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

		bridge.cdpMessage(
			clearerConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: clearerSession,
				method: "Fetch.disable",
			}),
		);
		await flush();
		bridge.cdpClosed(clearerConn);
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("drops tab-wide empty-value clears across session owners before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Network.setExtraHTTPHeaders", {
			headers: { "x-owner": "1" },
		});
		await sendRootCommand(clearerConn, clearerSession, "Network.setExtraHTTPHeaders", { headers: {} });

		await sendRootCommand(ownerConn, ownerSession, "Network.setBlockedURLs", {
			urls: ["https://blocked.example/*"],
		});
		await sendRootCommand(clearerConn, clearerSession, "Network.setBlockedURLs", { urls: [] });
		await sendRootCommand(ownerConn, ownerSession, "Network.setBlockedURLs", {
			urlPatterns: [{ urlPattern: "https://pattern.example/*" }],
		});
		await sendRootCommand(clearerConn, clearerSession, "Network.setBlockedURLs", { urlPatterns: [] });

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setLocaleOverride", { locale: "fr-FR" });
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setLocaleOverride", {});
		await sendRootCommand(ownerConn, ownerSession, "Emulation.setLocaleOverride", { locale: "de-DE" });
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setLocaleOverride", { locale: "" });

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setEmulatedMedia", {
			media: "print",
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setEmulatedMedia", {});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("tracks urlPatterns-only blocked URL rules across recovery and cleanup", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Network.setBlockedURLs", {
			urlPatterns: [{ urlPattern: "https://pattern.example/*" }],
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "blocked URL replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Network.setBlockedURLs",
			params: { urlPatterns: [{ urlPattern: "https://pattern.example/*" }] },
		});

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "blocked URL cleanup");
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Network.setBlockedURLs",
			params: { urls: [], urlPatterns: [] },
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await waitFor(() => ext2.rpcs("send").length === 3, "holder command after blocked URL cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setBlockedURLs",
			"Network.setBlockedURLs",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays accepted encodings across recovery and clears them when the owner disappears", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Network.setAcceptedEncodings", {
			encodings: ["gzip", "br"],
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "accepted encodings replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Network.setAcceptedEncodings",
			params: { encodings: ["gzip", "br"] },
		});

		bridge.cdpClosed(ownerConn);
		ack(bridge, ext2, "send");
		await waitFor(() => ext2.rpcs("send").length === 2, "accepted encodings cleanup");
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Network.clearAcceptedEncodings",
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await waitFor(() => ext2.rpcs("send").length === 3, "holder command after accepted encodings cleanup");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Network.setAcceptedEncodings",
			"Network.clearAcceptedEncodings",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("drops idle override clears before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setIdleOverride", {
			isUserActive: false,
			isScreenUnlocked: false,
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.clearIdleOverride");

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("drops tab-wide bypass-service-worker clears before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Network.setBypassServiceWorker", { bypass: true });
		await sendRootCommand(clearerConn, clearerSession, "Network.setBypassServiceWorker", { bypass: false });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("replays vision-deficiency emulation after guard recovery and resets it when the owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setEmulatedVisionDeficiency", {
			type: "blurredVision",
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "vision deficiency replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setEmulatedVisionDeficiency",
			params: { type: "blurredVision" },
		});
		ack(bridge, ext2, "send");
		await flush();

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext2.rpcs("send").length === 2, "vision deficiency cleanup after owner loss");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setEmulatedVisionDeficiency",
			"Emulation.setEmulatedVisionDeficiency",
		]);
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Emulation.setEmulatedVisionDeficiency",
			params: { type: "none" },
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setEmulatedVisionDeficiency",
			"Emulation.setEmulatedVisionDeficiency",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays focus emulation after guard recovery and resets it when the owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setFocusEmulationEnabled", {
			enabled: true,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "focus emulation replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: true },
		});
		ack(bridge, ext2, "send");
		await flush();

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext2.rpcs("send").length === 2, "focus emulation cleanup after owner loss");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setFocusEmulationEnabled",
			"Emulation.setFocusEmulationEnabled",
		]);
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: false },
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setFocusEmulationEnabled",
			"Emulation.setFocusEmulationEnabled",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays hidden-scrollbar emulation after guard recovery and resets it when the owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setScrollbarsHidden", {
			hidden: true,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery reattach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "hidden-scrollbar replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setScrollbarsHidden",
			params: { hidden: true },
		});
		ack(bridge, ext2, "send");
		await flush();

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext2.rpcs("send").length === 2, "hidden-scrollbar cleanup after owner loss");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setScrollbarsHidden",
			"Emulation.setScrollbarsHidden",
		]);
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Emulation.setScrollbarsHidden",
			params: { hidden: false },
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setScrollbarsHidden",
			"Emulation.setScrollbarsHidden",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("replays hardware-concurrency overrides after guard recovery and resets them to the browser default when the owner disconnects", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { hardwareConcurrency: 8 });
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const holder = new FakeCdpSocket();
		const holderConn = bridge.cdpConnected(holder);
		const holderSession = await attachPage(bridge, ext, holder, holderConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setHardwareConcurrencyOverride", {
			hardwareConcurrency: 16,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
			hardwareConcurrency: 8,
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "hardware-concurrency recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "hardware-concurrency replay");
		expect(ext2.rpcs("send")[0]).toMatchObject({
			method: "Emulation.setHardwareConcurrencyOverride",
			params: { hardwareConcurrency: 16 },
		});
		ack(bridge, ext2, "send");
		await flush();

		bridge.cdpClosed(ownerConn);
		await waitFor(() => ext2.rpcs("send").length === 2, "hardware-concurrency cleanup after owner loss");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setHardwareConcurrencyOverride",
			"Emulation.setHardwareConcurrencyOverride",
		]);
		expect(ext2.rpcs("send")[1]).toMatchObject({
			method: "Emulation.setHardwareConcurrencyOverride",
			params: { hardwareConcurrency: 8 },
		});
		ack(bridge, ext2, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			holderConn,
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
		);
		await flush();
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual([
			"Emulation.setHardwareConcurrencyOverride",
			"Emulation.setHardwareConcurrencyOverride",
			"Network.getCookies",
		]);
		ack(bridge, ext2, "send", { cookies: [] });
		await flush();
		expect(holder.messages.filter(message => message.id === commandId && "result" in message)).toHaveLength(1);
	});

	it("treats resetting hardware-concurrency to the browser default as a tab-wide clear before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { hardwareConcurrency: 8 });
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Emulation.setHardwareConcurrencyOverride", {
			hardwareConcurrency: 16,
		});
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setHardwareConcurrencyOverride", {
			hardwareConcurrency: 8,
		});

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
			hardwareConcurrency: 8,
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "hardware-concurrency clear recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("drops tab-wide ignore-certificate-errors clears before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Security.setIgnoreCertificateErrors", { ignore: true });
		await sendRootCommand(clearerConn, clearerSession, "Security.setIgnoreCertificateErrors", { ignore: false });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await flush();

		expect(ext2.rpcs("send")).toHaveLength(0);
	});

	it("clears touch emulation across Page and Emulation aliases before recovery", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const owner = new FakeCdpSocket();
		const ownerConn = bridge.cdpConnected(owner);
		const ownerSession = await attachPage(bridge, ext, owner, ownerConn, 1);
		const clearer = new FakeCdpSocket();
		const clearerConn = bridge.cdpConnected(clearer);
		const clearerSession = await attachPage(bridge, ext, clearer, clearerConn, 1);

		const sendRootCommand = async (
			connId: number,
			sessionId: string,
			method: string,
			params?: Record<string, unknown>,
		): Promise<void> => {
			const id = ++msgSeq;
			bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send");
			await flush();
		};

		await sendRootCommand(ownerConn, ownerSession, "Page.setTouchEmulationEnabled", { enabled: true });
		await sendRootCommand(clearerConn, clearerSession, "Emulation.setTouchEmulationEnabled", { enabled: false });

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.rpcs("attach").length === 1, "recovery attach RPC");
		ack(bridge, ext2, "attach");
		await waitFor(() => ext2.rpcs("send").length === 1, "owner header replay");
		expect(ext2.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.setExtraHTTPHeaders"]);
		expect(ext2.rpcs("send")[0]!.params).toEqual({
			headers: { "x-omp-session": "alive" },
		});

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
			JSON.stringify({
				id: commandId,
				sessionId: holderSession,
				method: "Network.getCookies",
			}),
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
		connect(bridge, ext3, [tab({ tabId: 1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext3.rpcs("send").length === 1, "restarted Network replay");
		expect(ext3.rpcs("attach")).toHaveLength(0);
		expect(ext3.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable"]);
		ack(bridge, ext3, "send");
		await waitFor(() => ext3.rpcs("send").length === 2, "restarted Page replay");
		expect(ext3.rpcs("send").map(rpc => rpc.method)).toEqual(["Network.enable", "Page.enable"]);
		ack(bridge, ext3, "send");
		await flush();

		const commandId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: commandId,
				sessionId: pageSession,
				method: "Page.getFrameTree",
			}),
		);
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: reconnectAutoAttachId,
				method: "Target.setAutoAttach",
			}),
		);
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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

	it("reruns immediate preloads when a replacement socket bypasses the old close callback", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, url: "https://example.com/before" })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;", runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, ext, "send", {});
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"));
		ack(bridge, ext, "send", { identifier: "root-script-before-recovery" });
		await flush();

		const replacement = new FakeExtSocket();
		bridge.extConnected(replacement);
		bridge.extClosed(ext);
		bridge.extMessage(
			replacement,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1, url: "https://example.com/after" })],
				attachedTabIds: [],
				recoverableTabIds: [1],
			}),
		);
		await waitFor(() => replacement.pending("attach").length === 1);
		ack(bridge, replacement, "attach");
		await waitFor(() => replacement.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));
		ack(bridge, replacement, "send", {});
		await waitFor(() =>
			replacement.pending("send").some(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument"),
		);

		const replay = replacement.pending("send").find(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(replay?.params).toEqual({
			source: "window.__relayInjected = true;",
			runImmediately: true,
		});
	});

	it("does not register an immediate preload on a replacement before recovery completes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		const addId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: addId,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;", runImmediately: true },
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Page.getFrameTree"));

		const replacement = new FakeExtSocket();
		bridge.extConnected(replacement);
		await flush();

		expect(replacement.rpcs("send")).toHaveLength(0);
		expect(cdp.messages.find(message => message.id === addId)?.result).toBeUndefined();
	});

	it("re-cycles Runtime for a preserved session that re-enables before the reconnect hello", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		// Enable Runtime on the live session so `ref.runtimeState` becomes "enabled".
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Runtime.enable",
			}),
		);
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: enableId,
				sessionId: pageSession,
				method: "Runtime.enable",
			}),
		);
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);

		// A surviving-session command arrives while attach A is pending.
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Target.setAutoAttach",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Network.enable",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Target.setAutoAttach",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Network.enable",
			}),
		);
		await flush();
		ack(bridge, ext, "send");
		await flush();

		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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

	it("reuses recovery when a same-socket hello reports the forced detach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: "window.__relayInjected = true;" },
			}),
		);
		await flush();
		ack(bridge, ext, "send", { identifier: "root-before-recovery" });
		await flush();

		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Fetch.enable",
			}),
		);
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Fetch.enable"));
		bridge.extClosed(ext);
		await flush();

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			attachedTabIds: [1],
			recoverableTabIds: [1],
		});
		await waitFor(() => ext2.pending("detach").length === 1);
		// Chrome emits the relay detach echo and the extension refreshes hello before
		// the detach RPC result reaches the bridge. No second recovery may start.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "detached",
				tabId: 1,
				reason: "target_closed",
				relayInitiated: true,
			}),
		);
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1, groupId: -1 })],
				attachedTabIds: [],
				recoverableTabIds: [],
			}),
		);
		await flush();
		expect(ext2.rpcs("detach")).toHaveLength(1);
		expect(ext2.rpcs("attach")).toHaveLength(0);

		ack(bridge, ext2, "detach");
		await waitFor(() => ext2.pending("attach").length === 1);
		ack(bridge, ext2, "attach");
		await waitFor(
			() => ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument").length === 1,
			"single preload replay",
		);
		ack(bridge, ext2, "send", { identifier: "root-after-recovery" });
		await flush();
		expect(ext2.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);
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
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstSession,
				method: "Runtime.enable",
			}),
		);
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
		);
		ack(bridge, ext, "send");
		await flush();

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);
		const runtimeSendCount = ext.rpcs("send").length;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondSession,
				method: "Runtime.enable",
			}),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([context]);

		bridge.cdpMessage(
			secondConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondSession,
				method: "Runtime.disable",
			}),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const nextContext = {
			context: { ...context.context, id: 18, uniqueId: "context-18" },
		};
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: nextContext,
			}),
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
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
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: firstSession,
				method: "Runtime.enable",
			}),
		);
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: secondSession,
				method: "Runtime.enable",
			}),
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
	it("resets cached Runtime state when relay detach succeeds before its RPC fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Runtime.disable"));
		ack(bridge, ext, "send");
		await waitFor(() => ext.pending("send").some(rpc => rpc.method === "Runtime.enable"));
		ack(bridge, ext, "send");
		await flush();

		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await waitFor(() => ext.pending("detach").length === 1);
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		// Chrome detached first; failing to persist recovery metadata only rejects
		// the RPC and must not preserve cached state from the dead debugger root.
		nack(bridge, ext, "detach", "failed to persist recovery state");
		await flush();

		const nextSession = await attachPage(bridge, ext, cdp, connId, 1);
		const sendsBeforeEnable = ext.rpcs("send").length;
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: nextSession, method: "Runtime.enable" }));
		await waitFor(() => ext.rpcs("send").length === sendsBeforeEnable + 1);
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext, "send");
		await waitFor(() => ext.rpcs("send").length === sendsBeforeEnable + 2);
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);
		ack(bridge, ext, "send");
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId },
			}),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);

		// Mirror Chrome: onDetach reaches the bridge before detach's RPC result.
		// This echo is expected and must not ban/retract the live target.
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "detached",
				tabId: 1,
				reason: "target_closed",
				relayInitiated: true,
			}),
		);
		ack(bridge, ext, "detach");
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: reattachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1" },
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId },
			}),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: reattachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1" },
			}),
		);
		await flush();
		// Only the initial attach has reached the extension while detach is pending.
		expect(ext.rpcs("attach")).toHaveLength(1);

		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "detached",
				tabId: 1,
				reason: "target_closed",
				relayInitiated: true,
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId },
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId: pageSession },
			}),
		);
		await flush();
		// The tab session still holds the attachment.
		expect(ext.rpcs("detach")).toHaveLength(0);
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId: tabSession },
			}),
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
		connect(bridge, replacement, [tab({ tabId: 1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId },
			}),
		);
		await flush();

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], { attachedTabIds: [1] });
		bridge.extMessage(
			replacement,
			JSON.stringify({
				t: "detached",
				tabId: 1,
				reason: "target_closed",
				relayInitiated: true,
			}),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: reattachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1" },
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1" },
			}),
		);
		await waitFor(() => ext.pending("attach").length === 1, "interrupted attach RPC");

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		await flush();

		const retryId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: retryId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1" },
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.detachFromTarget",
				params: { sessionId },
			}),
		);
		await flush();
		expect(ext.pending("detach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: reattachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1" },
			}),
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
			JSON.stringify({
				t: "detached",
				tabId: 1,
				reason: "target_closed",
				relayInitiated: true,
			}),
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(received);
	});

	it("treats DevTools replacement detaches as user takeovers", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extClosed(ext);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.rpcs("attach")).toHaveLength(1);

		// DevTools taking over the debugger is a real user takeover, not an
		// internal guard detach, so the preserved session must be retracted.
		bridge.extMessage(
			ext2,
			JSON.stringify({
				t: "detached",
				tabId: 1,
				reason: "replaced_with_devtools",
			}),
		);
		await flush();
		expect(cdp.messages.some(message => message.method === "Target.detachedFromTarget")).toBe(true);
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
		await waitFor(() => ext2.rpcs("detach").length === 1, "unheld recovery detach");
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: enableId,
				sessionId: pageSession,
				method: "Runtime.enable",
			}),
		);
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: pageSession,
				method: "Runtime.enable",
			}),
		);
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
		);
		ack(bridge, ext2, "send"); // Runtime.enable leg
		await flush();
		expect(
			cdp.messages.filter(m => m.sessionId === pageSession && m.method === "Runtime.executionContextCreated"),
		).toHaveLength(2);

		// A repeated enable now observes the restored state and acknowledges without
		// driving a redundant third root command.
		const reEnableId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: reEnableId,
				sessionId: pageSession,
				method: "Runtime.enable",
			}),
		);
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: disabledSession,
				method: "Runtime.disable",
			}),
		);
		await flush();

		// A second holder that keeps Runtime enabled, so root Runtime events keep flowing.
		const active = new FakeCdpSocket();
		const activeConn = bridge.cdpConnected(active);
		const activeSession = await attachPage(bridge, ext, active, activeConn, 1);

		// Recovery: socket drops, replacement reconnects, both page sessions preserved.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		ack(bridge, ext2, "attach");
		await flush();

		// The active holder re-enables Runtime after recovery; the root cycles and a
		// context is announced.
		bridge.cdpMessage(
			activeConn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: activeSession,
				method: "Runtime.enable",
			}),
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: disabledSession,
				method: "Runtime.enable",
			}),
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
			JSON.stringify({
				id: ++msgSeq,
				sessionId: disabledSession,
				method: "Runtime.disable",
			}),
		);
		await flush();

		// Recovery preserves both sessions. The explicit disable remains a per-session
		// opt-out, but the default session still depended on the pre-detach root
		// Runtime fan-out and needs the fresh root re-enabled.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
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
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: context,
			}),
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
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();
		expect(ext2.pending("attach")).toHaveLength(1);

		// A second extension reconnect replaces ext2 before its attach resolves.
		// extConnected rejects the in-flight attach with ExtensionReplacedError, so
		// #ensureAttached resolves false — but this is a transport swap, not a real
		// attach failure, so the recovery continuation must NOT retract the
		// preserved page session.
		const ext3 = new FakeExtSocket();
		connect(bridge, ext3, [tab({ tabId: 1, groupId: -1 })], {
			recoverableTabIds: [1],
		});
		await flush();

		// ext3's hello re-runs reconciliation and re-attaches the still-held tab.
		expect(ext3.pending("attach")).toHaveLength(1);
		ack(bridge, ext3, "attach");
		await flush();

		// The holder's original page session survived both reconnects: its command
		// routes to the freshly attached tab instead of "Unknown session id".
		const cmdId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
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
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: cmdId,
				sessionId: pageSession,
				method: "Runtime.evaluate",
			}),
		);
		ack(bridge, legacy, "send", { ok: true });
		await flush();
		const reply = cdp.messages.find(m => m.id === cmdId);
		expect(reply?.error).toBeUndefined();
	});
});
