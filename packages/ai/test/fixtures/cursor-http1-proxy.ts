import * as http from "node:http";
import { encodeConnectFrame } from "../../src/providers/cursor/connect-frame";
import { buildCursorRunHeaders } from "../../src/providers/cursor/headers";
import { openCursorHttp1Bridge } from "../../src/providers/cursor/http1-bridge";

const RUN_PATH = "/agent.v1.AgentService/Run";
const CONNECT_END_STREAM_FLAG = 0b00000010;
let proxiedPolls = 0;
let proxiedAppends = 0;
let pollTarget = "";
let appendTarget = "";

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

const proxy = http.createServer((req, res) => {
	const url = req.url ?? "";
	if (url.includes("RunPoll")) {
		proxiedPolls++;
		pollTarget = url;
		res.writeHead(200, { "content-type": "application/connect+proto" });
		res.end(
			Buffer.concat([
				encodeConnectFrame(pollResponse(0n, Buffer.from("proxied-frame").toString("base64"), true), false),
				frame(Buffer.from("{}"), CONNECT_END_STREAM_FLAG),
			]),
		);
		return;
	}
	if (url.includes("BidiAppend")) {
		proxiedAppends++;
		appendTarget = url;
		res.statusCode = 200;
		res.end();
		return;
	}
	res.statusCode = 404;
	res.end();
});
const listening = Promise.withResolvers<void>();
proxy.once("error", listening.reject);
proxy.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = proxy.address();
if (!address || typeof address === "string") throw new Error("proxy fixture did not bind");

delete Bun.env.PI_PROXY;
delete Bun.env.NO_PROXY;
delete Bun.env.no_proxy;
Bun.env.PI_PROXY_CURSOR = `http://127.0.0.1:${address.port}`;

const bridge = openCursorHttp1Bridge({
	baseUrl: "http://cursor-bridge-proxy.invalid:1",
	requestPath: RUN_PATH,
	runHeaders: buildCursorRunHeaders({
		apiKey: "http1-fallback-key",
		requestPath: RUN_PATH,
		gzipRequest: false,
	}),
	gzipRequest: false,
});
try {
	bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));
	const kinds: string[] = [];
	for await (const received of bridge.frames()) kinds.push(received.kind);
	await bridge.trailers();
	process.stdout.write(`${JSON.stringify({ proxiedPolls, proxiedAppends, pollTarget, appendTarget, kinds })}\n`);
} finally {
	bridge.close();
	const closed = Promise.withResolvers<void>();
	proxy.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}
