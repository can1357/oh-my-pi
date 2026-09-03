#!/usr/bin/env bun
/**
 * Test fixture: minimal stdio MCP server used by
 * `mcp-manager-notification-listeners.test.ts` to exercise the notification
 * listener API. On receiving the client's `notifications/initialized`, emits
 * TWO server-to-client notification frames:
 *
 *   1. `notifications/tools/list_changed` — a known method that MCPManager
 *      handles internally (triggers a `tools/list` refresh). Delivered to
 *      listeners AFTER the internal handling; verifies fanout is not gated
 *      on the method being unknown.
 *   2. A server-custom method (`notifications/custom/test-event`) with a
 *      distinctive payload — verifies that arbitrary methods are delivered
 *      to listeners verbatim, which is the extension use case (bridging a
 *      peer-messaging MCP's custom push into a session steer).
 *
 * The custom method + payload constants are exported so the test can assert
 * on frame equality without duplicating literals.
 */
import * as readline from "node:readline";

export const CUSTOM_NOTIFICATION_METHOD = "notifications/custom/test-event";
export const CUSTOM_NOTIFICATION_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({
	hello: "world",
	n: 42,
});

type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "notifications-fixture", version: "1.0.0" },
				capabilities: { tools: { listChanged: true } },
			};
		case "tools/list":
			return { tools: [] };
		default:
			return {};
	}
}

function writeNotification(method: string, params?: Record<string, unknown>): void {
	const frame: JsonRpcMessage = { jsonrpc: "2.0", method };
	if (params) frame.params = params;
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(trimmed) as JsonRpcMessage;
			} catch {
				return;
			}
			const isNotification = msg.id === undefined || msg.id === null;
			if (isNotification) {
				if (msg.method === "notifications/initialized") {
					writeNotification("notifications/tools/list_changed");
					writeNotification(CUSTOM_NOTIFICATION_METHOD, { ...CUSTOM_NOTIFICATION_PAYLOAD });
				}
				return;
			}
			if (!msg.method) return;
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
