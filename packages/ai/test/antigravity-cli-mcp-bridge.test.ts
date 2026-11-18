import { afterEach, describe, expect, it } from "bun:test";
import { connect, type Socket } from "node:net";
import {
	McpBridge,
	type McpToolDefinition,
	type McpToolOutput,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/mcp-bridge";

interface Reply {
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
}

interface Notification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function client(port: number) {
	const socket: Socket = connect({ host: "127.0.0.1", port });
	const ready = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const replies = new Map<number, PromiseWithResolvers<Reply>>();
	const notifications: Notification[] = [];
	const notificationWaiters: PromiseWithResolvers<Notification>[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", ready.resolve);
	socket.on("error", ready.reject);
	socket.on("close", () => closed.resolve());
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			const message = JSON.parse(line) as Reply | Notification;
			if ("method" in message) {
				const waiter = notificationWaiters.shift();
				if (waiter) waiter.resolve(message);
				else notifications.push(message);
				continue;
			}
			replies.get(message.id)?.resolve(message);
			replies.delete(message.id);
		}
	});
	cleanups.push(() => socket.destroy());
	await ready.promise;
	let nextId = 0;
	return {
		socket,
		closed: closed.promise,
		notifications,
		nextNotification(): Promise<Notification> {
			const queued = notifications.shift();
			if (queued) return Promise.resolve(queued);
			const deferred = Promise.withResolvers<Notification>();
			notificationWaiters.push(deferred);
			return deferred.promise;
		},
		request(method: string, params?: unknown, fragmented = false): Promise<Reply> {
			const id = ++nextId;
			const deferred = Promise.withResolvers<Reply>();
			replies.set(id, deferred);
			const frame = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			if (fragmented) {
				const character = frame.indexOf(Buffer.from("雪"));
				socket.write(frame.subarray(0, character + 1));
				socket.write(frame.subarray(character + 1));
			} else socket.write(frame);
			return deferred.promise;
		},
	};
}

const tools = [
	{
		name: "read",
		description: "Read",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
	},
];

const write: McpToolDefinition = {
	name: "write",
	description: "Write",
	inputSchema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
};

