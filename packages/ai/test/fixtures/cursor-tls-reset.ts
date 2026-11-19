import * as net from "node:net";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const server = net.createServer(socket => socket.resetAndDestroy());
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;

const address = server.address();
if (!address || typeof address === "string") throw new Error("TCP server did not bind");

const model: Model<"cursor-agent"> = buildModel({
	id: "cursor-reset-fixture",
	name: "Cursor reset fixture",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: `https://127.0.0.1:${address.port}`,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});
const context: Context = {
	messages: [{ role: "user", content: "trigger TLS reset", timestamp: Date.now() }],
};

try {
	const stream = streamCursor(model, context, { apiKey: "test-token" });
	const eventTypes: string[] = [];
	for await (const event of stream) eventTypes.push(event.type);
	const result = await stream.result();
	process.stdout.write(`${JSON.stringify({ eventTypes, stopReason: result.stopReason })}\n`);
} finally {
	server.close();
}
