#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server whose errors quote the URL in
 * `$OMP_TEST_ECHO_URL`, as a proxy or wrapper does when its upstream fails.
 * With `$OMP_TEST_FAIL_INIT=1` it refuses `initialize`; otherwise it serves one
 * `ping` tool whose every call fails. The message and the error's `data` both
 * carry the URL, so the text reaches omp without passing a URL redactor first.
 */
import * as readline from "node:readline";

const url = Bun.env.OMP_TEST_ECHO_URL ?? "";
const failInit = Bun.env.OMP_TEST_FAIL_INIT === "1";
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
	if (message.id === undefined) return;
	const fail = (text: string) =>
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text, data: { upstream: url } } });
	if (message.method === "initialize") {
		if (failInit) return fail(`upstream ${url} refused the session`);
		return send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "url-echo", version: "1" },
			},
		});
	}
	if (message.method === "tools/list") {
		return send({
			jsonrpc: "2.0",
			id: message.id,
			result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] },
		});
	}
	if (message.method === "tools/call") return fail(`upstream ${url} failed`);
	send({ jsonrpc: "2.0", id: message.id, result: {} });
});
