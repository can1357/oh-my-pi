import { describe, expect, it } from "bun:test";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import {
	type DaemonOperation,
	type DaemonTerminalExitNotification,
	type DaemonTerminalOutputNotification,
	parseDaemonRpcResult,
	parseDaemonWireMessage,
	parseDaemonWireRequest,
} from "../../src/launch/protocol";

const operation: Extract<DaemonOperation, { op: "logs" }> = {
	op: "logs",
	name: "web",
	lines: 20,
	head: false,
	follow: false,
	timeoutMs: 1_000,
};

const baseResult = {
	name: "web",
	text: "ready",
	cursor: 42,
	timedOut: false,
	state: "running" as const,
};

const baseSnapshot = {
	name: "web",
	id: "daemon-1",
	state: "ready" as const,
	createdAt: 1,
	startedAt: 1,
	restartCount: 0,
	outputBytes: 5,
	persist: false,
	detached: false,
};

describe("launch logs protocol", () => {
	it("decodes terminal rows without changing their bytes", () => {
		const terminalRows = ["\x1b[0m\x1b[1;38;5;2mready", "", "界e\u0301"];
		expect(parseDaemonRpcResult(operation, { ...baseResult, terminalRows })).toEqual({
			op: "logs",
			...baseResult,
			terminalRows,
		});
	});

	it("rejects a non-array terminal row payload", () => {
		expect(() => parseDaemonRpcResult(operation, { ...baseResult, terminalRows: "ready" })).toThrow(
			"result.terminalRows must be an array of strings",
		);
	});

	it("rejects non-string terminal row entries", () => {
		expect(() => parseDaemonRpcResult(operation, { ...baseResult, terminalRows: ["ready", 7] })).toThrow(
			"result.terminalRows item must be a string",
		);
	});
});

describe("launch logs compatibility", () => {
	it("preserves the rendered-row request for upgraded brokers", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			operation: { ...operation, renderTerminalRows: true },
		});
		expect(request.operation).toMatchObject({ ...operation, renderTerminalRows: true });
	});

	it("preserves completion owner changes on reconnect requests", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			owners: ["session-owner"],
			detachedOwners: ["parked-owner"],
			completionUnsubscribes: ["disposed-owner"],
			completionSubscriptionId: "subscription-1",
			operation: { op: "list" },
		});

		expect(request.owners).toEqual(["session-owner"]);
		expect(request.detachedOwners).toEqual(["parked-owner"]);
		expect(request.completionUnsubscribes).toEqual(["disposed-owner"]);
		expect(request.completionSubscriptionId).toBe("subscription-1");
	});

	it("decodes raw terminal text from an already-running legacy broker", () => {
		const result = parseDaemonRpcResult(operation, { ...baseResult, terminalText: "progress\rready" });
		if (result.op !== "logs") throw new Error("unexpected result");
		expect("terminalText" in result ? result.terminalText : undefined).toBe("progress\rready");
	});
});

describe("daemon mode protocol", () => {
	it("accepts persistence transitions and rejects unsupported modes", () => {
		const request = parseDaemonWireRequest({
			id: "mode-request",
			token: "token",
			operation: { op: "mode", name: "web", mode: "persist" },
		});
		expect(request.operation).toEqual({ op: "mode", name: "web", mode: "persist" });
		expect(
			parseDaemonRpcResult(
				{ op: "mode", name: "web", mode: "persist" },
				{ daemon: { ...baseSnapshot, persist: true } },
			),
		).toEqual({ op: "mode", daemon: { ...baseSnapshot, persist: true } });
		expect(() =>
			parseDaemonWireRequest({
				id: "bad-mode",
				token: "token",
				operation: { op: "mode", name: "web", mode: "restart" },
			}),
		).toThrow("operation.mode must be persist, session, or detached");
	});
});

const terminalSpec: DaemonSpec = {
	name: "mind-1",
	application: "/usr/bin/node",
	args: ["-e", "process.exit(0)"],
	env: {},
	cwd: "/work",
	pty: true,
	restart: "no",
	persist: true,
	detached: false,
};

const outputFrame: DaemonTerminalOutputNotification = {
	event: "terminal_output",
	subscriptionId: "view-1",
	name: "mind-1",
	id: "generation-1",
	sequence: 1,
	data: "\x1b[2Jhello λ\r\n",
};

