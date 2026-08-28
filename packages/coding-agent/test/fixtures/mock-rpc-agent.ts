#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, echoes each inbound command with a
 * success response, and stays alive until stdin closes or SIGTERM arrives.
 * Used by rpc-client lifecycle tests that need to exercise start/stop/start
 * without booting the full agent runtime (which requires provider credentials).
 */
if (Bun.env.MOCK_RPC_PID_FILE) {
	await Bun.write(Bun.env.MOCK_RPC_PID_FILE, String(process.pid));
}
if (Bun.env.MOCK_RPC_IGNORE_SIGTERM === "1") {
	process.on("SIGTERM", () => {});
}

const supportsProtocolV2 = Bun.env.MOCK_RPC_V2 === "1";
const legacyState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "mock-session",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};

if (Bun.env.MOCK_RPC_EXIT_BEFORE_READY) {
	const message = Bun.env.MOCK_RPC_EXIT_STDERR ?? "";
	if (message) {
		// Await the pipe write: exiting immediately can drop unflushed stderr
		// bytes, leaving the client's startup error without the failure text.
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stderr.write(message, () => resolve());
		await promise;
	}
	process.exit(Number(Bun.env.MOCK_RPC_EXIT_BEFORE_READY));
}

let protocolV2Enabled = false;
process.stdout.write(
	`${JSON.stringify(
		supportsProtocolV2
			? {
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				}
			: { type: "ready" },
	)}\n`,
);

function writeFrame(frame: Record<string, unknown>): void {
	const logical = Buffer.from(JSON.stringify(frame), "utf8");
	if (!protocolV2Enabled || logical.byteLength <= 1024 * 1024) {
		process.stdout.write(`${logical.toString("utf8")}\n`);
		return;
	}
	const chunkBytes = 256 * 1024;
	const count = Math.ceil(logical.byteLength / chunkBytes);
	for (let index = 0; index < count; index++) {
		process.stdout.write(
			`${JSON.stringify({
				type: "rpc_chunk",
				chunkId: "mock-rpc-v2",
				index,
				count,
				byteLength: logical.byteLength,
				data: logical.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
			})}\n`,
		);
	}
}

// Bun's `console` is an AsyncIterable over stdin lines.
for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (frame && typeof frame === "object" && typeof frame.type === "string") {
			if (Bun.env.MOCK_RPC_EXIT_ON_COMMAND) {
				process.stderr.write(Bun.env.MOCK_RPC_EXIT_STDERR ?? "");
				process.exit(Number(Bun.env.MOCK_RPC_EXIT_ON_COMMAND));
			}
			if (Bun.env.MOCK_RPC_INVALID_OUTPUT === "1") {
				process.stdout.write("{invalid-json\n");
				continue;
			}
			if (Bun.env.MOCK_RPC_IGNORE_COMMANDS === "1") continue;
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (frame.type === "negotiate_protocol" && frame.protocolVersion === 2) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { protocolVersion: 2 },
				});
				protocolV2Enabled = true;
				continue;
			}
			if (frame.type === "get_messages_page") {
				if (Bun.env.MOCK_RPC_PAGE_BUSY === "1") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "Cannot page messages while the session is changing",
						code: "session_busy",
					});
					continue;
				}
				if (Bun.env.MOCK_RPC_PAGE_STALE === "1" && frame.cursor !== undefined) {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "RPC message cursor is stale",
						code: "stale_cursor",
					});
					continue;
				}
				const first = frame.cursor === undefined;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: first
						? {
								messages: [{ role: "user", content: "first", timestamp: 1 }],
								nextCursor: "second-page",
								totalMessages: 2,
							}
						: {
								messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 }],
								totalMessages: 2,
							},
				});
				continue;
			}
			if (
				frame.type === "get_messages" &&
				(Bun.env.MOCK_RPC_PAGE_BUSY === "1" || Bun.env.MOCK_RPC_PAGE_STALE === "1")
			) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
						],
					},
				});
				continue;
			}
			if (
				frame.type === "get_state" &&
				(Bun.env.MOCK_RPC_LEGACY_STATE === "1" || Bun.env.MOCK_RPC_INVALID_TPS === "1")
			) {
				const data = {
					...legacyState,
					...(Bun.env.MOCK_RPC_INVALID_TPS === "1" ? { tokensPerSecond: "invalid" } : {}),
				};
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data,
				});
				continue;
			}

			writeFrame({
				id,
				type: "response",
				command: frame.type,
				success: true,
				data: supportsProtocolV2 ? { payload: "😀".repeat(270_000) } : {},
			});
		}
	} catch {
		// ignore parse errors — the test harness sends well-formed frames.
	}
}
process.exit(0);
