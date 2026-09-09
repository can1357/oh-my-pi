import * as fs from "node:fs/promises";
import * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { disposeCursorH2Pool } from "../../src/providers/cursor/h2-pool";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-req-debug-"));
process.chdir(tempDir);
Bun.env.PI_REQ_DEBUG = "1";

function frame(data: Uint8Array): Buffer {
	const out = Buffer.alloc(5 + data.length);
	out.writeUInt32BE(data.length, 1);
	out.set(data, 5);
	return out;
}

const turnEnded = create(AgentServerMessageSchema, {
	message: {
		case: "interactionUpdate",
		value: create(InteractionUpdateSchema, {
			message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
		}),
	},
});
const payload = toBinary(AgentServerMessageSchema, turnEnded);
const sessions = new Set<http2.Http2Session>();
let requestId: string | undefined;
const server = http2.createServer();
server.on("session", session => {
	sessions.add(session);
	session.on("close", () => sessions.delete(session));
});
server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
	stream.on("data", () => {});
	requestId = typeof headers["x-request-id"] === "string" ? headers["x-request-id"] : undefined;
	stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
	stream.end(frame(payload));
});
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = server.address();
if (!address || typeof address === "string") throw new Error("debug fixture did not bind");

const model: Model<"cursor-agent"> = buildModel({
	id: "cursor-request-debug-fixture",
	name: "Cursor request debug fixture",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: `http://127.0.0.1:${address.port}`,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});
const context: Context = { messages: [{ role: "user", content: "headers", timestamp: 1 }] };

try {
	const stream = streamCursor(model, context, { apiKey: "test-token", headers: { "x-trace": "debug-id" } });
	for await (const _event of stream) {
		// drain
	}
	await stream.result();
	const entries = await fs.readdir(tempDir);
	const requestDumpName = entries.find(name => /^rr-session-\d+\.json$/.test(name));
	if (!requestDumpName) throw new Error("expected request debug dump");
	const dump = JSON.parse(await fs.readFile(path.join(tempDir, requestDumpName), "utf8")) as {
		protocol?: string;
		headers?: Record<string, string>;
	};
	const responseLogName = entries.find(name => /^rr-session-\d+\.res\.log$/.test(name));
	if (!responseLogName) throw new Error("expected request debug response log");
	const responseBytes = await fs.readFile(path.join(tempDir, responseLogName));
	const separator = Buffer.from("\r\n\r\n");
	const separatorIndex = responseBytes.indexOf(separator);
	const body = separatorIndex < 0 ? Buffer.alloc(0) : responseBytes.subarray(separatorIndex + separator.length);
	process.stdout.write(
		`${JSON.stringify({
			requestId,
			dumpRequestId: dump.headers?.["x-request-id"],
			protocol: dump.protocol,
			bodyContainsPayload: body.includes(payload),
		})}\n`,
	);
} finally {
	await disposeCursorH2Pool();
	for (const session of sessions) session.destroy();
	const closed = Promise.withResolvers<void>();
	server.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
	await fs.rm(tempDir, { recursive: true, force: true });
}
