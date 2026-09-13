#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that models an aggregating gateway's
 * cold-start warmup window. It completes `initialize` instantly and stays
 * connected, but the toolset it advertises on successive `tools/list` calls is
 * scripted by `$OMP_TEST_TOOLS_PER_LIST` — a comma-separated list of tool
 * counts (default "0,1": the first list is empty, the second advertises one
 * tool). The last value repeats for any further calls.
 *
 * This reproduces the whole-session MCP outage verbatim: OMP's discovery ran
 * during the gateway's ~15-20s warmup and got a *successful* `{"tools":[]}`,
 * not an error. The connection never drops, so recovery must come from an
 * in-session re-list (auto-retry or `/mcp refresh`), never a reconnect.
 *
 * Each `tools/list` call appends `<ts> <count>` to `$OMP_TEST_LIST_LOG` (when
 * set) so a test can assert how many times tools were (re-)listed.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const countsPerList = (Bun.env.OMP_TEST_TOOLS_PER_LIST ?? "0,1")
	.split(",")
	.map(part => Number(part.trim()))
	.map(value => (Number.isFinite(value) && value >= 0 ? value : 0));
const listLog = Bun.env.OMP_TEST_LIST_LOG;

/** Deterministic tool name for index `i`: tool_a, tool_b, … (digit-free so MCP
 *  name sanitization can't collapse distinct tools together). */
export function warmupToolName(index: number): string {
	return `tool_${String.fromCharCode(97 + index)}`;
}

let listIndex = 0;

const rl = readline.createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", line => {
	const trimmed = line.trim();
	if (trimmed.length === 0) return;
	let message: { id?: number | string; method?: string };
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}

	if (message.method === "initialize" && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "warmup-empty", version: "1.0.0" },
			},
		});
		return;
	}

	if (message.method === "tools/list" && message.id !== undefined) {
		const count = countsPerList[Math.min(listIndex, countsPerList.length - 1)] ?? 0;
		listIndex++;
		if (listLog) {
			fs.appendFileSync(listLog, `${Date.now()} ${count}\n`);
		}
		const tools = Array.from({ length: count }, (_, i) => ({
			name: warmupToolName(i),
			description: `Fixture tool #${i}.`,
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}));
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
		return;
	}
});

rl.on("close", () => process.exit(0));
