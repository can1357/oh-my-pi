#!/usr/bin/env bun
/** JSONL MCP fixture with request-scoped progress and deliberately stray frames. */
import * as readline from "node:readline";

interface Request {
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: Request): Promise<void> {
	if (request.id === undefined) return;
	const reply = (result: unknown) => send({ jsonrpc: "2.0", id: request.id, result });
	if (request.method === "initialize") {
		reply({
			protocolVersion: "2025-11-25",
			capabilities: { tools: {} },
			serverInfo: { name: "progress-fixture", version: "1.0.0" },
		});
		return;
	}
	if (request.method === "tools/list") {
		reply({ tools: [{ name: "progress_tool", inputSchema: { type: "object" } }] });
		return;
	}
	if (request.method !== "tools/call" || request.params?.name !== "progress_tool") {
		reply({});
		return;
	}
	const args = (request.params.arguments ?? {}) as Record<string, unknown>;
	const meta = request.params._meta as Record<string, unknown> | undefined;
	const token = meta?.progressToken;
	const progress = (params: unknown) => send({ jsonrpc: "2.0", method: "notifications/progress", params });
	if (args.includeUnknown) {
		progress({ progressToken: typeof token === "number" ? String(token) : 0, progress: 999 });
	}
	if (args.includeMalformed) {
		progress({ progressToken: token, progress: "invalid" });
		progress({ progressToken: { token }, progress: 998 });
	}
	const steps = Array.isArray(args.steps)
		? args.steps
		: Array.from({ length: typeof args.steps === "number" ? args.steps : 3 }, (_, i) => ({ progress: i + 1 }));
	for (const step of steps) {
		progress({ progressToken: token, ...step });
		await Bun.sleep(typeof args.delayMs === "number" ? args.delayMs : 2);
	}
	reply({
		content: [{ type: "text", text: "progress complete" }],
		structuredContent: { requestId: request.id, _meta: request.params._meta, arguments: args },
	});
	if (args.includeLate) progress({ progressToken: token, progress: 1000 });
	send({ jsonrpc: "2.0", method: "notifications/progress-fixture-done", params: { id: request.id } });
}

if (import.meta.main) {
	const input = readline.createInterface({ input: process.stdin });
	input.on("line", line => {
		void handle(JSON.parse(line) as Request);
	});
	input.on("close", () => process.exit(0));
}
