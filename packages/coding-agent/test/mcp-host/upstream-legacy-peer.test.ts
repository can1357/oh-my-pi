import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { McpPeer } from "@oh-my-pi/pi-coding-agent/mcp/host/peer";
import { mcpUpstreams } from "@oh-my-pi/pi-coding-agent/mcp/host/peers";
import { MCP_LEGACY_TTL_MS } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { MCP_PROTOCOL_VERSION, MCPMeta, requestMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { SERVER_INSTRUCTIONS, TOOL_NAME, TOOL_RESULT } from "../fixtures/instructions-mcp";
import { CUSTOM_NOTIFICATION_METHOD, CUSTOM_NOTIFICATION_PAYLOAD } from "../fixtures/notifications-mcp";
import { FIXTURES, ROOTS, realDeps, stdioSpec, toolJson } from "./upstream-support";

const LEGACY_SERVER = path.join(import.meta.dir, "upstream-legacy-server.ts");
const PROGRESS_SERVER = path.join(FIXTURES, "progress-mcp.ts");

/** What `progress-mcp.ts` reports back about the `tools/call` it received. */
function received(result: Record<string, unknown>): Record<string, unknown> {
	const echoed = result.structuredContent;
	if (typeof echoed !== "object" || echoed === null) throw new Error("fixture did not echo the request");
	return { ...echoed };
}

describe("legacy peer over a subprocess", () => {
	let peer: McpPeer | undefined;

	afterEach(async () => {
		await peer?.close("test over");
		peer = undefined;
	});

	async function start(script: string, args: string[] = []): Promise<McpPeer> {
		peer = await mcpUpstreams.start(stdioSpec(script, args), "legacy", realDeps());
		return peer;
	}

	it("answers server/discover from the initialize result", async () => {
		const legacy = await start(path.join(FIXTURES, "instructions-mcp.ts"));

		expect(await legacy.request("server/discover", { _meta: requestMeta() })).toEqual({
			resultType: "complete",
			supportedVersions: [MCP_PROTOCOL_VERSION],
			capabilities: { tools: {} },
			instructions: SERVER_INSTRUCTIONS,
			ttlMs: MCP_LEGACY_TTL_MS,
			cacheScope: "private",
			_meta: { [MCPMeta.serverInfo]: { name: "instr-fixture", version: "1.0.0" } },
		});
	});

	it("completes list and call results with the hints a modern server would send", async () => {
		const legacy = await start(path.join(FIXTURES, "instructions-mcp.ts"));

		const list = await legacy.request("tools/list", { _meta: requestMeta() });
		expect(list).toMatchObject({ resultType: "complete", ttlMs: MCP_LEGACY_TTL_MS, cacheScope: "private" });
		expect(list.tools).toHaveLength(1);
		expect(list.tools).toMatchObject([{ name: TOOL_NAME }]);

		const called = await legacy.request("tools/call", { name: TOOL_NAME, arguments: {}, _meta: requestMeta() });
		expect(called).toEqual({
			content: [{ type: "text", text: TOOL_RESULT }],
			isError: false,
			resultType: "complete",
		});
	});

	it("reads a missing resources/templates/list method as an empty list and marks reads uncacheable", async () => {
		const legacy = await start(path.join(FIXTURES, "resources-no-templates-mcp.ts"));

		expect(await legacy.request("resources/templates/list", { _meta: requestMeta() })).toEqual({
			resourceTemplates: [],
			resultType: "complete",
			ttlMs: MCP_LEGACY_TTL_MS,
			cacheScope: "private",
		});
		const resources = await legacy.request("resources/list", { _meta: requestMeta() });
		const listed = Array.isArray(resources.resources) ? resources.resources : [];
		expect(listed.length).toBeGreaterThan(0);
		const read = await legacy.request("resources/read", { uri: listed[0].uri, _meta: requestMeta() });
		expect(read).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
	});

	it("strips modern-only request fields before forwarding", async () => {
		const legacy = await start(LEGACY_SERVER);

		const result = await legacy.request("tools/call", {
			name: "params",
			arguments: { a: 1 },
			inputResponses: { roots: { roots: [] } },
			requestState: "opaque",
			_meta: { ...requestMeta(), traceparent: "00-abc-def-01" },
		});

		expect(toolJson(result)).toEqual({
			name: "params",
			arguments: { a: 1 },
			_meta: { traceparent: "00-abc-def-01" },
		});
	});

	it("answers the server's roots/list request from the deps", async () => {
		const legacy = await start(LEGACY_SERVER);

		const result = await legacy.request("tools/call", { name: "roots", arguments: {}, _meta: requestMeta() });

		expect(toolJson(result)).toEqual(ROOTS);
	});

	it("routes a list-change notification to the subscriptions that asked for that type", async () => {
		const legacy = await start(LEGACY_SERVER);
		const tools: string[] = [];
		const prompts: string[] = [];
		const wantsTools = await legacy.listen(
			{ toolsListChanged: true, promptsListChanged: true },
			requestMeta(),
			method => tools.push(method),
		);
		const wantsPrompts = await legacy.listen({ promptsListChanged: true }, requestMeta(), method =>
			prompts.push(method),
		);
		// The server declares only tools.listChanged.
		expect(wantsTools.acknowledged).toEqual({ toolsListChanged: true });
		expect(wantsPrompts.acknowledged).toEqual({});

		await legacy.request("tools/call", { name: "change", arguments: {}, _meta: requestMeta() });
		expect(tools).toEqual(["notifications/tools/list_changed"]);
		expect(prompts).toEqual([]);

		wantsTools.close();
		await wantsTools.ended;
		await legacy.request("tools/call", { name: "change", arguments: {}, _meta: requestMeta() });
		expect(tools).toHaveLength(1);
	});

	it("subscribes a URI upstream once however many subscriptions list it, and unsubscribes with the last", async () => {
		const legacy = await start(LEGACY_SERVER);
		const subscribed = async () =>
			toolJson(await legacy.request("tools/call", { name: "subscribed", arguments: {}, _meta: requestMeta() }));
		const updates: string[] = [];
		const first = await legacy.listen({ resourceSubscriptions: ["file:///a"] }, requestMeta(), (_method, params) =>
			updates.push(`first:${String(params.uri)}`),
		);
		const second = await legacy.listen(
			{ resourceSubscriptions: ["file:///a", "file:///b"] },
			requestMeta(),
			(_method, params) => updates.push(`second:${String(params.uri)}`),
		);
		expect(first.acknowledged).toEqual({ resourceSubscriptions: ["file:///a"] });
		expect(await subscribed()).toEqual(["file:///a", "file:///b"]);

		await legacy.request("tools/call", { name: "touch", arguments: { uri: "file:///b" }, _meta: requestMeta() });
		expect(updates).toEqual(["second:file:///b"]);

		second.close();
		expect(await subscribed()).toEqual(["file:///a"]);
		first.close();
		expect(await subscribed()).toEqual([]);
	});

	it("asks for progress with a token of its own and leaves the caller's params untouched", async () => {
		const legacy = await start(PROGRESS_SERVER);
		// Frozen: a peer that wrote its token into the caller's objects would fail the request.
		const args = Object.freeze({ steps: 2, delayMs: 1, _meta: { toolOwned: true } });
		const meta = Object.freeze({ ...requestMeta(), trace: "keep", progressToken: "stale" });
		const progress: Record<string, unknown>[] = [];

		const result = await legacy.request(
			"tools/call",
			Object.freeze({ name: "progress_tool", arguments: args, _meta: meta }),
			{ onProgress: update => progress.push(update) },
		);

		const seen = received(result);
		expect(seen._meta).toEqual({ trace: "keep", progressToken: seen.requestId });
		expect(seen.arguments).toEqual(args);
		expect(progress).toEqual([{ progress: 1 }, { progress: 2 }]);
	});

	it("gives each concurrent call its own progress and nobody the stray frames", async () => {
		const legacy = await start(PROGRESS_SERVER);
		const first: Record<string, unknown>[] = [];
		const second: Record<string, unknown>[] = [];
		const call = (args: Record<string, unknown>, sink: Record<string, unknown>[]) =>
			legacy.request(
				"tools/call",
				{ name: "progress_tool", arguments: args, _meta: requestMeta() },
				{ onProgress: update => sink.push(update) },
			);

		await Promise.all([
			call(
				{
					steps: [
						{ progress: 1, message: "first" },
						{ progress: 2, message: "first" },
					],
					delayMs: 1,
					// A foreign token, a non-numeric amount, a token that is no token, and progress after the result.
					includeUnknown: true,
					includeMalformed: true,
					includeLate: true,
				},
				first,
			),
			call({ steps: [{ progress: 4 }, { progress: 5 }, { progress: 6 }], delayMs: 1 }, second),
		]);
		// Answered after everything the server wrote before it, the late frame included.
		await legacy.request("tools/list", { _meta: requestMeta() });

		expect(first).toEqual([
			{ progress: 1, message: "first" },
			{ progress: 2, message: "first" },
		]);
		expect(second).toEqual([{ progress: 4 }, { progress: 5 }, { progress: 6 }]);
	});

	it("keeps zero, negative and fractional progress but drops invalid optional fields and non-numeric amounts", async () => {
		const legacy = await start(PROGRESS_SERVER);
		const progress: Record<string, unknown>[] = [];

		await legacy.request(
			"tools/call",
			{
				name: "progress_tool",
				arguments: {
					steps: [
						{ progress: 0, total: 0, message: "" },
						{ progress: -0.5, total: "bad", message: 4 },
						{ progress: null },
					],
				},
				_meta: requestMeta(),
			},
			{ onProgress: update => progress.push(update) },
		);

		expect(progress).toEqual([{ progress: 0, total: 0, message: "" }, { progress: -0.5 }]);
	});

	it("keeps a server-defined notification sent right after initialize for the first subscription, even one with an empty filter", async () => {
		const legacy = await start(path.join(FIXTURES, "notifications-mcp.ts"));
		// The fixture notifies when it is initialized; this answer follows those lines on its stdout.
		await legacy.request("tools/list", { _meta: requestMeta() });
		const seen: { method: string; params: Record<string, unknown> }[] = [];

		const subscription = await legacy.listen({}, requestMeta(), (method, params) => seen.push({ method, params }));

		expect(subscription.acknowledged).toEqual({});
		// The list change it sent alongside is a type nobody subscribed to.
		expect(seen).toEqual([{ method: CUSTOM_NOTIFICATION_METHOD, params: { ...CUSTOM_NOTIFICATION_PAYLOAD } }]);
		subscription.close();
	});

	it("holds back at most the newest hundred server-defined notifications, in order, then delivers live to every subscription", async () => {
		const legacy = await start(LEGACY_SERVER);
		const custom = (count: number) =>
			legacy.request("tools/call", { name: "custom", arguments: { count }, _meta: requestMeta() });
		await custom(105);
		const first: unknown[] = [];
		const second: unknown[] = [];

		const one = await legacy.listen({}, requestMeta(), (method, params) => first.push([method, params.n]));
		const two = await legacy.listen({ toolsListChanged: true }, requestMeta(), (method, params) =>
			second.push([method, params.n]),
		);

		expect(first).toHaveLength(100);
		expect(first[0]).toEqual(["notifications/custom/tick", 5]);
		expect(first[99]).toEqual(["notifications/custom/tick", 104]);
		expect(second).toEqual([]);

		await custom(1);
		expect(first).toHaveLength(101);
		expect(second).toEqual([["notifications/custom/tick", 0]]);
		one.close();
		two.close();
	});

	describe("resource subscriptions that overlap", () => {
		const count = async (legacy: McpPeer, tool: "subscribe_calls" | "subscribed") =>
			toolJson(await legacy.request("tools/call", { name: tool, arguments: {}, _meta: requestMeta() }));

		it("shares one pending subscribe between the subscriptions that list the URI", async () => {
			const legacy = await start(LEGACY_SERVER);

			const [one, two] = await Promise.all([
				legacy.listen({ resourceSubscriptions: ["slow:a"] }, requestMeta(), () => {}),
				legacy.listen({ resourceSubscriptions: ["slow:a"] }, requestMeta(), () => {}),
			]);

			expect(one.acknowledged).toEqual({ resourceSubscriptions: ["slow:a"] });
			expect(two.acknowledged).toEqual({ resourceSubscriptions: ["slow:a"] });
			expect(await count(legacy, "subscribe_calls")).toBe(1);
			one.close();
			expect(await count(legacy, "subscribed")).toEqual(["slow:a"]);
			two.close();
			expect(await count(legacy, "subscribed")).toEqual([]);
		});

		it("fails every subscription waiting on a refused subscribe and asks the server again for the next one", async () => {
			const legacy = await start(LEGACY_SERVER);

			const failures = await Promise.all([
				legacy
					.listen({ resourceSubscriptions: ["fail:x"] }, requestMeta(), () => {})
					.catch((error: unknown) => error),
				legacy
					.listen({ resourceSubscriptions: ["fail:x"] }, requestMeta(), () => {})
					.catch((error: unknown) => error),
			]);

			for (const failure of failures) {
				expect(failure).toBeInstanceOf(MCPTransportError);
				if (failure instanceof MCPTransportError) expect(failure.rpc?.code).toBe(-32002);
			}
			expect(await count(legacy, "subscribe_calls")).toBe(1);
			// Nobody holds the URI after the refusal, so a new subscription is a new request, not a shared one.
			const again = await legacy
				.listen({ resourceSubscriptions: ["fail:x"] }, requestMeta(), () => {})
				.catch((error: unknown) => error);
			expect(again).toBeInstanceOf(MCPTransportError);
			expect(await count(legacy, "subscribe_calls")).toBe(2);
		});

		it("takes back a subscribe already sent when the signal aborts before the acknowledgement", async () => {
			const legacy = await start(LEGACY_SERVER);
			const controller = new AbortController();
			const listening = legacy.listen(
				{ resourceSubscriptions: ["slow:a"] },
				requestMeta(),
				() => {},
				controller.signal,
			);
			expect(await count(legacy, "subscribed")).toEqual(["slow:a"]);

			controller.abort(new Error("link went away"));

			expect(await listening.catch((error: unknown) => error)).toBeInstanceOf(MCPTransportError);
			// The unsubscribe follows the server's late answer to the subscribe.
			const deadline = Date.now() + 2_000;
			while (JSON.stringify(await count(legacy, "subscribed")) !== "[]") {
				if (Date.now() > deadline) throw new Error("the aborted subscription was never unsubscribed");
				await Bun.sleep(10);
			}
			expect(await count(legacy, "subscribe_calls")).toBe(1);
		});

		it("keeps an acknowledged subscription when the signal it was opened with aborts", async () => {
			const legacy = await start(LEGACY_SERVER);
			const controller = new AbortController();
			const updates: unknown[] = [];
			const subscription = await legacy.listen(
				{ resourceSubscriptions: ["file:///a"] },
				requestMeta(),
				(_method, params) => updates.push(params.uri),
				controller.signal,
			);

			controller.abort();
			await legacy.request("tools/call", { name: "touch", arguments: { uri: "file:///a" }, _meta: requestMeta() });

			expect(updates).toEqual(["file:///a"]);
			subscription.close();
		});
	});

	it("tells the server when a request is aborted", async () => {
		const log = path.join(import.meta.dir, `.cancel-frames-${process.pid}.log`);
		try {
			const legacy = await start(path.join(FIXTURES, "cancellable-mcp.ts"), [log]);
			const controller = new AbortController();
			const hanging = legacy.request(
				"tools/call",
				{ name: "hang", arguments: {}, _meta: requestMeta() },
				{ signal: controller.signal },
			);
			// The echo answer proves the server already read the hanging call.
			await legacy.request("tools/call", { name: "echo", arguments: { text: "x" }, _meta: requestMeta() });

			controller.abort();
			expect(await hanging.catch((error: unknown) => error)).toBeInstanceOf(MCPTransportError);
			await legacy.request("tools/call", { name: "echo", arguments: { text: "y" }, _meta: requestMeta() });

			const frames = (await Bun.file(log).text())
				.split("\n")
				.filter(line => line.length > 0)
				.map((line): Record<string, unknown> => JSON.parse(line));
			const hang = frames.find(frame => JSON.stringify(frame.params).includes('"hang"'));
			const cancelled = frames.find(frame => frame.method === "notifications/cancelled");
			expect(hang?.id).toBeDefined();
			expect(cancelled?.params).toMatchObject({ requestId: hang?.id });
		} finally {
			await peer?.close("test over");
			peer = undefined;
			await Bun.file(log)
				.delete()
				.catch(() => {});
		}
	});
});
