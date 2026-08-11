#!/usr/bin/env bun
import * as readline from "node:readline";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
};

const scopeIndex = process.argv.indexOf("--scope");
const requestedScope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : "public";
const cacheScope = requestedScope === "private" ? "private" : "public";
const ttlIndex = process.argv.indexOf("--ttl");
const ttlMs = ttlIndex >= 0 ? Number(process.argv[ttlIndex + 1]) : 60_000;
let listCount = 0;

function resultFor(method: string): Record<string, unknown> {
	if (method === "server/discover") {
		return {
			resultType: "complete",
			ttlMs: 60_000,
			cacheScope: "public",
			supportedVersions: ["2026-07-28"],
			capabilities: { tools: {} },
			_meta: {
				"io.modelcontextprotocol/serverInfo": { name: "cache-policy-fixture", version: "1.0.0" },
			},
		};
	}
	if (method === "tools/list") {
		listCount++;
		return {
			resultType: "complete",
			ttlMs,
			cacheScope,
			tools: [
				{
					name: listCount === 1 ? "cached_tool_initial" : "cached_tool_refreshed",
					inputSchema: { type: "object", properties: {} },
				},
			],
		};
	}
	return { resultType: "complete" };
}

if (import.meta.main) {
	const lines = readline.createInterface({ input: process.stdin });
	lines.on("line", line => {
		let request: JsonRpcRequest;
		try {
			request = JSON.parse(line) as JsonRpcRequest;
		} catch {
			return;
		}
		if (request.id === undefined || request.id === null) return;
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0" as const, id: request.id, result: resultFor(request.method) })}\n`,
		);
	});
	lines.on("close", () => process.exit(0));
}
