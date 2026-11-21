import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { isRecord } from "@oh-my-pi/pi-utils";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import {
	decodeHostError,
	MCP_HOST_ERROR_CODE,
	MCP_RESTART_METHOD,
	MCP_ROOTS_METHOD,
	mcpIdentity,
} from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import type { McpEndpoint } from "@oh-my-pi/pi-coding-agent/mcp/host/endpoint";
import { McpStore } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import type { JsonRpcError } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	attachLink,
	type Message,
	ScriptedUpstreams,
	scriptedEndpoint,
	settle,
	stdioSpec,
	type TestLink,
	until,
} from "./scripted";

function hostError(message: Message): { error: JsonRpcError; decoded: MCPTransportError } {
	const raw = message.error;
	if (!isRecord(raw) || typeof raw.code !== "number" || typeof raw.message !== "string") {
		throw new Error(`not an error response: ${JSON.stringify(message)}`);
	}
	const error: JsonRpcError = { code: raw.code, message: raw.message, data: raw.data };
	const decoded = decodeHostError(error);
	if (!decoded) throw new Error(`not a host error: ${JSON.stringify(message)}`);
	return { error, decoded };
}

describe("McpEndpoint upstream lifecycle", () => {
	let store: McpStore;
	let upstreams: ScriptedUpstreams;
	let endpoints: McpEndpoint[];

	function unit(options: { idleMs?: number; era?: "modern" | "legacy"; timeoutMs?: number } = {}): McpEndpoint {
		const endpoint = scriptedEndpoint({
			store,
			upstreams,
			idleMs: options.idleMs,
			era: options.era,
			spec: stdioSpec("scripted", options.timeoutMs),
		});
		endpoints.push(endpoint);
		return endpoint;
	}

	/** Script `tools/call crash` to kill the upstream mid-request and `tools/call slow` to never answer. */
	function scriptCrashAndSlow(): void {
		upstreams.handler = (method, params) => {
			if (method !== "tools/call") return undefined;
			if (params.name === "crash") {
				upstreams.last.exit({ code: 3, stderr: "boom" });
				return new Promise(() => {});
			}
			if (params.name === "slow") return new Promise(() => {});
			return undefined;
		};
	}

	beforeEach(() => {
		store = McpStore.memory();
		upstreams = new ScriptedUpstreams();
		endpoints = [];
	});

	afterEach(async () => {
		for (const endpoint of endpoints) await endpoint.stop("test over");
		store.close();
		vi.useRealTimers();
	});

	it("starts nothing on attach and reports idle", async () => {
		const endpoint = unit();
		const link = attachLink(endpoint);
		await link.status({ era: "modern", state: "idle", links: 1 });
		expect(upstreams.startAttempts).toBe(0);
		expect(endpoint.pids()).toEqual([]);
		await endpoint.ready;
	});

	it("starts the upstream once for concurrent first requests and announces the pid", async () => {
		const changes: string[] = [];
		const endpoint = scriptedEndpoint({ store, upstreams, changed: id => changes.push(id) });
		endpoints.push(endpoint);
		const link = attachLink(endpoint);
		link.request(1, "tools/call", { name: "alpha" });
		link.request(2, "tools/call", { name: "alpha" });
		await Promise.all([link.response(1), link.response(2)]);
		expect(upstreams.startAttempts).toBe(1);
		await link.status({ state: "starting" });
		await link.status({ state: "running", pid: upstreams.last.pid });
		expect(changes).toContain("unit-1");
	});

	it("stops an idle modern upstream and starts a new process for the next request", async () => {
		const endpoint = unit({ idleMs: 30 });
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		const first = upstreams.last;
		await link.status({ state: "running", pid: first.pid });
		link.clear();

		await link.status({ state: "idle" });
		expect(first.closeReasons).toEqual(["idle"]);
		expect(endpoint.pids()).toEqual([]);

		await link.call(2, "tools/call", { name: "alpha" });
		expect(upstreams.peers).toHaveLength(2);
		await link.status({ state: "running", pid: upstreams.last.pid });
		expect(upstreams.last.pid).not.toBe(first.pid);
	});

	it("stops an idle handshake-era upstream that only ever listed, and starts a clean one next", async () => {
		vi.useFakeTimers();
		const endpoint = unit({ idleMs: 20, era: "legacy" });
		const link = attachLink(endpoint);
		await link.call(1, "tools/list");
		await link.call(2, "resources/read", { uri: "file:///a" }, { "omp/cache": "no-store" });
		const first = upstreams.last;
		await until(() => first.listens.length === 1, "the host's subscription");
		link.clear();

		vi.advanceTimersByTime(20);
		await link.status({ state: "idle" });
		expect(first.closeReasons).toEqual(["idle"]);
		expect(endpoint.pids()).toEqual([]);

		await link.call(3, "tools/call", { name: "alpha" });
		const second = upstreams.last;
		expect(second.pid).not.toBe(first.pid);
		vi.advanceTimersByTime(60_000);
		await settle();
		expect(second.gone).toBe(false);
	});

	it("stops an idle handshake-era upstream again after a restart cleared its session", async () => {
		vi.useFakeTimers();
		const endpoint = unit({ idleMs: 20, era: "legacy" });
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		const first = upstreams.last;
		vi.advanceTimersByTime(60_000);
		await settle();
		expect(first.gone).toBe(false);

		link.notify(MCP_RESTART_METHOD);
		await until(() => first.gone, "restart");
		await link.call(2, "tools/list");
		const second = upstreams.last;
		expect(second.pid).not.toBe(first.pid);
		link.clear();
		vi.advanceTimersByTime(20);
		await link.status({ state: "idle" });
		expect(second.closeReasons).toEqual(["idle"]);
	});

	it("never idle-stops a handshake-era upstream that served a tools/call", async () => {
		vi.useFakeTimers();
		const endpoint = unit({ idleMs: 20, era: "legacy" });
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		vi.advanceTimersByTime(60_000);
		expect(upstreams.last.gone).toBe(false);
		expect(endpoint.pids()).toEqual([upstreams.last.pid]);
	});

	it("does not idle-stop while a request is in flight", async () => {
		vi.useFakeTimers();
		scriptCrashAndSlow();
		const endpoint = unit({ idleMs: 20 });
		const link = attachLink(endpoint);
		link.request(1, "tools/call", { name: "slow" });
		await until(() => upstreams.peers.length === 1 && upstreams.last.count("tools/call") === 1, "slow call upstream");
		vi.advanceTimersByTime(60_000);
		expect(upstreams.last.gone).toBe(false);
		expect(endpoint.busy()).toBe(true);

		link.notify("notifications/cancelled", { requestId: 1 });
		await until(() => !endpoint.busy(), "request cancelled");
		vi.advanceTimersByTime(60_000);
		await link.status({ state: "idle" });
	});

	it("fails the in-flight request with the exit of a crashed upstream and reports the failure", async () => {
		scriptCrashAndSlow();
		const link = attachLink(unit());
		const { decoded, error } = hostError(await link.call(1, "tools/call", { name: "crash" }));
		expect(error.code).toBe(MCP_HOST_ERROR_CODE);
		expect(error.data).toMatchObject({ exit: { code: 3, stderr: "boom" } });
		expect(decoded.failure).toBe("closed");
		const status = await link.status({ state: "failed" });
		expect(status.params).toMatchObject({ exit: { code: 3, stderr: "boom" } });

		expect(await link.call(2, "tools/call", { name: "alpha" })).toHaveProperty("result");
		expect(upstreams.peers).toHaveLength(2);
	});

	it("refuses to start after five crashes until omp/restart clears the guard", async () => {
		scriptCrashAndSlow();
		const link = attachLink(unit());
		for (let attempt = 1; attempt <= 5; attempt++) {
			hostError(await link.call(attempt, "tools/call", { name: "crash" }));
			await until(() => link.named("omp/status").some(m => JSON.stringify(m.params).includes('"failed"')), "failed");
			link.clear();
		}
		expect(upstreams.startAttempts).toBe(5);

		const { decoded } = hostError(await link.call(6, "tools/call", { name: "alpha" }));
		expect(decoded).toMatchObject({ failure: "closed", retryable: false });
		expect(decoded.message).toContain("5 times");
		expect(decoded.message).toContain("boom");
		expect(upstreams.startAttempts).toBe(5);

		link.notify(MCP_RESTART_METHOD);
		expect(await link.call(7, "tools/call", { name: "alpha" })).toHaveProperty("result");
		expect(upstreams.startAttempts).toBe(6);
	});

	it("reports a failed start to the request and as status", async () => {
		upstreams.startError = new MCPTransportError({
			transport: "stdio",
			stage: "connect",
			failure: "connect",
			message: "spawn ENOENT",
			retryable: true,
			code: "ENOENT",
		});
		const link = attachLink(unit());
		const { decoded } = hostError(await link.call(1, "tools/call", { name: "alpha" }));
		expect(decoded).toMatchObject({ failure: "connect", retryable: true, code: "ENOENT", message: "spawn ENOENT" });
		await link.status({ state: "failed" });
	});

	it("bounds a start by the spec's timeout", async () => {
		upstreams.startGate = new Promise(() => {});
		const link = attachLink(unit({ timeoutMs: 30 }));
		const { decoded } = hostError(await link.call(1, "tools/call", { name: "alpha" }));
		expect(decoded.failure).toBe("timeout");
		expect(decoded.message).toContain("30 ms");
	});

	it("restarts on omp/restart: stops the process, drops stored lists, and the next request starts another", async () => {
		const endpoint = unit();
		const link = attachLink(endpoint);
		await link.call(1, "tools/list");
		const first = upstreams.last;
		const identity = mcpIdentity(stdioSpec("scripted"));
		await until(() => store.get(identity, "server/discover", "{}") !== undefined, "discover stored");
		link.clear();
		link.notify(MCP_RESTART_METHOD);
		await link.status({ state: "idle" });
		expect(first.closeReasons).toEqual(["restart requested"]);
		expect(store.get(identity, "server/discover", "{}")).toBeUndefined();
		expect(store.get(identity, "tools/list", "{}")).toBeUndefined();

		upstreams.tools = ["gamma"];
		expect(await link.call(2, "tools/list")).toMatchObject({ result: { tools: [{ name: "gamma" }] } });
		expect(upstreams.peers).toHaveLength(2);
	});

	it("cancels the upstream request of a link that disconnects, leaving other links' requests alone", async () => {
		scriptCrashAndSlow();
		const endpoint = unit();
		const leaving = attachLink(endpoint);
		const staying = attachLink(endpoint);
		leaving.request(1, "tools/call", { name: "slow" });
		staying.request(1, "tools/call", { name: "slow" });
		await until(
			() => upstreams.peers.length === 1 && upstreams.last.count("tools/call") === 2,
			"both calls upstream",
		);

		leaving.disconnect();
		await until(() => upstreams.last.aborted.length === 1, "upstream cancellation");
		await staying.status({ links: 1 });
		expect(endpoint.busy()).toBe(true);
		expect(upstreams.last.aborted).toEqual(["tools/call"]);
	});

	it("cancels upstream on notifications/cancelled and sends no response for that request", async () => {
		scriptCrashAndSlow();
		const endpoint = unit();
		const link: TestLink = attachLink(endpoint);
		link.request(1, "tools/call", { name: "slow" });
		await until(() => upstreams.peers.length === 1 && upstreams.last.count("tools/call") === 1, "call upstream");
		link.notify("notifications/cancelled", { requestId: 1 });
		await until(() => upstreams.last.aborted.length === 1, "upstream cancellation");
		await link.call(2, "tools/call", { name: "alpha" });
		expect(link.messages.filter(message => message.id === 1)).toHaveLength(0);
		expect(endpoint.busy()).toBe(false);
	});

	it("answers a handshake-era server's roots from the link being served", async () => {
		const endpoint = unit({ era: "legacy" });
		const link = attachLink(endpoint);
		link.notify(MCP_ROOTS_METHOD, { roots: [{ uri: "file:///work", name: "work" }, { bogus: true }] });
		await link.call(1, "tools/call", { name: "alpha" });
		expect(upstreams.deps?.roots()).toEqual([{ uri: "file:///work", name: "work" }]);
	});

	it("stop() closes the upstream and every tunnel and settles exited", async () => {
		const endpoint = unit();
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		await endpoint.stop("shutting down");
		expect(await endpoint.exited).toEqual({ reason: "shutting down" });
		expect(upstreams.last.closeReasons).toEqual(["shutting down"]);
		await until(() => link.closed, "tunnel closed");
		expect(endpoint.pids()).toEqual([]);
	});

	it("snapshots what a rebuilt unit needs", () => {
		const endpoint = unit({ idleMs: 1234 });
		expect(endpoint.snapshot()).toEqual({
			spec: stdioSpec("scripted"),
			era: "modern",
			name: "scripted",
			idleMs: 1234,
		});
	});
	it("gives up on its own requests to a server that never answers them, after the spec's timeout", async () => {
		vi.useFakeTimers();
		upstreams.handler = method => (method === "server/discover" ? new Promise(() => {}) : undefined);
		const endpoint = unit({ timeoutMs: 500 });
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		const peer = upstreams.last;
		await until(() => peer.count("server/discover") === 1, "discover upstream");
		expect(endpoint.busy()).toBe(true);

		vi.advanceTimersByTime(499);
		await settle();
		expect(peer.aborted).toEqual([]);
		vi.advanceTimersByTime(1);
		await until(() => peer.aborted.includes("server/discover"), "deadline");
		await until(() => !endpoint.busy(), "host work over");
	});

	it("bounds its own requests at 30 s when the spec sets no timeout", async () => {
		vi.useFakeTimers();
		upstreams.handler = method => (method === "server/discover" ? new Promise(() => {}) : undefined);
		const link = attachLink(unit());
		await link.call(1, "tools/call", { name: "alpha" });
		const peer = upstreams.last;
		await until(() => peer.count("server/discover") === 1, "discover upstream");
		vi.advanceTimersByTime(29_999);
		await settle();
		expect(peer.aborted).toEqual([]);
		vi.advanceTimersByTime(1);
		await until(() => peer.aborted.includes("server/discover"), "deadline");
	});

	it("is not busy with its own work once no link is attached, and stop() cancels that work", async () => {
		upstreams.handler = method => (method === "server/discover" ? new Promise(() => {}) : undefined);
		const endpoint = unit();
		const link = attachLink(endpoint);
		await link.call(1, "tools/call", { name: "alpha" });
		const peer = upstreams.last;
		await until(() => peer.count("server/discover") === 1, "discover upstream");
		expect(endpoint.busy()).toBe(true);

		link.disconnect();
		await until(() => !endpoint.busy(), "unit free to be collected");
		expect(peer.aborted).toEqual([]);
		await endpoint.stop("collected");
		expect(peer.aborted).toEqual(["server/discover"]);
	});

	it("abandons a start when the only link waiting for it disconnects, and starts afresh for the next", async () => {
		upstreams.startGate = new Promise(() => {});
		const endpoint = unit();
		const link = attachLink(endpoint);
		link.request(1, "tools/call", { name: "alpha" });
		await until(() => upstreams.startAttempts === 1, "start");
		expect(endpoint.busy()).toBe(true);

		link.disconnect();
		await until(() => upstreams.startAborts === 1, "start aborted");
		expect(endpoint.busy()).toBe(false);

		upstreams.startGate = undefined;
		const next = attachLink(endpoint);
		expect(await next.call(1, "tools/call", { name: "alpha" })).toHaveProperty("result");
		expect(upstreams.startAttempts).toBe(2);
		await next.status({ state: "running", pid: upstreams.last.pid });
	});

	it("lets a cancelled request leave the wait for a start that others still need", async () => {
		const gate = Promise.withResolvers<void>();
		upstreams.startGate = gate.promise;
		const link = attachLink(unit());
		link.request(1, "tools/call", { name: "alpha", arguments: { n: 1 } });
		await until(() => upstreams.startAttempts === 1, "start");
		link.notify("notifications/cancelled", { requestId: 1 });
		link.request(2, "tools/call", { name: "alpha", arguments: { n: 2 } });
		await settle();
		gate.resolve();

		expect(await link.response(2)).toMatchObject({ result: { content: [{ text: '{"n":2}' }] } });
		expect(upstreams.startAttempts).toBe(1);
		expect(upstreams.startAborts).toBe(0);
		expect(upstreams.last.count("tools/call")).toBe(1);
		expect(link.messages.filter(message => message.id === 1)).toHaveLength(0);
	});

	it("stop() settles only after the upstream of a start it interrupted is closed", async () => {
		const startGate = Promise.withResolvers<void>();
		const closeGate = Promise.withResolvers<void>();
		upstreams.startGate = startGate.promise;
		upstreams.startIgnoresAbort = true;
		upstreams.closeGate = closeGate.promise;
		const endpoint = unit();
		const link = attachLink(endpoint);
		link.request(1, "tools/call", { name: "alpha" });
		await until(() => upstreams.startAttempts === 1, "start");

		let stopped = false;
		const stopping = endpoint.stop("shutting down").then(() => {
			stopped = true;
		});
		await settle();
		expect(stopped).toBe(false);

		startGate.resolve();
		await until(
			() => upstreams.peers.length === 1 && upstreams.last.closeReasons.length === 1,
			"late upstream closing",
		);
		await settle();
		expect(stopped).toBe(false);

		closeGate.resolve();
		await stopping;
		expect(upstreams.last.gone).toBe(true);
		expect(upstreams.last.closeReasons).toEqual(["start abandoned"]);
	});
});
