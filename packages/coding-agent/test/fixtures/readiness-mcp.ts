#!/usr/bin/env bun
/** Minimal stdio MCP server with independently delayed startup and tools/call. */
import * as readline from "node:readline";

const name = Bun.env.SRV_NAME ?? "srv";
const startupDelayMs = Number(Bun.env.DELAY_STARTUP ?? 0);
const callDelayMs = Number(Bun.env.DELAY_CALL ?? 0);

async function serve(): Promise<void> {
	if (startupDelayMs > 0) await Bun.sleep(startupDelayMs);
	const lines = readline.createInterface({ input: process.stdin });
	for await (const line of lines) {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof request !== "object" || request === null || !("method" in request)) continue;
		const method = request.method;
		if (!("id" in request)) continue;
		let result: object;
		switch (method) {
			case "initialize":
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name, version: "1.0.0" },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						{
							name: `${name}_marker`,
							description: `Return the ${name} marker.`,
							inputSchema: { type: "object", properties: {} },
						},
					],
				};
				break;
			case "tools/call":
				if (callDelayMs > 0) await Bun.sleep(callDelayMs);
				result = { content: [{ type: "text", text: `MARKER_OK::${name}` }] };
				break;
			default:
				result = {};
		}
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
	}
}

if (import.meta.main) void serve();
