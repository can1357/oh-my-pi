import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AnthropicMessagesClient } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Larger than loopback socket buffers on both ends, so a server that stops
// reading early leaves part of the body queued in the client.
const BODY = "x".repeat(32 * 1024 * 1024);
const HEADER_END = Buffer.from("\r\n\r\n");

let servers: Array<{ close(): void }> = [];

afterEach(() => {
	for (const server of servers) server.close();
	servers = [];
});

function testModel(provider: string, api: Api): Model<Api> {
	return buildModel({
		id: "upload-test",
		name: "upload-test",
		api,
		provider,
		baseUrl: "http://127.0.0.1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

/** Server that never responds: it drops the connection once it has read `cutoff(contentLength)` body bytes. */
async function droppingServer(cutoff: (contentLength: number) => number): Promise<string> {
	const server = net.createServer(socket => {
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
	return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

async function postThroughTransport(origin: string, body: string): Promise<unknown> {
	const fetch = transportFetch(testModel("openai", "openai-responses"), undefined);
	return fetch(`${origin}/v1/responses`, { method: "POST", body }).catch((error: unknown) => error);
}

async function expectRetryable(error: unknown, api: Api, provider: string): Promise<void> {
	const finalized = await AIError.finalize(error, { api, provider });
	expect(AIError.retriable(finalized.id)).toBe(true);
	expect(AIError.isProviderRetryableError(error)).toBe(true);
}

describe("transportFetch connection lost before a response", () => {
	it("says the body was still uploading when the connection drops mid-body", async () => {
		const origin = await droppingServer(() => 256 * 1024);
		const error = await postThroughTransport(origin, BODY);

		expect(error).toBeInstanceOf(AIError.ConnectionLostBeforeResponseError);
		await expectRetryable(error, "openai-responses", "openai");
		const { message } = error as Error;
		expect(message).toStartWith("Connection error: connection lost after ");
		expect(message).toEndWith(" while uploading the 32.0MB request body; no response received (ECONNRESET).");
	});

	it("says the body was written when the connection drops after the whole body", async () => {
		const origin = await droppingServer(contentLength => contentLength);
		const error = await postThroughTransport(origin, BODY);

		expect(error).toBeInstanceOf(AIError.ConnectionLostBeforeResponseError);
		await expectRetryable(error, "openai-responses", "openai");
		const { message } = error as Error;
		expect(message).toStartWith("Connection error: connection lost after ");
		expect(message).toEndWith(
			", after the 32.0MB request body was written to the socket, before any response (ECONNRESET).",
		);
	});

	it("leaves a body below the streaming threshold to Bun's own error", async () => {
		const origin = await droppingServer(() => 0);
		const error = await postThroughTransport(origin, "x".repeat(64 * 1024));

		expect(error).not.toBeInstanceOf(AIError.ConnectionLostBeforeResponseError);
		expect((error as Error).message).toContain("The socket connection was closed unexpectedly");
	});

	it("names the upload in the Anthropic client's error when the cowork transport falls back to fetch", async () => {
		const origin = await droppingServer(() => 256 * 1024);
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			baseURL: origin,
			maxRetries: 0,
			// First-party Anthropic resolves to the cowork transport, which hands a plain-http URL to Bun's fetch.
			fetch: transportFetch(testModel("anthropic", "anthropic-messages"), undefined),
		});
		const error = await client.messages
			.create({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: BODY }],
				max_tokens: 64,
				stream: true,
			})
			.asResponse()
			.catch((error: unknown) => error);

		expect(error).toBeInstanceOf(AIError.AnthropicConnectionError);
		await expectRetryable(error, "anthropic-messages", "anthropic");
		expect((error as Error).message).toMatch(
			/^Connection error: connection lost after .+ while uploading the 32\.\dMB request body; no response received \(ECONNRESET\)\.$/,
		);
	});

	it("follows a redirect by resending the whole body", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const received = (await request.arrayBuffer()).byteLength;
				if (new URL(request.url).pathname === "/moved") {
					return new Response(null, { status: 307, headers: { location: "/v1/responses" } });
				}
				return new Response(String(received));
			},
		});
		servers.push({ close: () => server.stop(true) });
		const fetch = transportFetch(testModel("openai", "openai-responses"), undefined);

		const response = await fetch(`http://127.0.0.1:${server.port}/moved`, { method: "POST", body: BODY });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(String(BODY.length));
	});
});
