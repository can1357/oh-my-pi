import { describe, expect, test } from "bun:test";
import {
	DAEMON_MAX_FRAME_BYTES,
	DAEMON_PROTOCOL_MAJOR,
	type DaemonHello,
	DaemonProtocolError,
	type DaemonShard,
	decodeDaemonFrame,
	encodeDaemonFrame,
	parseDaemonFrame,
} from "../src/daemon/protocol";

const shard: DaemonShard = { profile: "work" };

function hello(overrides: Partial<DaemonHello> = {}): DaemonHello {
	return {
		v: DAEMON_PROTOCOL_MAJOR,
		tag: "hello",
		requestId: "hello-1",
		profile: shard.profile,
		token: "secret",
		...overrides,
	};
}

describe("daemon protocol", () => {
	test("authenticates a profile shard without binding the daemon to a project root", () => {
		const frame: DaemonHello = {
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "hello",
			requestId: "profile-hello",
			profile: "work",
			token: "secret",
		};

		expect(parseDaemonFrame(frame)).toEqual(frame);
		expect(() => parseDaemonFrame({ ...frame, projectRoot: "/tmp/project" })).toThrow(/unknown field/);
	});

	test("represents the unnamed profile explicitly as null", () => {
		const frame: DaemonHello = {
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "hello",
			requestId: "unnamed-profile",
			profile: null,
			token: "secret",
		};

		expect(parseDaemonFrame(frame)).toEqual(frame);
		expect(() => parseDaemonFrame({ ...frame, profile: "default" })).toThrow(/unnamed profile.*null/i);
	});

	test("accepts numeric-major hello and preserves canonical shard", () => {
		const frame = parseDaemonFrame(hello());
		expect(frame).toEqual(hello());
	});

	test("rejects string and unsupported protocol majors", () => {
		expect(() => parseDaemonFrame({ ...hello(), v: "1" })).toThrow(DaemonProtocolError);
		expect(() => parseDaemonFrame({ ...hello(), v: DAEMON_PROTOCOL_MAJOR + 1 })).toThrow(
			/unsupported protocol major/,
		);
	});

	test("rejects token-bearing response and malformed tags", () => {
		expect(() =>
			parseDaemonFrame({ v: DAEMON_PROTOCOL_MAJOR, tag: "hello_ok", requestId: "x", token: "leak" }),
		).toThrow(/unknown field/);
		expect(() => parseDaemonFrame({ v: DAEMON_PROTOCOL_MAJOR, tag: "unknown", requestId: "x" })).toThrow(
			/unknown frame tag/,
		);
	});

	test("round-trips strict NDJSON frames and enforces byte limit", () => {
		const encoded = encodeDaemonFrame(hello());
		expect(encoded.endsWith("\n")).toBe(true);
		expect(decodeDaemonFrame(encoded.trim())).toEqual(hello());
		expect(() => encodeDaemonFrame({ ...hello(), token: "x".repeat(DAEMON_MAX_FRAME_BYTES) })).toThrow(
			/frame exceeds maximum size/,
		);
		expect(() => decodeDaemonFrame(`{${"x".repeat(DAEMON_MAX_FRAME_BYTES)}}`)).toThrow(/frame exceeds maximum size/);
	});

	test("parses server status and stable errors", () => {
		const frame = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "server_status",
			status: {
				daemonId: "d1",
				serverVersion: "0.1.0",
				protocolVersion: DAEMON_PROTOCOL_MAJOR,
				shard,
				sessionCount: 2,
				attachmentCount: 1,
				protectedJobCount: 0,
				uptimeMs: 50,
			},
		});
		expect(frame.tag).toBe("server_status");
		expect(() =>
			parseDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "response",
				requestId: "x",
				ok: false,
				error: { code: "authentication_failed", message: "no" },
				extra: true,
			}),
		).toThrow(/unknown field/);

		expect(() =>
			parseDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "response",
				requestId: "x",
				ok: false,
				error: { code: "bad_token", message: "no" },
			}),
		).toThrow(/unknown response error code/);
		expect(() => parseDaemonFrame({ v: DAEMON_PROTOCOL_MAJOR, tag: "event", sessionId: "s1", seq: 1 })).toThrow(
			/event.event is required/,
		);
	});

	test("parses ordered snapshot frames and rejects incomplete chunks", () => {
		const begin = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "snapshot_begin",
			sessionId: "s1",
			attachmentId: "a1",
			barrierSeq: 4,
		});
		const chunk = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "snapshot_chunk",
			sessionId: "s1",
			attachmentId: "a1",
			barrierSeq: 4,
			index: 0,
			chunk: { messages: [] },
		});
		const end = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "snapshot_end",
			sessionId: "s1",
			attachmentId: "a1",
			barrierSeq: 4,
			nextSeq: 5,
		});
		const restart = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "snapshot_restart",
			sessionId: "s1",
			attachmentId: "a1",
			previousBarrierSeq: 4,
			reason: "gap",
		});
		expect([begin.tag, chunk.tag, end.tag, restart.tag]).toEqual([
			"snapshot_begin",
			"snapshot_chunk",
			"snapshot_end",
			"snapshot_restart",
		]);
		expect(() =>
			parseDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_chunk",
				sessionId: "s1",
				attachmentId: "a1",
				barrierSeq: 4,
				index: -1,
				chunk: {},
			}),
		).toThrow(/non-negative integer/);
	});

	test("parses serializable session creation cwd and CLI overrides", () => {
		const frame = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "request",
			requestId: "create-1",
			operation: {
				op: "session_create",
				cwd: "/repo",
				overrides: {
					provider: "openai",
					model: "gpt-5",
					thinkingLevel: "high",
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					argv: ["--tools", "read", "@notes.md", "explain"],
				},
			},
		});
		expect(frame.tag).toBe("request");
		if (frame.tag !== "request" || frame.operation.op !== "session_create") throw new Error("unexpected frame");
		expect(frame.operation.cwd).toBe("/repo");
		expect(frame.operation.overrides?.model).toBe("gpt-5");
		expect(frame.operation.overrides?.provider).toBe("openai");
		expect(frame.operation.overrides?.thinkingLevel).toBe("high");
		expect(frame.operation.overrides?.argv).toEqual(["--tools", "read", "@notes.md", "explain"]);
		expect(() =>
			parseDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "create-invalid",
				operation: { op: "session_create", overrides: { argv: ["--tools", 1] } },
			}),
		).toThrow(/argv must be an array of strings/);
	});
	test("parses terminal-only attachment delivery and rejects unknown delivery modes", () => {
		const frame = parseDaemonFrame({
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "request",
			requestId: "attach-terminal",
			operation: {
				op: "attach",
				sessionId: "s1",
				attachmentId: "a1",
				mode: "interactive",
				delivery: "terminal",
			},
		});
		expect(frame.tag).toBe("request");
		if (frame.tag !== "request" || frame.operation.op !== "attach") throw new Error("unexpected frame");
		expect(frame.operation.delivery).toBe("terminal");
		expect(() =>
			parseDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "attach-invalid",
				operation: {
					op: "attach",
					sessionId: "s1",
					attachmentId: "a1",
					mode: "interactive",
					delivery: "verbose",
				},
			}),
		).toThrow(/delivery must be all or terminal/);
	});
});
