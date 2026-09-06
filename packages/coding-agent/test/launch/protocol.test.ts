import { describe, expect, it } from "bun:test";
import {
	type DaemonOperation,
	type DaemonWireMessage,
	parseDaemonRpcResult,
	parseDaemonSnapshot,
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

	it("preserves live output subscriptions on broker requests", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			outputSubscriptions: [
				{
					id: "monitor-1",
					registrationId: "registration-1",
					name: "web",
					owner: "session-owner",
					artifactPath: "/tmp/monitor.log",
				},
			],
			outputSubscriptionId: "output-subscription-1",
			operation: { op: "ping" },
		});

		expect(request.outputSubscriptions).toEqual([
			{
				id: "monitor-1",
				registrationId: "registration-1",
				name: "web",
				owner: "session-owner",
				artifactPath: "/tmp/monitor.log",
			},
		]);
		expect(request.outputSubscriptionId).toBe("output-subscription-1");
	});

	it("preserves the acknowledged artifact size on output subscriptions and rejects a negative one", () => {
		const subscription = {
			id: "monitor-1",
			registrationId: "registration-1",
			name: "web",
			owner: "session-owner",
			artifactPath: "/tmp/monitor.log",
		};
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			outputSubscriptions: [{ ...subscription, lastEpoch: "epoch-1", lastSeq: 4, artifactBytes: 1_024 }],
			outputSubscriptionId: "output-subscription-1",
			operation: { op: "ping" },
		});
		expect(request.outputSubscriptions?.[0]).toMatchObject({
			lastEpoch: "epoch-1",
			lastSeq: 4,
			artifactBytes: 1_024,
		});

		expect(() =>
			parseDaemonWireRequest({
				id: "request-1",
				token: "token-1",
				outputSubscriptions: [{ ...subscription, artifactBytes: -1 }],
				outputSubscriptionId: "output-subscription-1",
				operation: { op: "ping" },
			}),
		).toThrow("request.outputSubscriptions[0].artifactBytes must be a non-negative integer");
	});

	it("preserves the next-start target on output subscriptions", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			outputSubscriptions: [
				{
					id: "monitor-1",
					registrationId: "registration-1",
					name: "web",
					owner: "session-owner",
					artifactPath: "/tmp/monitor.log",
					startPending: true,
				},
			],
			outputSubscriptionId: "output-subscription-1",
			operation: { op: "ping" },
		});

		expect(request.outputSubscriptions?.[0]?.startPending).toBeTrue();
	});

	it("rejects a non-boolean next-start target", () => {
		expect(() =>
			parseDaemonWireRequest({
				id: "request-1",
				token: "token-1",
				outputSubscriptions: [
					{
						id: "monitor-1",
						registrationId: "registration-1",
						name: "web",
						owner: "session-owner",
						artifactPath: "/tmp/monitor.log",
						startPending: "yes",
					},
				],
				outputSubscriptionId: "output-subscription-1",
				operation: { op: "ping" },
			}),
		).toThrow("request.outputSubscriptions[0].startPending must be a boolean");
	});

	it("decodes raw terminal text from an already-running legacy broker", () => {
		const result = parseDaemonRpcResult(operation, { ...baseResult, terminalText: "progress\rready" });
		if (result.op !== "logs") throw new Error("unexpected result");
		expect("terminalText" in result ? result.terminalText : undefined).toBe("progress\rready");
	});
});

describe("launch monitor notifications", () => {
	it("decodes one ordered output batch", () => {
		expect(
			parseDaemonWireMessage({
				event: "daemon-output",
				monitorId: "monitor-1",
				registrationId: "registration-1",
				name: "web",
				daemonId: "daemon-1",
				seq: 2,
				text: "second\nthird",
				batchKind: "progress",
				suppressedEvents: 9,
				reminder: "chatty-monitor",
				truncated: true,
			}),
		).toEqual({
			event: "daemon-output",
			monitorId: "monitor-1",
			registrationId: "registration-1",
			name: "web",
			daemonId: "daemon-1",
			seq: 2,
			text: "second\nthird",
			batchKind: "progress",
			suppressedEvents: 9,
			reminder: "chatty-monitor",
			truncated: true,
		});
	});

	it("preserves an empty output batch without breaking its sequence", () => {
		expect(
			parseDaemonWireMessage({
				event: "daemon-output",
				monitorId: "monitor-1",
				registrationId: "registration-1",
				name: "web",
				daemonId: "daemon-1",
				seq: 0,
				text: "",
				batchKind: "suppression-summary",
				suppressedEvents: 1,
			}),
		).toMatchObject({
			event: "daemon-output",
			seq: 0,
			text: "",
			batchKind: "suppression-summary",
			suppressedEvents: 1,
		});
	});

	it("decodes a replay-gap batch with the artifact size it is backed by", () => {
		const gap: DaemonWireMessage = {
			event: "daemon-output" as const,
			monitorId: "monitor-1",
			registrationId: "registration-1",
			name: "web",
			daemonId: "daemon-1",
			epoch: "epoch-1",
			seq: 7,
			text: "",
			batchKind: "progress" as const,
			suppressedEvents: 3,
			truncated: true,
			artifactBytes: 4_096,
			replayGap: 3,
		};
		expect(parseDaemonWireMessage(gap)).toEqual(gap);
		expect(() => parseDaemonWireMessage({ ...gap, replayGap: 1.5 })).toThrow(
			"output.replayGap must be a non-negative integer",
		);
		expect(() => parseDaemonWireMessage({ ...gap, artifactBytes: "many" })).toThrow(
			"output.artifactBytes must be a finite number",
		);
	});

	it("decodes terminal state separately from output", () => {
		expect(
			parseDaemonWireMessage({
				event: "daemon-monitor-completed",
				monitorId: "monitor-1",
				registrationId: "registration-1",
				daemon: { ...baseSnapshot, state: "exited", exitedAt: 2, exitCode: 0 },
			}),
		).toEqual({
			event: "daemon-monitor-completed",
			monitorId: "monitor-1",
			registrationId: "registration-1",
			daemon: { ...baseSnapshot, state: "exited", exitedAt: 2, exitCode: 0 },
		});
	});

	it("decodes monitor expiry as a terminal registration event", () => {
		expect(
			parseDaemonWireMessage({
				event: "daemon-monitor-expired",
				monitorId: "monitor-1",
				registrationId: "registration-1",
				name: "web",
				daemonId: "daemon-1",
			}),
		).toEqual({
			event: "daemon-monitor-expired",
			monitorId: "monitor-1",
			registrationId: "registration-1",
			name: "web",
			daemonId: "daemon-1",
		});
	});

	it.each([-1, 1.5])("rejects invalid output sequence %s", seq => {
		expect(() =>
			parseDaemonWireMessage({
				event: "daemon-output",
				monitorId: "monitor-1",
				registrationId: "registration-1",
				name: "web",
				daemonId: "daemon-1",
				seq,
				text: "progress",
				batchKind: "progress",
				suppressedEvents: 0,
			}),
		).toThrow("output.seq must be a non-negative integer");
	});

	it("rejects malformed monitor payloads at the socket boundary", () => {
		expect(() =>
			parseDaemonWireMessage({
				event: "daemon-output",
				monitorId: "monitor-1",
				registrationId: "registration-1",
				name: "web",
				daemonId: "daemon-1",
				seq: "2",
				text: "progress",
			}),
		).toThrow("output.seq must be a finite number");
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
