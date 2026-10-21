#!/usr/bin/env bun
/** A stdio MCP server that logs raw frames and leaves `hang` calls pending. */
import * as readline from "node:readline";

interface Request {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: { name?: string; arguments?: { text?: string } };
}

async function startServer(): Promise<void> {
	const logPath = process.argv[2];
	if (!logPath) throw new Error("A frame log path is required");
	const mode = process.argv[3];
	if (mode === "no-read") {
		await Bun.write(`${logPath}.ready`, "ready");
		setInterval(() => {}, 60_000);
		return;
	}

	const log = Bun.file(logPath).writer();
	const lines = readline.createInterface({ input: process.stdin });
	try {
		for await (const line of lines) {
			log.write(`${line}\n`);
			await log.flush();
			let request: Request;
			try {
				request = JSON.parse(line) as Request;
			} catch {
				continue;
			}
			if (request.id === undefined || request.id === null) continue;
			let result: unknown;
			switch (request.method) {
				case "initialize":
					if (mode === "hang-initialize") continue;
					result = {
						protocolVersion: "2025-11-25",
						serverInfo: { name: "cancellable-fixture", version: "1.0.0" },
						capabilities: { tools: {} },
					};
					break;
				case "tools/list":
					result = {
						tools: ["hang", "echo"].map(name => ({
							name,
							inputSchema: { type: "object", properties: { text: { type: "string" } } },
						})),
					};
					break;
				case "tools/call":
					if (request.params?.name === "hang") continue;
					result = { content: [{ type: "text", text: request.params?.arguments?.text ?? "" }] };
					break;
				default:
					process.stdout.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							id: request.id,
							error: { code: -32601, message: "Method not found" },
						})}\n`,
					);
					continue;
			}
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
		}
	} finally {
		await log.end();
		lines.close();
	}
}

if (import.meta.main) {
	void startServer();
}