const exitFrame: DaemonTerminalExitNotification = {
	event: "terminal_exit",
	subscriptionId: "view-1",
	name: "mind-1",
	id: "generation-1",
	exitCode: 0,
	reason: "session disposed",
};

describe("terminal stream frames", () => {
	it("decodes terminal output without treating it as completion", () => {
		expect(parseDaemonWireMessage(outputFrame)).toEqual(outputFrame);
	});

	it("round-trips terminal output through the wire encoder byte for byte", () => {
		const decoded = parseDaemonWireMessage(JSON.parse(JSON.stringify(outputFrame)));
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(outputFrame));
	});

	it("decodes terminal exit with its exit status", () => {
		expect(parseDaemonWireMessage(exitFrame)).toEqual(exitFrame);
	});

	it("decodes a terminal exit that carries neither an exit code nor a reason", () => {
		const bare: DaemonTerminalExitNotification = {
			event: "terminal_exit",
			subscriptionId: "view-1",
			name: "mind-1",
			id: "generation-1",
		};
		expect(parseDaemonWireMessage(bare)).toEqual(bare);
	});

	it("keeps terminal frames distinguishable from completions", () => {
		const output = parseDaemonWireMessage(outputFrame);
		const completion = parseDaemonWireMessage({
			event: "daemon-completed",
			completionId: "completion-1",
			owner: "session-owner",
			daemon: baseSnapshot,
		});
		if (!("event" in output) || !("event" in completion)) throw new Error("expected notifications");
		expect(output.event).not.toBe(completion.event);
		expect("subscriptionId" in output && output.subscriptionId).toBe("view-1");
		expect("subscriptionId" in completion).toBe(false);
	});

	it("rejects an unknown event name instead of decoding it as a response envelope", () => {
		expect(() =>
			parseDaemonWireMessage({ event: "terminal_resumed", id: "request-1", ok: true, result: {} }),
		).toThrow("Unknown daemon event: terminal_resumed");
	});

	it("rejects terminal output whose data is not a string", () => {
		expect(() => parseDaemonWireMessage({ ...outputFrame, data: 7 })).toThrow("terminal.data must be a string");
	});

	it("rejects terminal output without a subscription id", () => {
		const { subscriptionId: _omitted, ...dropped } = outputFrame;
		expect(() => parseDaemonWireMessage(dropped)).toThrow("terminal.subscriptionId must be a non-empty string");
	});

	it("rejects a negative or fractional sequence number", () => {
		expect(() => parseDaemonWireMessage({ ...outputFrame, sequence: -1 })).toThrow(
			"terminal.sequence must be a nonnegative integer",
		);
		expect(() => parseDaemonWireMessage({ ...outputFrame, sequence: 1.5 })).toThrow(
			"terminal.sequence must be a nonnegative integer",
		);
	});
});

