import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMCPJsonRpcError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { MCP_NO_STORE, MCP_STALE_OK, mcpIdentity, OmpMeta } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import type { McpEndpoint } from "@oh-my-pi/pi-coding-agent/mcp/host/endpoint";
import { cacheParamsKey, McpStore } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { MCPMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { attachLink, ScriptedUpstreams, scriptedEndpoint, stdioSpec, until } from "./scripted";

const STALE_OK = { [OmpMeta.cache]: MCP_STALE_OK };

describe("McpEndpoint requests", () => {
	let store: McpStore;
	let upstreams: ScriptedUpstreams;
	let endpoint: McpEndpoint;

	beforeEach(() => {
		store = McpStore.memory();
		upstreams = new ScriptedUpstreams();
		endpoint = scriptedEndpoint({ store, upstreams });
	});

	afterEach(async () => {
		await endpoint.stop("test over");
		store.close();
	});

	it("keeps answers and progress of two links apart under the same request id and progress token", async () => {
		const release = Promise.withResolvers<void>();
		upstreams.handler = async (method, params, options) => {
			if (method !== "tools/call") return undefined;
			options.onProgress?.({ progress: 1, message: JSON.stringify(params.arguments) });
			await release.promise;
			return undefined;
		};
		const a = attachLink(endpoint);
		const b = attachLink(endpoint);
		a.request(1, "tools/call", { name: "alpha", arguments: { from: "a" } }, { progressToken: "t" });
		b.request(1, "tools/call", { name: "alpha", arguments: { from: "b" } }, { progressToken: "t" });
		const progressA = await a.next(message => message.method === "notifications/progress", "progress a");
		const progressB = await b.next(message => message.method === "notifications/progress", "progress b");
		release.resolve();
		const [answerA, answerB] = await Promise.all([a.response(1), b.response(1)]);

		expect(progressA.params).toEqual({ progress: 1, message: '{"from":"a"}', progressToken: "t" });
		expect(progressB.params).toEqual({ progress: 1, message: '{"from":"b"}', progressToken: "t" });
		expect(answerA).toMatchObject({ result: { content: [{ text: '{"from":"a"}' }] } });
		expect(answerB).toMatchObject({ result: { content: [{ text: '{"from":"b"}' }] } });
		expect(upstreams.peers).toHaveLength(1);
		const pid = upstreams.last.pid;
		await a.status({ state: "running", pid, links: 2 });
		await b.status({ state: "running", pid, links: 2 });
		expect(endpoint.pids()).toEqual([pid]);
	});

	it("sends upstream neither the link's progress token nor omp keys, and keeps the rest of _meta", async () => {
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" }, { progressToken: 7, ...STALE_OK, traceparent: "00-ab" });
		const sent = upstreams.last.calls.find(call => call.method === "tools/call");
		const meta = sent?.params._meta;
		expect(meta).toMatchObject({ traceparent: "00-ab", [MCPMeta.protocolVersion]: "2026-07-28" });
		expect(meta).not.toHaveProperty("progressToken");
		expect(meta).not.toHaveProperty(OmpMeta.cache);
	});

	it("rejects a request without the required _meta and one for another protocol revision", async () => {
		const link = attachLink(endpoint);
		link.raw({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		link.raw({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: { _meta: { [MCPMeta.protocolVersion]: "2025-11-25", [MCPMeta.clientCapabilities]: {} } },
		});
		expect(await link.response(1)).toMatchObject({ error: { code: -32602 } });
		expect(await link.response(2)).toMatchObject({
			error: { code: -32022, data: { supported: ["2026-07-28"], requested: "2025-11-25" } },
		});
		expect(upstreams.startAttempts).toBe(0);
	});

	it("serves a stale list under stale-ok before any upstream exists, then revalidates and reports the change", async () => {
		store.put(mcpIdentity(stdioSpec("scripted")), "tools/list", "{}", { tools: [{ name: "old" }] }, 0);
		const gate = Promise.withResolvers<void>();
		upstreams.startGate = gate.promise;
		const link = attachLink(endpoint);
		link.request("sub", "subscriptions/listen", { notifications: { toolsListChanged: true } });

		const stale = await link.call(1, "tools/list", {}, STALE_OK);
		expect(stale).toMatchObject({ result: { tools: [{ name: "old" }], _meta: { [OmpMeta.stale]: true } } });
		expect(upstreams.peers).toHaveLength(0);

		gate.resolve();
		const changed = await link.next(
			message => message.method === "notifications/tools/list_changed",
			"list_changed after revalidation",
		);
		expect(changed.params).toEqual({ _meta: { [MCPMeta.subscriptionId]: "sub" } });
		const fresh = await link.call(2, "tools/list", {}, STALE_OK);
		expect(fresh).toMatchObject({ result: { tools: [{ name: "alpha" }] } });
		expect(fresh).not.toHaveProperty(["result", "_meta", OmpMeta.stale]);
	});

	it("refetches a stale list before answering when the request carries no stale-ok hint", async () => {
		store.put(mcpIdentity(stdioSpec("scripted")), "tools/list", "{}", { tools: [{ name: "old" }] }, 0);
		const link = attachLink(endpoint);
		expect(await link.call(1, "tools/list")).toMatchObject({ result: { tools: [{ name: "alpha" }] } });
	});

	it("answers a fresh entry from the store without upstream traffic, for another unit too", async () => {
		const a = attachLink(endpoint);
		const first = await a.call(1, "tools/list");
		await until(() => upstreams.last.listens.length === 1, "list-change subscription");
		const traffic = upstreams.last.calls.length;

		const b = attachLink(endpoint);
		const second = await b.call(1, "tools/list");
		expect(second.result).toEqual(first.result);
		expect(upstreams.last.calls).toHaveLength(traffic);

		const other = scriptedEndpoint({ store, upstreams });
		try {
			const third = await attachLink(other).call(1, "tools/list");
			expect(third.result).toEqual(first.result);
			expect(upstreams.startAttempts).toBe(1);
		} finally {
			await other.stop("test over");
		}
	});

	it("fetches a cacheable result once for concurrent identical requests", async () => {
		const gate = Promise.withResolvers<void>();
		upstreams.handler = async method => {
			if (method !== "resources/list") return undefined;
			await gate.promise;
			return { resultType: "complete", resources: [{ uri: "file:///a", name: "a" }], ttlMs: 0 };
		};
		const a = attachLink(endpoint);
		const b = attachLink(endpoint);
		a.request(1, "resources/list");
		b.request(9, "resources/list");
		await until(() => upstreams.count("resources/list") === 1, "the shared fetch");
		gate.resolve();
		const [answerA, answerB] = await Promise.all([a.response(1), b.response(9)]);
		expect(answerA.result).toEqual(answerB.result);
		expect(upstreams.count("resources/list")).toBe(1);
	});

	it("never stores an input_required result", async () => {
		upstreams.handler = method =>
			method === "resources/read"
				? { resultType: "input_required", inputRequests: { r: { method: "roots/list" } } }
				: undefined;
		const link = attachLink(endpoint);
		const answer = await link.call(1, "resources/read", { uri: "file:///a" });
		expect(answer).toMatchObject({ result: { resultType: "input_required" } });
		expect(store.get(mcpIdentity(stdioSpec("scripted")), "resources/read", '{"uri":"file:///a"}')).toBeUndefined();
	});

	it("passes a server's JSON-RPC error through untouched", async () => {
		upstreams.handler = method => {
			if (method !== "prompts/get") return undefined;
			throw createMCPJsonRpcError("stdio", {
				code: -32021,
				message: "needs roots",
				data: { requiredCapabilities: { roots: {} } },
			});
		};
		const link = attachLink(endpoint);
		const answer = await link.call(1, "prompts/get", { name: "p" });
		expect(answer.error).toEqual({
			code: -32021,
			message: "needs roots",
			data: { requiredCapabilities: { roots: {} } },
		});
	});

	it("drops the stored tools list and tells subscribers when a call names an unknown tool", async () => {
		upstreams.capabilities = {};
		const link = attachLink(endpoint);
		link.request("sub", "subscriptions/listen", { notifications: { toolsListChanged: true } });
		await link.call(1, "tools/list");
		const identity = mcpIdentity(stdioSpec("scripted"));
		expect(store.get(identity, "tools/list", "{}")).toBeDefined();

		const answer = await link.call(2, "tools/call", { name: "removed" });
		expect(answer).toMatchObject({ error: { code: -32602 } });
		await link.next(message => message.method === "notifications/tools/list_changed", "list_changed");
		expect(store.get(identity, "tools/list", "{}")).toBeUndefined();
	});
	it("goes upstream under no-store whatever the store holds, and leaves the store as it was", async () => {
		const identity = mcpIdentity(stdioSpec("scripted"));
		const key = cacheParamsKey({ uri: "file:///a" });
		store.put(identity, "resources/read", key, { contents: [{ uri: "file:///a", text: "stored" }] }, 60_000);
		upstreams.handler = method =>
			method === "resources/read"
				? { resultType: "complete", contents: [{ uri: "file:///a", text: "live" }], ttlMs: 60_000 }
				: undefined;
		const link = attachLink(endpoint);

		const live = await link.call(1, "resources/read", { uri: "file:///a" }, { [OmpMeta.cache]: MCP_NO_STORE });
		expect(live).toMatchObject({ result: { contents: [{ text: "live" }] } });
		const sent = upstreams.last.calls.find(call => call.method === "resources/read");
		expect(sent?.params._meta).not.toHaveProperty(OmpMeta.cache);

		const stored = await link.call(2, "resources/read", { uri: "file:///a" });
		expect(stored).toMatchObject({ result: { contents: [{ text: "stored" }] } });
		expect(upstreams.count("resources/read")).toBe(1);
	});

	it("fetches anew for a request issued after a list change instead of joining the fetch that predates it", async () => {
		const first = attachLink(endpoint);
		await first.call(1, "tools/call", { name: "alpha" });
		await until(() => upstreams.last.listens.length === 1, "list-change subscription");
		const gate = Promise.withResolvers<void>();
		upstreams.handler = async method => {
			if (method === "tools/list") await gate.promise;
			return undefined;
		};
		first.request(2, "tools/list");
		await until(() => upstreams.count("tools/list") === 1, "the fetch that predates the change");

		upstreams.last.listens[0].sink("notifications/tools/list_changed", {});
		const second = attachLink(endpoint);
		second.request(1, "tools/list");
		await until(() => upstreams.count("tools/list") === 2, "a fetch of its own");
		gate.resolve();
		await Promise.all([first.response(2), second.response(1)]);
	});

	it("fetches anew after the only requester of a shared fetch cancelled it", async () => {
		const gate = Promise.withResolvers<void>();
		upstreams.handler = async method => {
			if (method === "resources/list") await gate.promise;
			return method === "resources/list" ? { resultType: "complete", resources: [], ttlMs: 0 } : undefined;
		};
		const link = attachLink(endpoint);
		link.request(1, "resources/list");
		await until(() => upstreams.count("resources/list") === 1, "first fetch");
		link.notify("notifications/cancelled", { requestId: 1 });
		await until(() => upstreams.last.aborted.length === 1, "first fetch cancelled upstream");
		link.request(2, "resources/list");
		await until(() => upstreams.count("resources/list") === 2, "second fetch");
		gate.resolve();
		expect(await link.response(2)).toMatchObject({ result: { resources: [] } });
		expect(upstreams.last.aborted).toEqual(["resources/list"]);
	});

	it("reports a list change when a later page of the list turns out to differ", async () => {
		const identity = mcpIdentity(stdioSpec("scripted"));
		store.put(identity, "tools/list", cacheParamsKey({ cursor: "p2" }), { tools: [{ name: "old" }] }, 0);
		upstreams.handler = (method, params) =>
			method === "tools/list" && params.cursor === "p2"
				? { resultType: "complete", tools: [{ name: "new" }], ttlMs: 0 }
				: undefined;
		const link = attachLink(endpoint);
		link.request("sub", "subscriptions/listen", { notifications: { toolsListChanged: true } });

		const stale = await link.call(1, "tools/list", { cursor: "p2" }, STALE_OK);
		expect(stale).toMatchObject({ result: { tools: [{ name: "old" }], _meta: { [OmpMeta.stale]: true } } });
		const changed = await link.next(
			message => message.method === "notifications/tools/list_changed",
			"list_changed for the page",
		);
		expect(changed.params).toEqual({ _meta: { [MCPMeta.subscriptionId]: "sub" } });
	});
});
