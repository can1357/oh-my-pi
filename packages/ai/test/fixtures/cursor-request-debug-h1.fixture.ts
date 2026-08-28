import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
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
import { encodeConnectFrame } from "../../src/providers/cursor/connect-frame";
import * as h2Pool from "../../src/providers/cursor/h2-pool";
import * as serverConfig from "../../src/providers/cursor/server-config";

function frame(data: Uint8Array, flags = 0): Buffer {
	const out = Buffer.alloc(5 + data.length);
	out[0] = flags;
	out.writeUInt32BE(data.length, 1);
	out.set(data, 5);
	return out;
}

function varint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0n);
	return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function pollResponse(seqno: bigint, data: string, eof: boolean): Uint8Array {
	const dataBytes = Buffer.from(data);
	const parts = [varint(8n), varint(seqno), varint(18n), varint(BigInt(dataBytes.length)), dataBytes];
	if (eof) parts.push(varint(24n), varint(1n));
	return concat(parts);
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
const context: Context = { messages: [{ role: "user", content: "debug", timestamp: 1 }] };

function model(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-request-debug-h1-fixture",
		name: "Cursor request debug H1 fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

test("captures the HTTP/1 poll payload", async () => {
	const originalCwd = process.cwd();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-req-debug-h1-"));
	process.chdir(tempDir);
	Bun.env.PI_REQ_DEBUG = "1";
	const server = http.createServer((req, res) => {
		if (req.url?.includes("RunPoll")) {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.end(
				Buffer.concat([
					encodeConnectFrame(pollResponse(0n, Buffer.from(payload).toString("base64"), false), false),
					encodeConnectFrame(pollResponse(1n, "", true), false),
					frame(Buffer.from("{}"), 0b00000010),
				]),
			);
			return;
		}
		res.statusCode = 200;
		res.end();
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("debug h1 fixture did not bind");
	vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
		ok: false,
		unavailable: { reason: "alpn", cause: new Error("h2 unavailable in isolated fixture") },
	});
	vi.spyOn(serverConfig, "fetchCursorBidiAvailability").mockResolvedValue("bidi-disabled");
	try {
		const stream = streamCursor(model(`http://127.0.0.1:${address.port}`), context, { apiKey: "test-token" });
		for await (const _event of stream) {
			// drain
		}
		await stream.result();
		const entries = await fs.readdir(tempDir);
		const requestDumpName = entries.find(name => /^rr-session-\d+\.json$/.test(name));
		if (!requestDumpName) throw new Error("expected request debug dump");
		const dump = JSON.parse(await fs.readFile(path.join(tempDir, requestDumpName), "utf8")) as { protocol?: string };
		const responseLogName = entries.find(name => /^rr-session-\d+\.res\.log$/.test(name));
		if (!responseLogName) throw new Error("expected request debug response log");
		const responseBytes = await fs.readFile(path.join(tempDir, responseLogName));
		const separator = Buffer.from("\r\n\r\n");
		const separatorIndex = responseBytes.indexOf(separator);
		const body = separatorIndex < 0 ? Buffer.alloc(0) : responseBytes.subarray(separatorIndex + separator.length);
		const result = { protocol: dump.protocol, bodyContainsPayload: body.includes(payload) };
		expect(result).toEqual({ protocol: "http", bodyContainsPayload: true });
		process.stdout.write(`REQUEST_DEBUG_RESULT=${JSON.stringify(result)}\n`);
	} finally {
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		const closed = Promise.withResolvers<void>();
		server.close(error => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
		process.chdir(originalCwd);
		delete Bun.env.PI_REQ_DEBUG;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}, 60_000);
