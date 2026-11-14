/** Real stdio MCP peer for CLI regression tests; the audit survives peer shutdown. */
import * as fs from "node:fs/promises";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

const auditPath = process.argv[2];
if (!auditPath) throw new Error("usage: rpc-mcp-server.ts <auditPath>");
await fs.appendFile(auditPath, `${JSON.stringify({ event: "spawn", pid: process.pid })}\n`);

for await (const request of readJsonl<unknown>(Bun.stdin.stream())) {
	if (!isRecord(request)) continue;
	await fs.appendFile(auditPath, `${JSON.stringify(request)}\n`);
	if (request.id === undefined) continue;
	let result: unknown;
	switch (request.method) {
		case "initialize":
			result = {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "rpc-regression", version: "1.0.0" },
			};
			break;
		case "tools/list":
			result = {
				tools: [
					{
						name: "regression_announce",
						description: "Return an independently audited invocation marker.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
			break;
		case "tools/call":
			result =
				isRecord(request.params) && request.params.name === "regression_announce"
					? { content: [{ type: "text", text: "rpc-mcp-invoked" }] }
					: { isError: true, content: [{ type: "text", text: "unexpected MCP tool" }] };
			break;
		default:
			result = {};
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

// A server may retain background handles after stdin closes. Require the CLI
// owner to terminate it rather than passing shutdown coverage through EOF alone.
// The ceiling also bounds this fixture if the test runner itself is interrupted.
await Bun.sleep(60_000);
