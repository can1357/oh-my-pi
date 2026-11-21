import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { McpPeer } from "@oh-my-pi/pi-coding-agent/mcp/host/peer";
import { mcpUpstreams } from "@oh-my-pi/pi-coding-agent/mcp/host/peers";
import { MCPMeta, requestMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { FIXTURES, isAlive, realDeps, stdioSpec, toolJson } from "./upstream-support";

const MODERN = path.join(FIXTURES, "modern-mcp.ts");
const ROGUE = path.join(import.meta.dir, "upstream-rogue-server.ts");

function call(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return { name, arguments: args, _meta: requestMeta() };
}

describe("modern peer over a subprocess", () => {
	let peer: McpPeer | undefined;

	afterEach(async () => {
		await peer?.close("test over");
		peer = undefined;
	});

	async function start(script = MODERN): Promise<McpPeer> {
		peer = await mcpUpstreams.start(stdioSpec(script), "modern", realDeps());
		return peer;
	}

	/** Every line the rogue server received so far. Answered in order, so it covers all that was written before. */
	async function framesAt(rogue: McpPeer): Promise<Record<string, unknown>[]> {
		const frames = toolJson(await rogue.request("tools/call", call("frames")));
		if (!Array.isArray(frames)) throw new Error("fixture did not return its frames");
		return frames;
	}

	it("forwards a request with the caller's metadata and returns the server's result untouched", async () => {
		const modern = await start();

		const result = await modern.request("tools/call", call("whoami"));

		expect(result.resultType).toBe("complete");
		expect(toolJson(result)).toEqual({ pid: modern.pid, calls: 1, client: "omp-coding-agent" });
	});

	it("delivers progress for the request that asked for it, without the token", async () => {
		const modern = await start();
		const progress: Record<string, unknown>[] = [];

		const result = await modern.request("tools/call", call("slow", { ms: 20 }), {
			onProgress: update => progress.push(update),
		});

		expect(toolJson(result)).toEqual({ done: true });
		expect(progress).toEqual([{ progress: 1 }]);
	});

	it("surfaces a server's JSON-RPC error with the raw error attached", async () => {
		const modern = await start();

		const failure = await modern.request("tools/call", call("no_such_tool")).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.failure).toBe("json_rpc");
		expect(failure.rpc).toEqual({ code: -32602, message: "Unknown tool: no_such_tool", data: undefined });
	});

	it("cancels an aborted request upstream: the server never answers it and keeps serving", async () => {
		const modern = await start();
		const controller = new AbortController();
		const slow = modern.request("tools/call", call("slow", { ms: 150 }), { signal: controller.signal });
		// The server counts every tools/call it serves, so this proves the slow one arrived first.
		expect(toolJson(await modern.request("tools/call", call("whoami")))).toMatchObject({ calls: 2 });

		controller.abort(new Error("link went away"));

		const failure = await slow.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(MCPTransportError);
		await Bun.sleep(250);
		expect(toolJson(await modern.request("tools/call", call("whoami")))).toMatchObject({ pid: modern.pid, calls: 3 });
	});

	it("opens a subscription, routes its notifications without the subscription id, and ends it on close", async () => {
		const modern = await start();
		const seen: { method: string; params: Record<string, unknown> }[] = [];

		const subscription = await modern.listen(
			{ toolsListChanged: true, promptsListChanged: true },
			requestMeta(),
			(method, params) => seen.push({ method, params }),
		);
		expect(subscription.acknowledged).toEqual({ toolsListChanged: true });

		await modern.request("tools/call", call("add_tool"));
		expect(seen).toEqual([{ method: "notifications/tools/list_changed", params: { _meta: {} } }]);
		expect(seen[0].params._meta).not.toHaveProperty(MCPMeta.subscriptionId);

		subscription.close();
		await subscription.ended;
		// Cancelled upstream: the server has nobody left to notify.
		await modern.request("tools/call", call("add_tool"));
		expect(seen).toHaveLength(1);
	});

	it("routes resource updates only to the subscription that listed the URI", async () => {
		const modern = await start();
		const first: string[] = [];
		const second: string[] = [];
		const a = await modern.listen({ resourceSubscriptions: ["fixture://one"] }, requestMeta(), (_method, params) =>
			first.push(String(params.uri)),
		);
		const b = await modern.listen({ resourceSubscriptions: ["fixture://two"] }, requestMeta(), (_method, params) =>
			second.push(String(params.uri)),
		);

		await modern.request("tools/call", call("touch", { uri: "fixture://two" }));

		expect(first).toEqual([]);
		expect(second).toEqual(["fixture://two"]);
		a.close();
		b.close();
	});

	it("reports a crash: the in-flight request fails, subscriptions end, and closed carries code and stderr", async () => {
		const modern = await start();
		const pid = modern.pid;
		const subscription = await modern.listen({ toolsListChanged: true }, requestMeta(), () => {});

		const failure = await modern
			.request("tools/call", call("crash", { code: 5, stderr: "fixture fell over\n" }))
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.retryable).toBe(false);
		expect(failure.code).toBe(5);
		expect(await modern.closed).toEqual({ code: 5, signal: undefined, stderr: "fixture fell over\n" });
		await subscription.ended;
		expect(pid !== undefined && isAlive(pid)).toBe(false);
	});

	it("stops the process on close and settles closed", async () => {
		const modern = await start();
		const pid = modern.pid;

		await modern.close("done");

		expect(pid !== undefined && isAlive(pid)).toBe(false);
		expect((await modern.closed).stderr).toBe("");
	});

	it("calls a subscription off upstream when its signal aborts before the acknowledgement", async () => {
		const rogue = await start(ROGUE);
		const controller = new AbortController();
		const listening = rogue.listen({ toolsListChanged: true }, requestMeta(), () => {}, controller.signal);
		const listen = (await framesAt(rogue)).find(frame => frame.method === "subscriptions/listen");
		expect(listen?.id).toBeDefined();

		controller.abort(new Error("link went away"));

		const failure = await listening.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(MCPTransportError);
		const cancelled = (await framesAt(rogue)).filter(frame => frame.method === "notifications/cancelled");
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0].params).toMatchObject({ requestId: listen?.id });
	});

	it("writes nothing for a subscription whose signal was already aborted", async () => {
		const rogue = await start(ROGUE);

		const failure = await rogue
			.listen({ toolsListChanged: true }, requestMeta(), () => {}, AbortSignal.abort(new Error("too late")))
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		expect((await framesAt(rogue)).map(frame => frame.method)).toEqual(["tools/call"]);
	});

	it("leaves an acknowledged subscription open when the signal it was opened with aborts", async () => {
		const modern = await start();
		const controller = new AbortController();
		const seen: string[] = [];
		const subscription = await modern.listen(
			{ toolsListChanged: true },
			requestMeta(),
			method => seen.push(method),
			controller.signal,
		);

		controller.abort();
		await modern.request("tools/call", call("add_tool"));

		expect(seen).toEqual(["notifications/tools/list_changed"]);
		subscription.close();
	});

	it("never answers a request a modern server sends, since the revision forbids client responses", async () => {
		const rogue = await start(ROGUE);

		await rogue.request("tools/call", call("ask"));
		// A response would be written while the request is handled; give it time to arrive before looking.
		await Bun.sleep(50);

		const written = await framesAt(rogue);
		expect(written.filter(frame => frame.method === undefined)).toEqual([]);
		expect(written.map(frame => frame.method)).toEqual(["tools/call", "tools/call"]);
	});

	it("kills the child when the start is aborted", async () => {
		const deps = realDeps();
		const controller = new AbortController();
		const spec = stdioSpec(path.join(FIXTURES, "cancellable-mcp.ts"), [
			path.join(import.meta.dir, `.abort-frames-${process.pid}.log`),
			"hang-initialize",
		]);
		const starting = mcpUpstreams.start(spec, "legacy", deps, controller.signal);
		while (deps.pids.length === 0) await Bun.sleep(5);

		controller.abort(new Error("nobody is waiting"));

		const failure = await starting.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(MCPTransportError);
		expect(isAlive(deps.pids[0])).toBe(false);
		await Bun.file(spec.args[1])
			.delete()
			.catch(() => {});
	});
});
