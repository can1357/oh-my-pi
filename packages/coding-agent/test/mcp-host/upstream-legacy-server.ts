#!/usr/bin/env bun
/**
 * Test fixture: a handshake-era (2025-11-25) stdio MCP server that exercises
 * what the existing legacy fixtures do not: a server-to-client `roots/list`
 * request, list-change and resource-update notifications on demand, and
 * `resources/subscribe` bookkeeping. Tools:
 *
 * - `roots`: asks the client for its roots and returns them.
 * - `change`: sends `notifications/tools/list_changed`.
 * - `touch`: sends `notifications/resources/updated` for `arguments.uri`.
 * - `subscribed`: returns the URIs currently subscribed.
 * - `params`: returns the `tools/call` params exactly as received.
 * - `custom`: sends `arguments.count` (default 1) `notifications/custom/tick`
 *   notifications numbered from 0.
 * - `subscribe_calls`: returns how many `resources/subscribe` requests arrived.
 *
 * `resources/subscribe` answers a `slow:` URI after 150 ms and refuses a
 * `fail:` URI.
 */
import * as readline from "node:readline";

interface Message {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
}

const subscribed = new Set<string>();
let subscribeCalls = 0;
const awaitingRoots = new Map<string, string | number>();
let asked = 0;

const write = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function handle(message: Message): void {
	if (message.method === undefined) {
		const caller = typeof message.id === "string" ? awaitingRoots.get(message.id) : undefined;
		if (caller !== undefined) write({ jsonrpc: "2.0", id: caller, result: text(message.result?.roots ?? null) });
		return;
	}
	const id = message.id;
	if (id === undefined) return;
	const params = message.params ?? {};
	const args = (params.arguments ?? {}) as Record<string, unknown>;
	switch (message.method) {
		case "initialize":
			write({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "legacy-host-fixture", version: "2.0.0" },
					capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
				},
			});
			return;
		case "resources/subscribe": {
			const uri = String(params.uri);
			subscribeCalls++;
			if (uri.startsWith("fail:")) {
				write({ jsonrpc: "2.0", id, error: { code: -32002, message: `Cannot subscribe to ${uri}` } });
				return;
			}
			subscribed.add(uri);
			if (uri.startsWith("slow:")) {
				setTimeout(() => write({ jsonrpc: "2.0", id, result: {} }), 150);
				return;
			}
			break;
		}
		case "resources/unsubscribe":
			subscribed.delete(String(params.uri));
			break;
		case "tools/call":
			switch (params.name) {
				case "roots": {
					const request = `roots-${++asked}`;
					awaitingRoots.set(request, id);
					write({ jsonrpc: "2.0", id: request, method: "roots/list" });
					return;
				}
				case "change":
					write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
					break;
				case "touch":
					write({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: args.uri } });
					break;
				case "custom":
					for (let n = 0; n < Number(args.count ?? 1); n++) {
						write({ jsonrpc: "2.0", method: "notifications/custom/tick", params: { n } });
					}
					break;
				case "subscribe_calls":
					write({ jsonrpc: "2.0", id, result: text(subscribeCalls) });
					return;
				case "subscribed":
					write({ jsonrpc: "2.0", id, result: text([...subscribed].sort()) });
					return;
				case "params":
					write({ jsonrpc: "2.0", id, result: text(params) });
					return;
			}
			break;
		default:
			write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			return;
	}
	write({ jsonrpc: "2.0", id, result: {} });
}

if (import.meta.main) {
	const lines = readline.createInterface({ input: process.stdin });
	lines.on("line", line => {
		if (line.trim().length > 0) handle(JSON.parse(line) as Message);
	});
	lines.on("close", () => process.exit(0));
}
