import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { MCP_RESTART_METHOD, mcpIdentity } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import type { McpEndpoint } from "@oh-my-pi/pi-coding-agent/mcp/host/endpoint";
import { cacheParamsKey, McpStore } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { MCP_SUBSCRIPTION_ACKNOWLEDGED, MCPMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { attachLink, ScriptedUpstreams, scriptedEndpoint, settle, stdioSpec, until } from "./scripted";

const ALL_LISTS = { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true };
const IDENTITY = mcpIdentity(stdioSpec("scripted"));

describe("McpEndpoint subscriptions", () => {
	let store: McpStore;
	let upstreams: ScriptedUpstreams;
	let endpoint: McpEndpoint;

	beforeEach(() => {
		store = McpStore.memory();
		upstreams = new ScriptedUpstreams();
		endpoint = scriptedEndpoint({ store, upstreams, idleMs: 40 });
	});

	afterEach(async () => {
		await endpoint.stop("test over");
		store.close();
		vi.useRealTimers();
	});

	it("acknowledges a list-change listen without starting the upstream", async () => {
		const link = attachLink(endpoint);
		link.request(5, "subscriptions/listen", { notifications: ALL_LISTS });
		const ack = await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		expect(ack.params).toEqual({ notifications: ALL_LISTS, _meta: { [MCPMeta.subscriptionId]: 5 } });
		expect(upstreams.startAttempts).toBe(0);
		expect(endpoint.busy()).toBe(false);
	});

	it("acknowledges only the list changes the stored discover result advertises", async () => {
		store.put(IDENTITY, "server/discover", "{}", upstreams.discoverResult(), 60_000);
		const link = attachLink(endpoint);
		link.request(5, "subscriptions/listen", { notifications: ALL_LISTS });
		const ack = await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		expect(ack.params).toMatchObject({ notifications: { toolsListChanged: true } });
		expect(ack.params).not.toHaveProperty(["notifications", "promptsListChanged"]);
		expect(upstreams.startAttempts).toBe(0);
	});

	it("fans an upstream list change out to every link's listen under its own id and drops the stored list", async () => {
		const a = attachLink(endpoint);
		const b = attachLink(endpoint);
		a.request(1, "subscriptions/listen", { notifications: { toolsListChanged: true } });
		b.request("mine", "subscriptions/listen", { notifications: { toolsListChanged: true } });
		await a.call(2, "tools/list");
		await until(() => upstreams.last.listens.length === 1, "the shared list-change subscription");
		expect(upstreams.last.listens[0].acknowledged).toEqual({ toolsListChanged: true });
		expect(store.get(IDENTITY, "tools/list", "{}")).toBeDefined();

		upstreams.tools = ["alpha", "beta"];
		upstreams.last.listens[0].sink("notifications/tools/list_changed", {});
		const toA = await a.next(message => message.method === "notifications/tools/list_changed", "change on a");
		const toB = await b.next(message => message.method === "notifications/tools/list_changed", "change on b");
		expect(toA.params).toEqual({ _meta: { [MCPMeta.subscriptionId]: 1 } });
		expect(toB.params).toEqual({ _meta: { [MCPMeta.subscriptionId]: "mine" } });
		expect(store.get(IDENTITY, "tools/list", "{}")).toBeUndefined();
		expect(await b.call(3, "tools/list")).toMatchObject({ result: { tools: [{ name: "alpha" }, { name: "beta" }] } });
	});

	it("stops delivering to a listen the link cancelled", async () => {
		const link = attachLink(endpoint);
		link.request(1, "subscriptions/listen", { notifications: { toolsListChanged: true } });
		await link.call(2, "tools/list");
		await until(() => upstreams.last.listens.length === 1, "the shared list-change subscription");
		link.notify("notifications/cancelled", { requestId: 1 });
		await link.call(3, "tools/call", { name: "alpha" });
		upstreams.last.listens[0].sink("notifications/tools/list_changed", {});
		await link.call(4, "tools/call", { name: "alpha" });
		expect(link.named("notifications/tools/list_changed")).toHaveLength(0);
	});

	it("tells every link that asked for a list type when the server is restarted on request", async () => {
		upstreams.capabilities = {};
		store.put(IDENTITY, "server/discover", "{}", upstreams.discoverResult(), 60_000);
		const link = attachLink(endpoint);
		link.request(1, "subscriptions/listen", { notifications: { promptsListChanged: true } });
		const ack = await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		expect(ack.params).toMatchObject({ notifications: {} });
		link.notify(MCP_RESTART_METHOD);
		const changed = await link.next(
			message => message.method === "notifications/prompts/list_changed",
			"prompts list_changed",
		);
		expect(changed.params).toEqual({ _meta: { [MCPMeta.subscriptionId]: 1 } });
	});

	it("forwards a resource subscription, which keeps the upstream from idling until it is cancelled", async () => {
		vi.useFakeTimers();
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		const ack = await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		expect(ack.params).toEqual({
			notifications: { resourceSubscriptions: ["file:///a"] },
			_meta: { [MCPMeta.subscriptionId]: 8 },
		});
		const peer = upstreams.last;
		const forwarded = peer.listens.find(listen => listen.acknowledged.resourceSubscriptions !== undefined);
		if (!forwarded) throw new Error("no forwarded subscription upstream");

		forwarded.sink("notifications/resources/updated", { uri: "file:///a" });
		const update = await link.next(message => message.method === "notifications/resources/updated", "update");
		expect(update.params).toEqual({ uri: "file:///a", _meta: { [MCPMeta.subscriptionId]: 8 } });

		vi.advanceTimersByTime(60_000);
		expect(peer.gone).toBe(false);
		expect(endpoint.busy()).toBe(true);

		link.notify("notifications/cancelled", { requestId: 8 });
		await until(() => !forwarded.open, "upstream subscription closed");
		vi.advanceTimersByTime(60_000);
		await link.status({ state: "idle" });
		expect(peer.closeReasons).toEqual(["idle"]);
		expect(endpoint.busy()).toBe(false);
	});

	it("ends a forwarded subscription with notifications/cancelled when the upstream goes away", async () => {
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		upstreams.last.exit({ code: 1, stderr: "gone" });
		const cancelled = await link.next(message => message.method === "notifications/cancelled", "teardown");
		expect(cancelled.params).toEqual({ requestId: 8 });
	});

	it("closes a link's forwarded subscription upstream when the link disconnects", async () => {
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		const forwarded = upstreams.last.listens.find(listen => listen.acknowledged.resourceSubscriptions !== undefined);
		link.disconnect();
		await until(() => forwarded?.open === false, "upstream subscription closed");
	});
	it("cancels a resource subscription upstream when the link cancels before the acknowledgement", async () => {
		upstreams.listenGate = new Promise(() => {});
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		await until(() => upstreams.peers.length === 1 && upstreams.last.pendingListens === 1, "listen upstream");
		await until(() => upstreams.last.listens.length === 1, "the host's own subscription");
		expect(endpoint.busy()).toBe(true);

		link.notify("notifications/cancelled", { requestId: 8 });
		await until(() => upstreams.last.abortedListens === 1, "upstream cancellation");
		await until(() => !endpoint.busy(), "pin released");
		await link.call(9, "tools/call", { name: "alpha" });
		expect(link.messages.filter(message => message.id === 8)).toHaveLength(0);
		expect(link.named(MCP_SUBSCRIPTION_ACKNOWLEDGED)).toHaveLength(0);
	});

	it("cancels a pending resource subscription upstream when the link disconnects", async () => {
		upstreams.listenGate = new Promise(() => {});
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		await until(() => upstreams.peers.length === 1 && upstreams.last.pendingListens === 1, "listen upstream");
		link.disconnect();
		await until(() => upstreams.last.abortedListens === 1, "upstream cancellation");
		await until(() => !endpoint.busy(), "pin released");
	});

	it("drops the stored read of a resource the server reports updated, and keeps a read in flight out of the store", async () => {
		let text = "one";
		let hold: Promise<void> | undefined;
		upstreams.handler = async (method, params) => {
			if (method !== "resources/read") return undefined;
			const answer = { resultType: "complete", contents: [{ uri: params.uri, text }], ttlMs: 60_000 };
			await hold;
			return answer;
		};
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		const forwarded = upstreams.last.listens.find(listen => listen.acknowledged.resourceSubscriptions !== undefined);
		if (!forwarded) throw new Error("no forwarded subscription upstream");
		const read = { uri: "file:///a" };

		expect(await link.call(1, "resources/read", read)).toMatchObject({ result: { contents: [{ text: "one" }] } });
		expect(await link.call(2, "resources/read", read)).toMatchObject({ result: { contents: [{ text: "one" }] } });
		expect(upstreams.count("resources/read")).toBe(1);

		text = "two";
		forwarded.sink("notifications/resources/updated", read);
		expect(store.get(IDENTITY, "resources/read", cacheParamsKey(read))).toBeUndefined();
		await link.next(message => message.method === "notifications/resources/updated", "update");

		const gate = Promise.withResolvers<void>();
		hold = gate.promise;
		link.request(3, "resources/read", read);
		await until(() => upstreams.count("resources/read") === 2, "read in flight");
		text = "three";
		forwarded.sink("notifications/resources/updated", read);
		hold = undefined;
		gate.resolve();
		expect(await link.response(3)).toMatchObject({ result: { contents: [{ text: "two" }] } });
		expect(store.get(IDENTITY, "resources/read", cacheParamsKey(read))).toBeUndefined();
		expect(await link.call(4, "resources/read", read)).toMatchObject({ result: { contents: [{ text: "three" }] } });
		expect(upstreams.count("resources/read")).toBe(3);
	});

	it("opens the host's subscription again, after a pause, when the server ends it", async () => {
		vi.useFakeTimers();
		const steady = scriptedEndpoint({ store, upstreams, idleMs: 0 });
		try {
			const link = attachLink(steady);
			link.request("sub", "subscriptions/listen", { notifications: { toolsListChanged: true } });
			await link.call(1, "tools/call", { name: "alpha" });
			const peer = upstreams.last;
			await until(() => peer.listens.length === 1, "the host's subscription");

			peer.listens[0].close();
			await settle();
			vi.advanceTimersByTime(249);
			await settle();
			expect(peer.listens).toHaveLength(1);
			vi.advanceTimersByTime(1);
			await until(() => peer.listens.length === 2, "subscription opened again");

			peer.listens[1].sink("notifications/tools/list_changed", {});
			await link.next(message => message.method === "notifications/tools/list_changed", "change after re-open");

			peer.listens[1].close();
			await settle();
			vi.advanceTimersByTime(499);
			await settle();
			expect(peer.listens).toHaveLength(2);
			vi.advanceTimersByTime(1);
			await until(() => peer.listens.length === 3, "second re-open after the doubled pause");

			await steady.stop("test over");
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(peer.listens).toHaveLength(3);
		} finally {
			await steady.stop("test over");
		}
	});

	it("delivers a server's own notification unchanged to every virtual listen", async () => {
		const a = attachLink(endpoint);
		const b = attachLink(endpoint);
		a.request(1, "subscriptions/listen", { notifications: { toolsListChanged: true } });
		b.request("mine", "subscriptions/listen", { notifications: {} });
		await a.call(2, "tools/call", { name: "alpha" });
		await until(() => upstreams.last.listens.length === 1, "the host's subscription");

		upstreams.last.listens[0].sink("notifications/acme/build", { step: 2, _meta: { trace: "t" } });
		const toA = await a.next(message => message.method === "notifications/acme/build", "custom on a");
		const toB = await b.next(message => message.method === "notifications/acme/build", "custom on b");
		expect(toA.params).toEqual({ step: 2, _meta: { trace: "t", [MCPMeta.subscriptionId]: 1 } });
		expect(toB.params).toEqual({ step: 2, _meta: { trace: "t", [MCPMeta.subscriptionId]: "mine" } });
	});

	it("delivers a server's own notification on a forwarded subscription to its link", async () => {
		const link = attachLink(endpoint);
		link.request(8, "subscriptions/listen", { notifications: { resourceSubscriptions: ["file:///a"] } });
		await link.next(message => message.method === MCP_SUBSCRIPTION_ACKNOWLEDGED, "acknowledgement");
		const forwarded = upstreams.last.listens.find(listen => listen.acknowledged.resourceSubscriptions !== undefined);
		forwarded?.sink("notifications/acme/build", { step: 3 });
		const custom = await link.next(message => message.method === "notifications/acme/build", "custom");
		expect(custom.params).toEqual({ step: 3, _meta: { [MCPMeta.subscriptionId]: 8 } });
	});

	it("holds a subscription on a handshake-era server that advertises nothing, and none on a modern one", async () => {
		upstreams.capabilities = {};
		const legacyStore = McpStore.memory();
		const legacy = scriptedEndpoint({ store: legacyStore, upstreams, era: "legacy" });
		try {
			const link = attachLink(legacy);
			link.request(1, "subscriptions/listen", { notifications: { toolsListChanged: true } });
			await link.call(2, "tools/call", { name: "alpha" });
			const peer = upstreams.last;
			await until(() => peer.listens.length === 1, "the host's subscription");
			expect(peer.listens[0].acknowledged).toEqual({});

			const read = { uri: "file:///a" };
			legacyStore.put(IDENTITY, "resources/read", cacheParamsKey(read), { contents: [] }, 60_000);
			peer.listens[0].sink("notifications/resources/updated", read);
			expect(legacyStore.get(IDENTITY, "resources/read", cacheParamsKey(read))).toBeUndefined();
			peer.listens[0].sink("notifications/acme/build", { step: 1 });
			await link.next(message => message.method === "notifications/acme/build", "custom");
			expect(link.named("notifications/resources/updated")).toHaveLength(0);
		} finally {
			await legacy.stop("test over");
			legacyStore.close();
		}

		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		const peer = upstreams.last;
		await until(() => store.get(IDENTITY, "server/discover", "{}") !== undefined, "discover after start");
		await settle();
		expect(peer.listens).toHaveLength(0);
	});
});
