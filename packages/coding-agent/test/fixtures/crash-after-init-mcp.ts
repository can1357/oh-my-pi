#!/usr/bin/env bun
/**
 * Test fixture: a minimal stdio MCP server that completes the initialize +
 * tools/list handshake and then exits cleanly. Models a misconfigured PHP
 * MCP server (e.g. Laravel Boost in a non-Laravel project) that successfully
 * advertises tools and then dies on the very next event-loop tick.
 *
 * Reproduces issue #1592: without a crash circuit breaker, every exit fires
 * `transport.onClose`, which triggers an unbounded reconnect storm — the
 * spindump in the bug report shows 66 487 PHP processes parented to the
 * agent's `bun` PID.
 *
 * Each invocation atomically appends the PID + timestamp to the path in
 * `$OMP_TEST_SPAWN_LOG`, so the test can count spawns without racing.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const spawnLog = Bun.env.OMP_TEST_SPAWN_LOG;
if (spawnLog) {
	fs.appendFileSync(spawnLog, `${process.pid} ${Date.now()}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", line => {
	let message: { id?: number | string; method?: string };
	try {
		message = JSON.parse(line);
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
				serverInfo: { name: "crash-after-init", version: "1.0.0" },
			},
		});
		return;
	}

	if (message.method === "tools/list" && message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
		// Exit on the next tick so the response is fully flushed before EOF.
		setImmediate(() => process.exit(0));
		return;
	}
});

rl.on("close", () => process.exit(0));
