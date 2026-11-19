#!/usr/bin/env bun
/**
 * Test fixture: stdio MCP server with lazy tool loaders, shaped like Kata's
 * `load_*` tools. `tools/list` starts with only the loaders; either loader adds
 * `extra_tool`.
 *
 * - `load_extra` pushes `notifications/tools/list_changed` before it replies,
 *   so the change lands while the call is still running (Kata's order).
 * - `load_extra_late` replies first and announces the change only afterwards,
 *   once no call to the server is running.
 *
 * With {@link LIST_DELAY_ENV} set, each `tools/list` answer is computed when the
 * request arrives but sent that many milliseconds later, so a refresh can still
 * be in flight with a stale list while a loader runs.
 */
import * as readline from "node:readline";

export const LOADER_TOOL = "load_extra";
export const LATE_LOADER_TOOL = "load_extra_late";
export const LOADED_TOOL = "extra_tool";
export const LIST_DELAY_ENV = "LAZY_LOADER_LIST_DELAY_MS";

/** Delay between `load_extra_late`'s reply and its change notice; long enough for the reply to settle. */
const LATE_NOTICE_DELAY_MS = 100;

type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
};

const emptySchema = { type: "object", properties: {} };

function startServer(): void {
	let loaded = false;
	const listDelayMs = Number(process.env[LIST_DELAY_ENV] ?? 0);
	const write = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
	const announce = () => write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(trimmed) as JsonRpcMessage;
		} catch {
			return;
		}
		if (msg.id === undefined || msg.id === null || !msg.method) return;
		let result: Record<string, unknown> = {};
		let announceLate = false;
		switch (msg.method) {
			case "initialize":
				result = {
					protocolVersion: "2025-03-26",
					serverInfo: { name: "lazy-loader-fixture", version: "1.0.0" },
					capabilities: { tools: { listChanged: true } },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						{ name: LOADER_TOOL, description: "Load the extra tool", inputSchema: emptySchema },
						{
							name: LATE_LOADER_TOOL,
							description: "Load the extra tool, announced late",
							inputSchema: emptySchema,
						},
						...(loaded ? [{ name: LOADED_TOOL, description: "The extra tool", inputSchema: emptySchema }] : []),
					],
				};
				break;
			case "tools/call": {
				const name = msg.params?.name;
				if ((name === LOADER_TOOL || name === LATE_LOADER_TOOL) && !loaded) {
					loaded = true;
					if (name === LOADER_TOOL) announce();
					else announceLate = true;
				}
				result = { content: [{ type: "text", text: "ok" }] };
				break;
			}
		}
		const response = { jsonrpc: "2.0", id: msg.id, result };
		if (msg.method === "tools/list" && listDelayMs > 0) setTimeout(() => write(response), listDelayMs);
		else write(response);
		if (announceLate) setTimeout(announce, LATE_NOTICE_DELAY_MS);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
