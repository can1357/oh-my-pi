import * as net from "node:net";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Fake HTTP CONNECT proxy: record the CONNECT target of the first request, then
// reset. The run fails afterwards regardless — the recorded target is the proof
// that the Cursor HTTP/2 path routed through the proxy.
const connectTargets: string[] = [];
const proxy = net.createServer(socket => {
	socket.once("data", (chunk: Buffer) => {
		const firstLine = chunk.toString("utf8").split("\r\n")[0];
		const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.1$/.exec(firstLine);
		if (match) connectTargets.push(match[1]);
		// Refuse the tunnel so the run fails fast instead of hitting the tunnel timeout.
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
	});
});
const proxyListening = Promise.withResolvers<void>();
proxy.once("error", proxyListening.reject);
proxy.listen(0, "127.0.0.1", proxyListening.resolve);
await proxyListening.promise;

const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy did not bind");

// Only the standard HTTPS_PROXY var is set; the provider-specific override and
// PI_PROXY are unset, so a fix that only reads PI_PROXY would connect direct and
// never reach this proxy.
delete Bun.env.PI_PROXY;
delete Bun.env.PI_PROXY_CURSOR;
delete Bun.env.HTTP_PROXY;
delete Bun.env.http_proxy;
delete Bun.env.ALL_PROXY;
delete Bun.env.all_proxy;
delete Bun.env.NO_PROXY;
delete Bun.env.no_proxy;
Bun.env.HTTPS_PROXY = `http://127.0.0.1:${proxyAddress.port}`;

// TEST-NET-2 (RFC 5737) target: not local/metadata, so the proxy is not bypassed,
// and unroutable so nothing actually connects past the proxy.
const model: Model<"cursor-agent"> = buildModel({
	id: "cursor-proxy-fixture",
	name: "Cursor proxy fixture",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://198.51.100.7:8443",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});
const context: Context = {
	messages: [{ role: "user", content: "trigger proxy connect", timestamp: Date.now() }],
};

try {
	const stream = streamCursor(model, context, { apiKey: "test-token" });
	for await (const _event of stream) {
		// drain events; the run errors once the proxy resets the tunnel
	}
	await stream.result();
} finally {
	proxy.close();
}

process.stdout.write(`${JSON.stringify({ connectTargets })}\n`);