describe("McpBridge", () => {
	it("rejects unknown tools and forwards argument validation to the host", async () => {
		const calls: { name: string; args: unknown }[] = [];
		const bridge = new McpBridge(tools, async (name, args) => {
			calls.push({ name, args });
			return { content: [{ type: "text", text: "host rejected" }], isError: true };
		});
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		const unknown = await peer.request("tools/call", { name: "missing", arguments: {} });
		expect(unknown.error?.code).toBe(-32602);
		expect(unknown.error?.message).toContain("missing");
		expect(calls).toHaveLength(0);
		const forwarded = [
			{ name: "read", arguments: [] },
			{ name: "read", arguments: { path: 2 } },
			{ name: "read", arguments: null },
		];
		for (const params of forwarded) {
			expect((await peer.request("tools/call", params)).result).toEqual({
				content: [{ type: "text", text: "host rejected" }],
				isError: true,
			});
		}
		expect(calls).toEqual(forwarded.map(params => ({ name: params.name, args: params.arguments })));
		expect((await peer.request("tools/list")).result).toEqual({ tools });
	});

	it("bounds an oversized unknown tool name in the error message", async () => {
		const bridge = new McpBridge(tools, async () => ({ content: [] }));
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		const name = "x".repeat(1_000);
		const reply = await peer.request("tools/call", { name, arguments: {} });
		expect(reply.error?.code).toBe(-32602);
		expect(reply.error?.message).toContain("x".repeat(128));
		expect(reply.error?.message.length).toBeLessThanOrEqual(142);
	});

	it("rejects a non-string tool name without escaping the handler", async () => {
		const bridge = new McpBridge(tools, async () => ({ content: [] }));
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		const reply = await peer.request("tools/call", { name: { toString: null }, arguments: {} });
		expect(reply.error?.code).toBe(-32602);
		expect(reply.error?.message).toBe("Unknown tool");
		expect((await peer.request("tools/list")).result).toEqual({ tools });
	});

	it("decodes fragmented UTF-8 and parks the MCP response until its actual result arrives", async () => {
		const arrived = Promise.withResolvers<{ name: string; args: unknown; id: string | undefined }>();
		const result = Promise.withResolvers<McpToolOutput>();
		const bridge = new McpBridge(tools, async (name, args, id) => {
			arrived.resolve({ name, args, id });
			return result.promise;
		});
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		const id = crypto.randomUUID();
		const reply = peer.request(
			"tools/call",
			{
				name: "read",
				arguments: { path: "雪.txt" },
				_meta: { "antigravity.google/conversation_id": id, progressToken: 4 },
			},
			true,
		);
		let replied = false;
		void reply.then(() => {
			replied = true;
		});
		expect(await arrived.promise).toEqual({ name: "read", args: { path: "雪.txt" }, id });
		expect(replied).toBe(false);
		const content: McpToolOutput = {
			content: [
				{ type: "text", text: "body" },
				{ type: "image", data: "YQ==", mimeType: "image/png" },
			],
			isError: false,
		};
		result.resolve(content);
		expect((await reply).result).toEqual(content);
	});

	it("notifies the host when the active MCP connection disappears", async () => {
		const disconnected = Promise.withResolvers<void>();
		const bridge = new McpBridge(tools, async () => ({ content: [] }), disconnected.resolve);
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		await peer.request("ping");
		peer.socket.destroy();
		await disconnected.promise;
	});
	it("closes connected sockets even when a tool handler is still pending", async () => {
		const arrived = Promise.withResolvers<void>();
		const result = Promise.withResolvers<McpToolOutput>();
		const bridge = new McpBridge(tools, async () => {
			arrived.resolve();
			return result.promise;
		});
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		void peer.request("tools/call", { name: "read", arguments: { path: "a" } });
		await arrived.promise;
		bridge.close();
		await peer.closed;
		result.resolve({ content: [{ type: "text", text: "late" }] });
		bridge.close();
	});

	it("advertises tool list changes on initialize", async () => {
		const bridge = new McpBridge(tools, async () => ({ content: [] }));
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		const reply = await peer.request("initialize", { protocolVersion: "2025-06-18" });
		expect(reply.result).toMatchObject({ capabilities: { tools: { listChanged: true } } });
	});

	it("announces the replaced tool set to the connected client", async () => {
		const bridge = new McpBridge(tools, async () => ({ content: [] }));
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		await peer.request("ping");
		const changed = peer.nextNotification();
		bridge.updateTools([...tools, write]);
		expect(await changed).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		expect((await peer.request("tools/list")).result).toEqual({ tools: [...tools, write] });
	});
	it("lists and validates the updated tool set on the same connection", async () => {
		const called: string[] = [];
		const bridge = new McpBridge(tools, async name => {
			called.push(name);
			return { content: [] };
		});
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		expect((await peer.request("tools/list")).result).toEqual({ tools });
		bridge.updateTools([...tools, write]);
		expect((await peer.request("tools/list")).result).toEqual({ tools: [...tools, write] });
		expect((await peer.request("tools/call", { name: "write", arguments: { text: "body" } })).result).toEqual({
			content: [],
		});
		bridge.updateTools([]);
		expect((await peer.request("tools/list")).result).toEqual({ tools: [] });
		expect((await peer.request("tools/call", { name: "read", arguments: { path: "a" } })).error?.code).toBe(-32602);
		expect(called).toEqual(["write"]);
	});

	it("rejects duplicate tool names on construction and update", async () => {
		const duplicate: McpToolDefinition = { name: "read", description: "Other read", inputSchema: {} };
		expect(() => new McpBridge([...tools, duplicate], async () => ({ content: [] }))).toThrow(
			"Duplicate Antigravity CLI tool name",
		);
		const bridge = new McpBridge(tools, async () => ({ content: [] }));
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		expect(() => bridge.updateTools([...tools, duplicate])).toThrow("Duplicate Antigravity CLI tool name");
		expect((await peer.request("tools/list")).result).toEqual({ tools });
		expect(peer.notifications).toEqual([]);
	});

	it("keeps the final tool list when updated after close", async () => {
		const bridge = new McpBridge(tools, async () => ({ content: [] }));
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		expect((await peer.request("tools/list")).result).toEqual({ tools });
		bridge.close();
		await peer.closed;
		// A duplicate name throws on a live bridge and a valid list replaces it, so the closed guard
		// must skip both: the list served by tools/list stays the pre-close list.
		const duplicate: McpToolDefinition = { name: "read", description: "Other read", inputSchema: {} };
		bridge.updateTools([...tools, duplicate]);
		bridge.updateTools([write]);
		expect(bridge.tools).toEqual(tools);
	});
});