describe("terminal stream operations", () => {
	it("decodes an atomic start-and-subscribe request", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "fixture-only",
			operation: {
				op: "terminal_start",
				subscriptionId: "view-1",
				spec: terminalSpec,
				columns: 93,
				rows: 31,
			},
		});
		if (request.operation.op !== "terminal_start") throw new Error("unexpected operation");
		expect(request.operation.subscriptionId).toBe("view-1");
		expect(request.operation.columns).toBe(93);
		expect(request.operation.rows).toBe(31);
		expect(JSON.stringify(request.operation.spec)).toBe(JSON.stringify(terminalSpec));
	});

	it("decodes attach, resize, detach and acknowledgement requests with their generation fence", () => {
		const attach = parseDaemonWireRequest({
			id: "request-1",
			token: "fixture-only",
			operation: {
				op: "terminal_attach",
				subscriptionId: "view-1",
				name: "mind-1",
				id: "generation-1",
				columns: 93,
				rows: 31,
			},
		});
		expect(attach.operation).toEqual({
			op: "terminal_attach",
			subscriptionId: "view-1",
			name: "mind-1",
			id: "generation-1",
			columns: 93,
			rows: 31,
		});
		expect(
			parseDaemonWireRequest({
				id: "request-2",
				token: "fixture-only",
				operation: {
					op: "terminal_resize",
					subscriptionId: "view-1",
					name: "mind-1",
					id: "generation-1",
					columns: 100,
					rows: 40,
				},
			}).operation,
		).toEqual({
			op: "terminal_resize",
			subscriptionId: "view-1",
			name: "mind-1",
			id: "generation-1",
			columns: 100,
			rows: 40,
		});
		expect(
			parseDaemonWireRequest({
				id: "request-3",
				token: "fixture-only",
				operation: { op: "terminal_detach", subscriptionId: "view-1", name: "mind-1", id: "generation-1" },
			}).operation,
		).toEqual({ op: "terminal_detach", subscriptionId: "view-1", name: "mind-1", id: "generation-1" });
		expect(
			parseDaemonWireRequest({
				id: "request-4",
				token: "fixture-only",
				operation: {
					op: "terminal_ack",
					subscriptionId: "view-1",
					name: "mind-1",
					id: "generation-1",
					sequence: 7,
				},
			}).operation,
		).toEqual({ op: "terminal_ack", subscriptionId: "view-1", name: "mind-1", id: "generation-1", sequence: 7 });
	});

	it("rejects terminal operations without a subscription id", () => {
		expect(() =>
			parseDaemonWireRequest({
				id: "request-1",
				token: "fixture-only",
				operation: { op: "terminal_detach", name: "mind-1", id: "generation-1" },
			}),
		).toThrow("operation.subscriptionId must be a non-empty string");
	});

	it("rejects terminal operations without the generation fence", () => {
		expect(() =>
			parseDaemonWireRequest({
				id: "request-1",
				token: "fixture-only",
				operation: { op: "terminal_detach", subscriptionId: "view-1", name: "mind-1" },
			}),
		).toThrow("operation.id must be a non-empty string");
	});

	it("rejects non-positive or fractional terminal dimensions", () => {
		const base = { op: "terminal_resize", subscriptionId: "view-1", name: "mind-1", id: "generation-1", rows: 31 };
		expect(() => parseDaemonWireRequest({ id: "r", token: "t", operation: { ...base, columns: 0 } })).toThrow(
			"operation.columns must be a positive integer",
		);
		expect(() => parseDaemonWireRequest({ id: "r", token: "t", operation: { ...base, columns: 1.5 } })).toThrow(
			"operation.columns must be a positive integer",
		);
		expect(() =>
			parseDaemonWireRequest({ id: "r", token: "t", operation: { ...base, columns: 93, rows: -1 } }),
		).toThrow("operation.rows must be a positive integer");
	});

	it("rejects an acknowledgement with a negative or fractional sequence", () => {
		const base = { op: "terminal_ack", subscriptionId: "view-1", name: "mind-1", id: "generation-1" };
		expect(() => parseDaemonWireRequest({ id: "r", token: "t", operation: { ...base, sequence: -1 } })).toThrow(
			"operation.sequence must be a nonnegative integer",
		);
		expect(() => parseDaemonWireRequest({ id: "r", token: "t", operation: { ...base, sequence: 0.5 } })).toThrow(
			"operation.sequence must be a nonnegative integer",
		);
	});

	it("keeps the generation fence on terminal input", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "fixture-only",
			operation: {
				op: "send",
				name: "mind-1",
				id: "generation-1",
				data: "\u0003",
			},
		});
		expect(request.operation).toEqual({
			op: "send",
			name: "mind-1",
			id: "generation-1",
			data: "\u0003",
		});
	});
});

