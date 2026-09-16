#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that holds its `tools/list` response until a
 * gate file appears, so a test can pin the exact instant the response is
 * allowed to come back.
 *
 * It records `$OMP_TEST_LIST_STARTED` the moment the request arrives — before
 * it starts waiting — so a test knows the `tools/list` is genuinely in flight,
 * then blocks until `$OMP_TEST_LIST_GATE` exists. That separates "when the
 * request was issued" from "when the response arrived" by an interval the test
 * controls, which is what makes the tool cache's request-time ordering token
 * observable: the token must fall before the gate was opened, not after.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export const GATED_TOOL_NAME = "gated_tool";

const gatePath = Bun.env.OMP_TEST_LIST_GATE;
const startedPath = Bun.env.OMP_TEST_LIST_STARTED;

const rl = readline.createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function waitForGate(): Promise<void> {
	if (!gatePath) return;
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(gatePath)) {
		if (Date.now() > deadline) return;
		await Bun.sleep(5);
	}
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
				serverInfo: { name: "gated-tools-list", version: "1.0.0" },
			},
		});
		return;
	}

	if (message.method === "tools/list" && message.id !== undefined) {
		const id = message.id;
		// Announce the request BEFORE waiting: the test needs to know the
		// `tools/list` is in flight so it can time the gate against it.
		if (startedPath) fs.appendFileSync(startedPath, `${Date.now()}\n`);
		void waitForGate().then(() => {
			send({
				jsonrpc: "2.0",
				id,
				result: {
					tools: [
						{
							name: GATED_TOOL_NAME,
							description: "Fixture tool released by a gate file.",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				},
			});
		});
		return;
	}
});

rl.on("close", () => process.exit(0));
