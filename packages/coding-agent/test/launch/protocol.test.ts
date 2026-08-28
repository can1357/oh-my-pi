import { describe, expect, it } from "bun:test";
import {
	type DaemonOperation,
	parseDaemonRpcResult,
	parseDaemonSnapshot,
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

describe("regex-derived protocol fields", () => {
	it("preserves an empty readiness match", () => {
		expect(parseDaemonSnapshot({ ...baseSnapshot, readyMatch: "" }).readyMatch).toBe("");
	});

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