describe("terminal stream results", () => {
	it("decodes a managed snapshot from an atomic start", () => {
		expect(
			parseDaemonRpcResult(
				{ op: "terminal_start", subscriptionId: "view-1", spec: terminalSpec, columns: 93, rows: 31 },
				{ daemon: baseSnapshot },
			),
		).toEqual({
			op: "terminal_start",
			daemon: baseSnapshot,
		});
	});

	it("decodes an attach result carrying the snapshot and accepted dimensions", () => {
		expect(
			parseDaemonRpcResult(
				{ op: "terminal_attach", subscriptionId: "view-1", name: "mind-1", id: "daemon-1", columns: 93, rows: 31 },
				{ daemon: baseSnapshot, columns: 93, rows: 31 },
			),
		).toEqual({ op: "terminal_attach", daemon: baseSnapshot, columns: 93, rows: 31 });
	});

	it("identifies the affected subscription on resize, detach and acknowledgement results", () => {
		expect(
			parseDaemonRpcResult(
				{ op: "terminal_resize", subscriptionId: "view-1", name: "mind-1", id: "daemon-1", columns: 93, rows: 31 },
				{ subscriptionId: "view-1", name: "mind-1", id: "daemon-1", columns: 93, rows: 31 },
			),
		).toEqual({
			op: "terminal_resize",
			subscriptionId: "view-1",
			name: "mind-1",
			id: "daemon-1",
			columns: 93,
			rows: 31,
		});
		expect(
			parseDaemonRpcResult(
				{ op: "terminal_detach", subscriptionId: "view-1", name: "mind-1", id: "daemon-1" },
				{ subscriptionId: "view-1", name: "mind-1", id: "daemon-1" },
			),
		).toEqual({ op: "terminal_detach", subscriptionId: "view-1", name: "mind-1", id: "daemon-1" });
		expect(
			parseDaemonRpcResult(
				{ op: "terminal_ack", subscriptionId: "view-1", name: "mind-1", id: "daemon-1", sequence: 4 },
				{ subscriptionId: "view-1", name: "mind-1", id: "daemon-1", sequence: 4 },
			),
		).toEqual({ op: "terminal_ack", subscriptionId: "view-1", name: "mind-1", id: "daemon-1", sequence: 4 });
	});
});

describe("terminal stream capability", () => {
	it("preserves an advertised terminal protocol version", () => {
		expect(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work", terminalProtocolVersion: 1 })).toEqual({
			op: "ping",
			projectDir: "/work",
			terminalProtocolVersion: 1,
		});
	});

	it("leaves the capability absent when the broker does not advertise it", () => {
		const result = parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work" });
		if (result.op !== "ping") throw new Error("unexpected result");
		expect(result.terminalProtocolVersion).toBeUndefined();
	});

	it("rejects a fractional terminal protocol version", () => {
		expect(() => parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work", terminalProtocolVersion: 0 })).toThrow(
			"result.terminalProtocolVersion must be a positive integer",
		);
	});
});

describe("legacy wire compatibility", () => {
	it("leaves a legacy response envelope field for field", () => {
		const response = { id: "request-1", ok: true, result: { projectDir: "/work" } };
		expect(JSON.stringify(parseDaemonWireMessage(response))).toBe(JSON.stringify(response));
	});

	it("leaves a completion notification field for field", () => {
		const completion = {
			event: "daemon-completed",
			completionId: "completion-1",
			owner: "session-owner",
			daemon: baseSnapshot,
		};
		expect(JSON.stringify(parseDaemonWireMessage(completion))).toBe(JSON.stringify(completion));
	});

	it("leaves a legacy operation byte identical on the wire", () => {
		const request = parseDaemonWireRequest({ id: "request-1", token: "fixture-only", operation: { op: "ping" } });
		expect(JSON.stringify(request.operation)).toBe('{"op":"ping"}');
		const send = parseDaemonWireRequest({
			id: "request-2",
			token: "fixture-only",
			operation: { op: "send", name: "web", data: "q" },
		});
		expect(JSON.stringify(send.operation)).toBe('{"op":"send","name":"web","data":"q"}');
	});

	it("leaves a legacy ping result field for field", () => {
		expect(JSON.stringify(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work" }))).toBe(
			'{"op":"ping","projectDir":"/work"}',
		);
	});
});

describe("regex-derived protocol fields", () => {
	it("preserves an empty wait pattern match", () => {
		const waitOperation: Extract<DaemonOperation, { op: "wait" }> = {
			op: "wait",
			name: "web",
			for: "ready",
			pattern: "^",
			timeoutMs: 1_000,
		};
		expect(
			parseDaemonRpcResult(waitOperation, {
				daemon: baseSnapshot,
				matched: "",
				timedOut: false,
			}),
		).toEqual({
			op: "wait",
			daemon: baseSnapshot,
			matched: "",
			timedOut: false,
		});
	});
});
