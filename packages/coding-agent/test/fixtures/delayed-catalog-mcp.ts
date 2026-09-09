#!/usr/bin/env bun
/**
 * Stdio MCP server whose tools/list is immediate, but resources/list and
 * prompts/list wait until `DELAY_CATALOG_UNTIL` exists on disk.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export const TOOL_NAME = "catalog_ping";
export const RESOURCE_URI = "test://delayed-catalog";
export const RESOURCE_NAME = "Delayed resource";
export const PROMPT_NAME = "delayed_prompt";

const GATE = process.env.DELAY_CATALOG_UNTIL ?? "";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

async function waitForGate(): Promise<void> {
	if (!GATE) return;
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(GATE)) {
		if (Date.now() > deadline) throw new Error("catalog gate timed out");
		await Bun.sleep(15);
	}
}

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "delayed-catalog-fixture", version: "1.0.0" },
				capabilities: { tools: {}, resources: {}, prompts: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: TOOL_NAME,
						description: "Immediate tool so connect can finish before catalogs.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "resources/list":
			return {
				resources: [{ uri: RESOURCE_URI, name: RESOURCE_NAME }],
			};
		case "resources/templates/list":
			return { resourceTemplates: [] };
		case "prompts/list":
			return {
				prompts: [{ name: PROMPT_NAME, description: "Delayed prompt" }],
			};
		case "tools/call":
			return { content: [{ type: "text", text: "ok" }], isError: false };
		default:
			return {};
	}
}

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "resources/list" || msg.method === "prompts/list") {
				try {
					await waitForGate();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } })}\n`,
					);
					return;
				}
			}
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: buildResult(msg.method) })}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
