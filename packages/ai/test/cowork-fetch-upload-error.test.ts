import { afterEach, describe, expect, it } from "bun:test";
import type * as net from "node:net";
import * as tls from "node:tls";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AnthropicMessagesClient } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";

// Self-signed for `localhost` and 127.0.0.1. The transport sends the URL host as
// TLS SNI, which may not be an IP, so requests name `localhost` as the server.
const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBeDCCAR6gAwIBAgIUUwabqd3Od7EpG/ATV629mXWtBsQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwOTE1NTk1NFoXDTM2MTEwNjE1
NTk1NFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEjvF5z4aomNL5GdUqnM1yLEgQiM8Sb/rJibj0fLBNbmM5oDcTdGJUntrZ
v9WW+eG3c+/Lq/igRBtMkdavU/07mqNOMEwwHQYDVR0OBBYEFHDpHVV9wIE8Gl5X
+mockv/85YhmMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0
hwR/AAABMAoGCCqGSM49BAMCA0gAMEUCIQCmy4ctVfbwjBvnX4Gugym8ufhGvFcs
3sWcUOIn65HLZwIgVJ2ME54BhenZsJFj3IrVgK0VIzlc56Vu4sMYxrf5Mak=
-----END CERTIFICATE-----`;
const LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoH/zLt4tzIx+JpyO
SjEUvLUB4G73eBx89eXc4f103WmhRANCAASO8XnPhqiY0vkZ1SqczXIsSBCIzxJv
+smJuPR8sE1uYzmgNxN0YlSe2tm/1Zb54bdz78ur+KBEG0yR1q9T/Tua
-----END PRIVATE KEY-----`;

// Larger than loopback socket buffers on both ends, so a server that stops
// reading early leaves part of the body queued in the client.
const params: MessageCreateParamsStreaming = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "x".repeat(32 * 1024 * 1024) }],
	max_tokens: 64,
	stream: true,
};

const HEADER_END = Buffer.from("\r\n\r\n");

let servers: tls.Server[] = [];

afterEach(() => {
	for (const server of servers) server.close();
	servers = [];
});

/** TLS server that never responds: it drops the connection once it has read `cutoff(contentLength)` body bytes. */
async function droppingServer(cutoff: (contentLength: number) => number): Promise<number> {
	const server = tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket: tls.TLSSocket) => {
		let head = Buffer.alloc(0);
		let bodyStart = -1;
		let limit = 0;
		let received = 0;
		socket.on("error", () => {});
		socket.on("data", (chunk: Buffer) => {
			if (bodyStart === -1) {
				head = Buffer.concat([head, chunk]);
				bodyStart = head.indexOf(HEADER_END);
				if (bodyStart === -1) return;
				const contentLength = Number(/content-length:\s*(\d+)/i.exec(head.subarray(0, bodyStart).toString())?.[1]);
				limit = cutoff(contentLength);
				received = head.length - bodyStart - HEADER_END.length;
			} else {
				received += chunk.length;
			}
			if (received >= limit) socket.destroy();
		});
	});
	servers.push(server);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	return (server.address() as net.AddressInfo).port;
}

async function sendThrough(port: number): Promise<unknown> {
	const client = new AnthropicMessagesClient({
		apiKey: "sk-test",
		baseURL: `https://127.0.0.1:${port}`,
		maxRetries: 0,
		fetch: coworkFetch,
		fetchOptions: { tls: { ca: LOCALHOST_CERT, serverName: "localhost" } },
	});
	return client.messages
		.create(params)
		.asResponse()
		.catch((error: unknown) => error);
}

async function expectRetryable(error: unknown): Promise<void> {
	expect(error).toBeInstanceOf(AIError.AnthropicConnectionError);
	const finalized = await AIError.finalize(error, { api: "anthropic-messages", provider: "anthropic" });
	expect(AIError.retriable(finalized.id)).toBe(true);
}

describe("cowork transport connection lost before a response", () => {
	it("says the body was still uploading when the connection drops mid-body", async () => {
		const port = await droppingServer(() => 256 * 1024);
		const error = await sendThrough(port);

		await expectRetryable(error);
		const { message } = error as Error;
		expect(message).toStartWith("Connection error: connection lost after ");
		expect(message).toContain("while uploading the 32.0MB request body; no response received");
	});

	it("says the body was sent when the connection drops before any response", async () => {
		const port = await droppingServer(contentLength => contentLength);
		const error = await sendThrough(port);

		await expectRetryable(error);
		const { message } = error as Error;
		expect(message).toStartWith("Connection error: connection lost after ");
		expect(message).toContain("after the 32.0MB request body was sent and before any response");
	});
});
