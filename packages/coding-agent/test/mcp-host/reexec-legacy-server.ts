#!/usr/bin/env bun
/**
 * Test fixture: a handshake-era (2025-11-25) stdio MCP server whose one tool,
 * {@link STATE_TOOL}, reports what this process has seen so far: its pid, how
 * many `initialize` requests arrived and how many `tools/call` requests it
 * served. A test can tell from two answers whether the same process and the
 * same `initialize` session served both.
 */
import * as readline from "node:readline";

export const STATE_TOOL = "state";

/** Text content of a {@link STATE_TOOL} result, as JSON. */
export interface LegacyServerState {
	pid: number;
	initializes: number;
	calls: number;
}

interface Message {
	id?: string | number;
	method?: string;
}

function startServer(): void {
	let initializes = 0;
	let calls = 0;
	const reply = (id: string | number, result: Record<string, unknown>) =>
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

	const lines = readline.createInterface({ input: process.stdin });
	lines.on("line", line => {
		if (line.trim().length === 0) return;
		const message = JSON.parse(line) as Message;
		const { id } = message;
		if (id === undefined || message.method === undefined) return;
		switch (message.method) {
			case "initialize":
				initializes++;
				reply(id, {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "reexec-legacy-fixture", version: "1.0.0" },
					capabilities: { tools: {} },
				});
				return;
			case "tools/list":
				reply(id, {
					tools: [
						{
							name: STATE_TOOL,
							description: "Report what this process has seen",
							inputSchema: { type: "object", properties: {} },
						},
					],
				});
				return;
			case "tools/call": {
				calls++;
				const state: LegacyServerState = { pid: process.pid, initializes, calls };
				reply(id, { content: [{ type: "text", text: JSON.stringify(state) }] });
				return;
			}
			default:
				reply(id, {});
		}
	});
	lines.on("close", () => process.exit(0));
}

if (import.meta.main) startServer();
