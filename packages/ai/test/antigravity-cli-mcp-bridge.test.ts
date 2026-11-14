import { afterEach, describe, expect, it } from "bun:test";
import { connect, type Socket } from "node:net";
import { McpBridge, type McpToolOutput } from "@oh-my-pi/pi-ai/providers/antigravity-cli/mcp-bridge";

interface Reply {
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
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
			const reply: Reply = JSON.parse(line);
			replies.get(reply.id)?.resolve(reply);
			replies.delete(reply.id);
		}
	});
	cleanups.push(() => socket.destroy());
	await ready.promise;
	let nextId = 0;
	return {
		socket,
		closed: closed.promise,
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

describe("McpBridge", () => {
	it("rejects unknown tools and invalid arguments without calling the host", async () => {
		let calls = 0;
		const bridge = new McpBridge(tools, async () => {
			calls++;
			return { content: [] };
		});
		cleanups.push(() => bridge.close());
		const peer = await client(bridge.port);
		for (const params of [
			{ name: "missing", arguments: {} },
			{ name: "read", arguments: [] },
			{ name: "read", arguments: { path: 2 } },
			{ name: "read", arguments: null },
		]) {
			expect((await peer.request("tools/call", params)).error?.code).toBe(-32602);
		}
		expect(calls).toBe(0);
		expect((await peer.request("tools/list")).result).toEqual({ tools });
	});

	it("decodes fragmented UTF-8 and parks the MCP response until its actual result arrives", async () => {
		const arrived = Promise.withResolvers<{ name: string; args: Record<string, unknown>; id: string | undefined }>();
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
});
