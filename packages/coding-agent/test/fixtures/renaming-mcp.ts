#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that renames its only tool during the
 * first call to it, and then exits for good.
 *
 * The first `tools/list` serves {@link RENAME_TOOL}. Calling it pushes
 * `notifications/tools/list_changed` before replying — Kata's order, the one
 * that makes the refresh belong to the caller's session — and every later
 * `tools/list` serves {@link RENAMED_TOOL} instead, so the server's whole
 * catalog is a tool one session's call loaded.
 *
 * The process exits shortly after answering that renamed list, and a respawn
 * sees the file named by {@link MARKER_ENV} and exits at once, so the server
 * ends up down with its renamed tool still registered: the shape in which a
 * missing-tool note has to say something true about a catalog not every
 * session can see.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export const RENAME_TOOL = "load";
export const RENAMED_TOOL = "search";
/** Env var naming the file that makes a respawn refuse; unset keeps the server respawnable. */
export const MARKER_ENV = "RENAMING_MCP_MARKER";

/** Delay between the renamed `tools/list` answer and the exit; long enough for the call that provoked it to settle. */
const EXIT_DELAY_MS = 250;

type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
};

const emptySchema = { type: "object", properties: {} };

function startServer(): void {
	const marker = process.env[MARKER_ENV];
	if (marker) {
		if (fs.existsSync(marker)) process.exit(3);
		fs.writeFileSync(marker, "spawned");
	}
	let renamed = false;
	const write = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
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
		let exitAfter = false;
		switch (msg.method) {
			case "initialize":
				result = {
					protocolVersion: "2025-03-26",
					serverInfo: { name: "renaming-fixture", version: "1.0.0" },
					capabilities: { tools: { listChanged: true } },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						renamed
							? { name: RENAMED_TOOL, description: "The renamed tool", inputSchema: emptySchema }
							: { name: RENAME_TOOL, description: "Rename the tool", inputSchema: emptySchema },
					],
				};
				exitAfter = renamed;
				break;
			case "tools/call":
				if (!renamed) {
					renamed = true;
					write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				}
				result = { content: [{ type: "text", text: "ok" }] };
				break;
		}
		write({ jsonrpc: "2.0", id: msg.id, result });
		if (exitAfter) setTimeout(() => process.exit(0), EXIT_DELAY_MS);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
