#!/usr/bin/env bun
/** Stdio MCP fixture that records an effect before optionally losing its response. */
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: { name?: string; arguments?: { crash?: boolean } };
};

async function startServer(): Promise<void> {
	const effectsPath = process.argv[2];
	if (!effectsPath) throw new Error("An effects file path is required");
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			let request: JsonRpcRequest;
			try {
				request = JSON.parse(line) as JsonRpcRequest;
			} catch {
				return;
			}
			if (request.id === undefined || request.id === null) return;
			let result: Record<string, unknown>;
			switch (request.method) {
				case "initialize":
					result = {
						protocolVersion: "2025-03-26",
						serverInfo: { name: "side-effect-fixture", version: "1.0.0" },
						capabilities: { tools: {} },
					};
					break;
				case "tools/list":
					result = {
						tools: [
							{
								name: "record_effect",
								inputSchema: { type: "object", properties: { crash: { type: "boolean" } } },
							},
						],
					};
					break;
				case "tools/call":
					if (request.params?.name !== "record_effect") {
						process.stdout.write(
							`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown tool" } })}\n`,
						);
						return;
					}
					await fs.appendFile(effectsPath, "record_effect\n");
					if (request.params.arguments?.crash === true) process.exit(1);
					result = { content: [{ type: "text", text: "effect recorded" }], isError: false };
					break;
				default:
					result = {};
			}
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) void startServer();
